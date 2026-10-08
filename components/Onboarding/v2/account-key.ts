"use client";

/**
 * The bound account as a render value (`userId:epoch`, null while none is bound). Onboarding reads
 * that belong to one account (the stored pace holds, the reward preview) tag their answer with it
 * and treat an answer for another key as not read (final Sol review r3 BLOCK: after an account
 * switch in the same mounted shell, the previous account's holds and foods stayed in force).
 */
import { useEffect, useState } from "react";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";

export function accountKeyOf(h: AccountHandle | null): string | null {
  return h ? `${h.userId}:${h.epoch}` : null;
}

export function currentAccountKey(): string | null {
  return accountKeyOf(currentAccountOrNull());
}

export function useAccountKey(): string | null {
  const [key, setKey] = useState<string | null>(currentAccountKey);
  useEffect(() => {
    const offReady = onAccountReady((h) => setKey(accountKeyOf(h)));
    const offGone = onAccountGone(() => setKey(null));
    return () => { offReady(); offGone(); };
  }, []);
  return key;
}
