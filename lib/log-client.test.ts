import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allOps } from "@/lib/sync/idb";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { buildCommitRequest, buildMealCommitRequest, liveStrip, resolveFoodRef, snapshotFor } from "./log-client";
import { localDateFor } from "@/lib/log/contract";
import { commitLogEntry, LOG_QUEUED_EVENT, outcomeFor, pendingEntryIds } from "./log-commit-client";
import { resetTestAccount } from "@/tests/helpers/account";
import { unbindAccount } from "@/lib/device/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** `resolveFoodRef` reaches for `browserClient()`; each case sets what it answers. */
const mocks = vi.hoisted(() => ({ browserClient: vi.fn<() => SupabaseClient>() }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: mocks.browserClient }));

const outboxSpies = vi.hoisted(() => ({
  enqueue: vi.fn(),
  actualEnqueue: null as null | ((...args: never[]) => Promise<unknown>),
}));

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/outbox")>();
  outboxSpies.actualEnqueue = actual.enqueue as never;
  return { ...actual, enqueue: (...args: unknown[]) => outboxSpies.enqueue(...args) };
});

const REV: CachedRevision = {
  revision_id: 910, catalog_food_id: 41, description: "Chicken breast, roasted", brand: null,
  source: "fdc_sr_legacy", version_label: "2026-04",
  per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null, iron: 1.04 },
  portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
  cached_at: "2026-09-11T10:00:00.000Z",
};

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  mocks.browserClient.mockReset();
  outboxSpies.enqueue.mockReset();
  outboxSpies.enqueue.mockImplementation(outboxSpies.actualEnqueue!);
});

describe("snapshotFor", () => {
  it("scales per-100 g values by grams and keeps the source on every nutrient", () => {
    const s = snapshotFor(REV, 140);
    expect(s.protein.amount).toBeCloseTo(43.4, 4);
    expect(s.protein.unit).toBe("g");
    expect(s.protein.basis).toBe("per_100g");
    expect(s.protein.source).toBe("fdc_sr_legacy");
    expect(s.protein.source_version).toBe("2026-04");
    expect(s.protein.revision_id).toBe(910);
  });

  it("keeps a measured zero at 0 and an unmeasured nutrient at null", () => {
    const s = snapshotFor(REV, 140);
    expect(s.carbohydrate.amount).toBe(0);
    expect(s.fiber_total.amount).toBeNull();
  });
});

describe("liveStrip", () => {
  it("reads the five strip numbers off the snapshot", () => {
    expect(liveStrip(REV, 140)).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5, fiber: 0 });
  });
  it("is zero at zero grams", () => {
    expect(liveStrip(REV, 0)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  });
  it("falls back to the Atwater estimate when the source never reported a calorie value", () => {
    const revNoKcal: CachedRevision = {
      ...REV,
      per_100g: { ...REV.per_100g, energy_kcal: null, energy_kcal_calc: 165 },
    };
    expect(liveStrip(revNoKcal, 140).kcal).toBe(231);
  });
});

describe("buildCommitRequest", () => {
  it("emits the snake_case wire shape with method 'search' and no base_rev on a create", () => {
    const req = buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "America/New_York", slot: "meal-2",
      items: [{ id: "22222222-2222-4222-8222-222222222222", foodRefId: "33333333-3333-4333-8333-333333333333",
                revision: REV, grams: 140, qty: 140, unit: "g", portionId: null }],
    });
    expect(req.method).toBe("search");
    expect(req).not.toHaveProperty("base_rev");
    expect(req.items[0]).toMatchObject({
      seq: 1, food_ref_id: "33333333-3333-4333-8333-333333333333",
      grams: 140, qty: 140, unit: "g", food_revision_id: 910, portion_id: null, was_edited: false,
    });
    // "America/New_York", the tz passed above — never the process's own zone.
    expect(req.local_date).toBe(localDateFor("2026-09-11T18:30:00.000Z", "America/New_York"));
    expect(req.items[0]).not.toHaveProperty("confidence");
  });

  it("carries confidence through when the caller has one, and omits it when absent", () => {
    const req = buildCommitRequest({
      entryId: "e", eatenAt: new Date(), tz: "UTC", slot: "meal-1",
      items: [
        { id: "a", foodRefId: "fa", revision: REV, grams: 100, qty: 1, unit: "g", confidence: 0.42 },
        { id: "b", foodRefId: "fb", revision: REV, grams: 50, qty: 50, unit: "g" },
      ],
    });
    expect(req.items[0].confidence).toBe(0.42);
    expect(req.items[1]).not.toHaveProperty("confidence");
  });

  it("numbers items from 1 and carries base_rev on an edit", () => {
    const req = buildCommitRequest({
      entryId: "e", eatenAt: new Date(), tz: "UTC", slot: "meal-1", baseRev: 4,
      items: [
        { id: "a", foodRefId: "fa", revision: REV, grams: 100, qty: 1, unit: "portion", portionId: 3, wasEdited: true },
        { id: "b", foodRefId: "fb", revision: REV, grams: 50, qty: 50, unit: "g" },
      ],
    });
    expect(req.base_rev).toBe(4);
    expect(req.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(req.items[0].was_edited).toBe(true);
  });
});

describe("resolveFoodRef", () => {
  it("reports 'signed_out' when there is no session, distinct from an RPC failure", async () => {
    // Phase 9 §0.1: no session means no account bound on this device.
    unbindAccount();
    mocks.browserClient.mockReturnValue({
      auth: { getClaims: async () => ({ data: { claims: null } }) },
      rpc: async () => ({ data: null, error: null }),
    } as unknown as SupabaseClient);
    const reasons: string[] = [];
    const ref = await resolveFoodRef(9001, (reason) => reasons.push(reason));
    expect(ref).toBeNull();
    expect(reasons).toEqual(["signed_out"]);
  });

  it("reports 'rpc_error' when signed in but get_or_create_food_ref fails", async () => {
    mocks.browserClient.mockReturnValue({
      auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as SupabaseClient);
    const reasons: string[] = [];
    const ref = await resolveFoodRef(9002, (reason) => reasons.push(reason));
    expect(ref).toBeNull();
    expect(reasons).toEqual(["rpc_error"]);
  });

  it("reports no failure reason on a successful resolve", async () => {
    mocks.browserClient.mockReturnValue({
      auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
      rpc: async () => ({ data: "ref-123", error: null }),
    } as unknown as SupabaseClient);
    const reasons: string[] = [];
    const ref = await resolveFoodRef(9003, (reason) => reasons.push(reason));
    expect(ref).toBe("ref-123");
    expect(reasons).toEqual([]);
  });
});

describe("commitLogEntry", () => {
  const REQ = buildCommitRequest({
    entryId: "44444444-4444-4444-8444-444444444444", eatenAt: new Date("2026-09-11T18:30:00.000Z"),
    tz: "UTC", slot: "meal-2",
    items: [{ id: "i1", foodRefId: "f1", revision: REV, grams: 140, qty: 140, unit: "g" }],
  });

  it("returns the server response on a 200", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: "ok", entry_id: REQ.entry_id, rev: 1, items: [], totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
    await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toMatchObject({ status: "ok", rev: 1 });
  });

  it("returns the failure body on a 409 without queuing anything", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: "conflict", current_rev: 7, entity: {} }),
      { status: 409, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
    await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toMatchObject({ status: "conflict", current_rev: 7 });
    await expect(allOps(h)).resolves.toHaveLength(0);
    // The entity this body hands back is empty, so it is not a row anything can edit: the entry
    // stays marked until a read-back settles it (Grok pass 5).
    await expect(pendingEntryIds()).resolves.toEqual(new Set([REQ.entry_id]));
  });

  it("queues a 401 so a lapsed session retries later", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: "unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
    await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toEqual({ status: "queued" });
    await expect(pendingEntryIds()).resolves.toEqual(new Set([REQ.entry_id]));
  });

  it("announces a queued entry so the pending dot appears without a sync", async () => {
    const dispatchEvent = vi.fn();
    const had = "window" in globalThis;
    (globalThis as { window?: unknown }).window = { dispatchEvent };
    try {
      const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      await commitLogEntry(REQ, { fetchImpl });
      // Twice since T0 §3: once when the local write marks the entry pending — before the post —
      // and once when the outbox takes that mark over. Both say the same thing to Today.
      expect(dispatchEvent).toHaveBeenCalledTimes(2);
      for (const [event] of dispatchEvent.mock.calls) {
        expect((event as Event).type).toBe(LOG_QUEUED_EVENT);
      }
    } finally {
      if (!had) delete (globalThis as { window?: unknown }).window;
    }
  });

  it("queues the same payload through the outbox when the network is gone", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toEqual({ status: "queued" });
    await expect(pendingEntryIds()).resolves.toEqual(new Set([REQ.entry_id]));
  });

  it("resolves with a status instead of rejecting when the outbox enqueue itself fails", async () => {
    // Every enqueue, not just the first: the commit queues the op before the POST as well
    // (Grok pass 2, HIGH 1), so a database that cannot be opened fails both attempts. The POST
    // has gone out by then, so the answer keeps the local write rather than taking it back
    // (Grok pass 16, HIGH 1).
    outboxSpies.enqueue.mockRejectedValue(new Error("IDB open failed"));
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toEqual({ status: "unqueued" });
  });
});

// Audit 2026-09-13 #3/#6 (branch fix-logfoodsheet-commit-pipeline): "Log a meal" never reached
// commitLogEntry at all, and a rejected/blocked commit left a phantom entry in her log with no
// warning — components/LogFoodSheet.tsx's saveMeal()/confirmCatalogPortion() call these two.
describe("outcomeFor", () => {
  it("keeps the entry for ok and for a queued (offline) commit", () => {
    expect(outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
    })).toEqual({ keep: true, message: null });
    expect(outcomeFor({ status: "queued" })).toEqual({ keep: true, message: null });
  });

  /**
   * Ruling 2026-09-14: the log marks, it never refuses. A flagged item IS kept — the whole point
   * is that an accidental gluten gets recorded — but she has to be told it was off-plan, or the
   * mark exists only in the response and never on her screen.
   */
  it("keeps a flagged entry and still says what was off-plan", () => {
    const outcome = outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }],
    });
    expect(outcome.keep).toBe(true);
    expect(outcome.message).toMatch(/gluten/i);
  });

  it("names every allergen when more than one line was off-plan", () => {
    const outcome = outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      flagged: [
        { path: "items.0", message: "blocked:allergen:gluten" },
        { path: "items.1", message: "blocked:allergen:dairy" },
      ],
    });
    expect(outcome.message).toMatch(/gluten/i);
    expect(outcome.message).toMatch(/dairy/i);
  });

  it("sol FIX (review round 2): says a food needs a label check, distinct from off-plan, when " +
    "the flagged entry is unverified rather than blocked — a food with no peanut evidence must " +
    "still surface its mark, not read as clean", () => {
    const outcome = outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      flagged: [{ path: "items.0", message: "unverified:allergen:peanut" }],
    });
    expect(outcome.keep).toBe(true);
    expect(outcome.message).toMatch(/peanut/i);
    expect(outcome.message).not.toMatch(/off-plan/i);
  });

  it("says both off-plan and needs-a-check when a commit carries one of each", () => {
    const outcome = outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      flagged: [
        { path: "items.0", message: "blocked:allergen:gluten" },
        { path: "items.1", message: "unverified:allergen:peanut" },
      ],
    });
    expect(outcome.message).toMatch(/off-plan/i);
    expect(outcome.message).toMatch(/gluten/i);
    expect(outcome.message).toMatch(/peanut/i);
  });

  it("still keeps a clean entry silently — no mark where there is nothing to mark", () => {
    expect(outcomeFor({
      status: "ok", entry_id: "e1", rev: 1, items: [],
      totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      flagged: [],
    })).toEqual({ keep: true, message: null });
  });

  it("never keeps a blocked/invalid commit — it must not sit as a silent phantom entry", () => {
    const outcome = outcomeFor({
      status: "invalid", issues: [{ path: "items[0]", message: "blocked:allergen:gluten" }],
    });
    expect(outcome.keep).toBe(false);
    expect(outcome.message).toBeTruthy();
  });

  it("rejects every other failure status too, each with a message to show her", () => {
    const failures: Parameters<typeof outcomeFor>[0][] = [
      { status: "deleted", deleted_at: "2026-09-13T00:00:00.000Z" },
      { status: "gone" },
      { status: "stale_revision", food_ref_id: "f1", revision_id: 5 },
    ];
    for (const failure of failures) {
      const outcome = outcomeFor(failure);
      expect(outcome.keep).toBe(false);
      expect(outcome.message).toBeTruthy();
    }
  });

  it("keeps a conflict — the entry exists, another device simply got there first", () => {
    // Grok pass 2, MEDIUM 6: the card stays for a conflict, so the words beside it have to agree.
    const outcome = outcomeFor({ status: "conflict", current_rev: 7, entity: {} });
    expect(outcome.keep).toBe(true);
    expect(outcome.message).toBeTruthy();
  });
});

describe("buildMealCommitRequest", () => {
  it("carries every catalog item in the meal as one request, one entry", () => {
    const req = buildMealCommitRequest({
      entryId: "55555555-5555-4555-8555-555555555555",
      eatenAt: new Date("2026-09-13T18:30:00.000Z"), tz: "UTC", slot: "meal-2",
      items: [
        { itemId: "i1", foodRefId: "f1", revision: REV, grams: 140, qty: 140, unit: "g", portionId: null },
        { itemId: "i2", foodRefId: "f2", revision: REV, grams: 85, qty: 1, unit: "portion", portionId: 3 },
      ],
    });
    expect(req.entry_id).toBe("55555555-5555-4555-8555-555555555555");
    expect(req.items).toHaveLength(2);
    expect(req.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(req.items[0]).toMatchObject({ food_ref_id: "f1", grams: 140, qty: 140, unit: "g" });
    expect(req.items[1]).toMatchObject({
      food_ref_id: "f2", grams: 85, qty: 1, unit: "portion", portion_id: 3,
    });
  });

  it("carrying one item to commitLogEntry reaches the server exactly once for the whole meal", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        status: "ok", entry_id: "e1", rev: 1, items: [],
        totals: { local_date: "2026-09-13", nutrients: [], micro_coverage_pct: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const req = buildMealCommitRequest({
      entryId: "66666666-6666-4666-8666-666666666666",
      eatenAt: new Date("2026-09-13T18:30:00.000Z"), tz: "UTC", slot: "meal-2",
      items: [{ itemId: "i1", foodRefId: "f1", revision: REV, grams: 140, qty: 140, unit: "g", portionId: null }],
    });
    await expect(commitLogEntry(req, { fetchImpl })).resolves.toMatchObject({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
