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

const writer: StarterWriter = {
  existing: () => loadStore().foods,
  mark: async (food, h) => {
    await setFoodMembership(food.name, food.status === "neutral" ? null : food.status,
      { food, account: h, acknowledge: true, note: food.note ?? null });
  },
  save: (food) => { upsertFood(food); },
  freshRules: readFreshRules,
};

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
  const RULE_CHANGED_ERROR = "A rule just changed what's safe to eat — go back to Foods and choose again.";
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
    if (!fresh) throw new Error("Couldn’t verify your food rules. Go back to Foods and retry.");
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
  let written = 0;
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
    await deps.mark(intended, h);
    assertCurrent(h);
    deps.save(intended);
    written++;
  }
  return written;
}
