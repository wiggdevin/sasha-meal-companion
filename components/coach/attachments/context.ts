import { slotForNow } from "@/lib/capture-client";
import { localDate } from "@/lib/coach/chat-state";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import type { SlotId } from "@/lib/types";

export type AttachmentMoment = { localDate: string; slot: SlotId };

/** Use the same local date and current-slot rule as the existing capture sheet. */
export function attachmentMoment(at: Date = new Date()): AttachmentMoment {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const date = localDate(tz, at);
  const slots = resolveDay(loadStore(), date).slots;
  return {
    localDate: date,
    slot: slotForNow(slots, at.getHours() * 60 + at.getMinutes()),
  };
}
