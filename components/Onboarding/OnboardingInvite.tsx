"use client";

import { useEffect, useState } from "react";
import { SYNCED_EVENT } from "@/lib/sync/client";
import {
  accountDisposition,
  dismissOnboardingInvite,
  readOnboardingInviteDismissedAt,
  readAccountOnboardingRow,
  shouldShowOnboardingInvite,
  type AccountOnboardingClient,
  type LocalOnboardingState,
  type OnboardingDisposition,
  type ServerOnboardingRow,
} from "@/lib/profile/onboarding-state";
import { browserClient } from "@/lib/supabase/client";
import OnboardingFlow from "./OnboardingFlow";
import Button from "@/components/ui/Button";

export function OnboardingInviteCard({
  onSetUp,
  onDismiss,
}: {
  onSetUp: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="shell">
      <div className="surface flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <p className="m-0 flex-1 text-tiny font-normal leading-body-sm text-graphite">
          Set up your profile so the coach can size your day — 2 minutes
        </p>
        <div className="flex shrink-0 gap-2">
          <Button className="flex-1 sm:flex-none" onClick={onSetUp}>Set up</Button>
          <Button variant="tertiary" className="flex-1 sm:flex-none" onClick={onDismiss}>Not now</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What one onboarding read means to this card. `undefined` is a FAILED read, and a failure is not
 * a row: it stays UNRESOLVED (D1 §1.3/§1.4), so only a row the server actually returned yields
 * none/invite/force. Mapping a dropped connection to "none" would have been a claim about the
 * account made from nothing, which is the guess the gate stopped making.
 */
export function inviteDisposition(
  serverRow: ServerOnboardingRow | null | undefined,
): OnboardingDisposition | null {
  return serverRow === undefined ? null : accountDisposition(serverRow);
}

export default function OnboardingInvite({
  now,
}: {
  /**
   * Accepted for the existing Today call site. The disposition is read from the account's own
   * row now (D1 §1.3), so this device-wide state no longer decides anything here.
   */
  localState?: LocalOnboardingState;
  now: Date;
}) {
  const [dismissedAt, setDismissedAt] = useState(readOnboardingInviteDismissedAt);
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState<OnboardingDisposition | null>(null);

  useEffect(() => {
    let live = true;
    // The narrow read port; the full client type is too deep for the structural check (TS2589).
    const client = browserClient() as unknown as AccountOnboardingClient;
    void readAccountOnboardingRow(client).then((serverRow) => {
      // A failed read invites nobody: the card asks for two minutes of setup, and it must not
      // ask on the strength of a dropped connection.
      if (live) setDisposition(inviteDisposition(serverRow));
    });
    return () => { live = false; };
  }, []);

  if (disposition === null || !shouldShowOnboardingInvite(disposition, dismissedAt, now)) {
    return null;
  }

  function dismiss(): void {
    setDismissedAt(dismissOnboardingInvite(now));
  }

  function finish(): void {
    setOpen(false);
    globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
  }

  return (
    <>
      <OnboardingInviteCard onSetUp={() => setOpen(true)} onDismiss={dismiss} />
      {open && <OnboardingFlow returnTo="/" onFinished={finish} />}
    </>
  );
}
