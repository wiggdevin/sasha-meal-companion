"use client";

import { accountFetch, accountHandle, accountJson, assertCurrent, currentAccountOrNull } from "@/lib/device/account";
import { loadConstraints } from "@/lib/constraints-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import { loadRuleReview } from "@/lib/rule-review-client";
import { loadStore, saveStoreFor } from "@/lib/store";
import { seedZeroFoodAccount } from "@/lib/foods/starter-seed";

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
 * W13 (D14): "No starter is marked Favored by default" for an open account — the legacy
 * zero-food auto-seed below is a CLOSED-world behaviour only, and it runs only on the server's
 * affirmative `closed`. Sol round 2 BLOCK: a failed read used to count as `closed`, so an open
 * account with zero foods whose world read failed was seeded with default Favored marks. Any
 * failure (network, timeout, non-OK status, unreadable body) is now `unknown`, which seeds
 * nothing; the next gate refresh reads again.
 */
type FoodWorldRead = "open" | "closed" | "unknown";

async function foodWorld(account: ReturnType<typeof accountHandle>): Promise<FoodWorldRead> {
  try {
    const response = await accountFetch(account, "/api/foods/world",
      { cache: "no-store" }, { budget: "prefs" });
    if (!response.ok) return "unknown";
    const body = await accountJson<{ world?: unknown }>(account, response);
    return body?.world === "open" || body?.world === "closed" ? body.world : "unknown";
  } catch {
    return "unknown";
  }
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
    if (!review || !constraints || !profiles) return "unavailable";
    if (review.required) return "review";
    if (access === null) return "unavailable";
    setReady(true);
    if (!access && world === "closed") await seedZeroFoodAccount(constraints.profile, profiles.instances).catch(() => false);
    assertCurrent(h);
    return "ready";
  } catch {
    if (currentAccountOrNull()?.userId === h.userId) setReady(false);
    return "unavailable";
  }
}
