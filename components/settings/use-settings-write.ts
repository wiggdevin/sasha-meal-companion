"use client";

import { useRef } from "react";
import { useActionFeedback } from "@/components/ui/ActionFeedback";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";

export const SETTINGS_WRITE_FAILED = "Couldn't save that change — try again when you have a connection.";

/**
 * One Settings section's writes through the shared ActionFeedback (FluidVoice F01-F09). Each edit is
 * sent after the one before it has settled, in tap order, so two quick edits are two writes with two
 * outcomes and the later one always lands last (UI audit r1: the sends used to race). An edit still
 * waiting when the account changes is never sent. Success glows the section's card with the shared haptic; a failure is the
 * shared alert, and the field keeps what was typed.
 */
export function useSettingsWrite<P>(send: (patch: P) => void | Promise<unknown>) {
  const feedback = useActionFeedback();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  function write(patch: P): void {
    const account = currentAccountOrNull();
    // Nothing in flight: sent now, in this tap. Otherwise it waits for the edit before it.
    const run = () => new Promise<unknown>((resolve) => {
      if (account !== null && !isCurrent(account)) throw new Error("The account changed before this edit was sent.");
      resolve(send(patch));
    });
    const sent = inFlight.current === 0 ? run() : queue.current.catch(() => {}).then(run);
    inFlight.current += 1;
    queue.current = sent;
    void sent.finally(() => { inFlight.current -= 1; }).catch(() => {});
    // Observed at once: a write that fails while it waits its turn is not an unhandled rejection.
    sent.catch(() => {});
    void feedback.run(() => sent, { kind: "commit", queue: true, failureMessage: SETTINGS_WRITE_FAILED,
      // Another account now: this edit's outcome belongs to the account that made it; say nothing.
      stale: () => account !== null && !isCurrent(account) });
  }
  return { feedback, write };
}
