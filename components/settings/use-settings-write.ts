"use client";

import { useActionFeedback } from "@/components/ui/ActionFeedback";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";

export const SETTINGS_WRITE_FAILED = "Couldn't save that change — try again when you have a connection.";

/**
 * One Settings section's writes through the shared ActionFeedback (FluidVoice F01-F09). Each edit is
 * sent at once; its outcome queues behind any still in flight, so two quick edits are two writes
 * with two outcomes. Success glows the section's card with the shared haptic; a failure is the
 * shared alert, and the field keeps what was typed.
 */
export function useSettingsWrite<P>(send: (patch: P) => void | Promise<unknown>) {
  const feedback = useActionFeedback();
  function write(patch: P): void {
    const account = currentAccountOrNull();
    const sent = Promise.resolve(send(patch));
    // Observed at once: a write that fails while it waits its turn is not an unhandled rejection.
    sent.catch(() => {});
    void feedback.run(() => sent, { kind: "commit", queue: true, failureMessage: SETTINGS_WRITE_FAILED,
      // Another account now: this edit's outcome belongs to the account that made it; say nothing.
      stale: () => account !== null && !isCurrent(account) });
  }
  return { feedback, write };
}
