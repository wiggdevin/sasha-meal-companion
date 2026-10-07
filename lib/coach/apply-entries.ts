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
import { allOps, getRow } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";
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

/** Everything Undo needs to put the entry back as it was: its slot, its time, its items. */
function originals(entry: LoggedFood, slot: SlotId | "snack") {
  return {
    slot, eatenAt: entry.at,
    items: (entry.items ?? []).map((item) => (item.grams === null
      // An unknown mass (t17): its count, and the per-unit numbers its snapshot was built from.
      ? { foodRefId: item.food_ref_id, grams: null, name: item.name, revisionId: null,
        qty: item.qty, unit: item.unit, perUnit: perUnitOf(item.snapshot) }
      : { foodRefId: item.food_ref_id, grams: item.grams, name: item.name,
        revisionId: revisionOf(item) })),
  };
}

export async function applyDeleteEntry(
  action: Extract<CoachAction, { kind: "delete_entry" }>, ctx: ApplyContext,
): Promise<ApplyResult> {
  const h = accountHandle();
  const found = dateOf(action.entryId);
  if (!found) return { status: "failed", reason: "That entry is not on this phone." };
  const slot = await slotOfEntry(h, action.entryId);
  await forgetLoggedEntry(found.date, action.entryId, h);
  return { status: "applied", token: { kind: "delete_entry", date: found.date,
    entry: { ...found.entry, tz: ctx.tz }, ...originals(found.entry, slot) } };
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
async function slotOfEntry(h: AccountHandle, entryId: string): Promise<SlotId | "snack"> {
  try {
    const row = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
    const mirrored = asSlot(row?.slot);
    if (mirrored) return mirrored;
  } catch (e) {
    rethrowAccountChanged(e); // a blocked database is not evidence of a snack; try the outbox
  }
  try {
    const queued = (await allOps(h))
      .filter((op) => op.entity === "log_entries" && op.entity_id === entryId
        && (op.kind === "create" || op.kind === "update"))
      .sort((a, b) => b.seq - a.seq)[0];
    const pending = asSlot((queued?.payload as { slot?: unknown } | undefined)?.slot);
    if (pending) return pending;
  } catch (e) { rethrowAccountChanged(e); /* fall through */ }
  return "snack";
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
    // The ORIGINALS: their slot, their time, their items with their revisions. Only the id is new,
    // because the delete left a tombstone on the old one (Grok pass 1, HIGH 8).
    entryId, eatenAt: new Date(token.eatenAt), tz: entry.tz ?? "UTC", slot: token.slot,
    note: entry.note, method: "text",
    items: token.items.map((item, index) => (item.grams === null
      ? { id: itemIds[index], foodRefId: item.foodRefId, revision: { revision_id: null },
        grams: null, qty: item.qty ?? 1, unit: item.unit ?? "each", portionId: null,
        ...(item.perUnit ? { perUnit: item.perUnit } : {}) }
      : { id: itemIds[index], foodRefId: item.foodRefId, revision: revisionRef(item.revisionId),
        grams: item.grams, qty: item.grams, unit: "g", portionId: null })),
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

/** The complete normalized row an update has to POST back, the way `saveExtraNote` finds it. */
async function completeRow(h: AccountHandle, entryId: string, entry: LoggedFood):
  Promise<Record<string, unknown> | null> {
  const pending = (await allOps(h))
    .filter((op) => op.entity === "log_entries" && op.entity_id === entryId)
    .sort((a, b) => b.seq - a.seq)[0];
  if (pending?.kind === "delete") throw new Error("This entry has been removed.");
  let row = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
  if (pending) row = { ...pending.payload, rev: (pending.base_rev ?? 0) + 1 };
  if (!row && entry.items?.some((item) => !item.food_ref_id.startsWith("local:"))) {
    const result = await withAccount(h, () => browserClient().from("log_entries")
      .select("*, items:log_items(*)").eq("id", entryId).maybeSingle());
    if (result.error || !result.data) throw new Error("Could not load the entry to move it.");
    row = result.data as Record<string, unknown>;
  }
  return row ?? null;
}

export async function retime(
  h: AccountHandle,
  entryId: string, date: string, at: string, tz: string,
): Promise<void> {
  const entry = getDay(date)?.extras?.find((extra) => extra.id === entryId);
  if (!entry) throw new Error("That entry is not on this phone.");
  const eatenAt = instantAt(date, at, tz);
  if (!eatenAt) throw new Error(`${at} is not a time on ${date}.`);
  const row = await completeRow(h, entryId, entry);
  if (row) {
    if (!isCompleteEntryRow(row)) throw new Error("The entry is not ready for editing.");
    const rev = row.rev as number;
    const payload = { ...serverFields(row), id: entryId,
      eaten_at: eatenAt.toISOString(), local_date: date, tz };
    await enqueueWithRow(h, { ...payload, rev: rev + 1 }, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: entryId,
      kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
    });
  }
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
  const row = await completeRow(h, token.entryId, entry);
  if (row) {
    if (!isCompleteEntryRow(row)) throw new Error("The entry is not ready for editing.");
    const rev = row.rev as number;
    const payload = { ...serverFields(row), id: token.entryId, eaten_at: token.previousAt };
    await enqueueWithRow(h, { ...payload, rev: rev + 1 }, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: token.entryId,
      kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
    });
  }
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
