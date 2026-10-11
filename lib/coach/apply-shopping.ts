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
const SHOPPING_RETRY_REASON = "Those items did not save. Try again.";
/** W020: lines that saved before an account switch stay on that account's list and the card has
 *  no Undo for them. "May": a switch inside one try loses that try's answer, so the apply cannot
 *  tell which lines landed. No item names: the card may already show for the account that took over. */
export const SHOPPING_SWITCH_PARTIAL_REASON = "The account changed while adding. Some items may "
  + "have been added before the change, and this card can't undo them. Remove them in Shopping.";

/** The apply's AccountChanged once an add was sent: still an account change to every caller
 *  (`instanceof`), but its message, which the card shows, reports the possible partial add. */
class ShoppingAddInterrupted extends AccountChanged {
  constructor() { super(); this.message = SHOPPING_SWITCH_PARTIAL_REASON; }
}

function uniqueLines(lines: readonly ShoppingLine[]): ShoppingLine[] {
  return [...new Map(lines.map((line) => [line.id, line])).values()];
}

function namesOf(lines: readonly ShoppingLine[]): string {
  const names = lines.map((line) => line.name);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** W020: a rollback that could not take every line back leaves a partial add the card cannot
 *  undo (the result carries no token), so it says which lines stayed and where to remove them. */
function leftBehindReason(kept: readonly ShoppingLine[]): string {
  if (kept.length === 0) return SHOPPING_RETRY_REASON;
  const one = kept.length === 1;
  return `Not every item saved. ${namesOf(kept)} ${one ? "is" : "are"} still on your list, `
    + `and this card can't undo ${one ? "it" : "them"}. Remove ${one ? "it" : "them"} in Shopping.`;
}

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
    // From here on a switch can leave lines behind; before here (the gate) it wrote nothing.
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
    // No rollback under another account: the saved lines belong to the account that left, and
    // the card says part of the add may have stayed (W020).
    if (error instanceof AccountChanged) throw new ShoppingAddInterrupted();
    // Also when the retry itself throws (round 9): what did save is taken back, and any line that
    // could not be taken back is named, since nothing can undo it from this card (W020).
    const taken = uniqueLines(saved);
    const rollback = await Promise.allSettled(taken.map((line) => deleteShoppingLine(line, account)));
    // A switch during the rollback: never name this account's items to the one that took over.
    if (rollback.some((result) => result.status === "rejected" && result.reason instanceof AccountChanged)) {
      throw new ShoppingAddInterrupted();
    }
    const kept = taken.filter((_, index) => rollback[index].status === "rejected");
    return { status: "failed", reason: leftBehindReason(kept) };
  }
  return { status: "applied", token: { kind: "add_to_shopping_list", lines: uniqueLines(saved) } };
}

/** Deletes every line the action created; a line the user already removed is simply gone. */
export async function undoAddToShoppingList(token: ShoppingToken): Promise<void> {
  await Promise.all(token.lines.map((line: ShoppingLine) => deleteShoppingLine(line)));
}
