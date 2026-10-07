/**
 * T0 §3 / §6 for the barcode path: the card is on Today before the POST, marked pending, exactly
 * as it is for a search pick and a capture. The scan sheet passed no optimistic card, so a scan
 * save showed nothing at all until the server answered (Grok pass 11, MEDIUM 4).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogCard } from "@/lib/log/catalog-card";
import { offPlanFor } from "@/lib/catalog-client";
import { buildCommitRequest, localDateOf } from "@/lib/log-client";
import { commitLogEntry, pendingEntryIds } from "@/lib/log-commit-client";
import { getDay, loadStore, saveStore } from "@/lib/store";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { resetTestAccount } from "@/tests/helpers/account";


vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const AT = new Date("2026-11-02T17:00:00.000Z");
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const REF_ID = "cccccccc-3333-4333-8333-333333333333";

const REVISION = {
  revision_id: 910, catalog_food_id: 41, description: "Ella's pouch", brand: "Ella's Kitchen",
  source: "off", version_label: "off-2026-09", cached_at: AT.toISOString(),
  per_100g: { energy_kcal: 60, protein: 1, carbohydrate: 12, fat_total: 0.4 },
  portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
} as unknown as CachedRevision;

beforeEach(async () => {
  await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
});

describe("the card a scan puts on Today", () => {
  it("carries the numbers the sheet is showing and the id the commit sends", () => {
    const card = catalogCard({
      revision: REVISION, entryId: ENTRY_ID, itemId: ITEM_ID, foodRefId: REF_ID,
      grams: 90, qty: 1, portion: { description: "1 pouch (90 g)" }, at: AT,
    });
    const request = buildCommitRequest({
      entryId: ENTRY_ID, eatenAt: AT, tz: "UTC", slot: "meal-2", method: "barcode",
      items: [{ id: ITEM_ID, foodRefId: REF_ID, revision: REVISION, grams: 90, qty: 1,
        unit: "portion", portionId: 5 }],
    });
    expect(card.items?.map((i) => i.id)).toEqual(request.items.map((i) => i.id));
    expect(card.macros.kcal).toBe(54);
    expect(card.portionLabel).toBe("1 × 1 pouch (90 g)");
  });

  it("is on the day, and marked pending, before the commit answers", async () => {
    const card = catalogCard({
      revision: REVISION, entryId: ENTRY_ID, itemId: ITEM_ID, foodRefId: REF_ID,
      grams: 90, qty: 1, portion: null, at: AT,
    });
    const request = buildCommitRequest({
      entryId: ENTRY_ID, eatenAt: AT, tz: "UTC", slot: "meal-2", method: "barcode",
      items: [{ id: ITEM_ID, foodRefId: REF_ID, revision: REVISION, grams: 90, qty: 90,
        unit: "g", portionId: null }],
    });
    const date = localDateOf(AT);
    const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(request, { fetchImpl: never, timingPath: "barcode",
      optimistic: { date, entry: card } });

    await vi.waitFor(() => { expect(getDay(date)?.extras ?? []).toHaveLength(1); });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("marks a blocked match off-plan the moment it goes up", async () => {
    // The search sheet passes the off-plan flags it derived; the scan sheet passed none, so a
    // scanned biscuit sat on Today with no mark until the reply reconciled it — which on the
    // queued path can be a long time (Grok pass 17, MEDIUM 3).
    const flags = offPlanFor({ description: "Wheat biscuits", brand: "Brand",
      policy: { verdict: "blocked", reason: "allergen:gluten" } });
    const card = catalogCard({
      revision: REVISION, entryId: ENTRY_ID, itemId: ITEM_ID, foodRefId: REF_ID,
      grams: 90, qty: 1, portion: null, at: AT, flags,
    });
    expect(card.flags).toContain("gluten");
  });

  it("is what the scan sheet commits with", () => {
    // No renderer in this repo, so the wiring is read from the source: the sheet must hand the
    // commit an optimistic card, as the log sheet and the capture sheet do.
    const source = readFileSync(
      new URL("../../components/ScanConfirmSheet.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/optimistic:\s*\{/);
    expect(source).toMatch(/catalogCard\(/);
    // The same two things the log sheet gets right: the match's own off-plan flags, and the one
    // date the request carries (Grok pass 17, MEDIUM 3).
    expect(source).toMatch(/flags: offPlanFor\(match\)/);
    expect(source).toMatch(/optimistic: \{ date: request\.local_date/);
    expect(source).not.toMatch(/localDateOf\(at\)/);
  });
});
