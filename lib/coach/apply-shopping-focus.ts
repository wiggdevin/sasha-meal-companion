"use client";

/**
 * `set_shopping_focus`'s write and its Undo (Phase 18 W11, D7): a POST to `/api/shopping/focus`,
 * the server deciding the actual timestamp (`resolveFocusEnd`) and recording the value it
 * replaced. Undo sends only the write's `actionId`; the server restores its own recorded value,
 * compare-and-set (never over a later choice), so the phone never sends a timestamp.
 *
 * Shopping is gated per account (`lib/recipe-access-client.ts`, mirroring the server's
 * `recipeAccessEnabled`): checked before the write so a disabled account gets one clear reason
 * (acceptance 4), never a request that reaches the server only to fail there.
 */
import type { CoachAction } from "@/lib/coach/actions";
import type { ApplyResult, UndoToken } from "@/lib/coach/apply-shared";
import { accountHandle } from "@/lib/device/account";
import { recipeAccessForCurrentAccount } from "@/lib/recipe-access-client";
import { undoShoppingFocusWrite, writeShoppingFocus } from "@/lib/shopping/focus-client";

export const SHOPPING_FOCUS_UNAVAILABLE_REASON = "Shopping isn't available for this account yet.";

type FocusAction = Extract<CoachAction, { kind: "set_shopping_focus" }>;
type FocusToken = Extract<UndoToken, { kind: "set_shopping_focus" }>;

export async function applySetShoppingFocus(action: FocusAction): Promise<ApplyResult> {
  const enabled = await recipeAccessForCurrentAccount();
  if (!enabled) return { status: "failed", reason: SHOPPING_FOCUS_UNAVAILABLE_REASON };
  try {
    const { actionId } = await writeShoppingFocus(accountHandle(), action.on, action.days);
    return { status: "applied", token: { kind: "set_shopping_focus", actionId } };
  } catch {
    return { status: "failed", reason: "That didn't save. Try again." };
  }
}

/** Undoes exactly this write; throws `ShoppingFocusSuperseded` when a later choice is in place. */
export async function undoSetShoppingFocus(token: FocusToken): Promise<void> {
  await undoShoppingFocusWrite(accountHandle(), token.actionId);
}
