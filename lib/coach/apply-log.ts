"use client";

/** The log half of a coach action: commit an entry, and undo it. T6 §6. */

import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import type { CoachAction } from "@/lib/coach/actions";
import { deriveMealTitle, sanitizeMealTitle } from "@/lib/coach/meal-title";
import { buildCommitRequest } from "@/lib/log-client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { commitNutritionUnchecked } from "@/lib/nutrition-display";
import { resolveDay } from "@/lib/resolve";
import { addExtra, loadStore, removeExtra } from "@/lib/store";
import { isCompleteEntryRow } from "@/lib/log/entry-row";
import { allOps, getRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import type { FoodComponent, LoggedFood } from "@/lib/types";
import {
  componentsFor, dateInZone, instantAt, revisionRef, round1, sum,
  type ApplyContext, type ApplyResult, type UndoToken,
} from "@/lib/coach/apply-shared";

type LogAction = Extract<CoachAction, { kind: "log_meal" }>;

function localExtra(action: LogAction, entryId: string,
  itemIds: string[], eatenAt: Date, title: string, components: FoodComponent[]): LoggedFood {
  const grams = round1(action.items.reduce((total, item) => total + item.grams, 0));
  const count = action.items.length;
  return {
    id: entryId, foodId: "meal", name: title, slot: action.slot, qty: 1, grams,
    portionLabel: `${count} item${count === 1 ? "" : "s"}`,
    macros: sum(components), flags: action.flagged.length ? action.flagged : undefined,
    note: action.note?.trim() || undefined, at: eatenAt.toISOString(),
    items: action.items.map((item, index) => ({
      id: itemIds[index], seq: index + 1, food_ref_id: item.foodRefId,
      grams: item.grams, qty: item.grams, unit: "g", snapshot: {}, foodId: item.foodRefId,
      name: item.name, portionLabel: `${item.grams} g`, macros: components[index].macros,
    })),
  };
}

/**
 * When the meal happened, in THEIR timezone (T6 §3). `at` wins over everything: it is the time the user
 * said. A snack is an extra, not a slot, so it has no planned time and lands now.
 */
function eatenAtFor(action: LogAction, ctx: ApplyContext): Date | null {
  const now = ctx.now ?? new Date();
  if (action.at) return instantAt(action.date, action.at, ctx.tz);
  let time: string | undefined;
  if (action.slot !== "snack") {
    try {
      time = resolveDay(loadStore(), action.date).slots
        .find((slot) => slot.slot === action.slot)?.time;
    } catch { /* The today fallback below is still valid when a plan cannot be read. */ }
  }
  if (time) return instantAt(action.date, time, ctx.tz);
  if (dateInZone(now, ctx.tz) === action.date) return now;
  // A past date with no planned time still needs one instant; midday is the honest default.
  return action.slot === "snack" ? instantAt(action.date, "12:00", ctx.tz) : null;
}

export async function applyLog(action: LogAction, ctx: ApplyContext): Promise<ApplyResult> {
  const h = accountHandle();
  const title = action.title ? sanitizeMealTitle(action.title) : deriveMealTitle(action.items);
  if (!title) return { status: "failed", reason: "That meal needs a dish name." };
  const eatenAt = eatenAtFor(action, ctx);
  if (!eatenAt) return { status: "failed", reason: `No planned time was found for ${action.slot}.` };
  // Checked before the commit: a card summing an unknown nutrient as zero would read as measured.
  const lines = componentsFor(action.items);
  if (!lines.ok) return { status: "failed", reason: lines.reason };

  const entryId = crypto.randomUUID();
  const itemIds = action.items.map(() => crypto.randomUUID());
  const request = { ...buildCommitRequest({
    entryId, eatenAt, tz: ctx.tz, slot: action.slot, note: action.note,
    title, method: "text",
    items: action.items.map((item, index) => ({
      id: itemIds[index], foodRefId: item.foodRefId,
      revision: revisionRef(item.catalogFoodRevisionId), grams: item.grams,
      qty: item.grams, unit: "g", portionId: null,
    })),
  }), local_date: action.date };
  const result = await commitLogEntry(request, { fetchImpl: ctx.fetchImpl, account: h });
  if (result.status !== "ok" && result.status !== "queued") {
    return { status: "failed", reason: `The meal did not save (${result.status.replace(/_/g, " ")}).` };
  }
  // The save hook fires; Today sees the accepted meal immediately. A pull may already have put this
  // entry's server card on the day: that card is newer than ours, and one entry is never two cards.
  assertCurrent(h);
  const shown = loadStore().days?.[action.date]?.extras?.some((extra) => extra.id === entryId);
  if (!shown) addExtra(action.date, localExtra(action, entryId, itemIds, eatenAt, title, lines.components));
  const baseRev = result.status === "ok" ? result.rev : null;
  return { status: "applied",
    token: { kind: "log_meal", date: action.date, entryId, baseRev, eatenAt: eatenAt.toISOString() },
    ...(commitNutritionUnchecked(result) ? { nutritionUnchecked: true as const } : {}) };
}

export async function logDeleteBaseRev(h: AccountHandle, entryId: string, known: number | null): Promise<number> {
  if (known !== null) return known;
  const pending = (await allOps(h)).filter((op) =>
    op.entity === "log_entries" && op.entity_id === entryId
      && (op.kind === "create" || op.kind === "update"))
    .sort((a, b) => b.seq - a.seq)[0];
  if (pending) return (pending.base_rev ?? 0) + 1;
  const row = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
  // The same bar the note path uses: a revision beside items that name no food is not a base.
  if (isCompleteEntryRow(row)) return row!.rev as number;
  throw new Error("That meal is not ready to undo yet.");
}

export async function undoLog(token: Extract<UndoToken, { kind: "log_meal" }>): Promise<void> {
  const h = accountHandle();
  const clientTs = new Date().toISOString();
  const baseRev = await logDeleteBaseRev(h, token.entryId, token.baseRev);
  await enqueue(h, {
    op_id: crypto.randomUUID(), entity: "log_entries", entity_id: token.entryId,
    kind: "delete", base_rev: baseRev, payload: {}, client_ts: clientTs,
  });
  assertCurrent(h);
  removeExtra(token.date, token.entryId);
}
