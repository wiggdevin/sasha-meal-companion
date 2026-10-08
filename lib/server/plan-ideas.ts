import "server-only";
/**
 * POST /api/plan/ideas: one Plan-sheet chip, answered by code (owner direction 2026-10-08). No
 * coach turn, no intent classification, no Gemini or other generative model. The cards come from
 * `suggestOptions` over the account's admitted pool — the same plate engine and the same pool
 * Today's layout uses: a closed account's currently eligible Eats (`eligibleFoods`, inside the v2
 * snapshot) with its v2 evidence, an open account's fresh admission read (`openWorldInputs`).
 *
 * Jev may rank the cards (lib/coach/suggest.ts: one call, only with 5+ Jev-eligible plates, only
 * plates of bundled universe foods, W10 acceptance 3), under a hard JEV_DEADLINE_MS; past it, or
 * on any Jev failure, the cards keep their formula order. Jev only orders admitted plates: it is
 * never on the allergen, Avoid or diet-rule path and never sets a number.
 *
 * Every read starts at once and in parallel; the build itself is pure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { suggestOptions, type SuggestPorts, type SuggestionResult } from "@/lib/coach/suggest";
import type { PoolInputs } from "@/lib/coach/suggest-pool";
import { isIanaTimeZone } from "@/lib/health/contract";
import type { Food } from "@/lib/foods";
import { mealEvidence, type LocalRefs } from "@/lib/meals/snapshot";
import { chipInput, type PlanIdeasRequest, type PlanIdeasResponse } from "@/lib/plan/chips";
import { BY_APP, byJev } from "@/lib/provenance";
import { getRuleReviewStatus } from "@/lib/server/constraints";
import { suggestionTarget } from "@/lib/server/coach-ports";
import { composePoolPorts } from "@/lib/server/compose-pool-ports";
import { foodsFor, userFoodRefIds } from "@/lib/server/day-context";
import { mealSnapshotV3 } from "@/lib/server/meal-snapshot-v3";
import type { SnapshotResponse } from "@/lib/server/meal-snapshot";
import type { MealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import { readOnHand } from "@/lib/server/plan-on-hand";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import { viewedDay } from "@/lib/server/viewed-day";

/**
 * The Jev ranking's hard bound. The reads before it take ~300-600 ms on a warm function; 450 ms
 * keeps the chip near the 1 s server target. A late answer is dropped, not applied later: a
 * re-rank after the cards render would move a card under the person's thumb.
 */
export const JEV_DEADLINE_MS = 450;

export type PlanIdeasDeps = {
  /** Tests: the Jev port (lib/coach/suggest-rank.ts `JevPort`). */
  systemOne?: Parameters<typeof suggestOptions>[1]["systemOne"];
  /** Tests: universe pool ids → catalog refs; defaults to lib/server/universe-refs.ts. */
  universeRefs?: SuggestPorts["universeRefs"];
  now?: Date;
};

export async function planIdeas(client: SupabaseClient, admin: SupabaseClient, userId: string,
  request: PlanIdeasRequest, deps: PlanIdeasDeps = {}): Promise<PlanIdeasResponse> {
  const startedAt = Date.now();
  const now = deps.now ?? new Date();
  const zone = isIanaTimeZone(request.zone) ? request.zone : "UTC";
  const clock = { tz: zone, date: request.date, now: now.toISOString() };
  const input = chipInput(request);
  // Start every read now; the build awaits each one where it needs it.
  const day = viewedDay(admin, userId, clock, input.slot);
  const settle = <T>(promise: Promise<T>) => { promise.catch(() => undefined); return promise; };
  const target = settle(suggestionTarget(admin, userId, input, clock, day.viewed));
  const snapshot = settle(mealSnapshotV3(client, userId, now));
  const foods = settle(foodsFor(admin, userId));
  const refs = settle(userFoodRefIds(admin, userId));
  const profile = settle(readPolicyProfile(client, userId, now).then((read) => read.profile));
  const review = settle(getRuleReviewStatus(client, userId).then((status) => status.required));
  const onHand = request.chip === "on_hand"
    ? settle(readOnHand(client, userId, { date: request.date, zone }, request.stated ?? []))
    : Promise.resolve([]);
  const pool = settle((async (): Promise<PoolInputs> => {
    const [body, own, ids] = await Promise.all([snapshot, foods, refs]);
    if ("world" in body && body.world === "open") {
      const { openWorldInputs } = await import("@/lib/meals/open-world");
      return openWorldInputs(body as MealSnapshotV3, own);
    }
    const closedBody = body as SnapshotResponse;
    const eligible = new Set(closedBody.eligible.eligibleFoodIds);
    const closed: Record<string, Food> = Object.fromEntries(Object.entries(own)
      .filter(([id]) => eligible.has(id)));
    const local: LocalRefs = Object.fromEntries(Object.entries(ids).map(([id, ref]) => [id, { userRefId: ref }]));
    return { foods: closed, evidence: mealEvidence(closedBody, closed, local) };
  })());
  // Universe foods resolve to the account's real catalog refs (lib/server/universe-refs.ts), so an
  // open account's universe cards can be placed.
  const { focus, universeRefs } = composePoolPorts(client, admin, clock.now, clock.date);
  const focusRead = settle(focus ? focus(userId) : Promise.resolve(undefined));

  const result: SuggestionResult = await suggestOptions(input, {
    userId,
    profile: await profile,
    target: () => target,
    // A chip never searches the catalog: the pool is the whole build.
    searchFoods: async () => [],
    ideasPool: () => pool,
    poolRefs: () => refs,
    onHand: () => onHand,
    focus: () => focusRead,
    ruleReviewRequired: () => review,
    slotClock: day.slotClock,
    timeOfDay: day.timeOfDay,
    jevDeadlineMs: JEV_DEADLINE_MS,
    ...(deps.systemOne ? { systemOne: deps.systemOne } : {}),
    ...((deps.universeRefs ?? universeRefs) ? { universeRefs: deps.universeRefs ?? universeRefs } : {}),
  });
  const cards = [...result];
  const jevRanked = cards.some((card) => card.provenance?.source === "jev");
  return {
    cards, chip: request.chip, provenance: jevRanked ? byJev("suggest-options") : BY_APP,
    serverMs: Date.now() - startedAt,
    ...(result.message ? { message: result.message } : {}),
    ...(result.offer ? { offer: result.offer } : {}),
    ...(request.chip === "quick15" ? { minutesSource: "engine" as const } : {}),
  };
}
