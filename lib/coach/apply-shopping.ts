"use client";

/**
 * `add_to_shopping_list`'s write and its Undo: the same manual-line client the Foods tab's own
 * Shopping screen uses (`lib/shopping-client.ts`), so a coach-added line is an ordinary manual line
 * — nothing about it says the coach wrote it.
 *
 * Shopping is gated per account (`lib/recipe-access-client.ts` `recipeAccessForCurrentAccount`,
 * mirroring the server's `recipeAccessEnabled`): checked before the write so a disabled account
 * gets one clear reason instead of a client write failing partway through.
 */

import type { CoachAction } from "@/lib/coach/actions";
import { dateInZone, type ApplyContext, type ApplyResult, type UndoToken } from "@/lib/coach/apply-shared";
import { AccountChanged, accountHandle } from "@/lib/device/account";
import { recipeAccessForCurrentAccount } from "@/lib/recipe-access-client";
import { addToCurrentShoppingList, deleteShoppingLine } from "@/lib/shopping-client";
import type { ShoppingLine } from "@/lib/shopping/types";

export const SHOPPING_UNAVAILABLE_REASON = "Shopping isn't available for this account yet.";

type ShoppingAction = Extract<CoachAction, { kind: "add_to_shopping_list" }>;
type ShoppingToken = Extract<UndoToken, { kind: "add_to_shopping_list" }>;

function today(ctx: Pick<ApplyContext, "tz" | "now">): string | null {
  const tz = ctx.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dateInZone(ctx.now ?? new Date(), tz);
}

export async function applyAddToShoppingList(
  action: ShoppingAction, ctx: ApplyContext,
): Promise<ApplyResult> {
  // One account for the whole apply (audit 2026-10-08 §4): the gate, both tries and the rollback
  // all run as the account bound when the apply started. A switch part-way throws AccountChanged
  // (the apply path's existing contract) instead of writing to the new account's list.
  const account = accountHandle();
  const enabled = await recipeAccessForCurrentAccount(account);
  if (!enabled) return { status: "failed", reason: SHOPPING_UNAVAILABLE_REASON };
  const date = today(ctx);
  if (!date) return { status: "failed", reason: "Could not read today's date." };
  // One id per item for both tries (DeepSeek audit round 9): the retry of an add that saved but
  // lost its answer gets that same row back, never a second one.
  const ids = new Map(action.names.map((name) => [name, crypto.randomUUID()]));
  const idsOf = (names: readonly string[]) => names.map((name) => ids.get(name) ?? crypto.randomUUID());
  const saved: ShoppingLine[] = [];
  try {
    const first = await addToCurrentShoppingList(action.names, date, ctx.tz, idsOf(action.names), account);
    saved.push(...first.lines);
    // One retry for what failed; if anything still did not save, the card says so and the saved
    // part is taken back, so the list never holds half of an add the card calls failed (DeepSeek
    // audit round 8: a partial-add notice reached no screen).
    if (first.failed.length > 0) {
      const retry = await addToCurrentShoppingList(first.failed, date, ctx.tz, idsOf(first.failed), account);
      saved.push(...retry.lines);
      if (retry.failed.length > 0) throw new Error("partial add");
    }
  } catch (error) {
    // No rollback under another account: the saved lines belong to the account that left.
    if (error instanceof AccountChanged) throw error;
    // Also when the retry itself throws (round 9): what did save is taken back.
    await Promise.allSettled(saved.map((line) => deleteShoppingLine(line, account)));
    return { status: "failed", reason: "Those items did not save. Try again." };
  }
  const lines = [...new Map(saved.map((line) => [line.id, line])).values()];
  return { status: "applied", token: { kind: "add_to_shopping_list", lines } };
}

/** Deletes every line the action created; a line the user already removed is simply gone. */
export async function undoAddToShoppingList(token: ShoppingToken): Promise<void> {
  await Promise.all(token.lines.map((line: ShoppingLine) => deleteShoppingLine(line)));
}
