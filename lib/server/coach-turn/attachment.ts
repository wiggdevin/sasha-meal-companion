/**
 * A photo, label or barcode turn (lib/server/coach-attachments.ts). It saves its own rows, so it
 * answers before the text turn's setup reads and never reaches finish().
 */

import type { CoachTurnRequest, CoachTurnResponse } from "@/lib/coach/types";
import { HttpError } from "@/lib/server/auth";
import { reserveTurn } from "@/lib/server/coach";
import { runAttachmentTurn } from "@/lib/server/coach-attachments";
import { beforeDeadline, LATE, TIMEOUT_MESSAGE } from "@/lib/server/coach-turn/deadline";
import type { Turn } from "@/lib/server/coach-turn/types";

export async function runAttachment(
  turn: Turn, attachment: NonNullable<CoachTurnRequest["attachment"]>,
): Promise<CoachTurnResponse> {
  const { client, admin, userId, req, deps, now, newId, saveDeadlineAt } = turn;
  // Bounded like the text turn (Sol review, 2026-09-23): an attachment turn that has not
  // answered by the save deadline is the retryable 503, and its replay covers a late save.
  const answered = await beforeDeadline(async () => {
    return runAttachmentTurn(client, admin, userId, { ...req, attachment },
      { now, newId, reserve: () => reserveTurn(userId), ...deps.attachment, saveBy: saveDeadlineAt });
  }, saveDeadlineAt);
  if (answered === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  return answered;
}
