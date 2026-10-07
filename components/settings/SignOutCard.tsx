"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { currentAccountOrNull } from "@/lib/device/account";
import { signOutHere, signOutNotice } from "@/lib/device/sign-out";
import { browserClient } from "@/lib/supabase/client";
import { CAPTION } from "./settings-styles";

/**
 * Sign out of this phone (Phase 9 slice 1, reload boundary). Says first what is still waiting to
 * send; a second tap signs out. The account's data stays on this phone (lib/device/forget.ts): the
 * page saves it, signs out, and reloads (lib/device/departure.ts).
 *
 * The last row of the one Data & account card (U17, 2026-10-04), so it draws no card of its own.
 * At rest it is a secondary button; the second step is the danger button armed (`data-armed`),
 * with what is waiting said above it.
 */
export default function SignOutCard() {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signOut = async (): Promise<void> => {
    if (busy) return;
    // The account the tap is for: a later session change never turns it into another's sign-out.
    const h = currentAccountOrNull();
    if (h === null) return;
    if (notice === null) {
      const text = await signOutNotice(h.userId);
      if (text !== null) { setNotice(text); return; }
    }
    setBusy(true);
    void signOutHere(browserClient().auth, h.userId);
  };

  return (
    <section aria-label="Sign out" className="flex flex-col gap-2 p-4">
      {notice ? <p role="status" className="m-0 text-caption text-graphite">{notice}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <p className={`m-0 min-w-0 ${CAPTION}`}>
          Your meals stay on this phone and come back when you sign in again.
        </p>
        {/* At rest a plain secondary: signing out keeps every meal on this phone, so it is not
            destructive. The second step, after the unsent notice, is the armed danger button. */}
        <Button variant={notice ? "danger" : "secondary"} size="sm" className="shrink-0" disabled={busy}
          data-armed={notice ? "true" : undefined} onClick={() => { void signOut(); }}>
          {notice ? "Sign out anyway" : "Sign out"}
        </Button>
      </div>
    </section>
  );
}
