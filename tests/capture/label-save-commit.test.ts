/**
 * W017 (audit 2026-10-10): "Save as my food" on a label capture, end to end.
 *
 * A030: the client sent `save_label_as_food` with a real ref and no `label_food`, so the server
 * refused every such save with 422. The request the capture sheet now builds is handed, as the
 * route hands it, to applyLogEntry, which must record it.
 *
 * A036: the label food was inserted before the refs and revisions were checked, so a refused or
 * retried commit left a second `label_scan` food behind.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyEdits, canSave, commitDraft } from "@/lib/capture-client";
import { LABEL_FOOD_PLACEHOLDER_REF, labelItemSeq } from "@/lib/capture/label-food";
import type { ProposeResponse } from "@/lib/capture/types";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { labelFoodIdFor } from "@/lib/log/op-id";
import { applyLogEntry } from "@/lib/server/log";
import { TEST_USER } from "@/tests/helpers/account";
import {
  DRAFT_ID, ENTRY_ID, fakeClient, ITEM_ID, PER_100G, REF_A, req,
} from "@/tests/helpers/log-fake-client";

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const LABEL_DRAFT: ProposeResponse = {
  draftId: DRAFT_ID, method: "label", notes: [], spend: { usedToday: 1, softCap: 30 },
  items: [{
    seq: 1, label: "Seeded crackers", foodRefId: null, catalogFoodRevisionId: null,
    grams: 30, qty: 1, unit: "whole", portionId: null, confidence: 0.9,
    policy: { verdict: "unverified" }, alternatives: [], autoResolved: false,
  }],
  labelFood: { name: "Seeded crackers", brand: "Acme", per100g: PER_100G,
    ingredientsText: "rice flour, seeds, salt", allergenTags: [],
    allergenWarnings: [{ allergen: "sesame", outcome: "unknown", text: "Check the label" }] },
};

/** The body the capture sheet posts, captured from its own fetch. */
async function sentBody(draft: ProposeResponse, saveLabelAsFood: boolean) {
  let sent: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
      totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
    { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const out = await commitDraft(draft, {}, { entryId: ENTRY_ID, tz: "UTC", slot: "meal-2",
    eatenAt: new Date("2026-09-11T16:00:00.000Z"), saveLabelAsFood, fetchImpl });
  return { out, sent: sent as Record<string, unknown> | null };
}

describe("label save as my food (A030)", () => {
  it("lets an ungrounded label item save only while it is saved as their food", () => {
    const items = applyEdits(LABEL_DRAFT.items, {});
    expect(canSave(items, labelItemSeq(LABEL_DRAFT, {}, true))).toBe(true);
    expect(canSave(items, labelItemSeq(LABEL_DRAFT, {}, false))).toBe(false);
  });

  it("sends the placeholder ref and the label_food body", async () => {
    const { out, sent } = await sentBody(LABEL_DRAFT, true);
    expect(out).toMatchObject({ status: "ok" });
    expect(sent).toMatchObject({
      method: "label", save_label_as_food: true,
      items: [{ food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, food_revision_id: null, portion_id: null,
        grams: 30, qty: 30, unit: "g" }],
      label_food: { name: "Seeded crackers", brand: "Acme", allergenTags: [],
        ingredientsText: "rice flour, seeds, salt" },
    });
    expect((sent?.label_food as Record<string, unknown>).allergenWarnings).toBeUndefined();
  });

  it("is recorded by the server, not refused with 422", async () => {
    const { sent } = await sentBody(LABEL_DRAFT, true);
    const db = fakeClient({
      tables: { food_refs: [{ id: "ref-for-label", kind: "user", user_food_id: "uf" }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 }, get_or_create_food_ref: "ref-for-label" },
    });
    // As app/api/log/commit/route.ts hands it over: the body, and the body's own label_food.
    const out = await applyLogEntry(db.client, "u1", sent, { labelFood: sent?.label_food });
    expect(out.status).toBe("ok");
    const op = db.rpc.mock.calls.find((c) => c[0] === "apply_sync_op")?.[1] as
      { p_op: { payload: { items: { food_ref_id: string }[] } } };
    expect(op.p_op.payload.items[0].food_ref_id).toBe("ref-for-label");
  });

  it("sends a plain commit when the toggle is off or the label item was swapped", async () => {
    const grounded: ProposeResponse = { ...LABEL_DRAFT,
      items: [{ ...LABEL_DRAFT.items[0], foodRefId: REF_A, catalogFoodRevisionId: 7 }] };
    const off = await sentBody(grounded, false);
    expect(off.sent?.save_label_as_food).toBeUndefined();
    expect(off.sent?.label_food).toBeUndefined();
    expect(labelItemSeq(grounded, { 1: { foodRefId: "other" } }, true)).toBeNull();
    expect(labelItemSeq(grounded, { 1: { removed: true } }, true)).toBeNull();
  });
});

const LABEL_BODY = { name: "Seeded crackers", per100g: PER_100G, allergenTags: [] };
const LABEL_ITEM = { id: ITEM_ID, seq: 1, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 30,
  unit: "g", grams: 30 };
const PINNED_ITEM = { id: "10000000-0000-4000-8000-000000000002", seq: 2, food_ref_id: REF_A,
  qty: 1, unit: "g", grams: 50, food_revision_id: 99 };
const labelReq = (items: Record<string, unknown>[]) =>
  req(items, { method: "label", draft_id: DRAFT_ID, save_label_as_food: true });

describe("label food rows only after validation (A036)", () => {
  it("inserts no food when another item's revision is stale", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 99, catalog_food_id: 7, is_active: false }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 }, get_or_create_food_ref: "ref-x" },
    });
    const out = await applyLogEntry(db.client, "u1", labelReq([LABEL_ITEM, PINNED_ITEM]),
      { labelFood: LABEL_BODY });
    expect(out.status).toBe("stale_revision");
    expect(db.inserted.some((i) => i.table === "user_foods")).toBe(false);
  });

  it("inserts no food when another item names an unknown ref", async () => {
    const db = fakeClient({ rpc: { get_or_create_food_ref: "ref-x" } });
    const out = await applyLogEntry(db.client, "u1",
      labelReq([LABEL_ITEM, { ...PINNED_ITEM, food_revision_id: null }]), { labelFood: LABEL_BODY });
    expect(out).toMatchObject({ status: "invalid",
      issues: [{ path: "items.1.food_ref_id", message: "unknown food_ref_id" }] });
    expect(db.inserted.some((i) => i.table === "user_foods")).toBe(false);
  });

  it("names the food by account and entry, and a retry reuses the row it already made", async () => {
    const id = labelFoodIdFor("u1", ENTRY_ID);
    const db = fakeClient({
      tables: { user_foods: [{ id }], food_refs: [{ id: "ref-x", kind: "user", user_food_id: id }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 }, get_or_create_food_ref: "ref-x" },
      insertError: { user_foods: { code: "23505", message: "duplicate key" } },
    });
    const out = await applyLogEntry(db.client, "u1", labelReq([LABEL_ITEM]), { labelFood: LABEL_BODY });
    expect(out.status).toBe("ok");
    expect(db.inserted.find((i) => i.table === "user_foods")?.row.id).toBe(id);
    // Not a new food this time, so nothing is reported as saved.
    expect((out as { user_food_id?: string }).user_food_id).toBeUndefined();
    const ref = db.rpc.mock.calls.find((c) => c[0] === "get_or_create_food_ref")?.[1];
    expect(ref).toMatchObject({ p_user_food_id: id });
  });

  it("finds the committed label item by its own id and inserts nothing", async () => {
    const db = fakeClient({
      tables: {
        log_items: [{ entry_id: ENTRY_ID, id: ITEM_ID, seq: 1, food_ref_id: "ref-held" }],
        food_refs: [{ id: "ref-held", kind: "user", user_food_id: "uf" }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", labelReq([LABEL_ITEM]), { labelFood: LABEL_BODY });
    expect(out.status).toBe("ok");
    expect(db.inserted.some((i) => i.table === "user_foods")).toBe(false);
  });
});
