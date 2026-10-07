/**
 * The resolution order of the Phase 3 spec's "API changes", in one place:
 *
 *   normalise to GTIN-14 and verify the check digit  → 400 invalid_gtin
 *   catalog_barcodes hit                             → return, cached: true, no network
 *   catalog_barcode_lookups 'miss' younger than 7 d  → not_found, no network
 *   OFF → FDC Branded → write → return               → cached: false
 *   both providers failed and nothing cached         → 503 upstream_unavailable
 *
 * A hit older than 90 days is served immediately and flagged for the NEXT request (architecture
 * §7.3) — the refresh never runs on the hot path. `status: 'not_found'` is a 200, because "we do
 * not know this barcode" is an answer, not an error, and a provider failure after a cache hit is
 * invisible to them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BarcodeMatch, BarcodeRequest, BarcodeResponse } from "@/lib/barcode/client";
import { normalizeGtin } from "@/lib/barcode/gtin";
import { fetchFdcBranded } from "@/lib/catalog/fdc";
import { fdcBrandedToRevision } from "@/lib/catalog/fdc-map";
import { fetchOffProduct, isProviderFailure } from "@/lib/catalog/off";
import { offToRevision, type RevisionDraft } from "@/lib/catalog/off-map";
import { completenessText } from "@/lib/foods/catalog-ingredients";
import { evaluatePolicy, loadProfile, type ConstraintProfile } from "@/lib/policy/constraints";
import { HttpError } from "@/lib/server/auth";
import { attributionFor, type CatalogSource } from "@/lib/server/catalog";
import { policyEvidence, scannedAllergenFacts, scannedAllergenTags } from "@/lib/server/barcode-policy";
import { writeProviderRevision } from "@/lib/server/catalog-writer";

export const NEGATIVE_CACHE_DAYS = 7;
/**
 * T0 §4: OFF goes first and alone for three seconds. It is the better source for a grocery
 * barcode, so it keeps its precedence; the head start is what caps the cost of its silence —
 * before this, a cold product paid OFF's whole timeout before FDC was even asked.
 */
export const OFF_HEAD_START_MS = 3_000;
export const REFRESH_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;
const QUALITY_RANK: Record<string, number> = { analytical: 0, survey: 1, label: 2, crowd: 3 };

export type ProviderDeps = {
  fetchOff?: typeof fetchOffProduct;
  fetchFdc?: typeof fetchFdcBranded;
  now?: () => Date;
  /** The 20/min outbound budget. Awaited immediately before the first provider call. */
  onOutbound?: () => Promise<void>;
  /** Fire-and-forget: the refresh is the NEXT request's job, never this one's. */
  scheduleRefresh?: (gtin14: string) => void;
};

const REVISION_SELECT = `
  id, catalog_food_id, description, brand, category, policy_categories, quality_class, quality_flags,
  catalog_versions!inner ( version_label, imported_at ),
  catalog_food_nutrients ( nutrient_code, amount_per_100g ),
  catalog_portions ( id, description, gram_weight, is_default, seq ),
  catalog_ingredients ( seq, name, allergen_tags, raw_text )`;

type RevisionRow = {
  id: number; catalog_food_id: number; description: string; brand: string | null;
  category: string | null; policy_categories: string[] | null;
  quality_class: BarcodeMatch["qualityClass"]; quality_flags: string[];
  catalog_versions: { version_label: string; imported_at: string };
  catalog_food_nutrients: { nutrient_code: string; amount_per_100g: number | null }[];
  catalog_portions: { id: number; description: string; gram_weight: number; is_default: boolean; seq: number }[];
  catalog_ingredients: { seq: number; name: string; allergen_tags: string[] | null; raw_text: string | null }[];
};

type BarcodeRow = { catalog_food_id: number; source: CatalogSource; published_at: string | null };

async function loadProfileFor(client: SupabaseClient, userId: string): Promise<ConstraintProfile> {
  const { data, error } = await client.from("constraint_profiles")
    .select("avoid_allergens, avoid_food_ref_ids, banned_categories, conditions, custom_rules").eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(500, "policy_failed", "Your food rules could not be read.");
  return loadProfile(data as Partial<ConstraintProfile> | null);
}

async function foodRefFor(client: SupabaseClient, userId: string, catalogFoodId: number): Promise<string> {
  const { data, error } = await client.rpc("get_or_create_food_ref", {
    p_user_id: userId, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
  });
  if (error || typeof data !== "string") {
    throw new HttpError(500, "food_ref_failed", "That product could not be prepared for logging.");
  }
  return data;
}

/** Their own mark on this ref, or null. Both halves matter now: `avoid` blocks, `eats` verifies. */
async function prefStatusFor(
  client: SupabaseClient, userId: string, foodRefId: string
): Promise<"eats" | "avoid" | null> {
  const { data } = await client.from("user_food_prefs").select("status")
    .eq("user_id", userId).eq("food_ref_id", foodRefId).maybeSingle();
  const status = (data as { status?: string } | null)?.status;
  return status === "eats" || status === "avoid" ? status : null;
}

async function toMatch(
  client: SupabaseClient, userId: string, profile: ConstraintProfile,
  row: RevisionRow, source: CatalogSource
): Promise<BarcodeMatch> {
  const per100g: Record<string, number | null> = {};
  for (const n of row.catalog_food_nutrients ?? []) per100g[n.nutrient_code] = n.amount_per_100g;
  const ingredients = [...(row.catalog_ingredients ?? [])].sort((a, b) => a.seq - b.seq);
  const allergenTags = scannedAllergenTags(ingredients, profile.avoid_allergens);
  // finding #2: scannedAllergenFacts needs only the revision id, the profile and the ingredients
  // already in hand here, so it runs alongside foodRefFor rather than behind the ref→pref chain.
  // finding #5/round-7: completenessText, not a raw seq>=1 join; its `verbatim` flag says whether
  // the text is genuinely the single printed statement, never a fallback join.
  const list = completenessText(ingredients.filter((i) => i.seq >= 1));
  const [foodRefId, facts] = await Promise.all([
    foodRefFor(client, userId, row.catalog_food_id),
    scannedAllergenFacts(client, userId, profile, row.id, list.text, allergenTags, list.verbatim),
  ]);
  const prefStatus = await prefStatusFor(client, userId, foodRefId);
  const evidence = policyEvidence({
    foodRefId, prefStatus, description: row.description, category: row.category,
    policyCategories: row.policy_categories, qualityFlags: row.quality_flags ?? [],
    ingredientCount: ingredients.length, allergenTags,
  });
  return {
    foodRefId, catalogFoodId: row.catalog_food_id, revisionId: row.id,
    description: row.description, brand: row.brand, source,
    qualityClass: row.quality_class, qualityFlags: row.quality_flags ?? [], per100g,
    portions: [...(row.catalog_portions ?? [])].sort((a, b) => a.seq - b.seq).map((p) => ({
      id: p.id, description: p.description, gramWeight: Number(p.gram_weight), isDefault: p.is_default,
    })),
    ingredientsText: ingredients.find((i) => i.seq === 1)?.raw_text ?? null,
    allergenTags,
    attribution: attributionFor(source, row.catalog_versions.version_label),
    // finding #2 (2026-10-02 DeepSeek audit): foodBrand/packaged below, so a scan's own
    // whole-food check sees this row's real brand and is never cleared as a generic commodity.
    policy: evaluatePolicy(profile,
      { ...evidence, ...facts, foodName: row.description, foodBrand: row.brand, packaged: true }),
  };
}

/** §4.1: several catalog_barcodes rows for one GTIN rank by quality_class then published_at. */
function rank(a: { row: RevisionRow; at: string | null }, b: { row: RevisionRow; at: string | null }): number {
  const byQuality = QUALITY_RANK[a.row.quality_class] - QUALITY_RANK[b.row.quality_class];
  if (byQuality !== 0) return byQuality;
  return Date.parse(b.at ?? "") - Date.parse(a.at ?? "");
}

async function cachedMatches(
  client: SupabaseClient, userId: string, profile: ConstraintProfile, gtin14: string, now: Date
): Promise<{ matches: BarcodeMatch[]; stale: boolean }> {
  const { data: barcodeData } = await client.from("catalog_barcodes")
    .select("catalog_food_id, source, published_at").eq("gtin14", gtin14);
  const barcodes = (barcodeData ?? []) as BarcodeRow[];
  if (barcodes.length === 0) return { matches: [], stale: false };
  const { data: revisionData } = await client.from("catalog_food_revisions")
    .select(REVISION_SELECT)
    .in("catalog_food_id", barcodes.map((b) => b.catalog_food_id))
    .eq("is_active", true);
  const ids = new Set(barcodes.map((b) => b.catalog_food_id));
  const rows = ((revisionData ?? []) as unknown as RevisionRow[])
    .filter((r) => ids.has(r.catalog_food_id));
  const paired = rows
    .map((row) => {
      const barcode = barcodes.find((b) => b.catalog_food_id === row.catalog_food_id);
      return { row, at: barcode?.published_at ?? null, source: barcode?.source ?? "off" };
    })
    .sort(rank)
    .slice(0, 3);
  const stale = paired.some(
    (p) => now.getTime() - Date.parse(p.row.catalog_versions.imported_at) > REFRESH_AFTER_DAYS * DAY_MS
  );
  // T0 §4: up to three matches, each with its own ref and pref read — one round trip's worth of
  // wall clock instead of three. `Promise.all` keeps the ranked order.
  const matches = await Promise.all(
    paired.map((p) => toMatch(client, userId, profile, p.row, p.source)));
  return { matches, stale };
}

/** The one revision a write just produced, read by its own id. Null when the row is not there. */
async function matchForRevision(
  client: SupabaseClient, userId: string, profile: ConstraintProfile,
  revisionId: number, source: CatalogSource
): Promise<BarcodeMatch | null> {
  const { data } = await client.from("catalog_food_revisions")
    .select(REVISION_SELECT).eq("id", revisionId).maybeSingle();
  if (!data) return null;
  return toMatch(client, userId, profile, data as unknown as RevisionRow, source);
}

/**
 * The match built from the draft this request wrote, for the case where reading it back finds
 * nothing. It carries what the draft carries; the portions a provider draft has no ids for are
 * left out rather than invented, and the next scan serves the stored row with all of them.
 */
async function matchFromDraft(
  client: SupabaseClient, userId: string, profile: ConstraintProfile,
  draft: RevisionDraft, written: { catalogFoodId: number; revisionId: number; versionLabel: string },
  source: CatalogSource,
): Promise<BarcodeMatch> {
  const per100g: Record<string, number | null> = { ...(draft.per100g ?? {}) };
  const allergenTags = [...new Set(draft.ingredients?.flatMap((i) => i.allergenTags ?? []) ?? [])];
  // finding #2: same as toMatch — scannedAllergenFacts only needs the revision id this write just
  // produced, so it runs alongside foodRefFor rather than behind the ref→pref chain.
  const [foodRefId, facts] = await Promise.all([
    foodRefFor(client, userId, written.catalogFoodId),
    scannedAllergenFacts(client, userId, profile, written.revisionId,
      draft.ingredientsText ?? null, allergenTags),
  ]);
  const prefStatus = await prefStatusFor(client, userId, foodRefId);
  return {
    foodRefId, catalogFoodId: written.catalogFoodId, revisionId: written.revisionId,
    description: draft.description, brand: draft.brand ?? null, source,
    qualityClass: draft.qualityClass, qualityFlags: draft.qualityFlags ?? [], per100g,
    portions: [],
    ingredientsText: draft.ingredientsText,
    allergenTags,
    attribution: attributionFor(source, written.versionLabel),
    // The same evidence the read-back path builds, from the same function: a draft is a thinner
    // description of the product, never a more permissive one.
    policy: evaluatePolicy(profile, { ...policyEvidence({
      foodRefId, prefStatus, description: draft.description, category: draft.category,
      policyCategories: draft.policyCategories, qualityFlags: draft.qualityFlags ?? [],
      ingredientCount: draft.ingredients?.length ?? 0, allergenTags }), ...facts,
      foodName: draft.description, foodBrand: draft.brand ?? null, packaged: true }),
  };
}

type LookupRow = { status: string; attempts: number; last_fetched_at: string };

async function recordLookup(
  admin: SupabaseClient, gtin14: string, prior: LookupRow | null,
  status: "hit" | "miss" | "error", source: "off" | "fdc_branded" | null,
  httpStatus: number | null, now: Date
): Promise<void> {
  await admin.from("catalog_barcode_lookups").upsert({
    gtin14, status, source, http_status: httpStatus,
    attempts: (prior?.attempts ?? 0) + 1, last_fetched_at: now.toISOString(),
  });
}

/** A clean "not this one" (404, or a draft the mapper rejected) is a miss; anything else is an outage. */
function isOutage(status: number | "timeout" | null): boolean {
  return status !== null && status !== 404;
}

type Attempt =
  | { ok: true; source: "off" | "fdc_branded"; draft: RevisionDraft }
  | { ok: false; source: "off" | "fdc_branded"; status: number | "timeout" | null };

/** One provider in flight: its answer, and the handle that cancels it when it loses the race. */
type Running = { answer: Promise<Attempt>; cancel: () => void };

/** One provider, fetched and mapped, never rejecting: a failure is a value, not a throw. */
function attempt(
  source: "off" | "fdc_branded", gtin14: string, fetchedAt: string, deps: ProviderDeps
): Running {
  type Mapped =
    | { failure: number | "timeout" }
    | { mapped: RevisionDraft | { reject: string } };
  const controller = new AbortController();
  const call: Promise<Mapped> = source === "off"
    ? (deps.fetchOff ?? fetchOffProduct)(gtin14, { signal: controller.signal }).then((r) =>
        isProviderFailure(r) ? { failure: r.status } : { mapped: offToRevision(r, fetchedAt) })
    : (deps.fetchFdc ?? fetchFdcBranded)(gtin14, { signal: controller.signal }).then((r) =>
        isProviderFailure(r) ? { failure: r.status } : { mapped: fdcBrandedToRevision(r, fetchedAt) });
  const answer = call.then((r): Attempt => {
    if ("failure" in r) return { ok: false, source, status: r.failure };
    // A draft the mapper rejected is "not this one", the same answer as a 404.
    if ("reject" in r.mapped) return { ok: false, source, status: 404 };
    return { ok: true, source, draft: { ...r.mapped, sourceId: gtin14 } };
  }, (): Attempt => ({ ok: false, source, status: null }));
  return { answer, cancel: () => controller.abort() };
}

/** A cancellable wait, so a fast OFF answer does not hold the function open for the head start. */
function headStart(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return { done, cancel: () => clearTimeout(timer) };
}

/**
 * OFF alone for OFF_HEAD_START_MS; then both, first usable answer wins. OFF still wins a tie,
 * because it is still asked first and its answer is still preferred when both land.
 */
async function fetchDraft(
  gtin14: string, now: Date, deps: ProviderDeps
): Promise<{ source: "off" | "fdc_branded"; draft: RevisionDraft } | { failed: (number | "timeout" | null)[] }> {
  const fetchedAt = now.toISOString();
  const off = attempt("off", gtin14, fetchedAt, deps);

  const wait = headStart(OFF_HEAD_START_MS);
  const first = await Promise.race([off.answer, wait.done.then(() => null)]);
  wait.cancel();
  if (first?.ok) return { source: first.source, draft: first.draft };

  const fdc = attempt("fdc_branded", gtin14, fetchedAt, deps);
  if (first) {
    // OFF is already out; nothing left to race.
    const only = await fdc.answer;
    return only.ok
      ? { source: only.source, draft: only.draft }
      : { failed: [first.status, only.status] };
  }

  // OFF is still in flight past its head start: whichever answers usefully first wins, and the
  // one that did not is cancelled rather than left spending the outbound budget unwatched.
  const winner = await Promise.race([off.answer, fdc.answer]);
  if (winner.ok) {
    (winner.source === "off" ? fdc : off).cancel();
    return { source: winner.source, draft: winner.draft };
  }
  const loser = winner.source === "off" ? fdc : off;
  const other = await loser.answer;
  if (other.ok) return { source: other.source, draft: other.draft };
  // Keep the ledger's order OFF-then-FDC whichever way round they finished.
  const both = await Promise.all([off.answer, fdc.answer]);
  return { failed: both.map((a) => (a.ok ? null : a.status)) };
}

/**
 * The ledger row and the HTTP answer are two different questions. ANY outage makes the row an
 * 'error', so a provider timeout never negative-caches a not_found for 7 days; only an outage on
 * EVERY provider is a 503 — one provider's definitive 404 plus another's timeout still means we
 * simply do not know this barcode. Returns true when the caller must 503.
 */
async function recordFailure(
  admin: SupabaseClient, gtin14: string, prior: LookupRow | null,
  failed: (number | "timeout" | null)[], now: Date
): Promise<boolean> {
  const anyOutage = failed.some(isOutage);
  const allOutage = failed.length > 0 && failed.every(isOutage);
  await recordLookup(admin, gtin14, prior, anyOutage ? "error" : "miss", null,
    typeof failed[0] === "number" ? failed[0] : null, now);
  return allOutage;
}

export async function resolveBarcode(
  client: SupabaseClient, admin: SupabaseClient, userId: string,
  req: BarcodeRequest, deps: ProviderDeps = {}
): Promise<BarcodeResponse> {
  const gtin14 = normalizeGtin(req.gtin);
  if (gtin14 === null) throw new HttpError(400, "invalid_gtin", "That is not a barcode we can read.");
  const now = (deps.now ?? (() => new Date()))();
  const profile = await loadProfileFor(client, userId);

  const cached = await cachedMatches(client, userId, profile, gtin14, now);
  if (cached.matches.length > 0) {
    if (cached.stale) deps.scheduleRefresh?.(gtin14);
    return cached.matches.length === 1
      ? { status: "resolved", gtin14, cached: true, match: cached.matches[0] }
      : { status: "ambiguous", gtin14, cached: true, matches: cached.matches };
  }

  const { data: lookupData } = await client.from("catalog_barcode_lookups")
    .select("status, attempts, last_fetched_at").eq("gtin14", gtin14).maybeSingle();
  const prior = lookupData as LookupRow | null;
  const fresh = prior !== null &&
    now.getTime() - Date.parse(prior.last_fetched_at) < NEGATIVE_CACHE_DAYS * DAY_MS;
  if (prior?.status === "miss" && fresh) {
    return { status: "not_found", gtin14, searchHint: req.hint ?? {} };
  }

  await deps.onOutbound?.();
  const fetched = await fetchDraft(gtin14, now, deps);
  if ("failed" in fetched) {
    if (await recordFailure(admin, gtin14, prior, fetched.failed, now)) {
      throw new HttpError(503, "upstream_unavailable", "The food databases are not answering. Try again in a minute.");
    }
    return { status: "not_found", gtin14, searchHint: req.hint ?? {} };
  }

  const written = await writeProviderRevision(admin, fetched.source, gtin14, fetched.draft, userId);
  await recordLookup(admin, gtin14, prior, "hit", fetched.source, 200, now);
  // T0 §4: the match is built from the revision this request just wrote — one keyed read —
  // instead of sweeping catalog_barcodes and catalog_food_revisions all over again.
  const match = await matchForRevision(client, userId, profile, written.revisionId, fetched.source)
    // The write succeeded, so the product IS in hand; a read-back that finds nothing (a replica
    // that has not caught up, a row filtered out) is no reason to tell them the food databases are
    // down. The match is built from the draft this request just wrote, which is what the spec's
    // §4 asked for in the first place (Grok pass 2, LOW 19).
    ?? await matchFromDraft(client, userId, profile, fetched.draft, written, fetched.source);
  return { status: "resolved", gtin14, cached: false, match };
}

/**
 * The 90-day refresh (architecture §7.3). resolveBarcode flags a stale hit; this runs AFTER the
 * response, so the scan the user is waiting on never pays for it. It spends the same outbound budget as
 * a hot-path fetch and it never throws: a background refresh that fails leaves the stale row in
 * place, which is exactly what the caller already served.
 */
export async function refreshBarcode(
  admin: SupabaseClient, userId: string, gtin14: string, deps: ProviderDeps = {}
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    await deps.onOutbound?.();
    const fetched = await fetchDraft(gtin14, now, deps);
    if ("failed" in fetched) {
      await recordFailure(admin, gtin14, null, fetched.failed, now);
      return;
    }
    await writeProviderRevision(admin, fetched.source, gtin14, fetched.draft, userId);
    await recordLookup(admin, gtin14, null, "hit", fetched.source, 200, now);
  } catch {
    /* stale data stands; the next request flags it again */
  }
}
