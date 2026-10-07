/** The single log-entry writer. Commit and sync both reach log_items through apply_sync_op, so
 * snapshots cannot diverge. Its deterministic op_id makes replays return the stored entry. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { issuesFrom, logCommitRequestSchema, opIdFor, unknownMassRefIssues, type LogCommitFailure, type LogCommitRequest, type LogCommitResponse } from "@/lib/log/contract";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { dayTotals } from "@/lib/server/day-totals";
import { commitLabelFood, labelFoodOrFailure, type LabelFoodInput } from "@/lib/server/log-label-food";
import { evidenceForItems } from "@/lib/server/log-evidence";
import { recordFingerprint } from "@/lib/server/log-duplicates";
import { partialRecipeItems } from "@/lib/server/log-recipe-coverage";
import { stampLogOccasionsSafely } from "@/lib/server/log-occasion";
import { deleteMedia, MEDIA_BUCKET } from "@/lib/server/media";
import { loadSuggestionEvidence } from "@/lib/coach/suggest-policy";
import { logCommitPolicyIssues, RULES_UNREADABLE_MESSAGE } from "@/lib/coach/log-policy";
import { normalizePreferenceFlags, type PreferenceFlag } from "@/lib/profile/onboarding-state";
import { getProfile } from "@/lib/server/constraints";
import { readPolicyProfile } from "@/lib/server/policy-profile";
type OpResult = { status: string; rev?: number; current_rev?: number; current?: Record<string, unknown>; deleted_at?: string };

/** Every food_ref the items name must exist and be visible to this caller. */
async function unknownRefIssues(client: SupabaseClient, req: LogCommitRequest) {
  const ids = [...new Set(req.items.map((i) => i.food_ref_id))];
  const { data, error } = await client.from("food_refs").select("id, kind").in("id", ids);
  if (error) throw error;
  const kinds = new Map((data ?? []).map((r) => [r.id as string, r.kind as string | undefined]));
  return [
    ...req.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !kinds.has(item.food_ref_id))
      .map(({ index }) => ({ path: `items.${index}.food_ref_id`, message: "unknown food_ref_id" })),
    // t17 round 3: null grams and per_unit only on the account's own food (SQL trigger twin).
    // An unknown ref is already refused above; it is not reported twice.
    ...unknownMassRefIssues(req.items,
      (id) => (kinds.has(id) ? kinds.get(id) ?? "unknown" : "user")),
  ];
}

/** A draft item pinned to a revision that is no longer active is refused, never silently moved. */
async function staleRevision(client: SupabaseClient, req: LogCommitRequest) {
  const pinned = req.items.filter((i) => i.food_revision_id != null);
  if (pinned.length === 0) return null;
  const { data, error } = await client.from("catalog_food_revisions")
    .select("id, is_active").in("id", pinned.map((i) => i.food_revision_id as number));
  if (error) throw error;
  const active = new Set((data ?? []).filter((r) => r.is_active).map((r) => r.id as number));
  const bad = pinned.find((i) => !active.has(i.food_revision_id as number));
  return bad
    ? { status: "stale_revision" as const, food_ref_id: bad.food_ref_id,
        revision_id: bad.food_revision_id as number }
    : null;
}

function opFor(userId: string, req: LogCommitRequest) {
  return {
    op_id: opIdFor(req.entry_id, req.base_rev),
    entity: "log_entries",
    entity_id: req.entry_id.toLowerCase(),
    kind: req.base_rev === undefined ? "create" : "update",
    base_rev: req.base_rev ?? null,
    client_ts: new Date().toISOString(),
    payload: {
      ...(req.title !== undefined ? { title: req.title } : {}),
      note: req.note ?? null, media_ref: null,
      eaten_at: req.eaten_at, tz: req.tz,
      local_date: req.local_date, slot: req.slot, method: req.method,
      items: req.items.map((i) => ({ id: i.id, seq: i.seq, qty: i.qty, unit: i.unit,
        food_ref_id: i.food_ref_id, grams: i.grams, snapshot: null,
        // Unknown mass (t17): the SQL multiplies these per-unit numbers by qty.
        ...(i.grams === null ? { per_unit: i.per_unit ?? null } : {}),
        food_revision_id: i.food_revision_id ?? null, portion_id: i.portion_id ?? null,
        was_edited: i.was_edited ?? false, confidence: i.confidence ?? null })),
    },
  };
}

/** The stored items, whole. The client mirrors this reply verbatim (T0 §3), so every editable
 * field must return rather than leaving a row the next POST cannot identify. */
async function storedItems(client: SupabaseClient, entryId: string) {
  const { data, error } = await client.from("log_items")
    .select("id, entry_id, seq, food_ref_id, qty, unit, grams, portion_id, food_revision_id, was_edited, confidence, snapshot, nutrition_partial")
    .eq("entry_id", entryId).order("seq", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string, entry_id: r.entry_id as string, seq: Number(r.seq),
    food_ref_id: r.food_ref_id as string, qty: Number(r.qty), unit: r.unit as string,
    // null is an unknown mass (t17) and stays null: Number(null) would read it as 0.
    grams: r.grams === null || r.grams === undefined ? null : Number(r.grams),
    portion_id: (r.portion_id ?? null) as number | null,
    food_revision_id: (r.food_revision_id ?? null) as number | null,
    was_edited: Boolean(r.was_edited),
    confidence: (r.confidence ?? null) as number | null,
    snapshot: (r.snapshot ?? {}) as Snapshot,
    nutrition_partial: typeof r.nutrition_partial === "boolean" ? r.nutrition_partial : null,
  }));
}

async function ok(
  client: SupabaseClient, userId: string, req: LogCommitRequest, rev: number
): Promise<LogCommitResponse> {
  const items = await storedItems(client, req.entry_id);
  // #21: a saved recipe with unmeasured ingredients is recorded, and named as a partial count.
  const partial = await partialRecipeItems(client, items, userId);
  return { status: "ok", entry_id: req.entry_id, rev, items,
    totals: await dayTotals(client, userId, req.local_date),
    ...(partial.marks.length > 0 ? { partial_nutrition: partial.marks } : {}),
    ...(partial.unchecked ? { nutrition_unchecked: true as const } : {}) };
}

/**
 * Our media copy, gone within a second of the tap (AC8). The path is DERIVED — draft_id is the
 * object's uuid — so no media_ref travels on the wire and nothing from the body is trusted as a
 * capability. A failure here is logged, never thrown: the 24-hour sweep is the backstop, and a
 * saved meal must not report failure because a file lingered.
 */
async function deleteCommittedMedia(
  admin: SupabaseClient, userId: string, entryId: string, draftId: string | undefined
): Promise<void> {
  try {
    const paths = new Set<string>();
    const byEntry = await admin.from("media_objects").select("path")
      .eq("user_id", userId).eq("entry_id", entryId);
    if (byEntry.error) {
      console.error("media_objects lookup by entry_id failed", { entry_id: entryId, error: byEntry.error });
    }
    for (const row of (byEntry.data ?? []) as { path: string }[]) paths.add(row.path);
    if (draftId) {
      const byDraft = await admin.from("media_objects").select("path")
        .eq("user_id", userId).like("path", `${MEDIA_BUCKET}/${userId}/${draftId}.%`);
      if (byDraft.error) {
        console.error("media_objects lookup by draft_id failed",
          { entry_id: entryId, draft_id: draftId, error: byDraft.error });
      }
      for (const row of (byDraft.data ?? []) as { path: string }[]) paths.add(row.path);
    }
    // One failed removal must not keep the others: it stays live and the daily sweep retries it.
    for (const path of paths) {
      try { await deleteMedia(admin, path); } catch { /* logged by deleteMedia */ }
    }
  } catch (e) {
    console.error("media delete after commit failed", { entry_id: entryId, error: e });
  }
}

/**
 * The caller's constraint_profiles row plus its confirmed dietary-profile hard rules, through RLS
 * (lib/server/policy-profile.ts — the same one read every other policy call site uses).
 *
 * Owner ruling (2026-10-02): a failed read fails CLOSED, not open — `profileRules` stays
 * unreadable rather than silently answering "this account has no hard rules," the same reasoning
 * aed3c8e already applied to the live reply check. Logging itself still never refuses (only marks:
 * docs/decisions/2026-09-14-logging-marks-never-refuses.md), so the commit still writes; every
 * item just gets its own unverified mark instead of one silently skipping the rule entirely.
 */
async function loadCallerProfile(
  client: SupabaseClient, userId: string,
): Promise<{ profile: ConstraintProfile; profileRulesReadable: boolean }> {
  try {
    const { profile } = await readPolicyProfile(client, userId, new Date());
    return { profile, profileRulesReadable: true };
  } catch (error) {
    console.warn("[server-log] policy profile unreadable; profile rules fail safe", { error });
    const { profile } = await getProfile(client, userId);
    return { profile, profileRulesReadable: false };
  }
}

/**
 * `null` means the read failed (a thrown exception, or an `error` the old code silently ignored
 * while still reading `data` off the same response) — never conflated with "this account has no
 * diet preferences," which is what an empty array used to mean either way. Owner ruling
 * (2026-10-02): a diet preference flag (halal/kosher/vegan/etc.) fails safe, so its caller must be
 * able to tell "none" from "could not read."
 */
async function loadCallerPreferenceFlags(client: SupabaseClient): Promise<readonly PreferenceFlag[] | null> {
  try {
    const { data, error } = await client.from("user_settings").select("diet_prefs").maybeSingle();
    if (error) return null;
    const raw = (data as { diet_prefs?: { flags?: unknown } } | null)?.diet_prefs?.flags;
    // A stored value that is not a list of strings ({ "flags": "halal" }) cannot prove the account
    // has no flags: unreadable, not empty (Grok audit round 9).
    if (raw !== undefined && raw !== null
      && (!Array.isArray(raw) || raw.some((flag) => typeof flag !== "string"))) return null;
    return normalizePreferenceFlags(Array.isArray(raw) ? raw : []);
  } catch { return null; }
}

/**
 * One `flagged` entry per blocked item, plus one per allergen an item is `unverified` for that a
 * label check would resolve (sol FIX, review round 2 — §5's "shows a 'Check the label' mark"
 * applies here too, not only to the coach's own log actions). Logging still writes and every
 * commit rechecks policy.
 */
async function policyIssues(
  client: SupabaseClient, userId: string, req: LogCommitRequest, label: LabelFoodInput | null
): Promise<{ path: string; message: string }[]> {
  const { profile, profileRulesReadable } = await loadCallerProfile(client, userId);
  const evidence = await evidenceForItems(client, req.items, label);
  const facetEvidence = await loadSuggestionEvidence(userId, req.items.map((item) => ({
    name: "",
    foodRefId: item.food_ref_id,
    catalogFoodRevisionId: item.food_revision_id ?? null,
    grams: item.grams,
    kcalPer100g: null,
    proteinPer100g: null,
    carbsPer100g: null,
    fatPer100g: null,
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    verdict: "unverified" as const,
    // Phase 13 §4, §9 R5: the confirmed profile rules' own facets, read from the cache alongside
    // everything else this turn needs — never a fresh model call (same as suggest/compose).
  })), { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) });
  const fallbackFlags = facetEvidence.status === "ready"
    ? [] : await loadCallerPreferenceFlags(client);
  const baseEvidence = facetEvidence.status === "ready"
    ? evidence : evidence.map((item) => ({ ...item, preferenceFlags: fallbackFlags ?? [] }));
  const issues = logCommitPolicyIssues(profile, req.items, baseEvidence, facetEvidence);
  const unreadable: { path: string; message: string }[] = [];
  // Owner ruling (2026-10-02): a preference-flags read that failed cannot stand in for "this
  // account has none" — judging with [] above would silently pass a food whose real flags (say,
  // no_soy) could not be read at all. Every item gets its own unverified notice on top of
  // whatever the evaluation above already found.
  // Phase 18 W2a: logCommitPolicyIssues already marks every non-blocked item when the evidence
  // read failed; a blocked item gets the mark here too when its flags were also unreadable.
  if (facetEvidence.status !== "ready" && fallbackFlags === null) {
    unreadable.push(...req.items.map((_, index) => ({
      path: `items.${index}`, message: RULES_UNREADABLE_MESSAGE,
    })).filter((mark) => !issues.some((issue) => issue.path === mark.path
      && issue.message === mark.message)));
  }
  // Same ruling for the profile hard rules themselves: a failed readPolicyProfile must not read
  // as "this account has none" either.
  if (!profileRulesReadable) {
    unreadable.push(...req.items.map((_, index) => ({
      path: `items.${index}`,
      message: "unverified:profile_rules:Your account's food rules could not be checked.",
    })));
  }
  return [...issues, ...unreadable];
}

/**
 * Validates the label_food body, then runs the constraint policy against it.
 *
 * A malformed label is still a refusal — nothing can be written from it. A BLOCKED item is not:
 * since 2026-09-14 the log marks rather than refuses, so the policy's verdict rides back as
 * `flagged` and the entry is recorded (docs/decisions/2026-09-14-logging-marks-never-refuses.md).
 * The check still runs server-side on every item, which is what W3-10 asked for; what changed is
 * that its answer informs the record instead of discarding it.
 */
async function checkLabelAndPolicy(
  client: SupabaseClient, userId: string, req: LogCommitRequest, labelFoodBody: unknown
): Promise<
  { label: LabelFoodInput | null; flagged: { path: string; message: string }[] } | LogCommitFailure
> {
  const labelCheck = labelFoodOrFailure(req, labelFoodBody);
  if ("status" in labelCheck) return labelCheck;
  const flagged = await policyIssues(client, userId, req, labelCheck.label);
  return { ...labelCheck, flagged };
}

export async function applyLogEntry(
  client: SupabaseClient, userId: string, body: unknown,
  extras: { admin?: SupabaseClient; labelFood?: unknown } = {}
): Promise<LogCommitResponse | LogCommitFailure> {
  const parsed = logCommitRequestSchema.safeParse(body);
  if (!parsed.success) return { status: "invalid", issues: issuesFrom(parsed.error) };
  const req = parsed.data;

  const labelCheck = await checkLabelAndPolicy(client, userId, req, extras.labelFood);
  if ("status" in labelCheck) return labelCheck;
  const flagged = labelCheck.flagged;

  const labelResult = await commitLabelFood(client, userId, req, labelCheck.label);
  const userFoodId = labelResult.userFoodId;

  const issues = await unknownRefIssues(client, req);
  if (issues.length > 0) return { status: "invalid", issues };

  const stale = await staleRevision(client, req);
  if (stale) return stale;

  const { data, error } = await client.rpc("apply_sync_op",
    { p_user_id: userId, p_op: opFor(userId, req) });
  if (error) throw error;
  const result = data as OpResult;

  if (result.status === "applied") {
    await recordFingerprint(client, userId, req);
    // D1: the occasion is the server's, from the slot's clock on that date; no client sends it.
    // Only an applied write is stamped (never a replay, conflict or refusal).
    await stampLogOccasionsSafely(client, userId, { ids: [req.entry_id] });
    await deleteCommittedMedia(extras.admin ?? client, userId, req.entry_id, req.draft_id);
    const response = await ok(client, userId, req, result.rev as number);
    const withFood = userFoodId ? { ...response, user_food_id: userFoodId } : response;
    return flagged.length > 0 ? { ...withFood, flagged } : withFood;
  }
  if (result.status === "duplicate") {
    const { data: row, error: readError } = await client.from("log_entries")
      .select("rev").eq("id", req.entry_id).maybeSingle();
    if (readError) throw readError;
    if (!row) return { status: "gone" };
    // A retry keeps its marks, judged from the STORED items — never the retry body, which may differ.
    const response = await ok(client, userId, req, Number(row.rev));
    const stored = await policyIssues(client, userId, { ...req, items: response.items
      .map((i) => ({ ...i, confidence: i.confidence ?? undefined })) }, null);
    return stored.length > 0 ? { ...response, flagged: stored } : response;
  }
  if (result.status === "conflict") {
    return { status: "conflict", current_rev: result.current_rev as number,
      entity: (result.current ?? {}) as Record<string, unknown> };
  }
  if (result.status === "deleted") {
    return { status: "deleted", deleted_at: result.deleted_at as string };
  }
  if (result.status === "gone") return { status: "gone" };
  return { status: "invalid", issues: [{ path: "entry_id", message: `sync refused the op: ${result.status}` }] };
}
