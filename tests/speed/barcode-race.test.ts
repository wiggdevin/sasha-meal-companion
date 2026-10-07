/**
 * T0 §4 / AC5 — OFF and FDC are raced, with a three-second head start for OFF.
 *
 * OFF is the better source for a grocery barcode and is usually fast, so it goes first and alone;
 * but a cold product used to pay OFF's whole timeout before FDC was even asked. The head start
 * keeps OFF's precedence while capping what its silence costs.
 */
import { describe, expect, it, vi } from "vitest";
import { OFF_HEAD_START_MS, resolveBarcode } from "@/lib/server/barcode";
import { fakeClient } from "../barcode/fake-client";

const GTIN = "04006381333931";
const NOW = new Date("2026-09-19T12:00:00.000Z");

const OFF_PRODUCT = {
  code: GTIN, product_name: "Pouch", brands: "Ella's",
  nutriments: { "energy-kcal_100g": 60 }, ingredients_text: "Pear",
};
const FDC_PRODUCT = {
  fdcId: 1, description: "POUCH", gtinUpc: "4006381333931",
  foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 60 }],
};

/** Tables that start empty and get the written revision pushed into them by the write RPC. */
function coldClient() {
  const tables = {
    catalog_barcodes: [] as Record<string, unknown>[],
    constraint_profiles: [] as Record<string, unknown>[],
    catalog_barcode_lookups: [] as Record<string, unknown>[],
    catalog_food_revisions: [] as Record<string, unknown>[],
  };
  const made = fakeClient(tables, {
    catalog_write_provider_revision: () => {
      tables.catalog_barcodes.push({ gtin14: GTIN, catalog_food_id: 12, source: "off",
        published_at: NOW.toISOString() });
      tables.catalog_food_revisions.push({
        id: 34, catalog_food_id: 12, description: "Pouch", brand: "Ella's",
        quality_class: "crowd", quality_flags: [], is_active: true,
        catalog_versions: { version_label: "off-2026-09-19", imported_at: NOW.toISOString() },
        catalog_food_nutrients: [{ nutrient_code: "energy_kcal", amount_per_100g: 60 }],
        catalog_portions: [], catalog_ingredients: [],
      });
      return { catalog_food_id: 12, revision_id: 34, version_label: "off-2026-09-19" };
    },
    get_or_create_food_ref: "11111111-1111-4111-8111-111111111111",
  });
  return made;
}

/** A provider that answers after `ms` of fake time. */
function after<T>(ms: number, value: T) {
  return vi.fn(() => new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms); }));
}

describe("the head start", () => {
  it("is three seconds", () => {
    expect(OFF_HEAD_START_MS).toBe(3000);
  });
});

describe("racing OFF and FDC", () => {
  it("never asks FDC at all when OFF answers inside the head start", async () => {
    vi.useFakeTimers();
    try {
      const { client } = coldClient();
      const fetchOff = after(500, OFF_PRODUCT);
      const fetchFdc = vi.fn();
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN },
        { fetchOff: fetchOff as never, fetchFdc: fetchFdc as never, now: () => NOW });
      await vi.advanceTimersByTimeAsync(600);
      const res = await run;
      expect(res.status).toBe("resolved");
      expect(fetchFdc).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("asks FDC at once when OFF has already failed inside the head start", async () => {
    vi.useFakeTimers();
    try {
      const { client } = coldClient();
      const fetchFdc = after(200, FDC_PRODUCT);
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: after(100, { status: 404 }) as never, fetchFdc: fetchFdc as never, now: () => NOW,
      });
      await vi.advanceTimersByTimeAsync(400);
      await run;
      expect(fetchFdc).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("AC5: an OFF 5 s timeout with FDC answering in 1 s resolves in four seconds", async () => {
    vi.useFakeTimers();
    try {
      const { client } = coldClient();
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: after(5000, { status: "timeout" }) as never,
        fetchFdc: after(1000, FDC_PRODUCT) as never,
        now: () => NOW,
      });
      let settled = false;
      void run.then(() => { settled = true; });
      // FDC starts at 3 s and answers at 4 s; nothing has resolved a moment before that.
      await vi.advanceTimersByTimeAsync(OFF_HEAD_START_MS + 900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      expect((await run).status).toBe("resolved");
    } finally { vi.useRealTimers(); }
  });

  it("still prefers OFF when it wins the race it started three seconds ahead of", async () => {
    vi.useFakeTimers();
    try {
      const { client, rpc } = coldClient();
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: after(3500, OFF_PRODUCT) as never,
        fetchFdc: after(4000, FDC_PRODUCT) as never,
        now: () => NOW,
      });
      await vi.advanceTimersByTimeAsync(5000);
      await run;
      expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision",
        expect.objectContaining({ p_source: "off" }));
    } finally { vi.useRealTimers(); }
  });

  it("503s only when both lose, and reports both failures to the ledger", async () => {
    vi.useFakeTimers();
    try {
      const { client, upserts } = coldClient();
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: after(4000, { status: "timeout" }) as never,
        fetchFdc: after(4500, { status: 503 }) as never,
        now: () => NOW,
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await run).toMatchObject({ status: 503, code: "upstream_unavailable" });
      expect(upserts[0]).toMatchObject({ table: "catalog_barcode_lookups",
        rows: { gtin14: GTIN, status: "error" } });
    } finally { vi.useRealTimers(); }
  });
});

/**
 * Grok 4.6 MEDIUM 10: a race that never cancels the loser leaves an outbound request running
 * against the provider's rate budget long after nobody is waiting for its answer.
 */
describe("the loser is cancelled", () => {
  /** A provider that answers after `ms`, and records the signal it was handed. */
  function watched<T>(ms: number, value: T) {
    const signals: (AbortSignal | undefined)[] = [];
    const fn = vi.fn((_gtin: string, deps?: { signal?: AbortSignal }) => {
      signals.push(deps?.signal);
      return new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms); });
    });
    return { fn, signals };
  }

  it("aborts FDC when OFF wins the race it started three seconds ahead of", async () => {
    vi.useFakeTimers();
    try {
      const { client } = coldClient();
      const off = watched(3_500, OFF_PRODUCT);
      const fdc = watched(4_000, FDC_PRODUCT);
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: off.fn as never, fetchFdc: fdc.fn as never, now: () => NOW,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await run;
      expect(fdc.signals[0]?.aborted).toBe(true);
      expect(off.signals[0]?.aborted).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("aborts OFF when FDC answers first — AC5's case", async () => {
    vi.useFakeTimers();
    try {
      const { client } = coldClient();
      const off = watched(5_000, { status: "timeout" });
      const fdc = watched(1_000, FDC_PRODUCT);
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: off.fn as never, fetchFdc: fdc.fn as never, now: () => NOW,
      });
      await vi.advanceTimersByTimeAsync(4_200);
      await run;
      expect(off.signals[0]?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("still records both failures when both lose", async () => {
    vi.useFakeTimers();
    try {
      const { client, upserts } = coldClient();
      const run = resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: after(4_000, { status: "timeout" }) as never,
        fetchFdc: after(4_500, { status: 503 }) as never,
        now: () => NOW,
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await run).toMatchObject({ status: 503, code: "upstream_unavailable" });
      expect(upserts[0]).toMatchObject({ rows: { status: "error" } });
    } finally { vi.useRealTimers(); }
  });
});

describe("the write path", () => {
  it("answers from the revision it just wrote, even when the read back finds nothing", async () => {
    // Grok pass 2, LOW 19: a write that succeeded followed by a read that did not is a 503 saying
    // "the food databases are not answering" about a product we have in hand. The spec's own
    // §4 wording is to build the match from the revision just written.
    const tables = {
      catalog_barcodes: [] as Record<string, unknown>[],
      constraint_profiles: [] as Record<string, unknown>[],
      catalog_barcode_lookups: [] as Record<string, unknown>[],
      catalog_food_revisions: [] as Record<string, unknown>[],   // the read back finds nothing
    };
    const { client } = fakeClient(tables, {
      catalog_write_provider_revision: () =>
        ({ catalog_food_id: 12, revision_id: 34, version_label: "off-2026-09-19" }),
      get_or_create_food_ref: "11111111-1111-4111-8111-111111111111",
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue(OFF_PRODUCT) as never, now: () => NOW,
    });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.revisionId).toBe(34);
    expect(res.match.description).toBe("Pouch");
    expect(res.cached).toBe(false);
  });

  it("builds the match from the revision just written, not from a second cache sweep", async () => {
    const { client, from } = coldClient();
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue(OFF_PRODUCT) as never, now: () => NOW,
    });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.cached).toBe(false);
    expect(res.match.revisionId).toBe(34);
    // Two reads of catalog_barcodes would mean the post-write path swept the cache again.
    const barcodeReads = from.mock.calls.filter(([t]) => t === "catalog_barcodes");
    expect(barcodeReads).toHaveLength(1);
  });
});
