"use client";

import type { ReactNode } from "react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";

/**
 * The one "are you sure?" step before an action that throws away the user's own choices (owner,
 * 2026-10-05: "If a user is going to click anything like reset to your plan, there needs to be a
 * confirmation modal"). The confirm button names the action; Cancel keeps everything as it was.
 */
export default function ConfirmSheet({
  title, children, confirmLabel, cancelLabel = "Cancel", destructive = false, onConfirm, onCancel,
}: {
  title: string;
  /** What will change, in a sentence or two. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The action discards data or choices: the confirm button takes the danger style. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet title={title} onClose={onCancel}
      footer={<div className="flex flex-col gap-2.5">
        <Button variant={destructive ? "danger" : "primary"} size="lg" block
          onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="tertiary" block onClick={onCancel}>{cancelLabel}</Button>
      </div>}>
      <div className="px-0.5 text-body text-graphite [text-wrap:pretty]">{children}</div>
    </Sheet>
  );
}
