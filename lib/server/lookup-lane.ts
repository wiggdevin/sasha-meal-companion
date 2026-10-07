/**
 * Phase 13 §3.3, §9 R8 (slice 6): the `lookup` coach tool's one server entry point.
 *
 * The pipeline, in order, and why each step comes before the next:
 *   1. `validateLookupSubject` (lib/coach/lookup-subject.ts) — the D0 gate. Rejects a name, a
 *      condition, a medical question or a stray number before any I/O at all.
 *   2. Catalog resolution — the same `searchFoods` port every coach tool grounds a food name
 *      against (lib/coach/ground.ts). The validated candidate must land on a real catalog
 *      revision, whose own name and brand are what the model sees; a user-authored food is never
 *      a subject, and free text that matches nothing in the catalog never reaches a search
 *      (§9 R8: "the lookup `subject` must resolve to a catalog product or a controlled
 *      brand/food field before any search").
 *   3. `generateGrounded` (lib/ai/gemini-grounded.ts) — the one Gemini call, `googleSearch`-
 *      grounded, on the lane's own 8 s budget (LANES.lookup.budgetMs), never the coach turn's
 *      retry policy, and cancelled by the turn's abort when the tool batch stops waiting first.
 *   4. `filterGroundedAnswer` (lib/ai/lookup-grounding.ts) — drops any numeric claim the model's
 *      own grounding metadata does not link to a source.
 *   5. `capLookupEvidence` (lib/policy/lookup-evidence.ts) — every answer, whatever it claims,
 *      caps out at `no_evidence`. Merged with stored evidence, a `listed` hard block never moves.
 *
 * A refusal at step 1 or 2 costs zero model calls and zero spend. A failure at step 3 (timeout,
 * spend cap, circuit open, provider error) is caught here and read back as the same "no fact
 * today" refusal — the reason itself is already in the `ai_calls` row `generateGrounded` wrote.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateGrounded } from "@/lib/ai/gemini-grounded";
import { lookupPayload } from "@/lib/ai/gemini-payloads";
import { LANES } from "@/lib/ai/lanes";
import { filterGroundedAnswer } from "@/lib/ai/lookup-grounding";
import type { FoodHit } from "@/lib/coach/executors";
import type { LookupToolResult } from "@/lib/coach/lookup-types";
import { validateLookupSubject, type LookupSubjectContext } from "@/lib/coach/lookup-subject";
import { capLookupEvidence } from "@/lib/policy/lookup-evidence";

export type { LookupToolResult } from "@/lib/coach/lookup-types";

export type LookupPorts = {
  searchFoods: (userId: string, query: string, limit: number) => Promise<FoodHit[]>;
};

type ResolvedSubject = { name: string; foodRefId: string | null; brand: string | null };

/**
 * One more than the top hit: the shared search puts an exact user-food match first
 * (lib/server/coach-ports.ts searchExactUserFood), so the catalog's own top hit is at most second.
 */
const RESOLVE_LIMIT = 2;

/**
 * The top CATALOG hit, or null. A user food (`catalogFoodRevisionId: null` — a custom or
 * label-scan row) is skipped whatever its name: its name and brand are the user's own text and
 * may carry health context, so they never become a search subject (review r1, sol BLOCK). Only a
 * catalog revision's own name and brand reach the model.
 */
async function resolveSubject(
  userId: string, subject: string, searchFoods: LookupPorts["searchFoods"],
): Promise<ResolvedSubject | null> {
  const hits = await searchFoods(userId, subject, RESOLVE_LIMIT);
  const hit = hits.find((row) => typeof row.catalogFoodRevisionId === "number");
  if (!hit) return null;
  return { name: hit.name, foodRefId: hit.foodRefId, brand: hit.brand };
}

export async function runLookup(
  admin: SupabaseClient,
  userId: string,
  subject: string,
  ports: LookupPorts,
  ctx: LookupSubjectContext = {},
  /** The coach turn's abort (review r1): the grounded call stops the moment the batch does. */
  opts: { signal?: AbortSignal } = {},
): Promise<LookupToolResult> {
  const rejection = validateLookupSubject(subject, ctx);
  if (rejection) return { ok: false, subject, refusal: rejection };

  const resolved = await resolveSubject(userId, subject, ports.searchFoods);
  if (!resolved) return { ok: false, subject, refusal: "unresolved" };

  try {
    const result = await generateGrounded({
      payload: lookupPayload(resolved.name), userId, admin, timeoutMs: LANES.lookup.budgetMs,
      signal: opts.signal,
    });
    const filtered = filterGroundedAnswer(result.text, result.groundingMetadata);
    return {
      ok: true, subject, resolvedName: resolved.name, foodRefId: resolved.foodRefId,
      brand: resolved.brand, answer: filtered.text, sources: filtered.sources,
      webSearchQueries: filtered.webSearchQueries, evidence: capLookupEvidence(),
    };
  } catch {
    return { ok: false, subject, refusal: "unavailable" };
  }
}
