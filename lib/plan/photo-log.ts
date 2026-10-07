"use client";
/**
 * Logging from the Plan panel, through the app's own capture pipeline: a plate photo goes through
 * the photo capture (sign, upload, `/api/log/propose`), a menu pick or "I had …" through the text
 * capture, and both commit with `commitDraft` filed under THIS slot, the way "Log what you ate"
 * files its entries. Nothing here estimates nutrition: the commit's catalog rows do.
 *
 * The Plan panel proposes first and commits only what the person has seen (2026-10-04, AI audit B3:
 * the plate's "Log it" showed one estimate and then committed a second capture nobody saw):
 * `proposePlate` / `proposeDescribed` return the capture's draft for the card to show in the capture
 * editor, and `commitPanelDraft` files it, with the person's edits, once they confirm.
 * The recipe hub uses the same review (PanelReview, 2026-10-04). `logPlatePhoto` / `logDescribed`
 * still propose and commit in one go, only for callers that already showed what they log.
 *
 * The confirm sheet's rule holds here too (spec AC9): an item the rules block never leaves the
 * phone, and an ungrounded one is left out rather than guessed at.
 */
import {
  applyEdits, captureMedia, captureText, commitDraft, type CaptureContext, type CaptureOutcome, type DraftEdits,
} from "@/lib/capture-client";
import type { ProposeResponse } from "@/lib/capture/types";
import type { TimingRun } from "@/lib/timing";
import { AccountChanged, assertCurrent, isCurrent, type AccountHandle } from "@/lib/device/account";
import { localDateOf } from "@/lib/log-client";
import { savedFrom } from "@/lib/log/outcome";
import type { SlotId } from "@/lib/types";

export type PanelLogResult = { ok: true; date: string } | { ok: false; message: string };

const NOTHING_MATCHED = "I couldn’t match that to foods. Try “Log what you ate”.";
const NOTHING_TO_CHECK = "I couldn’t find any food in that. Try other words or a photo.";

/** The day and time the panel was opened on: a past day's slot, at its own clock time. */
export type PanelDay = { date: string; time: string };
type Filing = Pick<CaptureContext, "localDate" | "tz"> & { eatenAt: Date };

/**
 * Today (or a future day) logs "now", like every other log (components/CaptureSheet.tsx
 * useCaptureWhen). A past day's panel files the entry on that day at the slot's time, so it lands
 * on the day the person was looking at and ticks that slot.
 */
export function filing(viewed?: PanelDay, now = new Date()): Filing {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
  if (!viewed || !/^\d{4}-\d{2}-\d{2}$/.test(viewed.date) || viewed.date >= today) {
    return { localDate: today, tz, eatenAt: now };
  }
  const time = /^\d{2}:\d{2}$/.test(viewed.time) ? viewed.time : "12:00";
  return { localDate: viewed.date, tz, eatenAt: new Date(`${viewed.date}T${time}:00`) };
}

/** The edits that make a draft committable: ungrounded items out, grams scaled to the portion. */
export function panelEdits(items: { seq: number; grams: number; foodRefId: string | null }[],
  factor: number): DraftEdits {
  const edits: DraftEdits = {};
  for (const item of items) {
    if (item.foodRefId === null) edits[item.seq] = { removed: true };
    else if (factor !== 1) edits[item.seq] = { grams: Math.max(1, Math.round(item.grams * factor)) };
  }
  return edits;
}

/**
 * The draft committed as the account the capture started as. An account switch between propose
 * and commit throws AccountChanged (as readPlanDocument does), so nothing is filed under the new
 * account and the caller closes the panel instead of reporting a result.
 */
async function commit(h: AccountHandle, outcome: CaptureOutcome, slot: SlotId, at: Filing, factor: number):
  Promise<PanelLogResult> {
  if (outcome.kind !== "draft") return { ok: false, message: outcome.message };
  const { draft, run } = outcome;
  const kept = draft.items.filter((item) => item.foodRefId !== null);
  if (kept.length === 0) return { ok: false, message: NOTHING_MATCHED };
  const blocked = kept.filter((item) => item.policy.verdict === "blocked").map((item) => item.label);
  if (blocked.length > 0) {
    return { ok: false, message: `Not logged: ${blocked.slice(0, 3).join(", ")} is off your rules. Use “Log what you ate” to change it.` };
  }
  const { eatenAt, tz } = at;
  assertCurrent(h);
  const result = await commitDraft(draft, panelEdits(draft.items, factor),
    { entryId: crypto.randomUUID(), eatenAt, tz, slot, run, account: h });
  if (!isCurrent(h)) throw new AccountChanged();
  const saved = savedFrom(result);
  return saved.ok ? { ok: true, date: localDateOf(eatenAt) } : saved;
}

/** A capture waiting for the person to check it: nothing is logged until `commitPanelDraft`. */
export type PanelDraft = { draft: ProposeResponse; run?: TimingRun; slot: SlotId; at: Filing };
export type PanelProposal = { ok: true; pending: PanelDraft } | { ok: false; message: string };

/** The draft at a portion of what was photographed: every grounded item's grams scaled, the way the
 *  capture editor's own grams edit would (the portion it named is cleared). */
export function scaleDraft(draft: ProposeResponse, factor: number): ProposeResponse {
  if (factor === 1) return draft;
  const edits: DraftEdits = {};
  for (const item of draft.items) edits[item.seq] = { grams: Math.max(1, Math.round(item.grams * factor)) };
  return { ...draft, items: applyEdits(draft.items, edits).map(({ removed: _removed, wasEdited: _edited, ...item }) => item) };
}

/** An ungrounded item is shown with its alternatives to pick from, so only an empty draft is a dead end. */
function proposal(outcome: CaptureOutcome, slot: SlotId, at: Filing, factor: number): PanelProposal {
  if (outcome.kind !== "draft") return { ok: false, message: outcome.message };
  if (outcome.draft.items.length === 0) return { ok: false, message: NOTHING_TO_CHECK };
  return { ok: true, pending: { draft: scaleDraft(outcome.draft, factor), run: outcome.run, slot, at } };
}

/** A plate photo, at a portion of what was photographed, proposed for `slot`. Nothing is logged. */
export async function proposePlate(h: AccountHandle, image: Blob, slot: SlotId, factor: number,
  viewed?: PanelDay): Promise<PanelProposal> {
  const at = filing(viewed);
  const outcome = await captureMedia("photo", image, { localDate: at.localDate, tz: at.tz, slot, account: h });
  if (!isCurrent(h)) throw new AccountChanged();
  return proposal(outcome, slot, at, factor);
}

/** A dish name from a menu, or the person's own "I had …", proposed for `slot`. Nothing is logged. */
export async function proposeDescribed(h: AccountHandle, text: string, slot: SlotId,
  viewed?: PanelDay): Promise<PanelProposal> {
  const at = filing(viewed);
  const outcome = await captureText(text, { localDate: at.localDate, tz: at.tz, slot, account: h });
  if (!isCurrent(h)) throw new AccountChanged();
  return proposal(outcome, slot, at, 1);
}

/**
 * The checked draft, with the person's edits from the capture editor, committed as the account the
 * capture started as and filed under its slot and day. A blocked item never leaves the phone.
 */
export async function commitPanelDraft(h: AccountHandle, pending: PanelDraft, edits: DraftEdits):
  Promise<PanelLogResult> {
  const kept = applyEdits(pending.draft.items, edits).filter((item) => !item.removed);
  const blocked = kept.filter((item) => item.policy.verdict === "blocked").map((item) => item.label);
  if (blocked.length > 0) {
    return { ok: false, message: `Not logged: ${blocked.slice(0, 3).join(", ")} is off your rules. Remove it to log the rest.` };
  }
  if (!kept.some((item) => item.foodRefId !== null)) return { ok: false, message: NOTHING_MATCHED };
  const { eatenAt, tz } = pending.at;
  assertCurrent(h);
  const result = await commitDraft(pending.draft, edits,
    { entryId: crypto.randomUUID(), eatenAt, tz, slot: pending.slot, run: pending.run, account: h });
  if (!isCurrent(h)) throw new AccountChanged();
  const saved = savedFrom(result);
  return saved.ok ? { ok: true, date: localDateOf(eatenAt) } : saved;
}

/** A plate photo, at a portion of what was photographed, logged to `slot` (the recipe hub). */
export async function logPlatePhoto(h: AccountHandle, image: Blob, slot: SlotId, factor: number,
  viewed?: PanelDay): Promise<PanelLogResult> {
  const at = filing(viewed);
  return commit(h, await captureMedia("photo", image, { localDate: at.localDate, tz: at.tz, slot, account: h }),
    slot, at, factor);
}

/** A dish name from a menu, or the person's own "I had …", logged to `slot` (the recipe hub). */
export async function logDescribed(h: AccountHandle, text: string, slot: SlotId,
  viewed?: PanelDay): Promise<PanelLogResult> {
  const at = filing(viewed);
  return commit(h, await captureText(text, { localDate: at.localDate, tz: at.tz, slot, account: h }), slot, at, 1);
}
