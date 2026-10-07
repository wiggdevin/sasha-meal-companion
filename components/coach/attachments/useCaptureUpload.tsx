"use client";

import { useState } from "react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import { attachmentMoment } from "@/components/coach/attachments/context";
import { signAndUpload } from "@/lib/capture-client";
import type { CoachAttachment } from "@/lib/coach/attachments";
import { resizeImage } from "@/lib/media/resize";

type Status = { busy: boolean; message: string | null } | null;
export type CaptureMethod = "photo" | "label";

const SENT: Record<CaptureMethod, string> = { photo: "Sent a photo", label: "Sent a nutrition label" };

/** Resize, upload and hand one picked image to the coach as a capture attachment. */
export function useCaptureUpload(
  onAttachment: (attachment: CoachAttachment, optimisticText: string) => void | Promise<boolean>,
  now: () => Date = () => new Date(),
) {
  const [status, setStatus] = useState<Status>(null);

  async function upload(file: File, method: CaptureMethod = "photo"): Promise<void> {
    const at = now();
    setStatus({ busy: true, message: null });
    try {
      const photo = await resizeImage(file);
      const uploaded = await signAndUpload("image", photo, fetch);
      if (uploaded.kind === "failed") {
        setStatus({ busy: false, message: uploaded.outcome.message });
        return;
      }
      const moment = attachmentMoment(at);
      onAttachment({
        kind: "capture", v: 1, method, mediaPath: uploaded.path,
        localDate: moment.localDate, slot: moment.slot,
      }, SENT[method]);
      setStatus(null);
    } catch {
      setStatus({ busy: false, message: "That photo would not open. Try again." });
    }
  }

  /** Shown while the photo is checked for a barcode, before anything is uploaded. */
  const reading = () => setStatus({ busy: true, message: "Looking for a barcode…" });
  return { busy: status?.busy === true, status, upload, reading, dismiss: () => setStatus(null) };
}

/** The upload's progress or failure, with a retry when the caller can reopen its picker. */
export function CaptureStatusSheet({ status, onDismiss, onRetry }: {
  status: Status; onDismiss: () => void; onRetry?: () => void;
}) {
  if (!status) return null;
  return <Sheet title="Photo" subtitle="A plate, a menu, a label or a barcode."
    onClose={onDismiss}>
    <div className="flex flex-col gap-3">
      <p role="status" className="m-0 text-caption font-normal text-graphite">
        {status.busy ? status.message ?? "Uploading photo…" : status.message}
      </p>
      {!status.busy && onRetry && <Button variant="secondary" block onClick={onRetry}>Try again</Button>}
    </div>
  </Sheet>;
}
