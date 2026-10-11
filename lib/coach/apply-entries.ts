"use client";

/**
 * The logged-entry half of a coach action: delete one, retime one, and save a meal as a recipe —
 * T6 §3. Each goes through the path the user already uses by hand:
 *
 * - delete  -> `forgetLoggedEntry`, T0's delete path, tombstone and all.
 * - retime  -> the same complete-row update `saveExtraNote` queues, with a new `eaten_at`.
 * - recipe  -> `saveRecipe`, the Foods tab's own create.
 */

import {
  accountHandle, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import type { CoachAction } from "@/lib/coach/actions";
import { forgetLoggedEntry } from "@/lib/log/delete-entry";
import { isCompleteEntryRow, serverFields } from "@/lib/log/entry-row";
import { buildCommitRequest } from "@/lib/log-client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { commitNutritionUnchecked } from "@/lib/nutrition-display";
import { saveRecipe } from "@/lib/recipes-client";
import { addExtra, getDay, loadStore, updateExtra } from "@/lib/store";
import { allOps, getRow, type QueuePrecondition } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";
import { latestQueued, retryStaleRead, unchangedSince } from "@/lib/sync/row-queue";
import { browserClient } from "@/lib/supabase/client";
import type { LoggedFood, LoggedItem, SlotId } from "@/lib/types";
import {
  instantAt, revisionRef, type ApplyContext, type ApplyResult, type UndoOutcome, type UndoToken,
} from "@/lib/coach/apply-shared";

/** The date an entry sits on, found in their own store — the action carries only the id. */
function dateOf(entryId: string): { date: string; entry: LoggedFood } | null {
  const store = loadStore();
  for (const [date, day] of Object.entries(store.days)) {
    const entry = day.extras?.find((extra) => extra.id === entryId);
    if (entry) return { date, entry };
  }
  return null;
}

/** A mirrored item carries its catalog revision; a bundled one does not. */
function revisionOf(item: unknown): number | null {
  const value = (item as { food_revision_id?: unknown }).food_revision_id;
  return typeof value === "number" ? value : null;
}

/**
 * The exact per-unit numbers a per-unit snapshot carries (`per_unit`, t17 round 4) — never an
 * amount divided back by qty, which would bring its rounding with it. Undefined when there are
 * none (unknown nutrients stay unknown on the restored entry).
 */
function perUnitOf(snapshot: LoggedItem["snapshot"]): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(snapshot ?? {})) {
    const exact = value?.basis === "per_unit" ? value.per_unit : undefined;
    if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) out[code] = exact;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Everything Undo needs to put the entry back as it was: its slot, its time, its title and its
 * items with their own amounts (audit 2026-10-10 A028/A037: the restore dropped the title and
 * rewrote "2 eggs" as "100 g").
 */
function originals(entry: LoggedFood, wire: EntryWire) {
  return {
    slot: wire.slot, eatenAt: entry.at,
    ...(wire.title !== undefined ? { title: wire.title } : {}),
    items: (entry.items ?? []).map((item) => {
      const stored = wire.items.get(item.id) ?? {};
      return item.grams === null
        // An unknown mass (t17): its count, and the per-unit numbers its snapshot was built from.
        ? { foodRefId: item.food_ref_id, grams: null, name: item.name, revisionId: null,
          qty: item.qty, unit: item.unit, perUnit: perUnitOf(item.snapshot), ...stored }
        : { foodRefId: item.food_ref_id, grams: item.grams, name: item.name,
          revisionId: revisionOf(item), qty: item.qty, unit: item.unit, ...stored };
    }),
  };
}

export async function applyDeleteEntry(
  action: Extract<CoachAction, { kind: "delete_entry" }>, ctx: ApplyContext,
): Promise<ApplyResult> {
  const h = accountHandle();
  const found = dateOf(action.entryId);
  if (!found) return { status: "failed", reason: "That entry is not on this phone." };
  const wire = await wireOfEntry(h, action.entryId, found.entry);
  await forgetLoggedEntry(found.date, action.entryId, h);
  return { status: "applied", token: { kind: "delete_entry", date: found.date,
    entry: { ...found.entry, tz: ctx.tz }, ...originals(found.entry, wire) } };
}

const SLOTS: readonly string[] = ["coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2",
  "meal-3", "meal-4", "meal-5", "meal-6", "hot-chocolate", "snack"];

function asSlot(value: unknown): SlotId | "snack" | null {
  return typeof value === "string" && SLOTS.includes(value) ? value as SlotId | "snack" : null;
}

/**
 * The slot the entry belonged to.
 *
 * A `LoggedFood` on the phone NEVER carries one — Today orders extras by their time, so the field
 * does not exist on the card — and reading `entry.slot` therefore made every undo a snack
 * (Grok pass 2, HIGH 2). The slot lives on the wire: in the mirrored `log_entries` row, or, for a
 * commit that has not settled yet, in the create op still sitting in the outbox. Only an entry
 * that neither knows about falls through to "snack".
 *
 * It must be read BEFORE the delete, which takes the mirror row and the queued op with it.
 */
type StoredItem = { portionId?: number | null; wasEdited?: boolean };
type EntryWire = { slot: SlotId | "snack"; title?: string | null; items: Map<string, StoredItem> };

/** The stored title: a string, or null for an untitled row; undefined when the row has no field. */
function titleOf(row: Record<string, unknown>): string | null | undefined {
  if (typeof row.title === "string") return row.title.trim() ? row.title : null;
  return row.title === null ? null : undefined;
}

/** Each stored item's portion and edit mark, by item id. */
function storedItems(row: Record<string, unknown>): Map<string, StoredItem> {
  const items = Array.isArray(row.items) ? row.items as Record<string, unknown>[] : [];
  return new Map(items.flatMap((item): [string, StoredItem][] => typeof item?.id !== "string" ? []
    : [[item.id, {
      ...(typeof item.portion_id === "number" || item.portion_id === null
        ? { portionId: item.portion_id as number | null } : {}),
      ...(typeof item.was_edited === "boolean" ? { wasEdited: item.was_edited } : {}),
    }]]));
}

/**
 * The wire half of the entry: its slot, its title and its items' portions — read from the
 * newest queued create or update, else the mirrored row. With neither, the card's own name is the
 * title it showed, so it is kept.
 */
async function wireOfEntry(h: AccountHandle, entryId: string, entry: LoggedFood): Promise<EntryWire> {
  const rows: Record<string, unknown>[] = [];
  try {
    const queued = (await allOps(h))
      .filter((op) => op.entity === "log_entries" && op.entity_id === entryId
        && (op.kind === "create" || op.kind === "update"))
      .sort((a, b) => b.seq - a.seq)[0];
    if (queued?.payload && typeof queued.payload === "object") {
      rows.push(queued.payload as Record<string, unknown>);
    }
  } catch (e) { rethrowAccountChanged(e); /* fall through to the mirror */ }
  try {
    const row = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
    if (row) rows.push(row);
  } catch (e) {
    rethrowAccountChanged(e); // a blocked database is not evidence of a snack
  }
  const slot = rows.map((row) => asSlot(row.slot)).find((value) => value !== null) ?? "snack";
  const title = rows.map(titleOf).find((value) => value !== undefined);
  const items = rows.map(storedItems).find((map) => map.size > 0) ?? new Map<string, StoredItem>();
  return { slot, title: rows.length > 0 ? title : entry.name, items };
}

/**
 * Put back what was deleted. The delete is a durable tombstone on the original id, so the entry
 * comes back as a NEW one with the same contents at the same time — which is what the user asked for.
 */
export async function undoDeleteEntry(
  token: Extract<UndoToken, { kind: "delete_entry" }>,
): Promise<UndoOutcome> {
  const h = accountHandle();
  const entry = token.entry;
  if (token.items.length === 0) throw new Error("That entry cannot be put back.");
  const entryId = crypto.randomUUID();
  const itemIds = token.items.map(() => crypto.randomUUID());
  const request = { ...buildCommitRequest({
    // The ORIGINALS: their slot, their time, their title, their items with their revisions and
    // amounts. Only the id is new, because the delete left a tombstone on the old one (Grok
    // pass 1, HIGH 8). A token minted before the title and amounts were kept restores as before.
    entryId, eatenAt: new Date(token.eatenAt), tz: entry.tz ?? "UTC", slot: token.slot,
    note: entry.note, method: "text",
    ...(token.title !== undefined ? { title: token.title } : {}),
    items: token.items.map((item, index) => (item.grams === null
      ? { id: itemIds[index], foodRefId: item.foodRefId, revision: { revision_id: null },
        grams: null, qty: item.qty ?? 1, unit: item.unit ?? "each", portionId: item.portionId ?? null,
        ...(item.wasEdited !== undefined ? { wasEdited: item.wasEdited } : {}),
        ...(item.perUnit ? { perUnit: item.perUnit } : {}) }
      : { id: itemIds[index], foodRefId: item.foodRefId, revision: revisionRef(item.revisionId),
        grams: item.grams, qty: item.qty ?? item.grams, unit: item.unit ?? "g",
        portionId: item.portionId ?? null,
        ...(item.wasEdited !== undefined ? { wasEdited: item.wasEdited } : {}) })),
  }), local_date: token.date };
  const result = await commitLogEntry(request, { account: h });
  if (result.status !== "ok" && result.status !== "queued") {
    throw new Error("That entry did not come back.");
  }
  assertCurrent(h);
  addExtra(token.date, { ...entry, id: entryId, at: token.eatenAt,
    items: (entry.items ?? []).map((item, index) => ({ ...item, id: itemIds[index] })) });
  return commitNutritionUnchecked(result) ? { nutritionUnchecked: true } : undefined;
}

/** The complete normalized row an update has to POST back, the way `saveExtraNote` finds it, and
 *  the check its write makes that the queued op or mirror it was read from still stands. */
async function completeRow(h: AccountHandle, entryId: string, entry: LoggedFood):
  Promise<{ row: Record<string, unknown> | null; unchanged: QueuePrecondition }> {
  const pending = latestQueued(await allOps(h), "log_entries", entryId);
  if (pending?.kind === "delete") throw new Error("This entry has been removed.");
  const mirrored = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
  let row = mirrored;
  if (pending) row = { ...pending.payload, rev: (pending.base_rev ?? 0) + 1 };
  if (!row && entry.items?.some((item) => !item.food_ref_id.startsWith("local:"))) {
    const result = await withAccount(h, () => browserClient().from("log_entries")
      .select("*, items:log_items(*)").eq("id", entryId).maybeSingle());
    if (result.error || !result.data) throw new Error("Could not load the entry to move it.");
    row = result.data as Record<string, unknown>;
  }
  return { row: row ?? null, unchanged: unchangedSince("log_entries", entryId, pending, mirrored?.rev) };
}

/** A move carries the entry's note unchanged, so on a conflict the other device's note stands
 *  rather than being joined to the one this move copied (audit 2026-10-10 A077). */
function noteBaseOf(row: Record<string, unknown>): string | null {
  return typeof row.note === "string" && row.note.trim() ? row.note.trim() : null;
}

/** The fields a move changes, as the row held them before it: what a conflict rebase compares
 *  against to keep the move's new time (lib/sync/log-entry-ops.ts `movedFields`). */
function moveBaseOf(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

export async function retime(
  h: AccountHandle,
  entryId: string, date: string, at: string, tz: string,
): Promise<void> {
  const entry = getDay(date)?.extras?.find((extra) => extra.id === entryId);
  if (!entry) throw new Error("That entry is not on this phone.");
  const eatenAt = instantAt(date, at, tz);
  if (!eatenAt) throw new Error(`${at} is not a time on ${date}.`);
  await retryStaleRead(async () => {
    const { row, unchanged } = await completeRow(h, entryId, entry);
    if (!row) return;
    if (!isCompleteEntryRow(row)) throw new Error("The entry is not ready for editing.");
    const rev = row.rev as number;
    const payload = { ...serverFields(row), id: entryId,
      eaten_at: eatenAt.toISOString(), local_date: date, tz };
    await enqueueWithRow(h, { ...payload, rev: rev + 1 }, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: entryId,
      kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
      note_base: noteBaseOf(row), base_fields: moveBaseOf(row, ["eaten_at", "local_date", "tz"]),
    }, Date.now(), unchanged);
  });
  assertCurrent(h);
  updateExtra(date, entryId, { at: eatenAt.toISOString() });
}

export async function applyMoveEntry(
  action: Extract<CoachAction, { kind: "move_entry" }>, ctx: ApplyContext,
): Promise<ApplyResult> {
  const h = accountHandle();
  const found = dateOf(action.entryId);
  if (!found) return { status: "failed", reason: "That entry is not on this phone." };
  const previousAt = found.entry.at;
  await retime(h, action.entryId, found.date, action.at, ctx.tz);
  return { status: "applied", token: { kind: "move_entry", date: found.date,
    entryId: action.entryId, previousAt } };
}

export async function undoMoveEntry(
  token: Extract<UndoToken, { kind: "move_entry" }>,
): Promise<void> {
  const h = accountHandle();
  const entry = getDay(token.date)?.extras?.find((extra) => extra.id === token.entryId);
  if (!entry) throw new Error("That entry is not on this phone.");
  const clock = new Date(token.previousAt);
  await retryStaleRead(async () => {
    const { row, unchanged } = await completeRow(h, token.entryId, entry);
    if (!row) return;
    if (!isCompleteEntryRow(row)) throw new Error("The entry is not ready for editing.");
    const rev = row.rev as number;
    const payload = { ...serverFields(row), id: token.entryId, eaten_at: token.previousAt };
    await enqueueWithRow(h, { ...payload, rev: rev + 1 }, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: token.entryId,
      kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
      note_base: noteBaseOf(row), base_fields: moveBaseOf(row, ["eaten_at", "local_date", "tz"]),
    }, Date.now(), unchanged);
  });
  assertCurrent(h);
  updateExtra(token.date, token.entryId, { at: clock.toISOString() });
}

export async function applySaveRecipe(
  action: Extract<CoachAction, { kind: "save_recipe" }>,
): Promise<ApplyResult> {
  const allowed = action.items.filter((item) => item.verdict === "allowed");
  const rejected = action.items.filter((item) => item.verdict !== "allowed");
  if (rejected.length > 0 && action.refusals === undefined) {
    return { status: "failed", reason: "Could not verify this recipe; try again." };
  }
  const notices = action.refusals ?? [];
  if (allowed.length === 0) {
    return { status: "failed",
      reason: notices.join(" ") || "No verified ingredients remain, so the recipe was not saved." };
  }
  const { recipeId, rev } = await saveRecipe({
    name: action.name, servings: 1,
    items: allowed.map((item, index) => ({
      seq: index + 1, foodRefId: item.foodRefId, qty: item.grams, unit: "g",
      grams: item.grams, state: "raw" as const,
      foodRevisionId: item.catalogFoodRevisionId ?? null,
      per100g: {
        energy_kcal: item.kcalPer100g, protein: item.proteinPer100g,
        carbohydrate: item.carbsPer100g, fat_total: item.fatPer100g,
      } as never,
    })),
  });
  return {
    status: "applied", token: { kind: "save_recipe", recipeId, rev },
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/** Undo a recipe by deleting the revision it created — the same soft delete the Foods tab queues. */
export async function undoSaveRecipe(
  token: Extract<UndoToken, { kind: "save_recipe" }>,
): Promise<void> {
  const h = accountHandle();
  const { enqueue } = await import("@/lib/sync/outbox");
  const { putRow } = await import("@/lib/sync/idb");
  const existing = (await getRow(h, "recipes", token.recipeId)) as Record<string, unknown> | undefined;
  await putRow(h, "recipes", token.recipeId,
    { ...existing, deleted_at: new Date().toISOString(), rev: token.rev + 1 });
  await enqueue(h, {
    op_id: crypto.randomUUID(), entity: "recipes", entity_id: token.recipeId,
    kind: "delete", base_rev: token.rev, payload: {}, client_ts: new Date().toISOString(),
  });
}
