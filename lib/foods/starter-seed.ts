"use client";

import { accountHandle, accountKey, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { browserClient } from "@/lib/supabase/client";
import { loadStore } from "@/lib/store";
import type { Profile } from "@/lib/constraints-client";
import type { Store } from "@/lib/types";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import { persistStarterSelection } from "@/lib/foods/starter-client";
import { initialStarterSelection, starterChoices, starterSelectionValid } from "@/lib/foods/starter";

const MARKER = "starter-suggestions-seeded-v1";
const pending = new Map<string, Promise<boolean>>();

export async function remoteHasFoods(h: AccountHandle): Promise<boolean | null> {
  const client = browserClient();
  const foods = await withAccount(h, (owner) => client.from("user_foods")
    // Include soft-deleted rows: another device must not resurrect cleared starter choices.
    .select("id").eq("user_id", owner).limit(1));
  if (foods.error) return null;
  const prefs = await withAccount(h, (owner) => client.from("user_food_prefs")
    .select("food_ref_id").eq("user_id", owner).limit(1));
  if (prefs.error) return null;
  return (foods.data?.length ?? 0) > 0 || (prefs.data?.length ?? 0) > 0;
}

export type SeedDependencies = {
  store: () => Store;
  remoteHasFoods: (h: AccountHandle) => Promise<boolean | null>;
  persist: typeof persistStarterSelection;
  storage: Pick<Storage, "getItem" | "setItem">;
};

const defaults: SeedDependencies = {
  store: loadStore, remoteHasFoods, persist: persistStarterSelection,
  storage: typeof localStorage === "undefined" ? {
    getItem: () => null, setItem: () => {},
  } : localStorage,
};

/** Auto-seed only verified empty, onboarded accounts after server rule review. */
export function seedZeroFoodAccount(profile: Profile, instances: readonly ProfileInstance[] = [],
  deps: SeedDependencies = defaults): Promise<boolean> {
  const h = accountHandle();
  const current = pending.get(h.userId);
  if (current) return current;
  const work = (async () => {
    const store = deps.store();
    if (!store.settings.ruleReviewReady || !store.settings.onboardedAt
      || !store.settings.activeTargetProfile) return false;
    const marker = accountKey(h, MARKER);
    const state = deps.storage.getItem(marker);
    if (state === "complete" || (state && state !== "pending")) return false;
    if (state !== "pending" || Object.keys(store.foods).length === 0) {
      if (Object.keys(store.foods).length > 0) return false;
      const hasFoods = await deps.remoteHasFoods(h);
      assertCurrent(h);
      if (hasFoods !== false) return false; // account history and network errors fail closed
    }
    const flags = store.settings.dietPrefs?.flags ?? [];
    const choices = starterChoices(flags, profile, instances);
    const marks = initialStarterSelection(flags, profile, store.settings.dietPrefs?.text ?? "", instances);
    const eats = Object.entries(marks).filter(([, mark]) => mark === "eats").map(([id]) => id);
    if (!starterSelectionValid(eats, choices)) return false;
    // A partial write keeps this marker so the same device can resume only missing suggestions.
    if (state !== "pending") deps.storage.setItem(marker, "pending");
    await deps.persist(marks, choices, undefined, "suggested");
    assertCurrent(h);
    deps.storage.setItem(marker, "complete");
    return true;
  })().finally(() => pending.delete(h.userId));
  pending.set(h.userId, work);
  return work;
}
