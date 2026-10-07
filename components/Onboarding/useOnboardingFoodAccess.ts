"use client";

import { useCallback, useEffect, useState } from "react";
import {
  accountFetch, accountHandle, accountJson, assertCurrent, currentAccountOrNull,
  onAccountGone, onAccountReady,
  type AccountHandle,
} from "@/lib/device/account";
import { loadConstraints } from "@/lib/constraints-client";
import { loadRuleReview } from "@/lib/rule-review-client";
import type { OnboardingState } from "@/lib/profile/onboarding-state";

type Status = "checking" | "pilot" | "legacy" | "review" | "unavailable";

async function readAccess(account: AccountHandle): Promise<Status> {
  try {
    const response = await accountFetch(account, "/api/recipes/access",
      { cache: "no-store" }, { budget: "prefs" });
    if (!response.ok) return "unavailable";
    const body = await accountJson<{ enabled?: unknown }>(account, response);
    if (typeof body?.enabled !== "boolean") return "unavailable";
    if (!body.enabled) return "legacy";
    const [review, constraints] = await Promise.all([
      loadRuleReview({ account }), loadConstraints({ account }),
    ]);
    assertCurrent(account);
    return !review || !constraints ? "unavailable" : review.required ? "review" : "pilot";
  } catch {
    return "unavailable";
  }
}

/** Keep starter choices unloaded until the account's server flag is known. */
export function useOnboardingFoodAccess(state: OnboardingState | null): {
  status: Status; retry: () => void; revalidate: () => Promise<Status>;
} {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [result, setResult] = useState<{ epoch: number; key: string; status: Status } | null>(null);
  const [revision, setRevision] = useState(0);
  // Recheck after preferences are answered, before Foods can be passed.
  const key = state && state.step >= 4
    ? `foods\0${state.flags.join("|")}\0${state.prefsText}` : "before-foods";

  useEffect(() => {
    const ready = onAccountReady((next) => {
      setAccount((previous) => previous?.epoch === next.epoch ? previous : next);
    });
    const gone = onAccountGone(() => { setAccount(null); setResult(null); });
    return () => { ready(); gone(); };
  }, []);

  useEffect(() => {
    if (!account) return;
    let live = true;
    const read = async () => {
      const status = await readAccess(account);
      if (live && currentAccountOrNull()?.epoch === account.epoch)
        setResult({ epoch: account.epoch, key, status });
    };
    void read();
    return () => { live = false; };
  }, [account, key, revision]);

  const revalidate = useCallback(async (): Promise<Status> => {
    let current: AccountHandle;
    try { current = accountHandle(); } catch { return "unavailable"; }
    if (!account || current.epoch !== account.epoch || current.userId !== account.userId)
      return "unavailable";
    setResult(null);
    const status = await readAccess(current);
    try {
      if (accountHandle().epoch !== current.epoch) return "unavailable";
    } catch { return "unavailable"; }
    setResult({ epoch: current.epoch, key, status });
    return status;
  }, [account, key]);

  return {
    status: result && account && result.epoch === account.epoch && result.key === key
      ? result.status : "checking",
    retry: () => { setResult(null); setRevision((value) => value + 1); },
    revalidate,
  };
}
