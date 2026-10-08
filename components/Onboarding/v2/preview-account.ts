"use client";

/**
 * Final Sol review BLOCK: the reward preview planned from the starter picks alone, while Today
 * plans from the account's full verified Eats. For a returning account the two differed. This
 * reads the account as it stands — its store and Today's own verified set for its existing Eats
 * (`loadEligibleLocalFoodIds`, the same read Today makes) — once each time the reward beat opens,
 * for `onboardingPlanPreview`'s `account` input. A new account (no Eats yet) makes no read.
 */
import { useEffect, useState } from "react";
import { accountHandle } from "@/lib/device/account";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import type { PreviewAccount } from "@/lib/onboarding/plan-preview";
import { defaultStore, loadStore } from "@/lib/store";

export type PreviewAccountReads = {
  store: typeof loadStore;
  eligible: typeof loadEligibleLocalFoodIds;
};

const defaultReads: PreviewAccountReads = { store: loadStore, eligible: loadEligibleLocalFoodIds };

export async function readPreviewAccount(reads: PreviewAccountReads = defaultReads): Promise<PreviewAccount> {
  let store: ReturnType<typeof loadStore>;
  try {
    store = reads.store();
  } catch {
    store = defaultStore();
  }
  if (!Object.values(store.foods).some((food) => food.status === "eats")) return { store, verified: null };
  try {
    return { store, verified: await reads.eligible(accountHandle(), store.foods) };
  } catch {
    return { store, verified: null };
  }
}

/** The account for the preview while `enabled`; null until the read answers. */
export function usePreviewAccount(enabled: boolean, reads: PreviewAccountReads = defaultReads): PreviewAccount | null {
  const [account, setAccount] = useState<PreviewAccount | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void readPreviewAccount(reads).then((value) => { if (live) setAccount(value); });
    return () => { live = false; };
  }, [enabled, reads]);
  return account;
}
