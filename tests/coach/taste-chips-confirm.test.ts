/**
 * Phase 18 W5b-2: the coach side of a confirmed taste-chip card.
 *
 * - `coachConfirmRequest` turns the user's picks on one card into ONE confirm request bound to the
 *   card (message id and proposal id), refusing any chip the card did not offer.
 * - The message view reads `tool_calls.tasteChips` on an assistant message only, and only a valid card.
 * - The Undo list draws a `taste_v1` record from its taste receipt only; it is server-undoable while
 *   open, unexpired and receipted; the phone can never close it locally.
 */
import { describe, expect, it, vi } from "vitest";
import { coachConfirmRequest, type TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import { toMessageView } from "@/lib/coach/message-view";
import { tasteConfirmRequestSchema } from "@/lib/profile/taste-confirm";
import { performUndo, toUndoView, type UndoRow } from "@/lib/server/coach-undo";

const CARD: TasteChipsProposal = { kind: "taste_chips_proposal", v: 1, id: "p1",
  dislikes: [{ key: "t:soft", label: "Soft", p: 0.97 }, { key: "t:slimy", label: "Slimy", p: 0.9 }],
  cuisines: [{ key: "latin_american", label: "Latin American", p: 0.94 }] };
const MESSAGE = "0b9f8a77-3c1d-4e2f-8a6b-5d4c3b2a1f00";
const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";

describe("coachConfirmRequest", () => {
  it("binds the kept chips to the card, as a valid confirm request", () => {
    const request = coachConfirmRequest(CARD, MESSAGE, { dislikes: ["t:soft", "t:soft"], cuisines: ["latin_american"] }, ACTION);
    expect(request).toEqual({ actionId: ACTION, source: "coach", dislikes: ["t:soft"], cuisines: ["latin_american"],
      coach: { messageId: MESSAGE, proposalId: "p1" } });
    expect(tasteConfirmRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses no picks and any chip the card did not offer", () => {
    expect(coachConfirmRequest(CARD, MESSAGE, { dislikes: [], cuisines: [] }, ACTION)).toBeNull();
    expect(coachConfirmRequest(CARD, MESSAGE, { dislikes: ["t:bitter"], cuisines: [] }, ACTION)).toBeNull();
    expect(coachConfirmRequest(CARD, MESSAGE, { dislikes: [], cuisines: ["korean"] }, ACTION)).toBeNull();
  });
});

describe("the message view", () => {
  const row = (role: "user" | "assistant", tasteChips: unknown) =>
    ({ id: "m1", role, content: "x", seq: 1, tool_calls: { tasteChips } });
  it("carries a valid card on an assistant message only", () => {
    expect(toMessageView(row("assistant", CARD)).tasteChips).toEqual(CARD);
    expect(toMessageView(row("user", CARD)).tasteChips).toBeUndefined();
    expect(toMessageView(row("assistant", { ...CARD, dislikes: [{ key: "f:Okra", label: "x", p: 0.9 }] })).tasteChips)
      .toBeUndefined();
    expect(toMessageView(row("assistant", undefined)).tasteChips).toBeUndefined();
  });
});

const NOW = new Date("2026-10-06T12:00:00Z");
const record = (patch: Partial<UndoRow> = {}): UndoRow => ({
  id: "r1", user_id: "u1", thread_id: "t1", message_id: MESSAGE, action_id: ACTION, kind: "confirm_taste_chips",
  inverse: {}, expected_rev: null, created_at: "2026-10-06T11:00:00Z", undone_at: null,
  expires_at: "2026-10-13T11:00:00Z", record_mode: "taste_v1", source_check: null, ...patch,
});
const RECEIPT = { action_id: ACTION, added_dislikes: ["t:soft"], added_cuisines: ["latin_american"] };

describe("the Undo list's taste record", () => {
  it("is drawn from its receipt and server-undoable while open", () => {
    const view = toUndoView(record(), NOW, null, RECEIPT);
    expect(view.card).toEqual({ type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
      added: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, complete: true });
    expect(view.serverUndoable).toBe(true);
  });

  it("is never server-undoable undone, expired, or without its receipt", () => {
    expect(toUndoView(record({ undone_at: "2026-10-06T11:30:00Z" }), NOW, null, RECEIPT).serverUndoable).toBe(false);
    expect(toUndoView(record({ expires_at: "2026-10-06T11:59:00Z" }), NOW, null, RECEIPT).serverUndoable).toBe(false);
    const missing = toUndoView(record(), NOW, null, null);
    expect(missing.card).toMatchObject({ type: "taste", complete: false });
    expect(missing.serverUndoable).toBe(false);
  });

  it("refuses a local close without calling the database's Undo", async () => {
    const rpc = vi.fn();
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: record(), error: null }) });
    const client = { from: () => chain, rpc } as never;
    await expect(performUndo(client, "u1", "r1", { local: true }, NOW)).rejects.toMatchObject({
      status: 409, code: "undo_receipt_record" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
