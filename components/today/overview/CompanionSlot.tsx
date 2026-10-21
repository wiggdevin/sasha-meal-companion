"use client";

import { createPortal } from "react-dom";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import CompanionCard from "@/components/today/overview/CompanionCard";
import { MASCOTS } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";
import type { OverviewData } from "@/components/today/overview/types";
import { setCompanionShown, useCompanionShown } from "@/lib/today/companion-visibility";

/**
 * The companion's place in the Overview face (UI makeover §4 item 4, §5): the chosen companion's
 * row, or nothing at all when the account hides it (no care reads, notes or awards either). Hiding
 * from the row offers Undo; Settings › Your companion shows it again on any device.
 */
export default function CompanionSlot({ data, active }: {
  data: OverviewData;
  /** True while the Overview face is on show. */
  active: boolean;
}) {
  const mascot = useMascot();
  const shown = useCompanionShown(mascot);
  const feedback = useActionFeedback();
  const name = MASCOTS[mascot].name;
  const show = (next: boolean) => void feedback.run(() => setCompanionShown(mascot, next), {
    kind: "change",
    confirm: next ? "control" : "notice",
    successMessage: next ? undefined : `${name} is hidden. Show it again in Settings.`,
    undo: next ? undefined : { action: () => show(true) },
    failureMessage: next ? `Couldn't show ${name}. Try again.` : `Couldn't hide ${name}. Try again.`,
  });
  return <>
    {shown && <CompanionCard data={data} mascot={mascot} active={active} onHide={() => show(false)} />}
    {/* To the body: the Day card's face animates a filter, which would hold a fixed toast inside it. */}
    {typeof document !== "undefined"
      && createPortal(<ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />, document.body)}
  </>;
}
