"use client";

import type { PantryItem, ShoppingLine, ShoppingPeriod, ShoppingPurchaseWindow } from "@/lib/shopping/types";
import { AccountChanged, accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { defaultShoppingDraft, type ShoppingDraft, type ShoppingPreviewInput } from "@/lib/shopping/contracts";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import { identityKey } from "@/lib/shopping/aggregate";
import type { ShoppingPreviewResult } from "@/lib/shopping/preview-contract";
import { withRuleMark, withRuleMarks } from "@/lib/shopping/rule-mark-wire";
import { refreshShoppingFocus } from "@/lib/shopping/focus-client";
import { currentShoppingPeriod } from "@/lib/shopping/current";

export type ShoppingSnapshot = { period: ShoppingPeriod | null; lines: ShoppingLine[];
  purchaseWindows?: ShoppingPurchaseWindow[] };
export class ShoppingStaleRevision extends Error {
  constructor() { super("Shopping changed elsewhere."); this.name = "ShoppingStaleRevision"; }
}
/** A shopping route answered the request with `status`: unlike a transport failure, a deadline or
 *  an unreadable body, the caller knows how the server decided (W020). */
export class ShoppingRequestFailed extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ShoppingRequestFailed"; }
}
/** The status a shopping route answered a failed request with, or null when no answer was read:
 *  such a write may still have landed. */
export function shoppingAnswerStatus(error: unknown): number | null {
  if (error instanceof ShoppingStaleRevision) return 409;
  if (error instanceof ShoppingRequestFailed) return error.status;
  return null;
}
/** True when the route refused the request (4xx), so it changed nothing. */
export function shoppingRefused(error: unknown): boolean {
  const status = shoppingAnswerStatus(error);
  return status !== null && status >= 400 && status < 500;
}
/** `account`: the handle a multi-step caller captured once, so every step runs as that account
 *  and a mid-flow switch throws `AccountChanged` instead of carrying on as the new one. */
async function shoppingRequest<T>(path: string, init: RequestInit = {},
  budget: "search" | "prefs" | "commit" = "prefs", account?: AccountHandle): Promise<T> {
  const h = account ?? accountHandle();
  const res = await accountFetch(h, path, { cache: "no-store", ...init }, { budget });
  if (!res.ok) {
    let body: { error?: unknown; message?: unknown } | null;
    try { body = await accountJson(h, res); }
    catch (cause) {
      if (cause instanceof AccountChanged) throw cause;
      body = null;
    }
    const code = typeof body?.error === "string" ? body.error : "";
    const message = typeof body?.message === "string" ? body.message : "";
    if (code === "stale_revision" || code === "stale_preview")
      throw new ShoppingStaleRevision();
    const fail = (text: string) => new ShoppingRequestFailed(text, res.status);
    if (code === "rule_review_required")
      throw fail("Confirm your food rules at the top of the planner, then preview again.");
    if (["needs_profile", "target_changes_in_period", "bad_period", "bad_coverage",
      "slot_unavailable", "recipe_policy_requires_review", "infeasible_plan",
      "recipe_plan_unavailable", "shopping_unavailable", "preview_unavailable"].includes(code) && message)
      throw fail(message);
    if (code === "recipe_pilot_unavailable")
      throw fail("Shopping is not available for this account yet.");
    if (res.status === 409) throw fail("Shopping changed elsewhere. Refresh and preview again.");
    throw fail(`Shopping request failed (${res.status}). Try again.`);
  }
  return accountJson<T>(h, res);
}
function body(value: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}
/** Every line of a snapshot with its `ruleMark` checked at the boundary (missing or malformed → null). */
function markSnapshot(snapshot: ShoppingSnapshot): ShoppingSnapshot {
  return { ...snapshot, lines: withRuleMarks(snapshot.lines) };
}
function periodPath(periodId: string): string {
  return `/api/shopping/periods/${encodeURIComponent(periodId)}`;
}
export async function listShoppingPeriods(startDate?: string, endDate?: string,
  account?: AccountHandle): Promise<ShoppingPeriod[]> {
  const params = new URLSearchParams();
  if (startDate) params.set("start", startDate);
  if (endDate) params.set("end", endDate);
  const query = params.size ? `?${params}` : "";
  const result = await shoppingRequest<{ periods: ShoppingPeriod[] }>(`/api/shopping/periods${query}`, {}, "search", account);
  return result.periods;
}
/** The preview's draft is strict and carries no title (a list's name is saved on the period). */
function previewDraft(draft: ShoppingDraft): Omit<ShoppingDraft, "title"> {
  const { title: _title, ...rest } = draft;
  return rest;
}
export async function previewShopping(input: ShoppingPreviewInput,
  period: ShoppingPeriod | null): Promise<ShoppingPreviewResult> {
  const result = await shoppingRequest<ShoppingPreviewResult>("/api/shopping/preview", {
    method: "POST", ...body({ ...(period ? { periodId: period.id,
      expectedRevision: period.revision } : {}), draft: previewDraft(input.draft), basket: input.basket,
      ...(input.excludeRecipeIds?.length ? { excludeRecipeIds: input.excludeRecipeIds } : {}) }),
  }, "commit");
  return { ...result, lines: withRuleMarks(result.lines) };
}
export async function acceptShopping(previewId: string, requestId: string): Promise<ShoppingSnapshot> {
  return markSnapshot(await shoppingRequest<ShoppingSnapshot>("/api/shopping/accept", {
    method: "POST", ...body({ previewId, requestId }),
  }, "commit"));
}
export async function getShoppingPeriod(periodId: string): Promise<ShoppingSnapshot> {
  return markSnapshot(await shoppingRequest<ShoppingSnapshot>(periodPath(periodId), {}, "search"));
}
export async function patchShoppingPurchaseWindow(window: ShoppingPurchaseWindow,
  patch: Partial<Pick<ShoppingPurchaseWindow, "checked" | "note">>): Promise<ShoppingPurchaseWindow> {
  const result = await shoppingRequest<{ purchaseWindow: ShoppingPurchaseWindow }>(
    `${periodPath(window.periodId)}/purchase-windows/${encodeURIComponent(window.id)}`, {
      method: "PATCH", ...body({ expectedRevision: window.revision,
        requestId: crypto.randomUUID(), patch }),
    }, "commit");
  return result.purchaseWindow;
}
export async function createShoppingPeriod(draft: ShoppingDraft,
  requestId = crypto.randomUUID(), account?: AccountHandle): Promise<ShoppingPeriod> {
  const result = await shoppingRequest<{ period: ShoppingPeriod }>("/api/shopping/periods", {
    method: "POST", ...body({ period: draft, requestId }),
  }, "commit", account);
  return result.period;
}
export async function patchShoppingLine(line: ShoppingLine, patch: ShoppingLinePatch): Promise<ShoppingLine> {
  const result = await shoppingRequest<{ line: ShoppingLine }>(
    `${periodPath(line.periodId)}/lines/${encodeURIComponent(line.id)}`, {
      method: "PATCH", ...body({ expectedRevision: line.revision,
        requestId: crypto.randomUUID(), patch }),
    }, "commit");
  // The saved line's mark is the one to show: an edit (a new name) can change it.
  return withRuleMark(result.line);
}
export async function addManualShoppingLine(periodId: string, name: string, requestId: string,
  account?: AccountHandle): Promise<ShoppingLine> {
  const line: Omit<ShoppingLine, "id" | "periodId" | "revision"> = {
    origin: "manual", name, identity: null, category: "manual", needGrams: null,
    confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
  };
  const result = await shoppingRequest<{ line: ShoppingLine }>(`${periodPath(periodId)}/lines`, {
    method: "POST", ...body({ requestId, line }),
  }, "commit", account);
  return withRuleMark(result.line);
}
/** Removes one line, plan or manual; the route keeps the row and marks it deleted. */
export async function deleteShoppingLine(line: ShoppingLine, account?: AccountHandle): Promise<void> {
  await shoppingRequest<{ deleted: true }>(`${periodPath(line.periodId)}/lines/${encodeURIComponent(line.id)}`, {
    method: "DELETE", ...body({ expectedRevision: line.revision, requestId: crypto.randomUUID() }),
  }, "commit", account);
}
/** D7: every pantry row is a shopping-focus key unless it is deleted or set to 0 g, so a pantry
 *  write re-reads the held focus keys at once (not awaited; a failed read holds no focus). */
function afterPantryWrite(h: AccountHandle): void {
  void refreshShoppingFocus(h, true);
}
export async function removePantryItem(item: PantryItem): Promise<void> {
  const h = accountHandle();
  await shoppingRequest<{ deleted: true }>(`/api/shopping/pantry/${encodeURIComponent(item.id)}`, {
    method: "DELETE", ...body({ expectedRevision: item.revision, requestId: crypto.randomUUID() }),
  }, "commit", h);
  afterPantryWrite(h);
}
export async function listPantry(): Promise<PantryItem[]> {
  const result = await shoppingRequest<{ items: PantryItem[] }>("/api/shopping/pantry", {}, "search");
  return withRuleMarks(result.items);
}
export async function confirmPantryForLine(line: ShoppingLine, grams: number): Promise<PantryItem> {
  if (!line.identity || !Number.isFinite(grams) || grams < 0) throw new Error("Choose a mapped ingredient and a valid amount.");
  const h = accountHandle();
  const pantry = await listPantry();
  const existing = pantry.find((item) => identityKey(item.identity) === identityKey(line.identity!));
  const result = await shoppingRequest<{ item: PantryItem }>("/api/shopping/pantry", {
    method: "PUT", ...body({ requestId: crypto.randomUUID(), expectedRevision: existing?.revision ?? null,
      item: { id: existing?.id, name: line.name, identity: line.identity, confirmedGrams: grams } }),
  }, "commit", h);
  afterPantryWrite(h);
  return withRuleMark(result.item);
}

/**
 * Adds items to the saved list that covers `today`, starting this week's list when none does
 * (2026-10-02): the assistant and the Today card add to "my list" without opening Shopping.
 * Every step runs as one account (`account`, else the one bound when the call starts): a switch
 * part-way throws `AccountChanged`, never a list read as one account and written as another.
 */
export async function addToCurrentShoppingList(names: readonly string[], today: string,
  timezone: string, requestIds: readonly string[] = names.map(() => crypto.randomUUID()),
  account: AccountHandle = accountHandle(),
): Promise<{ lines: ShoppingLine[]; failed: string[]; uncertain: string[] }> {
  const periods = await listShoppingPeriods(undefined, undefined, account);
  const covering = currentShoppingPeriod(periods, today);
  const period = covering
    ?? await createShoppingPeriod(defaultShoppingDraft(today, timezone), crypto.randomUUID(), account);
  // Every item on its own (DeepSeek audit round 7): one failed add must not hide the lines that
  // did save, or the caller loses their Undo.
  // A caller that retries passes the same ids (DeepSeek audit round 9): an add that saved but
  // whose answer was lost then returns its own row instead of a second one.
  const results = await Promise.allSettled(names.map((name, index) =>
    addManualShoppingLine(period.id, name, requestIds[index] ?? crypto.randomUUID(), account)));
  // A line that failed because the account changed is not a "failed item" to retry: the whole
  // add belongs to an account that is no longer bound.
  const changed = results.find((result) => result.status === "rejected" && result.reason instanceof AccountChanged);
  if (changed) throw new AccountChanged();
  return {
    lines: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    failed: names.filter((_, index) => results[index].status === "rejected"),
    // W020: a failed add the route never refused (lost answer, deadline, 5xx) may still have saved.
    uncertain: names.filter((_, index) => {
      const result = results[index];
      return result.status === "rejected" && !shoppingRefused(result.reason);
    }),
  };
}
