import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { patchPurchaseWindow } from "@/lib/shopping/repository";
import { purchaseWindowPatch } from "@/lib/shopping/validation";

const userId = crypto.randomUUID();
const periodId = crypto.randomUUID();
const lineId = crypto.randomUUID();
const windowId = crypto.randomUUID();
const requestId = crypto.randomUUID();
const row = { id: windowId, user_id: userId, period_id: periodId, line_id: lineId,
  window_start_date: "2026-10-01", window_end_date: "2026-10-07",
  need_grams: "900", confirmed_stock_grams: "500", buy_grams: "400",
  checked: true, note: "Bought on Monday", rev: 2 };

function client(status: string, purchaseWindow = row): SupabaseClient {
  const stub = { rpc: vi.fn().mockResolvedValue({ data: { status, purchaseWindow }, error: null }) };
  return stub as unknown as SupabaseClient;
}

describe("dated purchase-window boundary", () => {
  it("accepts only checked/note edits and imports the authenticated route", async () => {
    expect(purchaseWindowPatch.parse({ checked: true, note: null })).toEqual({ checked: true, note: null });
    expect(purchaseWindowPatch.safeParse({}).success).toBe(false);
    expect(purchaseWindowPatch.safeParse({ buyGrams: 0 }).success).toBe(false);
    expect(purchaseWindowPatch.safeParse({ checked: true, needGrams: 0 }).success).toBe(false);
    const route = await import("@/app/api/shopping/periods/[id]/purchase-windows/[windowId]/route");
    expect(route.PATCH).toBeTypeOf("function");
  });

  it("maps a confirmed edit without accepting a foreign row", async () => {
    const saved = await patchPurchaseWindow(client("ok"), userId, periodId, windowId, 1,
      requestId, { checked: true, note: "Bought on Monday" });
    expect(saved).toMatchObject({ id: windowId, lineId, needGrams: 900,
      confirmedStockGrams: 500, buyGrams: 400, checked: true, revision: 2 });
    await expect(patchPurchaseWindow(client("ok", { ...row, user_id: crypto.randomUUID() }),
      userId, periodId, windowId, 1, requestId, { checked: true }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("maps stale and reused-key receipts to 409", async () => {
    await expect(patchPurchaseWindow(client("stale_revision"), userId, periodId,
      windowId, 1, requestId, { checked: true }))
      .rejects.toMatchObject({ status: 409, code: "stale_revision" });
    await expect(patchPurchaseWindow(client("idempotency_conflict"), userId, periodId,
      windowId, 1, requestId, { note: "changed" }))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });
});
