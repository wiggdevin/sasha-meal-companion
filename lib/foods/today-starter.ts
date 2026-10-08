"use client";

import { accountFetch, accountHandle, accountJson, assertCurrent, currentAccountOrNull } from "@/lib/device/account";
import { loadConstraints } from "@/lib/constraints-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import { loadRuleReview } from "@/lib/rule-review-client";
import { loadStore, saveStoreFor } from "@/lib/store";
import { seedZeroFoodAccount } from "@/lib/foods/starter-seed";
import { drainWorldOpenPending, markWorldOpenPending } from "@/lib/foods/world-open-client";

export type StarterGate = "ready" | "review" | "unavailable";

/** Only an explicit server decision can enter the legacy starter-seed path. */
async function recipeAccess(account: ReturnType<typeof accountHandle>): Promise<boolean | null> {
  try {
    const response = await accountFetch(account, "/api/recipes/access",
      { cache: "no-store" }, { budget: "prefs" });
    if (!response.ok) return null;
    const body = await accountJson<{ enabled?: unknown }>(account, response);
    return typeof body?.enabled === "boolean" ? body.enabled : null;
  } catch {
    return null;
  }
}

/**
 * W13 (D14): "No starter is marked Favored by default" for an open account, and none for a new
 * account whose onboarding open default has not landed yet. Sol round 4 BLOCK: the decision is
 * the SERVER's (`GET /api/foods/world` -> `starterSeed`, lib/server/food-world.ts
 * `readFoodWorldState`), so every device of the account agrees. A device-local pending flag
 * cannot see another device's failed open POST: device A finishes onboarding and its open POST
 * answers 503; device B then sees onboarded + `closed` with no flag of its own. The server knows
 * the default is still due (`food_world_default_due_at`, stamped with `onboarded_at`) and answers
 * `starterSeed: false` on every device until the world is decided.
 *
 * Only an affirmative `{ world: "closed", starterSeed: true }` seeds. Any failure (network,
 * timeout, non-OK status, unreadable or partial body) is `unknown` and seeds nothing (Sol round 2
 * BLOCK); the next gate refresh reads again.
 */
type FoodWorldRead = { seed: boolean; openDefaultPending: boolean };

const UNKNOWN: FoodWorldRead = { seed: false, openDefaultPending: false };

async function foodWorld(account: ReturnType<typeof accountHandle>): Promise<FoodWorldRead> {
  try {
    const response = await accountFetch(account, "/api/foods/world",
      { cache: "no-store" }, { budget: "prefs" });
    if (!response.ok) return UNKNOWN;
    const body = await accountJson<{ world?: unknown; starterSeed?: unknown;
      openDefaultPending?: unknown }>(account, response);
    return {
      seed: body?.world === "closed" && body.starterSeed === true,
      openDefaultPending: body?.world === "closed" && body.openDefaultPending === true,
    };
  } catch {
    return UNKNOWN;
  }
}

/**
 * The server says this account's onboarding open default is still due, so this device takes the
 * intent over: it records it and drains it like the onboarding device would. The default's POST
 * is one conditional write (`food_world_set_at is null`), so any number of devices posting it is
 * safe, and an account whose onboarding device is gone still opens. Never throws, never blocks.
 */
function adoptOpenDefault(account: ReturnType<typeof accountHandle>): void {
  void (async () => {
    await markWorldOpenPending(account);
    await drainWorldOpenPending(account);
  })().catch(() => undefined);
}

/** A successful server read is required before Today renders generated suggestions. */
export async function refreshStarterGate(): Promise<StarterGate> {
  const h = accountHandle();
  const setReady = (ready: boolean) => {
    assertCurrent(h);
    const store = loadStore();
    saveStoreFor(h, { ...store, settings: { ...store.settings, ruleReviewReady: ready } },
      { silent: true });
  };
  try {
    setReady(false);
    const [review, constraints, profiles, access, world] = await Promise.all([
      loadRuleReview({ account: h }), loadConstraints({ account: h }), fetchProfileInstances(h),
      recipeAccess(h), foodWorld(h),
    ]);
    assertCurrent(h);
    if (world.openDefaultPending) adoptOpenDefault(h);
    if (!review || !constraints || !profiles) return "unavailable";
    if (review.required) return "review";
    if (access === null) return "unavailable";
    setReady(true);
    if (!access && world.seed) await seedZeroFoodAccount(constraints.profile, profiles.instances).catch(() => false);
    assertCurrent(h);
    return "ready";
  } catch {
    if (currentAccountOrNull()?.userId === h.userId) setReady(false);
    return "unavailable";
  }
}
