"use client";

import type { PantryItem, ShoppingLine, ShoppingPeriod, ShoppingPurchaseWindow } from "@/lib/shopping/types";
import { AccountChanged, accountFetch, accountHandle, accountJson } from "@/lib/device/account";
import { defaultShoppingDraft, type ShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import type { ShoppingPreviewInput } from "@/components/ShoppingView";
import { identityKey } from "@/lib/shopping/aggregate";
import type { ShoppingPreviewResult } from "@/lib/shopping/preview-contract";
import { withRuleMark, withRuleMarks } from "@/lib/shopping/rule-mark-wire";

export type ShoppingSnapshot = { period: ShoppingPeriod | null; lines: ShoppingLine[];
  purchaseWindows?: ShoppingPurchaseWindow[] };
export class ShoppingStaleRevision extends Error {
  constructor() { super("Shopping changed elsewhere."); this.name = "ShoppingStaleRevision"; }
}
async function shoppingRequest<T>(path: string, init: RequestInit = {},
  budget: "search" | "prefs" | "commit" = "prefs"): Promise<T> {
  const h = accountHandle();
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
    if (code === "rule_review_required")
      throw new Error("Confirm your food rules at the top of the planner, then preview again.");
    if (["needs_profile", "target_changes_in_period", "bad_period", "bad_coverage",
      "slot_unavailable", "recipe_policy_requires_review", "infeasible_plan",
      "recipe_plan_unavailable", "shopping_unavailable", "preview_unavailable"].includes(code) && message)
      throw new Error(message);
    if (code === "recipe_pilot_unavailable")
      throw new Error("Shopping is not available for this account yet.");
    if (res.status === 409) throw new Error("Shopping changed elsewhere. Refresh and preview again.");
    throw new Error(`Shopping request failed (${res.status}). Try again.`);
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
export async function listShoppingPeriods(startDate?: string, endDate?: string): Promise<ShoppingPeriod[]> {
  const params = new URLSearchParams();
  if (startDate) params.set("start", startDate);
  if (endDate) params.set("end", endDate);
  const query = params.size ? `?${params}` : "";
  const result = await shoppingRequest<{ periods: ShoppingPeriod[] }>(`/api/shopping/periods${query}`, {}, "search");
  return result.periods;
}
export async function previewShopping(input: ShoppingPreviewInput,
  period: ShoppingPeriod | null): Promise<ShoppingPreviewResult> {
  const result = await shoppingRequest<ShoppingPreviewResult>("/api/shopping/preview", {
    method: "POST", ...body({ ...(period ? { periodId: period.id,
      expectedRevision: period.revision } : {}), draft: input.draft, basket: input.basket }),
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
  requestId = crypto.randomUUID()): Promise<ShoppingPeriod> {
  const result = await shoppingRequest<{ period: ShoppingPeriod }>("/api/shopping/periods", {
    method: "POST", ...body({ period: draft, requestId }),
  }, "commit");
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
export async function addManualShoppingLine(periodId: string, name: string, requestId: string): Promise<ShoppingLine> {
  const line: Omit<ShoppingLine, "id" | "periodId" | "revision"> = {
    origin: "manual", name, identity: null, category: "manual", needGrams: null,
    confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
  };
  const result = await shoppingRequest<{ line: ShoppingLine }>(`${periodPath(periodId)}/lines`, {
    method: "POST", ...body({ requestId, line }),
  }, "commit");
  return withRuleMark(result.line);
}
/** Removes one line, plan or manual; the route keeps the row and marks it deleted. */
export async function deleteShoppingLine(line: ShoppingLine): Promise<void> {
  await shoppingRequest<{ deleted: true }>(`${periodPath(line.periodId)}/lines/${encodeURIComponent(line.id)}`, {
    method: "DELETE", ...body({ expectedRevision: line.revision, requestId: crypto.randomUUID() }),
  }, "commit");
}
export async function removePantryItem(item: PantryItem): Promise<void> {
  await shoppingRequest<{ deleted: true }>(`/api/shopping/pantry/${encodeURIComponent(item.id)}`, {
    method: "DELETE", ...body({ expectedRevision: item.revision, requestId: crypto.randomUUID() }),
  }, "commit");
}
export async function listPantry(): Promise<PantryItem[]> {
  const result = await shoppingRequest<{ items: PantryItem[] }>("/api/shopping/pantry", {}, "search");
  return withRuleMarks(result.items);
}
export async function confirmPantryForLine(line: ShoppingLine, grams: number): Promise<PantryItem> {
  if (!line.identity || !Number.isFinite(grams) || grams < 0) throw new Error("Choose a mapped ingredient and a valid amount.");
  const pantry = await listPantry();
  const existing = pantry.find((item) => identityKey(item.identity) === identityKey(line.identity!));
  const result = await shoppingRequest<{ item: PantryItem }>("/api/shopping/pantry", {
    method: "PUT", ...body({ requestId: crypto.randomUUID(), expectedRevision: existing?.revision ?? null,
      item: { id: existing?.id, name: line.name, identity: line.identity, confirmedGrams: grams } }),
  }, "commit");
  return withRuleMark(result.item);
}

/**
 * Adds items to the saved list that covers `today`, starting this week's list when none does
 * (2026-10-02): the assistant and the Today card add to "my list" without opening Shopping.
 */
export async function addToCurrentShoppingList(names: readonly string[], today: string,
  timezone: string, requestIds: readonly string[] = names.map(() => crypto.randomUUID()),
): Promise<{ lines: ShoppingLine[]; failed: string[] }> {
  const periods = await listShoppingPeriods();
  const covering = periods.find((row) => row.startDate <= today && row.endDate >= today);
  const period = covering ?? await createShoppingPeriod(defaultShoppingDraft(today, timezone));
  // Every item on its own (DeepSeek audit round 7): one failed add must not hide the lines that
  // did save, or the caller loses their Undo.
  // A caller that retries passes the same ids (DeepSeek audit round 9): an add that saved but
  // whose answer was lost then returns its own row instead of a second one.
  const results = await Promise.allSettled(names.map((name, index) =>
    addManualShoppingLine(period.id, name, requestIds[index] ?? crypto.randomUUID())));
  return {
    lines: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    failed: names.filter((_, index) => results[index].status === "rejected"),
  };
}
