/**
 * The propose pipeline (spec §5, §7; architecture §4.2). One order, and it matters:
 *
 *   flag → media fetch and re-validate → duplicate → caps → model → grounding → grams → policy
 *
 * Media is fetched and validated before the duplicate probe and the caps check (not after), because
 * the duplicate hash is over the request's bytes and needs them first. Everything that can refuse
 * without spending still runs before the model call. Nothing here writes a log row: the draft is
 * returned and forgotten, and only a commit call reaches log_entries (§4.2, AC2).
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inputHashFor, installedGenai, MODELS, type Media } from "@/lib/ai/adapter";
import { writeBlockedCall } from "@/lib/ai/call-ledger";
import { captureOpenRouterReady, PURPOSE_BY_METHOD, runCapture as runCaptureImpl } from "@/lib/ai/capture";
import { assertGeminiAttested } from "@/lib/ai/attestation";
import { byModel } from "@/lib/provenance";
import { capturePayload } from "@/lib/ai/gemini-payloads";
import { captureOpenRouterPayload, openRouterCapturePurpose } from "@/lib/ai/openrouter-payloads";
import type { CaptureItem, CaptureItems, CapturePurpose, LabelNutrients } from "@/lib/ai/schemas";
import { capState, hardCap, softCap, type CapState } from "@/lib/ai/spend";
import { isMethodEnabled } from "@/lib/capture/flags";
import { pickCandidate, topAlternatives, type ScoredHit } from "@/lib/capture/grounding";
import { allergenTagsFromIngredients, buildDraft, type GroundedItem } from "@/lib/capture/propose";
import { gramsFor, matchPortion, parseAmount, type CapturePortion } from "@/lib/capture/quantity";
import type { DraftItem, ProposeRequest, ProposeResponse } from "@/lib/capture/types";
import { validateAudio, validateImage } from "@/lib/media/validate";
import { isPackagedCatalogSource } from "@/lib/catalog/category-map";
import { completenessText } from "@/lib/foods/catalog-ingredients";
import {
  allergenRule, labelEvidence, labelFindings, mergeStoredEvidence, namedAllergenHints,
  withCrustaceanAllowance, type AllergenFinding, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { evaluatePolicy, type ConstraintProfile, type PolicyVerdict } from "@/lib/policy/constraints";
import { pregnancyTunaFinding } from "@/lib/policy/pregnancy-tuna";
import { readAllergenChecks, readAllergenEvidence } from "@/lib/server/allergen-evidence";
import {
  ACCOUNT_DAY_LAST_RESORT_ZONE, readAccountZone, resolveAccountDay,
} from "@/lib/server/account-day";
import { HttpError } from "@/lib/server/auth";
import { adviseDraftFoodRoles } from "@/lib/server/food-role-advice";
import type { MealComponentRoleAdvice } from "@/lib/coach/role-advice";
import { loadUserProfile, searchFoods as searchFoodsImpl } from "@/lib/server/catalog";
import { draftIdFromPath, fetchOwnedObject as fetchOwnedObjectImpl } from "@/lib/server/media";
import { fetchAllRows } from "@/lib/server/paged-read";

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export class DuplicateRequest extends HttpError {
  constructor(public aiCallId: string) {
    super(409, "duplicate_request", "That capture is already open. Check the draft you have.");
  }
}

export type CaptureDeps = {
  runCapture?: typeof runCaptureImpl;
  searchFoods?: typeof searchFoodsImpl;
  fetchOwnedObject?: typeof fetchOwnedObjectImpl;
  now?: () => number;
  /** Role advice per grounded food (lib/server/food-role-advice.ts); fails soft to none. */
  adviseRoles?: (foodRefIds: (string | null)[]) => Promise<Map<string, MealComponentRoleAdvice>>;
};

/** The media methods carry a path; text carries text. Narrowed once, here. */
function mediaPathOf(req: ProposeRequest): string | null {
  return req.method === "text" ? null : req.mediaPath;
}

const KNOWN_TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

function assertKnownTimeZone(tz: string): void {
  if (!KNOWN_TIME_ZONES.has(tz)) {
    throw new HttpError(400, "bad_request", "That time zone is not recognised.");
  }
}

/** A path with no live media_objects row is not theirs to read, whatever the storage bucket holds:
 * no row, someone else's row, or a row already tombstoned by a commit or the sweep all mean the
 * same thing here — refuse before spending a download on it. */
async function assertLiveMediaObject(admin: SupabaseClient, userId: string, path: string): Promise<void> {
  const { data, error } = await admin.from("media_objects")
    .select("path, user_id, deleted_at").eq("path", path).maybeSingle();
  if (error) {
    console.error("media_objects read failed", { path, error });
    throw new HttpError(503, "provider_unavailable", "Capture is unavailable right now.");
  }
  const row = data as { user_id: string; deleted_at: string | null } | null;
  if (!row || row.user_id !== userId || row.deleted_at !== null) {
    throw new HttpError(403, "media_not_owned", "That file is not yours.");
  }
}

async function loadMedia(
  admin: SupabaseClient, userId: string, req: ProposeRequest, fetchOwned: typeof fetchOwnedObjectImpl
): Promise<Media | null> {
  const path = mediaPathOf(req);
  if (path === null) return null;
  await assertLiveMediaObject(admin, userId, path);
  const object = await fetchOwned(admin, userId, path);       // throws 403 before any download
  const result = req.method === "voice"
    ? validateAudio(object.bytes, object.mimeType)
    : validateImage(object.bytes, object.mimeType);
  if (!result.ok) throw new HttpError(415, "unsupported_media", result.reason);
  return { bytes: object.bytes, mimeType: object.mimeType };
}

async function portionsFor(
  client: SupabaseClient, revisionId: number
): Promise<CapturePortion[]> {
  const { data, error } = await client.from("catalog_portions")
    .select("id, description, gram_weight").eq("food_revision_id", revisionId);
  if (error) {
    console.error("catalog_portions read failed", { revisionId, error });
    return [];
  }
  return ((data ?? []) as { id: number; description: string; gram_weight: number }[])
    .map((p) => ({ id: p.id, description: p.description, gramWeight: Number(p.gram_weight) }));
}

/**
 * finding (r5, sol BLOCK): a photo/voice/text item that grounds to a real catalog hit used to
 * read only this revision's structured `allergen_tags` — never its verbatim seq-1 ingredient
 * text (`raw_text`, the same column search's own `allergenTagsByRevision` reads), so a named
 * allergen the label spells out but that never made it into the structured tags column (mustard
 * is not one of the nine FALCPA majors and is rarely pre-tagged) fell back to `unverified`
 * instead of `present`, even though the very same revision's search result already judges it
 * correctly (`FoodSearchHit.policy`, computed from this same text).
 *
 * ORCHESTRATOR fix (round 7, item 6): reads via `completenessText`, the same seq-1-plus-shape
 * check every other read of this table uses (lib/server/barcode.ts, lib/foods/catalog-
 * ingredients.ts catalogWarmFood), instead of trusting a bare seq-1 `raw_text` on its own —
 * `verbatim` says whether that text is genuinely the single printed statement (condition a) so
 * the grounded capture path can never treat a non-standard row shape as complete just because
 * seq 1 happens to carry SOME text.
 *
 * review round 2 (sol BLOCK): `names` — every row's own parsed `name`, seq 1 included — so the
 * caller can run the same `namedAllergenHints` fallback search's own `allergenTagsByRevision` and
 * detail's `getFoodDetail` already run over ALL rows' names. `completenessText`'s own `text` above
 * is, in the common shape, seq 1's verbatim statement ALONE (a later row's split fragment stays
 * out of it on purpose — the shape that makes the label read as complete at all): a later row that
 * carries no `allergen_tags` of its own and is never repeated in seq 1's text named nothing this
 * function returned, though the very same revision's search result already caught it via that
 * fallback (`FoodSearchHit.policy`) — capture and search could disagree about the same revision.
 */
async function allergenTagsFor(
  client: SupabaseClient, revisionId: number
): Promise<{ tags: string[] | null; ingredientsText: string | null; verbatim: boolean;
  names: string[]; unread?: true }> {
  // t18 r3: a revision has no bound on its ingredient rows. Paged by primary key (seq, within the
  // one revision); a failed page is `unread`, never a shorter tag list (see `withUnreadIngredients`).
  type IngredientRow = { seq: number; name: string; raw_text: string | null;
    allergen_tags: string[] | null };
  let rows: IngredientRow[];
  try {
    rows = await fetchAllRows<IngredientRow>((from, to) => client.from("catalog_ingredients")
      .select("seq,name,raw_text,allergen_tags").eq("food_revision_id", revisionId)
      .order("seq").range(from, to));
  } catch (error) {
    console.error("catalog_ingredients read failed", { revisionId, error });
    return { tags: null, ingredientsText: null, verbatim: true, names: [], unread: true };
  }
  if (rows.length === 0) return { tags: null, ingredientsText: null, verbatim: true, names: [] };
  const ingredientRows = rows.filter((r) => r.seq >= 1);
  const list = completenessText(ingredientRows);
  return {
    tags: rows.flatMap((r) => r.allergen_tags ?? []),
    ingredientsText: list.text,
    verbatim: list.verbatim,
    names: ingredientRows.map((r) => r.name).filter(Boolean),
  };
}

/** Same purpose and input hash, succeeded, inside the last ten minutes — the repeat-tap guard. */
async function assertNotDuplicate(
  client: SupabaseClient, userId: string, purpose: CapturePurpose, inputHash: string, since: string
): Promise<void> {
  // The OpenRouter twin records the same input hash (lib/ai/capture.ts), so one probe finds the
  // request whichever provider answered it.
  const twin = openRouterCapturePurpose(purpose);
  const priorCall = await client.from("ai_calls").select("id")
    .eq("user_id", userId).in("purpose", twin ? [purpose, twin] : [purpose]).eq("input_hash", inputHash)
    .eq("status", "ok").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (priorCall.error) {
    console.error("ai_calls duplicate probe failed", { userId, purpose, error: priorCall.error });
    return;
  }
  if (priorCall.data) throw new DuplicateRequest((priorCall.data as { id: string }).id);
}

/**
 * Writes one `blocked` ai_calls row and refuses at the hard cap; the soft cap only warns. The day
 * the cap counts is the account's stored zone (UTC as the logged last resort), never the zone the
 * request names: a caller could otherwise pick a zone whose midnight just passed and reset the
 * count (audit A143).
 */
async function assertUnderCaps(
  admin: SupabaseClient, userId: string, purpose: CapturePurpose, inputHash: string
): Promise<{ usedToday: number; soft: number; state: CapState }> {
  const { zone } = resolveAccountDay({ purpose: "capture cap",
    storedZone: await readAccountZone(admin, userId) });
  const used = await admin.rpc("ai_calls_today",
    { p_user_id: userId, p_tz: zone ?? ACCOUNT_DAY_LAST_RESORT_ZONE });
  if (used.error) {
    console.error("ai_calls_today failed", { userId, error: used.error });
    throw new HttpError(503, "provider_unavailable", "Capture is unavailable right now.");
  }
  const usedToday = Number(used.data ?? 0);
  const soft = softCap();
  const hard = hardCap();
  const state = capState(usedToday, soft, hard);
  if (state === "blocked") {
    await writeBlockedCall(admin, {
      userId, purpose, provider: "google", model: MODELS[purpose],
      sdkVersion: installedGenai().version, inputHash, error: `daily cap ${hard} reached`,
    });
    throw new HttpError(429, "spend_cap", "That is today's capture limit. Search still works.");
  }
  return { usedToday, soft, state };
}

async function resolveFoodRef(
  client: SupabaseClient, userId: string, catalogFoodId: number
): Promise<string | null> {
  const ref = await client.rpc("get_or_create_food_ref", {
    p_user_id: userId, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
  });
  if (ref.error) {
    console.error("get_or_create_food_ref failed", { userId, catalogFoodId, error: ref.error });
    return null;
  }
  return (ref.data as string | null) ?? null;
}

/** Either source can only ever ADD `listed` (see finding #4, review round 1); `null` only when
 *  neither one has anything to add. Exported for its own unit test. */
export function combineAllergenTags(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null && b === null) return null;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * One model item, grounded against the catalog and judged. A ref is only ever written for a search
 * that cleared the auto-resolve gate (lib/search/thresholds.ts) — an item that did not is left
 * `foodRefId: null` (spec §5: "null = ungrounded, the user picks") with alternatives to choose from
 * instead. Grams and the allergen evidence still come from the top pick either way: they are a hint
 * for the stepper and a policy check, not a silent grounding.
 *
 * Exported for its own test (review round 1, finding #4) — every other caller reaches it through
 * `proposeDraft`.
 */
export async function groundItem(
  client: SupabaseClient, userId: string, item: CaptureItem, label: LabelNutrients | null,
  profile: ConstraintProfile, searchFoods: typeof searchFoodsImpl
): Promise<{ grounded: GroundedItem; verdict: PolicyVerdict;
  /** review r2 sol/BLOCK: the revision's own stored evidence, read above and already merged into
   *  `verdict` — handed back so a label capture's card (labelFoodOf) can merge the SAME evidence
   *  into its own warning text, instead of reading the fresh OCR scan alone and disagreeing with
   *  the verdict beside it. `{}` when nothing grounded, a no-op merge either way. */
  storedEvidence: Record<string, StoredAllergenEvidence>;
  /** sol FIX (review round 1, finding #7): the same "I checked the label" mark, already merged
   *  into `verdict` — handed back for the same reason as `storedEvidence`, so labelFoodOf's card
   *  can never disagree with the verdict beside it about whether this allergen was checked. */
  checkedAllergens: string[];
  /** round 13, item 3: the same merged allergen tags (catalog `allergen_tags` plus this label's
   *  own OCR-derived tags) already folded into `verdict` — handed back so labelFoodOf's card reads
   *  the identical signal instead of the label's OCR text alone. */
  allergenTags: string[] | null;
  /** t18 r4: the grounded revision's ingredient rows could not be read; the card must not clear. */
  ingredientsUnread?: true }> {
  const query = [item.brand, item.label].filter(Boolean).join(" ");
  const found = await searchFoods(client, { q: query, limit: 25 });
  const hits = found.hits as unknown as ScoredHit[];
  const picked = pickCandidate(hits, found.queryClass);
  const alternatives: DraftItem["alternatives"] = [];
  let foodRefId: string | null = null;
  let portionId: number | null = null;
  let grams = item.grams;
  let allergenTags: string[] | null = null;
  let catalogIngredientsText: string | null = null;
  let catalogIngredientsVerbatim = true;
  let stored: Record<string, StoredAllergenEvidence> = {};
  let checked: string[] = [];
  let ingredientsUnread = false;

  if (picked) {
    // T0 §4: portions, ingredients and the food refs are four independent round trips against
    // the same revision. They ran one after another; they now run together. The alternatives keep
    // their `topAlternatives` order because the results are mapped back by position, not by
    // whichever ref resolved first.
    //
    // sol BLOCK (finding #6, review round 1): this slice's own allergen-evidence/check reads
    // (`readAllergenEvidence`, `readAllergenChecks` below) joined this same Promise.all rather
    // than adding a wave of their own, the same reasoning lib/server/catalog.ts's searchFoods
    // already argues for its own version of this read — argued, not measured, here too: closing
    // it for real needs a before/after `pnpm timings --path capture` sample against production,
    // which needs production DB access this fixer pass does not have (and the repo's own rules
    // forbid touching the production database directly). Every read added here is a single
    // indexed `.in()` over at most one revision key, batched into a Promise.all already paying
    // for portions/ingredients/refs, not an extra round trip.
    //
    // review round 2 (sol BLOCK): still no before/after p95 sample exists for THIS route either —
    // the same gap dfc713c documented for search, and lib/coach/suggest-policy.ts's own evidence
    // wave documents for coach. Unresolved for the same reason: closing it needs production access
    // outside this fixer pass. Flagged for the orchestrator, not fabricated here.
    const alternativeHits = picked.autoResolved ? [] : topAlternatives(hits);
    const revisionKey = `catalog_revision:${picked.hit.revisionId}`;
    const [portions, ingredients, ownRef, altRefs, evidence, checks] = await Promise.all([
      portionsFor(client, picked.hit.revisionId),
      allergenTagsFor(client, picked.hit.revisionId),
      picked.autoResolved ? resolveFoodRef(client, userId, picked.hit.catalogFoodId) : null,
      Promise.all(alternativeHits.map((hit) => resolveFoodRef(client, userId, hit.catalogFoodId))),
      readAllergenEvidence(client, [revisionKey]),
      readAllergenChecks(client, userId, [revisionKey]),
    ]);
    stored = evidence.get(revisionKey) ?? {};
    checked = checks.get(revisionKey) ?? [];
    const amount = parseAmount(`${item.qty} ${item.unit} ${item.label}`)
      ?? { qty: item.qty, unit: item.unit };
    // audit 2026-10-10 A007/A044: a count with no portion row keeps the model's own grams; nothing
    // here invents a weight per piece.
    grams = gramsFor(amount.qty, amount.unit, portions) ?? item.grams;
    portionId = matchPortion(amount.unit, portions)?.id ?? null;
    // review round 2 (sol BLOCK): a later, untagged row's own NAME can still name the allergen
    // (e.g. "sesame" split into its own row with no `allergen_tags` entry) even when seq 1's
    // verbatim statement alone reads as a complete, allergen-free label — the same fallback
    // search (`lib/server/catalog.ts` allergenTagsByRevision) and detail already run over every
    // row's name. Only ever ADDS a tag; `null` (no ingredient rows at all) stays `null`.
    const nameHints = namedAllergenHints(ingredients.names.join(", "), profile.avoid_allergens);
    allergenTags = ingredients.tags === null ? null : combineAllergenTags(ingredients.tags, nameHints);
    catalogIngredientsText = ingredients.ingredientsText;
    catalogIngredientsVerbatim = ingredients.verbatim;
    ingredientsUnread = ingredients.unread === true;
    foodRefId = ownRef;
    alternativeHits.forEach((hit, i) => {
      const refId = altRefs[i];
      if (refId) alternatives.push({ foodRefId: refId, catalogFoodRevisionId: hit.revisionId,
        label: hit.description, score: hit.score,
        // W139: the search verdict reads the catalog row only; a scanned label's own text can
        // name more, so a label draft's alternatives stay unverified until the commit rechecks.
        ...(hit.policy && !label ? { policy: hit.policy } : {}) });
    });
  }

  const grounded: GroundedItem = {
    foodRefId, catalogFoodRevisionId: foodRefId && picked ? picked.hit.revisionId : null,
    grams, portionId, alternatives, autoResolved: picked?.autoResolved ?? false,
  };
  // sol BLOCK (finding #4, review round 1): a label capture that GROUNDED to a real catalog
  // revision must still carry that revision's own structured `allergen_tags` column
  // (`allergenTags`, read via `allergenTagsFor` above) alongside what this photo's OCR text
  // spells out — not the OCR text alone. `allergenTags` is independent of the
  // `food_allergen_evidence` warm job (`stored`, merged into `allergenEvidence` below): a
  // revision tagged peanut whose background warm has not run yet, matched to a label photo
  // whose OCR omitted peanut, used to read `allowed` here even though the barcode path for the
  // exact same revision would block it. Either source can only ever ADD `listed`, never remove
  // it, so combining them is safe; `null` only when NEITHER source has anything to add.
  //
  // round 13, item 3: kept in its own variable (not inlined) so it can be handed back to the
  // caller too — labelFoodOf's card must read the SAME merged tags this verdict does, not the
  // label's OCR text alone, or a blocked item could sit beside a card that still says the label
  // does not list the allergen.
  const mergedAllergenTags = label ? combineAllergenTags(
    allergenTagsFromIngredients(label.ingredientsText), allergenTags) : allergenTags;
  const judged = evaluatePolicy(profile, {
    foodRefId,
    // finding #8: the label's own name when this is a label capture, else the grounded catalog
    // hit's name, else the model's own item label — whichever this item actually has.
    foodName: label ? label.name : found.hits[0]?.description ?? item.label,
    allergenTags: mergedAllergenTags,
    // Phase 13 §5: a scanned label is its own evidence, read from the printed list; a grounded
    // catalog food carries its stored evidence and this user's product checks.
    //
    // finding #2: a label matched to a catalog revision must still merge that revision's STORED
    // evidence (`stored`, already read above) with what THIS label's own text says — the same merge
    // lib/server/barcode-policy.ts's scannedAllergenFacts does for a barcode scan. Reading the live
    // label alone let a complete-but-omits-sesame photo answer `allowed` for a revision Jev had
    // already marked `listed`, the exact two-paths-disagree bug that file's header warns about.
    // r4 BLOCK #2: labelEvidence's own key set must include `crustacean` whenever `shellfish` is
    // avoided, or mergeStoredEvidence (which only merges the keys the live map already has) drops
    // a stored crustacean `listed` this label's own text does not happen to repeat.
    //
    // finding (r5): `checked` (already read via readAllergenChecks above, alongside `stored`) must
    // reach this call in BOTH branches — the label branch dropped it, so a product the user had
    // already marked "I checked the label" for (via the barcode card) read as unverified again
    // the next time the same revision was captured by photo or label scan.
    ...(label
      ? { allergenEvidence: mergeStoredEvidence(
            labelEvidence(withCrustaceanAllowance(profile.avoid_allergens), label.ingredientsText),
            stored),
          ingredientsText: label.ingredientsText ?? null, checkedAllergens: checked }
      // finding (r5, sol BLOCK): a photo/voice/text item that GROUNDS to a real catalog hit (no
      // scanned label of its own) must still read that revision's own verbatim ingredient text —
      // the same seq-1 `raw_text` search's own per-hit policy already reads — or a named allergen
      // absent from the structured `allergen_tags` column (mustard, not one of the nine FALCPA
      // majors and rarely pre-tagged) falls back to unverified instead of the present it should be.
      : { allergenEvidence: stored, checkedAllergens: checked,
          ingredientsText: catalogIngredientsText,
          // ORCHESTRATOR fix (round 7, item 6): condition (a) — this text is verbatim only when
          // completenessText found the revision's single printed statement, never when it fell
          // back to the joined names across rows.
          ingredientsTextIsLabel: catalogIngredientsVerbatim }),
    // The hit carries its own `policy_categories` since T1 round 2 (catalog_search returns the
    // column), so grounding judges the category instead of discarding the evidence. No hit at all
    // is `null` — no category evidence — rather than an empty "checked, none banned".
    category: found.hits[0]?.policyCategories ?? null,
    onEatsList: (found.hits[0]?.prefStatus ?? null) === "eats",
    onAvoidList: (found.hits[0]?.prefStatus ?? null) === "avoid",
    // 2026-10-02 DeepSeek audit (F1, HIGH): the label's own brand when this is a label capture,
    // else the model's own brand guess, else the grounded catalog hit's brand — whichever this
    // item actually has. Without it, a packaged "Chicken breast" nutrition-panel photo (no
    // ingredient list in frame, no brand string on an unbranded store label) fell through to
    // lib/policy/whole-foods.ts's whole-food clearance ("Plain poultry has no dairy") while the
    // label card right beside it (labelFindings, below) still said "Check the label for dairy".
    foodBrand: label?.brand ?? item.brand ?? found.hits[0]?.brand ?? null,
    // A label scan is packaged by definition, whatever its own `brand` string reads; a photo/voice
    // item grounded to a branded or Open Food Facts catalog row is packaged too, same as search and
    // detail's own policy reads (lib/server/catalog.ts).
    packaged: label !== null || isPackagedCatalogSource(found.hits[0]?.source),
  });
  const verdict = ingredientsUnread ? withUnreadIngredients(judged, checked) : judged;
  return { grounded, verdict, storedEvidence: stored, checkedAllergens: checked,
    allergenTags: mergedAllergenTags, ...(ingredientsUnread ? { ingredientsUnread: true } : {}) };
}

/**
 * t18 r4: the grounded revision's ingredient rows could not be read. A row the read missed may list
 * an allergen, so nothing may clear one: a label's "No sesame listed", a whole-food clearance or a
 * stored `not_listed` all become "Check the label", and an allowed item is unverified. A finding
 * already `present`, a block and the user's own explicit check stand. Both branches, label or not.
 */
export function withUnreadIngredients(verdict: PolicyVerdict,
  userChecked: readonly string[]): PolicyVerdict {
  const allergens = verdict.allergens && uncleared(verdict.allergens, userChecked);
  return { ...verdict, ...(allergens ? { allergens } : {}),
    verdict: verdict.verdict === "allowed" ? "unverified" : verdict.verdict };
}

/** Every finding but `present` and the user's own check becomes "Check the label" (t18 r4). */
function uncleared<F extends Pick<AllergenFinding, "allergen" | "outcome" | "text">>(
  findings: readonly F[], userChecked: readonly string[]): F[] {
  return findings.map((finding) =>
    finding.outcome === "present" || userChecked.includes(finding.allergen) ? finding
      : { ...finding, outcome: "unknown", text: `Check the label for ${allergenRule(finding.allergen).label}`,
        ...("checkable" in finding ? { checkable: true } : {}) });
}

/**
 * An item whose grounding could not run at all — a catalog read that timed out, an RPC that
 * failed. The answer is the one `groundItem` already documents for an item it could not resolve:
 * `foodRefId: null`, "the user picks", with the model's own grams to start from and no alternatives to
 * offer. One food's bad luck must not lose the model call the other four already paid for, and it
 * must never come back as a verdict — no evidence is `unverified`, never `allowed`.
 */
function ungroundable(
  item: CaptureItem, error: unknown
): { grounded: GroundedItem; verdict: PolicyVerdict;
  storedEvidence: Record<string, StoredAllergenEvidence>; checkedAllergens: string[];
  allergenTags: string[] | null; ingredientsUnread?: true } {
  console.error("grounding failed for one item", {
    label: item.label,
    error: error instanceof Error
      ? { name: error.name, message: error.message.slice(0, 300) }
      : { name: "UnknownError", message: "non-Error rejection" },
  });
  return {
    grounded: {
      foodRefId: null, catalogFoodRevisionId: null, grams: item.grams, portionId: null,
      alternatives: [], autoResolved: false,
    },
    verdict: { verdict: "unverified" },
    storedEvidence: {},
    checkedAllergens: [],
    allergenTags: null,
  };
}

/** The label method makes its own one-item envelope from the parsed nutrition; every other method's
 * output already is one. */
function itemsFromOutput(label: LabelNutrients | null, output: CaptureItems | LabelNutrients): CaptureItems {
  if (!label) return output as CaptureItems;
  return { items: [{ label: label.name, grams: label.servingGrams, qty: 1, unit: "whole",
    confidence: 0.9, ...(label.brand ? { brand: label.brand } : {}) }], notes: [] };
}

export function labelFoodOf(
  label: LabelNutrients | null, profile: ConstraintProfile,
  // review r2 sol/BLOCK: the revision groundItem matched this label against, when it did — the
  // SAME stored evidence its verdict merged in, so this card's own text cannot disagree with it.
  revisionEvidence?: Readonly<Record<string, StoredAllergenEvidence>>,
  // sol FIX (review round 1, finding #7): the same "I checked the label" mark the item's own
  // verdict already merged in — without it, a prior check could make the verdict `allowed` while
  // this card, right beside it, still said "Check the label for X".
  checkedAllergens?: readonly string[],
  // round 13, item 3: the same merged tags (catalog `allergen_tags` plus this label's own
  // OCR-derived tags) groundItem's own verdict already folds in — without them this card read the
  // fresh OCR text alone and could say "No <allergen> listed" beside an item the verdict blocked.
  allergenTags?: readonly string[] | null,
  // t18 r4: the matched revision's ingredient rows could not be read, so this card, like the
  // verdict beside it, must not clear an allergen a missed row may list.
  ingredientsUnread = false,
): ProposeResponse["labelFood"] | undefined {
  if (!label) return undefined;
  // Phase 13 §5: the capture card warns right after labelToNutrients, one line per allergen the
  // account avoids ("Contains sesame", "No egg listed on the label", "Check the label for gluten").
  const found = labelFindings(profile.avoid_allergens, label.ingredientsText, revisionEvidence,
    checkedAllergens, allergenTags)
    .map(({ allergen, outcome, text }) => ({ allergen, outcome, text }));
  const warnings = ingredientsUnread ? uncleared(found, checkedAllergens ?? []) : found;
  // finding #8 / finding #11: the pregnancy/tuna finding is independent of the avoid list
  // (evaluatePolicy folds it in the same way for the item's own verdict); the label card must
  // show it too, not just a food the search/grounding path picked.
  const tuna = pregnancyTunaFinding({
    conditions: profile.conditions, profileIds: profile.profileIds,
    ingredientsText: label.ingredientsText, foodName: label.name,
  });
  const allWarnings = tuna
    ? [...warnings, { allergen: tuna.allergen, outcome: tuna.outcome, text: tuna.text }] : warnings;
  return { name: label.name, ...(label.brand ? { brand: label.brand } : {}),
    per100g: label.per100g, ...(label.ingredientsText ? { ingredientsText: label.ingredientsText } : {}),
    allergenTags: allergenTagsFromIngredients(label.ingredientsText) ?? [],
    ...(allWarnings.length > 0 ? { allergenWarnings: allWarnings } : {}) };
}

/** Photo/voice/label draftIds come from the media path (Task 13's commit route needs the same id
 * both times); text falls back to a fresh uuid since there is no path to derive one from. */
function draftIdFor(req: ProposeRequest): string {
  const path = mediaPathOf(req);
  return path ? (draftIdFromPath(path) ?? randomUUID()) : randomUUID();
}

/** The soft cap only warns: say what happens next, without counts or blame. */
function capNotes(state: CapState): string[] {
  return state === "warn"
    ? ["You’ve logged a lot today. A few more and quick logging pauses until tomorrow; you can still add foods by hand."]
    : [];
}

export async function proposeDraft(
  client: SupabaseClient, admin: SupabaseClient, userId: string,
  req: ProposeRequest, deps: CaptureDeps = {}
): Promise<ProposeResponse> {
  if (!isMethodEnabled(req.method)) {
    throw new HttpError(404, "method_disabled", "That way of logging is not switched on.");
  }
  assertKnownTimeZone(req.tz);
  const purpose = PURPOSE_BY_METHOD[req.method];
  const runCapture = deps.runCapture ?? runCaptureImpl;
  const searchFoods = deps.searchFoods ?? searchFoodsImpl;
  const now = deps.now ?? Date.now;

  // The hash must be the one the adapter will write, so the index finds it next time. Media is
  // hashed by its bytes, so the same photo twice collides even though the object path differs.
  // Phase 13 §9 R3: the attestation is checked before the media is read, and again by the payload
  // builder before anything is serialised. Off, capture refuses with 503 nous_unconfirmed.
  assertGeminiAttested();
  const media = await loadMedia(admin, userId, req, deps.fetchOwnedObject ?? fetchOwnedObjectImpl);
  const text = req.method === "text" ? req.text : undefined;
  const payload = capturePayload(purpose,
    { text, slot: req.slot, localDate: req.localDate }, media ?? undefined);
  const inputHash = inputHashFor(payload.parts, payload.media);

  const since = new Date(now() - DUPLICATE_WINDOW_MS).toISOString();
  await assertNotDuplicate(client, userId, purpose, inputHash, since);
  const { usedToday, soft, state } = await assertUnderCaps(admin, userId, purpose, inputHash);

  // Owner request 2026-10-02: text, photo and label ask OpenRouter first (lib/ai/capture.ts), the
  // Gemini payload above stays the fallback.
  // 2026-10-06 (Gemini project denial, #gemini-fallback): voice gets the opposite order — Gemini
  // stays primary, and its OpenRouter twin is only tried once the Gemini pair is exhausted
  // (ctx.openRouterFallback), so the app recovers onto Gemini on its own once access is restored.
  const twin = openRouterCapturePurpose(purpose);
  const openRouterPayload = twin && captureOpenRouterReady()
    ? captureOpenRouterPayload(twin, { text, slot: req.slot, localDate: req.localDate }, media ?? undefined)
    : undefined;
  const captureCtx = !openRouterPayload
    ? { userId, admin }
    : purpose === "voiceToItems"
      ? { userId, admin, openRouterFallback: openRouterPayload, inputHash }
      : { userId, admin, openRouter: openRouterPayload, inputHash };

  const modelStarted = Date.now();
  const output = await runCapture(payload, captureCtx);
  const modelMs = Date.now() - modelStarted;

  const label = purpose === "labelToNutrients" ? (output as LabelNutrients) : null;
  // 2026-10-03: no clearly visible panel means the name and numbers are filler — never a draft.
  // Same code and copy as a reply we cannot use (lib/ai/capture.ts), so the client shows its
  // existing "Nothing came back to check." line.
  if (label?.labelReadable === false) {
    throw new HttpError(422, "schema_invalid", "The model returned a shape we do not accept.");
  }
  const parsed = itemsFromOutput(label, output);

  // T0 §4: every item is grounded at the same time, and `Promise.all` preserves the model's
  // order, so what the user reads on the confirm sheet is still the order the model said it in.
  const groundStarted = Date.now();
  const profile = await loadUserProfile(client);
  const results = await Promise.all(parsed.items.map(
    (item) => groundItem(client, userId, item, label, profile, searchFoods)
      .catch((error: unknown) => ungroundable(item, error))));
  const groundMs = Date.now() - groundStarted;
  const grounded: GroundedItem[] = results.map((r) => r.grounded);
  const verdicts: PolicyVerdict[] = results.map((r) => r.verdict);

  const notes = capNotes(state);
  const draftId = draftIdFor(req);
  // itemsFromOutput makes exactly one item for a label capture (its own one-item envelope), so
  // results[0] is always the ground of THIS label when one exists.
  const labelFood = labelFoodOf(label, profile, results[0]?.storedEvidence,
    results[0]?.checkedAllergens, results[0]?.allergenTags, results[0]?.ingredientsUnread === true);
  const { deterministicSanity } = await import("@/lib/log/sanity");
  // Every draft from this path is the capture model's read (C8): the label says AI read it.
  const draft = buildDraft(parsed, grounded, verdicts, {
    draftId, method: req.method, spend: { usedToday, softCap: soft }, notes,
    // The two hops only the server can time (T0 §1). The client stores them in the same run as
    // its own marks; `ai_calls.latency_ms` stays the provider-side truth.
    timings: { model: modelMs, ground: groundMs },
    ...(labelFood ? { labelFood } : {}),
  }, deterministicSanity);
  // Task t2c: a new food on the draft gets the coach's role advice; a failure is no advice.
  const advice = await (deps.adviseRoles
    ?? ((ids) => adviseDraftFoodRoles(client, userId, ids)))(draft.items.map((item) => item.foodRefId))
    .catch(() => new Map<string, MealComponentRoleAdvice>());
  const items = advice.size === 0 ? draft.items : draft.items.map((item) => {
    const roleAdvice = item.foodRefId ? advice.get(item.foodRefId) : undefined;
    return roleAdvice ? { ...item, roleAdvice } : item;
  });
  return { ...draft, items, provenance: byModel(purpose) };
}
