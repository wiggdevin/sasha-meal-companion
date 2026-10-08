"use client";

/**
 * Final Sol review BLOCK: the reward preview planned from the starter picks alone, while Today
 * plans from the account's full verified Eats. For a returning account the two differed. This
 * reads the account as it stands — its store and Today's own verified set for its existing Eats
 * (`loadEligibleLocalFoodIds`, the same read Today makes) — once each time the reward beat opens,
 * for `onboardingPlanPreview`'s `account` input. A new account (no Eats yet) makes no read.
 */
import { useEffect, useState } from "react";
import { currentAccountKey, useAccountKey } from "@/components/Onboarding/v2/account-key";
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

/** The account for the preview while `enabled`; null until THIS account's read answers. Final Sol
 *  review r3 BLOCK: the answer is tagged with the account it was read for and dropped when the
 *  beat closes, so a switched account never sees the previous account's foods. */
export function usePreviewAccount(enabled: boolean, reads: PreviewAccountReads = defaultReads): PreviewAccount | null {
  const accountKey = useAccountKey();
  const [answer, setAnswer] = useState<{ key: string; account: PreviewAccount } | null>(null);
  useEffect(() => {
    if (!enabled || accountKey === null) return;
    let live = true;
    void readPreviewAccount(reads).then((value) => {
      if (live && currentAccountKey() === accountKey) setAnswer({ key: accountKey, account: value });
    });
    // Closing the beat (or a switch) drops the answer: a reopened beat waits for a fresh read.
    return () => { live = false; setAnswer(null); };
  }, [enabled, reads, accountKey]);
  return enabled && answer !== null && answer.key === accountKey ? answer.account : null;
}
