import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { PantryItem, ShoppingLine, ShoppingPeriod, ShoppingPurchaseWindow } from "./types";

type Db = Record<string, unknown>;
function number(value: unknown): number | null { return value == null ? null : Number(value); }
function issue(error: unknown): never {
  throw new HttpError(503, "shopping_unavailable", "Shopping is unavailable. Try again shortly.",
    { cause: error });
}
function stale(): never { throw new HttpError(409, "stale_revision", "This list changed. Reload and retry your edit."); }
function keyConflict(): never { throw new HttpError(409, "idempotency_conflict",
  "This request ID was already used with different shopping details."); }
function duplicateStock(): never { throw new HttpError(409, "pantry_identity_exists",
  "This food is already in your pantry. Reload and edit its confirmed amount."); }
function absent(): never { throw new HttpError(404, "not_found", "Shopping item not found."); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function createFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function period(row: Db): ShoppingPeriod {
  return { id: String(row.id), userId: String(row.user_id),
    startDate: String(row.start_date), endDate: String(row.end_date),
    timezone: String(row.timezone), people: Number(row.people),
    mealCoverage: row.meal_coverage as string[], mode: row.mode as ShoppingPeriod["mode"],
    effort: row.effort as ShoppingPeriod["effort"],
    maxActiveMinutes: number(row.max_active_minutes),
    variety: row.variety as ShoppingPeriod["variety"],
    budgetAmount: number(row.budget_amount), currency: row.currency as string | null,
    locale: row.locale as string | null, lockMode: row.lock_mode as ShoppingPeriod["lockMode"],
    planRevision: Number(row.plan_revision), revision: Number(row.rev) };
}
function line(row: Db): ShoppingLine {
  return { id: String(row.id), periodId: String(row.period_id),
    origin: row.origin as ShoppingLine["origin"], name: String(row.name),
    identity: row.identity as ShoppingLine["identity"],
    category: row.category as ShoppingLine["category"],
    needGrams: number(row.need_grams), confirmedStockGrams: number(row.confirmed_stock_grams),
    buyGrams: number(row.buy_grams), packageGrams: number(row.package_grams),
    purchaseConversionStatus: row.purchase_conversion_status as ShoppingLine["purchaseConversionStatus"],
    sources: row.sources as ShoppingLine["sources"], pinned: Boolean(row.pinned),
    checked: Boolean(row.checked), note: row.note as string | null, revision: Number(row.rev) };
}
function pantry(row: Db): PantryItem {
  return { id: String(row.id), userId: String(row.user_id), name: String(row.name),
    identity: row.identity as PantryItem["identity"],
    confirmedGrams: number(row.confirmed_grams), confirmedAt: String(row.confirmed_at),
    revision: Number(row.rev) };
}
function purchaseWindow(row: Db): ShoppingPurchaseWindow {
  return { id: String(row.id), periodId: String(row.period_id), lineId: String(row.line_id),
    windowStartDate: String(row.window_start_date), windowEndDate: String(row.window_end_date),
    needGrams: number(row.need_grams), confirmedStockGrams: number(row.confirmed_stock_grams),
    buyGrams: number(row.buy_grams), checked: Boolean(row.checked),
    note: row.note as string | null, revision: Number(row.rev) };
}

export type PeriodDraft = Omit<ShoppingPeriod, "id" | "userId" | "planRevision" | "revision">;
export type LineDraft = Omit<ShoppingLine, "id" | "periodId" | "revision" | "ruleMark">;
export type PantryDraft = Omit<PantryItem, "id" | "userId" | "confirmedAt" | "revision" | "ruleMark">;

export async function listPeriods(client: SupabaseClient, userId: string,
  start?: string, end?: string): Promise<ShoppingPeriod[]> {
  let query = client.from("shopping_periods").select("*").eq("user_id", userId)
    .is("deleted_at", null).order("start_date", { ascending: false }).limit(52);
  if (start) query = query.gte("end_date", start);
  if (end) query = query.lte("start_date", end);
  const result = await query;
  if (result.error) issue(result.error);
  return (result.data ?? []).map((row) => period(row as Db));
}

export async function createPeriod(client: SupabaseClient, userId: string,
  draft: PeriodDraft, requestId: string): Promise<ShoppingPeriod> {
  const prior = await client.from("shopping_periods").select("*")
    .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  if (prior.error) issue(prior.error);
  if (prior.data) return period(prior.data as Db);
  const insert = await client.from("shopping_periods").insert({ user_id: userId,
    start_date: draft.startDate, end_date: draft.endDate, timezone: draft.timezone,
    people: draft.people, meal_coverage: draft.mealCoverage, mode: draft.mode,
    effort: draft.effort, max_active_minutes: draft.maxActiveMinutes,
    variety: draft.variety, budget_amount: draft.budgetAmount,
    currency: draft.currency, locale: draft.locale, lock_mode: draft.lockMode,
    request_id: requestId }).select("*").single();
  if (insert.error) {
    if (insert.error.code === "23505") {
      const retry = await client.from("shopping_periods").select("*")
        .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
      if (retry.data) return period(retry.data as Db);
    }
    issue(insert.error);
  }
  return period(insert.data as Db);
}

export async function getPeriod(client: SupabaseClient, userId: string, id: string):
  Promise<{ period: ShoppingPeriod; lines: ShoppingLine[];
    purchaseWindows: ShoppingPurchaseWindow[] }> {
  const root = await client.from("shopping_periods").select("*")
    .eq("id", id).eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (root.error) issue(root.error);
  if (!root.data) absent();
  const [rows, dated] = await Promise.all([
    client.from("shopping_lines").select("*")
      .eq("user_id", userId).eq("period_id", id).is("deleted_at", null).order("name"),
    client.from("shopping_purchase_windows").select("*")
      .eq("user_id", userId).eq("period_id", id).is("deleted_at", null)
      .order("window_start_date"),
  ]);
  if (rows.error || dated.error) issue(rows.error ?? dated.error);
  const lines = (rows.data ?? []).map((row) => line(row as Db));
  const nameById = new Map(lines.filter((item) => item.origin === "plan")
    .map((item) => [item.id, item.name]));
  const purchaseWindows = (dated.data ?? []).map((row) => purchaseWindow(row as Db))
    .filter((item) => nameById.has(item.lineId))
    .sort((a, b) => a.windowStartDate.localeCompare(b.windowStartDate)
      || (nameById.get(a.lineId) ?? "").localeCompare(nameById.get(b.lineId) ?? "")
      || a.lineId.localeCompare(b.lineId));
  return { period: period(root.data as Db), lines, purchaseWindows };
}

export type PurchaseWindowPatch = Partial<Pick<ShoppingPurchaseWindow, "checked" | "note">>;
/** RPC owns the edit transaction and durable request receipt; derived amounts are read-only. */
export async function patchPurchaseWindow(client: SupabaseClient, userId: string,
  periodId: string, windowId: string, expectedRevision: number, requestId: string,
  patch: PurchaseWindowPatch): Promise<ShoppingPurchaseWindow> {
  const result = await client.rpc("shopping_patch_purchase_window", {
    p_period_id: periodId, p_window_id: windowId, p_expected_revision: expectedRevision,
    p_request_id: requestId, p_patch: patch,
  });
  if (result.error) issue(result.error);
  const receipt = result.data as { status?: string; purchaseWindow?: Db } | null;
  if (receipt?.status === "idempotency_conflict") keyConflict();
  if (receipt?.status === "stale_revision") stale();
  if (receipt?.status === "not_found") absent();
  if (receipt?.status !== "ok" || !receipt.purchaseWindow
    || receipt.purchaseWindow.user_id !== userId
    || receipt.purchaseWindow.period_id !== periodId
    || receipt.purchaseWindow.id !== windowId) issue(new Error("Invalid purchase-window response"));
  return purchaseWindow(receipt.purchaseWindow);
}

export type PeriodPatch = Partial<Pick<ShoppingPeriod, "startDate" | "endDate" | "timezone" |
  "people" | "mealCoverage" | "mode" | "effort" | "maxActiveMinutes" | "variety" |
  "budgetAmount" | "currency" | "locale" | "lockMode" | "planRevision">>;

export async function patchPeriod(client: SupabaseClient, userId: string, id: string,
  expectedRevision: number, requestId: string, patch: PeriodPatch): Promise<ShoppingPeriod> {
  const p: Db = { rev: expectedRevision + 1, last_request_id: requestId,
    updated_at: new Date().toISOString() };
  if (patch.startDate !== undefined) p.start_date = patch.startDate;
  if (patch.endDate !== undefined) p.end_date = patch.endDate;
  if (patch.timezone !== undefined) p.timezone = patch.timezone;
  if (patch.people !== undefined) p.people = patch.people;
  if (patch.mealCoverage !== undefined) p.meal_coverage = patch.mealCoverage;
  if (patch.mode !== undefined) p.mode = patch.mode;
  if (patch.effort !== undefined) p.effort = patch.effort;
  if (patch.maxActiveMinutes !== undefined) p.max_active_minutes = patch.maxActiveMinutes;
  if (patch.variety !== undefined) p.variety = patch.variety;
  if (patch.budgetAmount !== undefined) p.budget_amount = patch.budgetAmount;
  if (patch.currency !== undefined) p.currency = patch.currency;
  if (patch.locale !== undefined) p.locale = patch.locale;
  if (patch.lockMode !== undefined) p.lock_mode = patch.lockMode;
  if (patch.planRevision !== undefined) p.plan_revision = patch.planRevision;
  const result = await client.from("shopping_periods").update(p)
    .eq("id", id).eq("user_id", userId).eq("rev", expectedRevision)
    .is("deleted_at", null).select("*").maybeSingle();
  if (result.error) issue(result.error);
  if (result.data) return period(result.data as Db);
  const current = await client.from("shopping_periods").select("*")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (current.error) issue(current.error);
  if (!current.data || current.data.deleted_at) absent();
  if (current.data.last_request_id === requestId) return period(current.data as Db);
  stale();
}

export async function createLine(client: SupabaseClient, userId: string, periodId: string,
  draft: LineDraft, requestId: string): Promise<ShoppingLine> {
  await getPeriod(client, userId, periodId);
  const submitted = createFingerprint({ periodId, draft });
  const prior = await client.from("shopping_lines").select("*")
    .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  if (prior.error) issue(prior.error);
  if (prior.data) {
    if (prior.data.create_fingerprint !== submitted) keyConflict();
    return line(prior.data as Db);
  }
  const result = await client.from("shopping_lines").insert({
    period_id: periodId, user_id: userId, origin: draft.origin, name: draft.name,
    identity: draft.identity, category: draft.category, need_grams: draft.needGrams,
    confirmed_stock_grams: draft.confirmedStockGrams, buy_grams: draft.buyGrams,
    package_grams: draft.packageGrams,
    purchase_conversion_status: draft.purchaseConversionStatus,
    sources: draft.sources, pinned: draft.pinned, checked: draft.checked,
    note: draft.note, request_id: requestId, create_fingerprint: submitted,
  }).select("*").single();
  if (result.error) {
    if (result.error.code === "23505") {
      const winner = await client.from("shopping_lines").select("*")
        .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
      if (winner.error) issue(winner.error);
      if (winner.data) {
        if (winner.data.create_fingerprint !== submitted) keyConflict();
        return line(winner.data as Db);
      }
    }
    issue(result.error);
  }
  return line(result.data as Db);
}

export type LinePatch = Partial<Pick<ShoppingLine, "name" | "identity" | "category" |
  "needGrams" | "confirmedStockGrams" | "buyGrams" | "packageGrams" |
  "purchaseConversionStatus" | "sources" | "pinned" | "checked" | "note">>;
export async function patchLine(client: SupabaseClient, userId: string, periodId: string,
  id: string, expectedRevision: number, requestId: string, patch: LinePatch,
  remove = false): Promise<ShoppingLine> {
  const fields: Record<keyof LinePatch, string> = { name: "name", identity: "identity",
    category: "category", needGrams: "need_grams", confirmedStockGrams: "confirmed_stock_grams",
    buyGrams: "buy_grams", packageGrams: "package_grams",
    purchaseConversionStatus: "purchase_conversion_status", sources: "sources",
    pinned: "pinned", checked: "checked", note: "note" };
  const p: Db = { rev: expectedRevision + 1, last_request_id: requestId,
    updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch) as [keyof LinePatch, unknown][]) {
    if (value !== undefined) p[fields[key]] = value;
  }
  if (remove) p.deleted_at = new Date().toISOString();
  const result = await client.from("shopping_lines").update(p)
    .eq("id", id).eq("user_id", userId).eq("period_id", periodId)
    .eq("rev", expectedRevision).is("deleted_at", null).select("*").maybeSingle();
  if (result.error) issue(result.error);
  if (result.data) return line(result.data as Db);
  const current = await client.from("shopping_lines").select("*")
    .eq("id", id).eq("user_id", userId).eq("period_id", periodId).maybeSingle();
  if (current.error) issue(current.error);
  if (!current.data) absent();
  if (current.data.last_request_id === requestId) return line(current.data as Db);
  stale();
}

export async function listPantry(client: SupabaseClient, userId: string): Promise<PantryItem[]> {
  const rows = await client.from("shopping_pantry").select("*").eq("user_id", userId)
    .is("deleted_at", null).order("name");
  if (rows.error) issue(rows.error);
  return (rows.data ?? []).map((row) => pantry(row as Db));
}

export async function putPantry(client: SupabaseClient, userId: string,
  draft: PantryDraft & { id?: string }, expectedRevision: number | null,
  requestId: string): Promise<PantryItem> {
  if (!draft.id) {
    const submitted = createFingerprint({ name: draft.name, identity: draft.identity,
      confirmedGrams: draft.confirmedGrams });
    const prior = await client.from("shopping_pantry").select("*")
      .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
    if (prior.error) issue(prior.error);
    if (prior.data) {
      if (prior.data.create_fingerprint !== submitted) keyConflict();
      return pantry(prior.data as Db);
    }
    const inserted = await client.from("shopping_pantry").insert({ user_id: userId,
      name: draft.name, identity: draft.identity, confirmed_grams: draft.confirmedGrams,
      request_id: requestId, create_fingerprint: submitted }).select("*").single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        const winner = await client.from("shopping_pantry").select("*")
          .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
        if (winner.error) issue(winner.error);
        if (winner.data) {
          if (winner.data.create_fingerprint !== submitted) keyConflict();
          return pantry(winner.data as Db);
        }
        duplicateStock();
      }
      issue(inserted.error);
    }
    return pantry(inserted.data as Db);
  }
  if (expectedRevision === null) stale();
  const result = await client.from("shopping_pantry").update({ name: draft.name,
    identity: draft.identity, confirmed_grams: draft.confirmedGrams,
    confirmed_at: new Date().toISOString(), rev: expectedRevision + 1,
    last_request_id: requestId, updated_at: new Date().toISOString() })
    .eq("id", draft.id).eq("user_id", userId).eq("rev", expectedRevision)
    .is("deleted_at", null).select("*").maybeSingle();
  if (result.error) {
    if (result.error.code === "23505") duplicateStock();
    issue(result.error);
  }
  if (result.data) return pantry(result.data as Db);
  const current = await client.from("shopping_pantry").select("*")
    .eq("id", draft.id).eq("user_id", userId).maybeSingle();
  if (current.error) issue(current.error);
  if (!current.data || current.data.deleted_at) absent();
  if (current.data.last_request_id === requestId) return pantry(current.data as Db);
  stale();
}

export async function removePantry(client: SupabaseClient, userId: string, id: string,
  expectedRevision: number, requestId: string): Promise<void> {
  const result = await client.from("shopping_pantry").update({
    deleted_at: new Date().toISOString(), rev: expectedRevision + 1,
    last_request_id: requestId,
  }).eq("id", id).eq("user_id", userId).eq("rev", expectedRevision)
    .is("deleted_at", null).select("id").maybeSingle();
  if (result.error) issue(result.error);
  if (result.data) return;
  const current = await client.from("shopping_pantry").select("id,last_request_id")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (current.error) issue(current.error);
  if (!current.data) absent();
  if (current.data.last_request_id === requestId) return;
  stale();
}
