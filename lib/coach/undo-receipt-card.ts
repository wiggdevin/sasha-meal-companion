/**
 * The Undo list's card for a receipt record (docs/specs/coach-undo-receipt.md §6.5), built from the
 * record's one immutable receipt only — what the server read from the rows the write changed, never
 * what a coach message said. Every legacy record gets the generic card instead (§5): no card is
 * ever inferred from a message.
 *
 * Pure: lib/server/coach-undo.ts reads the receipt and passes it here.
 */
import { dayLabel, displayName, slotName } from "@/lib/coach/actions/copy";
import {
  RECEIPT_KINDS, type CoachUndoCard, type ReceiptKind, type SourceCheck,
} from "@/lib/coach/undo-types";

/** One `coach_action_receipts` row as the list reads it. */
export type ReceiptRow = {
  id: string; action_id: string; kind: string; source: Record<string, unknown> | null;
  source_check: string; applied: Record<string, unknown>;
};

type Line = { name: string | null; grams: number | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const isLocalDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const SOURCE_CHECKS = new Set<string>(["match", "mismatch", "none"]);

export const GENERIC_TITLE = "Coach change" as const;

/** The generic card every legacy record gets (spec §5). */
export function genericCard(kind: string): CoachUndoCard {
  return { type: "generic", kind, title: GENERIC_TITLE };
}

/** One `taste_chip_receipts` row as the Undo list reads it (Phase 18 W5b-2). */
export type TasteReceiptRow = { action_id: string; added_dislikes: unknown; added_cuisines: unknown };

/** The card of a taste record, from its receipt only; null (no receipt read) draws an incomplete card. */
export function tasteCard(receipt: TasteReceiptRow | null): CoachUndoCard {
  const keys = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
  const dislikes = keys(receipt?.added_dislikes);
  const cuisines = keys(receipt?.added_cuisines);
  const complete = dislikes !== null && cuisines !== null;
  return { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
    added: { dislikes: dislikes ?? [], cuisines: cuisines ?? [] }, complete };
}

function isReceiptKind(kind: string): kind is ReceiptKind {
  return (RECEIPT_KINDS as readonly string[]).includes(kind);
}

/** A stored food line: its name (null when it had none) and grams (null when the mass is unknown). */
function itemLines(items: unknown): Line[] | null {
  if (!Array.isArray(items)) return null;
  const lines: Line[] = [];
  for (const item of items) {
    if (!isRecord(item)) return null;
    lines.push({ name: text(item.name), grams: num(item.grams) });
  }
  return lines;
}

/** A slot override's components as lines: grams only when the component is measured in grams. */
function componentLines(override: unknown): Line[] | null {
  if (!isRecord(override) || !Array.isArray(override.components)) return null;
  const lines: Line[] = [];
  for (const component of override.components) {
    if (!isRecord(component)) return null;
    lines.push({ name: text(component.name),
      grams: component.unit === "g" ? num(component.qty) : null });
  }
  return lines;
}

type Body = { title: string; lines: Line[]; date: string; slot: string | null };

function body(kind: ReceiptKind, applied: Record<string, unknown>, createdDate: string): Body | null {
  if (kind === "log_meal") {
    const lines = itemLines(applied.items);
    const slot = text(applied.slot);
    if (!lines || !slot || !isLocalDate(applied.date)) return null;
    return { title: `Logged ${slotName(slot)} on ${dayLabel(applied.date)}`, lines,
      date: applied.date, slot };
  }
  if (kind === "save_recipe") {
    const lines = itemLines(applied.items);
    const name = text(applied.name);
    if (!lines || !name) return null;
    return { title: `Saved the recipe "${name}"`, lines, date: createdDate, slot: null };
  }
  const slot = text(applied.slot);
  const after = applied.after;
  const lines = componentLines(after);
  if (!lines || !slot || !isLocalDate(applied.date) || !isRecord(after)) return null;
  const what = text(after.title) ?? lines.find((line) => line.name)?.name ?? "a meal";
  return { title: `Put ${displayName(what)} in ${slotName(slot)} on ${dayLabel(applied.date)}`,
    lines, date: applied.date, slot };
}

/**
 * The card for a receipt record. `receipt` is its one receipt as read, or null when the read held
 * none: then the card is `complete: false` and the record is never server-undoable (spec §6.4).
 * A receipt whose body cannot be read is treated the same way.
 */
export function receiptCard(record: { kind: string; createdAt: string; sourceCheck: string | null },
  receipt: ReceiptRow | null): CoachUndoCard {
  const createdDate = record.createdAt.slice(0, 10);
  const recordCheck: SourceCheck = SOURCE_CHECKS.has(record.sourceCheck ?? "")
    ? record.sourceCheck as SourceCheck : "none";
  if (!isReceiptKind(record.kind)) return genericCard(record.kind);
  const incomplete: CoachUndoCard = { type: "receipt", kind: record.kind, title: GENERIC_TITLE,
    lines: [], date: createdDate, slot: null, messageId: null, sourceCheck: recordCheck,
    complete: false };
  if (!receipt || receipt.kind !== record.kind || !SOURCE_CHECKS.has(receipt.source_check)
    || !isRecord(receipt.applied)) return incomplete;
  const drawn = body(record.kind, receipt.applied, createdDate);
  if (!drawn) return incomplete;
  const sourceCheck = receipt.source_check as SourceCheck;
  const messageId = sourceCheck === "match" && isRecord(receipt.source)
    ? text(receipt.source.messageId) : null;
  return { type: "receipt", kind: record.kind, ...drawn, messageId, sourceCheck, complete: true };
}
