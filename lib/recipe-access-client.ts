"use client";

import { useEffect, useState } from "react";
import { accountFetch, accountHandle, accountJson, currentAccountOrNull,
  onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";

type Access = { epoch: number; enabled: boolean; unavailable: boolean };

export type RecipeAccess = {
  enabled: boolean;
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
};

/** Fail closed on account changes and transport errors; only an explicit server answer enables access. */
export function useRecipeAccess(): RecipeAccess {
  const [account, setAccount] = useState<AccountHandle | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  useEffect(() => {
    const ready = onAccountReady((next) => { setAccount(next); setAccess(null); });
    const gone = onAccountGone(() => { setAccount(null); setAccess(null); });
    return () => { ready(); gone(); };
  }, []);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    const current = account;
    let version = 0;
    const read = async () => {
      const request = ++version;
      try {
        const response = await accountFetch(current, "/api/recipes/access",
          { cache: "no-store", signal: controller.signal }, { budget: "prefs" });
        if (!response.ok) throw new Error("Recipe access could not be checked.");
        const body = await accountJson<{ enabled?: unknown }>(current, response);
        if (!controller.signal.aborted && request === version) {
          if (typeof body?.enabled !== "boolean") throw new Error("Recipe access response was invalid.");
          setAccess({ epoch: current.epoch, enabled: body.enabled, unavailable: false });
        }
      } catch {
        if (!controller.signal.aborted && request === version && currentAccountOrNull()?.epoch === current.epoch)
          setAccess({ epoch: current.epoch, enabled: false, unavailable: true });
      }
    };
    void read();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void read();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", onVisible); };
  }, [account, retryVersion]);
  const retry = () => {
    setAccess(null);
    setRetryVersion((value) => value + 1);
  };
  return { enabled: access?.epoch === account?.epoch && access?.enabled === true,
    loading: account === null ? currentAccountOrNull() !== null : access?.epoch !== account.epoch,
    unavailable: access?.epoch === account?.epoch && access?.unavailable === true,
    retry };
}

export async function recipeAccessForCurrentAccount(
  account: AccountHandle = accountHandle(),
): Promise<boolean> {
  const response = await accountFetch(account, "/api/recipes/access", { cache: "no-store" }, { budget: "prefs" });
  if (!response.ok) return false;
  return (await accountJson<{ enabled: boolean }>(account, response)).enabled === true;
}
