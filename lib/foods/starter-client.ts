"use client";

import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { setFoodMembership } from "@/lib/foods/prefs-client";
import { loadStore, upsertFood } from "@/lib/store";
import type { Food } from "@/lib/foods";
import {
  STARTERS, starterExcludedByCurrentRules, starterFood, starterSelectionValid,
  type Starter, type StarterMark,
} from "@/lib/foods/starter";
import { loadConstraints, type Profile } from "@/lib/constraints-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import type { ProfileInstance } from "@/lib/policy/profiles/types";

type FreshRules = { profile: Profile; instances: readonly ProfileInstance[] };

export type StarterWriter = {
  existing: () => Record<string, Food>;
  mark: (food: Food, h: AccountHandle) => Promise<void>;
  save: (food: Food) => void;
  /**
   * Re-reads the account's constraints+profile-instances right now, independent of whatever the
   * caller's own `allowed` list was computed from a moment earlier. When this field IS configured
   * (every production path — see below) a `null` result (offline, account switch mid-await) fails
   * the whole write closed (GPT-6 Sol r1 BLOCK): falling back to the stale `allowed` list on a
   * failed read would reopen the exact gap this field exists to close. Optional on the TYPE only
   * so existing deps overrides (unit tests that stub out the whole write path) need not supply it
   * — omitting it is a test-only convenience that skips the recheck, never a production fallback.
   * `lib/foods/starter-seed.ts` does NOT omit it: its production call leaves `deps` undefined, so
   * `persistStarterSelection`'s own default parameter substitutes the full `writer` below
   * (freshRules included) — the auto-seed path is protected the same as the onboarding write path.
   * Only `lib/foods/starter-seed.test.ts` stubs `persist` itself, which bypasses
   * `persistStarterSelection` (and this recheck) entirely for that unit test.
   */
  freshRules?: (h: AccountHandle) => Promise<FreshRules | null>;
};

async function readFreshRules(h: AccountHandle): Promise<FreshRules | null> {
  try {
    const [constraints, profiles] = await Promise.all([
      loadConstraints({ account: h }), fetchProfileInstances(h),
    ]);
    if (!constraints) return null;
    return { profile: constraints.profile, instances: profiles.instances };
  } catch {
    return null;
  }
}

/**
 * ONB2-P0 (GOAL defect 6): `acknowledge` only buys an immediate server round trip for the
 * truncation flag the Foods sheet shows (`FOOD_MEMBERSHIP_TRUNCATED_MESSAGE`,
 * `components/MyFoods.tsx`) — nothing in this file's own write path (below) ever reads the
 * acknowledgement `deps.mark` returns. The membership op is queued (`enqueue`, local only) either
 * way, so skipping the RPC here does not change what reaches the server, only when: the queued op
 * rides the one sync pass every caller already runs right after this write (`flushOutboxNow` in
 * `ConversationalOnboarding.tsx`/`OnboardingFlow.tsx`/`lib/onboarding/save-plan.ts`), instead of a
 * second, redundant, serialized write per food on top of it.
 */
export const defaultStarterWriter: StarterWriter = {
  existing: () => loadStore().foods,
  mark: async (food, h) => {
    await setFoodMembership(food.name, food.status === "neutral" ? null : food.status,
      { food, account: h, acknowledge: false, note: food.note ?? null });
  },
  save: (food) => { upsertFood(food); },
  freshRules: readFreshRules,
};

const writer = defaultStarterWriter;

/** How many foods' membership writes (ref minting + the queued op) run at once. Bounded so a
 *  12-food pick-for-me run does not fire 12 concurrent ref-minting RPCs; high enough that the
 *  loop's wall time is driven by the slowest food, not the sum of all of them. */
const STARTER_WRITE_CONCURRENCY = 4;

/** Shared with `lib/onboarding/save-plan.ts`, which runs its own pre-write floor check against
 *  the same fresh rules this file's own recheck uses, before ever calling `persistStarterSelection`. */
export const STARTER_RULE_CHANGED_ERROR =
  "A rule just changed what's safe to eat — go back to Foods and choose again.";
export const STARTER_RULES_UNAVAILABLE_ERROR =
  "Couldn’t verify your food rules. Go back to Foods and retry.";

/** A reviewed onboarding choice. Neutral or filtered-out foods never become implied likes. */
export async function persistStarterSelection(
  marks: Readonly<Record<string, StarterMark>>,
  allowed: readonly Starter[],
  deps: StarterWriter = writer,
  kind: "reviewed" | "suggested" = "reviewed",
): Promise<number> {
  const selected = Object.entries(marks).filter(([, mark]) => mark === "eats").map(([id]) => id);
  if (!starterSelectionValid(selected, allowed)) throw new Error("Choose at least two foods in each group.");
  const allowedIds = new Set(allowed.map((item) => item.id));
  const knownIds = new Set(STARTERS.map((item) => item.id));
  const h = accountHandle();
  const RULE_CHANGED_ERROR = STARTER_RULE_CHANGED_ERROR;
  // ONB2-RULE-REREAD-WRITE (GPT-6 Sol r1/r2): narrows, but does NOT fully close, the gap between
  // the caller's own reread (which produced `allowed`) and this write. One fresh read, taken right
  // before the write loop below starts and reused for every item in it, catches a rule saved
  // between that reread and the start of THIS write — the window this task asked to close. It is
  // not a per-item atomic check against each individual write: no transaction spans this loop, so
  // a rule saved mid-loop, between two awaited `deps.mark` calls, is a residual gap this does not
  // close (Sol r2 WARN) and that predates this fix. Closing that one fully would need a rule
  // revision checked atomically with each write, which this layer has no way to do.
  // A `deps` override that omits `freshRules` (this file's own unit tests) skips the recheck
  // entirely rather than silently falling back to the real network call `writer` uses. Every
  // production caller — ConversationalOnboarding, OnboardingFlow, and starter-seed.ts's auto-seed
  // — leaves `deps` itself undefined, so the default parameter below substitutes the full
  // `writer` (freshRules included): the recheck-skip only ever happens inside a test.
  // A `freshRules` that IS configured but fails (offline, account switch mid-await) fails the
  // whole write closed — Sol r1 BLOCK: silently falling back to the stale `allowed` list on a
  // failed read would reopen the exact gap this fix exists to close.
  let fresh: { profile: Profile; instances: readonly ProfileInstance[] } | null = null;
  if (deps.freshRules) {
    fresh = await deps.freshRules(h);
    if (!fresh) throw new Error(STARTER_RULES_UNAVAILABLE_ERROR);
  }
  // `starterChoices` excludes every starter outright once `avoid_food_ref_ids` is non-empty (this
  // local catalog has no food-ref IDs, so an unresolved ID rule can't be waived by name) — the
  // fresh check has to honor that same all-or-nothing rule, not just the per-item allergen/
  // category/hard-rule predicate `starterExcludedByCurrentRules` covers (Sol r1 BLOCK).
  const freshBlocksEverything = fresh !== null && fresh.profile.avoid_food_ref_ids.length > 0;
  const freshExcluded = fresh === null ? null : new Set(
    STARTERS.filter((item) => freshBlocksEverything
      || starterExcludedByCurrentRules(item, fresh!.profile, fresh!.instances)).map((item) => item.id));
  // Revalidate the two-per-role floor against what the fresh snapshot actually still allows,
  // BEFORE writing anything — a selection that passed the stale `allowed` list a moment ago can
  // fail it now, and that must surface as one clean error, never a partial write (Sol r1 WARN).
  if (freshExcluded) {
    const stillSelected = selected.filter((id) => !freshExcluded.has(id));
    const stillAllowed = allowed.filter((item) => !freshExcluded.has(item.id));
    if (!starterSelectionValid(stillSelected, stillAllowed)) throw new Error(RULE_CHANGED_ERROR);
  }
  // ONB2-P0 (GOAL defect 6): decide what to write FIRST, off one snapshot of `deps.existing()`,
  // then run the actual writes in bounded-concurrency batches instead of one `await` per food in
  // series — the "one awaited server round trip per food" the live QA measured at 6-12 foods.
  // Each entry is a distinct starter id, so two entries never race the same row; the one
  // documented timing difference from the old strictly-sequential loop is that this snapshot of
  // `existing` cannot reflect a sibling write from elsewhere in THIS SAME call (it could never
  // reflect one from outside this call either — that race predates this change and is the same
  // residual gap the ONB2-RULE-REREAD-WRITE comment above already documents).
  const toWrite: Array<{ food: Food }> = [];
  for (const [id, mark] of Object.entries(marks)) {
    if (mark === "neutral" || !knownIds.has(id) || (mark === "eats" && !allowedIds.has(id))) continue;
    if (mark === "eats" && freshExcluded?.has(id)) continue;
    const food = { ...starterFood(id, mark),
      ...(kind === "suggested" ? { note: "Starter suggestion — review this food" } : {}) };
    const existing = Object.values(deps.existing()).find((item) =>
      item.id === food.id || item.name.toLowerCase() === food.name.toLowerCase());
    if (existing?.status === mark) continue;
    // Auto-seeding preserves any prior choice; a fresh reviewed tap takes precedence.
    if (kind === "suggested" && existing && existing.status !== "neutral") continue;
    const intended = kind === "suggested" && existing
      ? { ...food, note: existing.note } : food;
    toWrite.push({ food: intended });
  }
  let written = 0;
  for (let i = 0; i < toWrite.length; i += STARTER_WRITE_CONCURRENCY) {
    const batch = toWrite.slice(i, i + STARTER_WRITE_CONCURRENCY);
    // A rejection from one item surfaces (and stops the NEXT batch from starting) only after
    // every item already in flight in this batch settles — same non-atomic-loop caveat as before,
    // now scoped to a batch instead of one item.
    // allSettled, not all (final Sol review BLOCK): `Promise.all` rejected on the first failure
    // while its siblings were still in flight, so the save offered Try again and a retry could
    // snapshot `existing` before those writes landed and queue the same memberships twice.
    const settled = await Promise.allSettled(batch.map(async ({ food }) => {
      await deps.mark(food, h);
      assertCurrent(h);
      deps.save(food);
    }));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    written += batch.length;
  }
  return written;
}

/**
 * Final Sol review BLOCK: a food op the server REJECTS (a newer mark from another device) leaves
 * the queue like an applied one, and the phone reconciles the food to the server's mark. So an
 * empty queue alone does not prove the chosen foods were saved. True when every mark
 * `persistStarterSelection` would write for this selection is what this phone now holds for that
 * food — the server's answer, after the delivery pass.
 */
export function starterMarksStand(
  marks: Readonly<Record<string, StarterMark>>,
  allowed: readonly Starter[],
  existing: () => Record<string, Food> = writer.existing,
): boolean {
  const allowedIds = new Set(allowed.map((item) => item.id));
  const knownIds = new Set(STARTERS.map((item) => item.id));
  const foods = Object.values(existing());
  return Object.entries(marks).every(([id, mark]) => {
    if (mark === "neutral" || !knownIds.has(id) || (mark === "eats" && !allowedIds.has(id))) return true;
    const food = starterFood(id, mark);
    const held = foods.find((item) =>
      item.id === food.id || item.name.toLowerCase() === food.name.toLowerCase());
    return held?.status === mark;
  });
}
