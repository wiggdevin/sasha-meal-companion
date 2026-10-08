"use client";

/**
 * `set_shopping_focus`'s write and its Undo (Phase 18 W11, D7): a thin POST to
 * `/api/shopping/focus`, the server deciding the actual timestamp (`resolveFocusEnd`) and
 * returning the value it replaced — Undo puts that exact value back, never a guess.
 *
 * Shopping is gated per account (`lib/recipe-access-client.ts`, mirroring the server's
 * `recipeAccessEnabled`): checked before the write so a disabled account gets one clear reason
 * (acceptance 4), never a request that reaches the server only to fail there.
 */
import type { CoachAction } from "@/lib/coach/actions";
import type { ApplyResult, UndoToken } from "@/lib/coach/apply-shared";
import { accountFetch, accountHandle, accountJson } from "@/lib/device/account";
import { recipeAccessForCurrentAccount } from "@/lib/recipe-access-client";

export const SHOPPING_FOCUS_UNAVAILABLE_REASON = "Shopping isn't available for this account yet.";

type FocusAction = Extract<CoachAction, { kind: "set_shopping_focus" }>;
type FocusToken = Extract<UndoToken, { kind: "set_shopping_focus" }>;

async function postFocus(body: Record<string, unknown>):
  Promise<{ until: string | null; previous: string | null }> {
  const h = accountHandle();
  const res = await accountFetch(h, "/api/shopping/focus", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, { budget: "prefs" });
  if (!res.ok) throw new Error("shopping-focus request failed");
  return accountJson(h, res);
}

export async function applySetShoppingFocus(action: FocusAction): Promise<ApplyResult> {
  const enabled = await recipeAccessForCurrentAccount();
  if (!enabled) return { status: "failed", reason: SHOPPING_FOCUS_UNAVAILABLE_REASON };
  try {
    const { previous } = await postFocus({ on: action.on,
      ...(action.days !== undefined ? { days: action.days } : {}) });
    return { status: "applied", token: { kind: "set_shopping_focus", previousUntil: previous } };
  } catch {
    return { status: "failed", reason: "That didn't save. Try again." };
  }
}

/** Puts back the EXACT `shopping_focus_until` this action replaced — on, off or untouched —
 *  never a re-derived "N days from now", which would not reproduce the original timestamp. */
export async function undoSetShoppingFocus(token: FocusToken): Promise<void> {
  await postFocus({ on: token.previousUntil !== null, exact: token.previousUntil });
}
