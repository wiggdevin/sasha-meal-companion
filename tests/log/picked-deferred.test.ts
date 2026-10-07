/**
 * t17 (calc audit 2026-10-05): the durable log path for picked foods.
 *
 * Gap 2 — a mixed meal with a non-ready pick commits whole: ready items are kept, the non-ready one
 * is resolved before the commit or the WHOLE entry waits and is upgraded later. No item is dropped.
 * Gap 3 — a first-use offline pick upgrades to the real food ref through the ref registry once the
 * phone is back online, and upgrading twice is harmless.
 * Gap 1 — an account food with no known unit weight is still never sent with an invented mass.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import type { Food } from "@/lib/foods";
import type { AdoptableFood } from "@/lib/foods/adopt-client";
import { opIdFor, type LogCommitRequest } from "@/lib/log/contract";
import { catalogCard } from "@/lib/log/catalog-card";
import { deferredKey } from "@/lib/log/deferred-store";
import { preparePickedCommit, type LogPick } from "@/lib/log/picked-commit";
import {
  commitOrDeferPickedFoods, deferPickedCommit, drainDeferredPicks, readAllDeferred, readDeferred,
  refusedDeferred, retryDeferred,
} from "@/lib/log/picked-deferred";
import { forgetLoggedEntry, pendingEntryIds } from "@/lib/log-commit-client";
import { cachedFoodRef, resetFoodRefCache } from "@/lib/log-client";
import { getDay, loadStore, saveStore } from "@/lib/store";
import { allOps, putMeta } from "@/lib/sync/idb";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: { message: "offline" } }),
  }),
}));

let h: AccountHandle;
const AT = new Date("2026-11-02T17:00:00.000Z");
const TZ = "UTC";
const DATE = "2026-11-02";
const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";
const CATALOG_ITEM = "bbbbbbbb-2222-4222-8222-222222222222";
const CATALOG_EXTRA = "eeeeeeee-9999-4999-8999-999999999999";
const CHICKEN = "chicken-breast-roasted";

/** A minter that is offline until `online()` is called, then hands out one stable ref per row. */
function flakyMinter() {
  let up = false;
  const refs = new Map<string, string>();
  const mint = vi.fn(async (food: AdoptableFood) => {
    if (!up) return null;
    if (!refs.has(food.id)) {
      refs.set(food.id, `dddddddd-0000-4000-8000-${String(refs.size + 1).padStart(12, "0")}`);
    }
    return refs.get(food.id) as string;
  });
  return { mint, online: () => { up = true; } };
}

function okFetch(bodies: LogCommitRequest[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as LogCommitRequest;
    bodies.push(req);
    return new Response(JSON.stringify({
      status: "ok", entry_id: req.entry_id, rev: 1,
      items: req.items.map((i) => ({ ...i, entry_id: req.entry_id, portion_id: null,
        food_revision_id: i.food_revision_id ?? null, was_edited: false, confidence: null,
        snapshot: {} })),
      totals: { local_date: req.local_date, nutrients: [], micro_coverage_pct: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const down = () => vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;

function bundledPick(id = "mfz1-ab12-f"): LogPick {
  const card: LoggedFood = {
    id, foodId: CHICKEN, name: "Chicken breast, roasted",
    portionLabel: "1 cup, chopped or diced", qty: 1, grams: 140,
    macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 }, at: AT.toISOString(),
  };
  return { source: "bundled", card };
}

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: AT.toISOString(),
} as unknown as CachedRevision;

function catalogPick(foodRefId: string | null = CATALOG_REF): LogPick {
  const card = catalogCard({ revision: REVISION, entryId: CATALOG_EXTRA, itemId: CATALOG_ITEM,
    foodRefId: foodRefId ?? "local", grams: 50, qty: 50, portion: null, at: AT });
  return { source: "catalog", card, itemId: CATALOG_ITEM, foodRefId, revision: REVISION,
    grams: 50, qty: 50, unit: "g", portionId: null };
}

const POUCH: Food = {
  id: "mystery-pouch", name: "Grandma's veggie pouch", role: "carb", unit: "pouch",
  perUnit: { protein: 2, carbs: 14, fat: 1 }, status: "eats", updatedAt: AT.toISOString(),
};

const MEAL = { name: "Lunch bowl", note: "" };

beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetFoodRefCache();
  saveStore({ ...loadStore(), days: {} });
});

describe("gap 2: a mixed meal with a non-ready pick", () => {
  it("waits whole: the ready catalog item and the non-ready bundled item are both kept, nothing partial is sent", async () => {
    const { mint } = flakyMinter();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(), bundledPick()],
      slot: "meal-3", meal: MEAL, at: AT, tz: TZ, mint, fetchImpl });

    expect(out.status).toBe("deferred");
    expect(fetchImpl).not.toHaveBeenCalled();
    const [card] = getDay(DATE)?.extras ?? [];
    expect(card.items?.map((i) => i.food_ref_id)).toEqual([CATALOG_REF, `local:${CHICKEN}`]);
    expect(card.items?.[1].macros).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5 });
    expect(card.localOnly).toBeUndefined();
    expect(await pendingEntryIds(h)).toContain(card.id);
    expect(await readAllDeferred(h)).toHaveLength(1);
  });

  it("commits every item as one entry once the missing ref can be minted", async () => {
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(), bundledPick()],
      slot: "meal-3", meal: MEAL, at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    const provisional = out.entry;

    online();
    const bodies: LogCommitRequest[] = [];
    const report = await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });

    expect(report.committed.map((c) => c.entryId)).toEqual([provisional.id]);
    expect(bodies).toHaveLength(1);
    const req = bodies[0];
    expect(req.entry_id).toBe(provisional.id);
    expect(req.local_date).toBe(DATE);
    expect(req.title).toBe("Lunch bowl");
    expect(req.items.map((i) => i.food_ref_id)).toEqual([
      CATALOG_REF, "dddddddd-0000-4000-8000-000000000001"]);
    // The ids the card showed are the ids the server stores.
    expect(req.items.map((i) => i.id)).toEqual(provisional.items?.map((i) => i.id));
    const extras = getDay(DATE)?.extras ?? [];
    expect(extras).toHaveLength(1);
    expect(extras[0].items?.some((i) => i.food_ref_id.startsWith("local:"))).toBe(false);
    expect(await readAllDeferred(h)).toEqual([]);
    expect(await pendingEntryIds(h)).not.toContain(provisional.id);
  });

  it("resolves a catalog pick with no committed ref before the commit, from the registry's resolver", async () => {
    const catalogRef = vi.fn(async () => CATALOG_REF);
    const bodies: LogCommitRequest[] = [];
    const { mint, online } = flakyMinter();
    online();
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(null), bundledPick()],
      slot: "meal-3", meal: MEAL, at: AT, tz: TZ, mint, catalogRef, fetchImpl: okFetch(bodies) });

    expect(out.status).toBe("sent");
    expect(catalogRef).toHaveBeenCalledWith(7, h);
    expect(bodies[0].items[0]).toMatchObject({ id: CATALOG_ITEM, food_ref_id: CATALOG_REF,
      food_revision_id: 910 });
  });

  it("defers a catalog pick whose ref cannot be resolved offline, and resolves it on the drain", async () => {
    let up = false;
    const catalogRef = vi.fn(async () => (up ? CATALOG_REF : null));
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(null)], slot: "meal-1",
      at: AT, tz: TZ, catalogRef, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(out.status).toBe("deferred");
    expect(getDay(DATE)?.extras?.[0].items?.[0].food_ref_id).toBe("local:catalog:7");

    up = true;
    const bodies: LogCommitRequest[] = [];
    await drainDeferredPicks(h, { catalogRef, fetchImpl: okFetch(bodies) });
    expect(bodies[0].items[0].food_ref_id).toBe(CATALOG_REF);
  });

  it("is never sent once the user deletes the waiting card", async () => {
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(), bundledPick()],
      slot: "meal-3", meal: MEAL, at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);

    await forgetLoggedEntry(DATE, out.entry.id, h);
    online();
    const fetchImpl = okFetch([]);
    const report = await drainDeferredPicks(h, { mint, fetchImpl });

    expect(report.committed).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await readAllDeferred(h)).toEqual([]);
  });
});

/** The server refuses the commit: a catalog revision went stale between the tap and the drain. */
const staleFetch = () => vi.fn(async () => new Response(JSON.stringify({
  status: "stale_revision", food_ref_id: CATALOG_REF, revision_id: 910 }),
{ status: 422, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("round 2: a refused deferred log never vanishes (GPT-6 BLOCK 1)", () => {
  async function deferMeal() {
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [catalogPick(), bundledPick()],
      slot: "meal-3", meal: MEAL, at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    online();
    return { mint, entry: out.entry };
  }

  it("keeps the card on Today as a local card marked not saved, with a reason, and the record", async () => {
    const { mint, entry } = await deferMeal();
    const report = await drainDeferredPicks(h, { mint, fetchImpl: staleFetch() });

    expect(report.committed).toEqual([]);
    expect(report.refused.map((r) => r.entryId)).toEqual([entry.id]);
    const extras = getDay(DATE)?.extras ?? [];
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ id: entry.id, localOnly: true,
      notSaved: expect.stringContaining("changed in the catalog") });
    expect(extras[0].items).toHaveLength(2);
    expect(extras[0].items?.every((i) => i.food_ref_id.startsWith("local:"))).toBe(true);
    expect(await refusedDeferred(h)).toEqual([expect.objectContaining({ entryId: entry.id,
      localDate: DATE, status: "stale_revision" })]);
    // Not drawn as a save in progress, and not sent again by the next drain on its own.
    expect(await pendingEntryIds(h)).not.toContain(entry.id);
    const again = okFetch([]);
    await drainDeferredPicks(h, { mint, fetchImpl: again });
    expect(again).not.toHaveBeenCalled();
  });

  const CURRENT = { ...REVISION, revision_id: 911,
    per_100g: { energy_kcal: 270, protein: 9, carbohydrate: 50, fat_total: 3.3 } } as CachedRevision;

  it("a retry after stale_revision re-pins the catalog line to the food's current revision (round 3)", async () => {
    const { mint, entry } = await deferMeal();
    await drainDeferredPicks(h, { mint, fetchImpl: staleFetch() });

    const currentRevision = vi.fn(async () => CURRENT);
    expect(await retryDeferred(h, entry.id, { currentRevision }))
      .toEqual({ status: "waiting", repinned: true });
    expect(currentRevision).toHaveBeenCalledWith(7, h);
    // The waiting card already shows the new numbers: 50 g at 270 kcal / 100 g.
    expect(getDay(DATE)?.extras?.[0].items?.[0].snapshot.energy_kcal?.amount).toBe(135);
    const bodies: LogCommitRequest[] = [];
    await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });
    // The new pin, at the same 50 g; the bundled line is unchanged.
    expect(bodies[0].items[0]).toMatchObject({ food_ref_id: CATALOG_REF, food_revision_id: 911,
      grams: 50 });
    expect(bodies[0].items[1].food_revision_id).toBeNull();
  });

  it("a retry whose food left the catalog, or with no catalog reachable, stays not saved and says why", async () => {
    const { mint, entry } = await deferMeal();
    await drainDeferredPicks(h, { mint, fetchImpl: staleFetch() });

    const gone = await retryDeferred(h, entry.id, { currentRevision: async () => "gone" });
    expect(gone).toMatchObject({ status: "gone", reason: expect.stringContaining("no longer in the catalog") });
    expect(getDay(DATE)?.extras?.[0]).toMatchObject({ localOnly: true,
      notSaved: expect.stringContaining("Bread is no longer in the catalog") });
    const offline = await retryDeferred(h, entry.id, { currentRevision: async () => "offline" });
    expect(offline).toMatchObject({ status: "offline" });
    expect((await refusedDeferred(h))[0].reason).toContain("cannot be reached");
    const fetchImpl = okFetch([]);
    await drainDeferredPicks(h, { mint, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is recoverable: a retry sends it again, and a success replaces the not-saved card", async () => {
    const { mint, entry } = await deferMeal();
    await drainDeferredPicks(h, { mint, fetchImpl: staleFetch() });

    expect(await retryDeferred(h, entry.id, { currentRevision: async () => REVISION }))
      .toEqual({ status: "waiting", repinned: false });
    const bodies: LogCommitRequest[] = [];
    const report = await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });
    expect(report.committed.map((c) => c.entryId)).toEqual([entry.id]);
    expect(bodies[0].items).toHaveLength(2);
    const [card] = getDay(DATE)?.extras ?? [];
    expect(card.notSaved).toBeUndefined();
    expect(card.localOnly).toBeUndefined();
    expect(await readAllDeferred(h)).toEqual([]);
  });

  it("goes only when the user deletes it, and then owes the server nothing", async () => {
    const { mint, entry } = await deferMeal();
    await drainDeferredPicks(h, { mint, fetchImpl: staleFetch() });
    await forgetLoggedEntry(DATE, entry.id, h);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await readAllDeferred(h)).toEqual([]);
    expect(await pendingEntryIds(h)).not.toContain(entry.id);
  });
});

describe("gap 3: a first use offline upgrades to the real ref", () => {
  it("keeps the pick pending, then mints its ref through the registry and commits it", async () => {
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [bundledPick()], slot: "meal-2",
      at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    expect(out.entry.items?.[0].food_ref_id).toBe(`local:${CHICKEN}`);

    // Still offline: the drain keeps the record and counts the miss.
    expect((await drainDeferredPicks(h, { mint })).waiting).toEqual([out.entry.id]);
    expect((await readDeferred(h, out.entry.id))?.attempts).toBe(1);

    online();
    const bodies: LogCommitRequest[] = [];
    await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });
    const ref = bodies[0].items[0].food_ref_id;
    expect(ref).toBe("dddddddd-0000-4000-8000-000000000001");
    const adopted = mint.mock.calls.at(-1)?.[0] as AdoptableFood;
    expect(cachedFoodRef(`user-food:${adopted.id}`, h)).toBe(ref);
  });

  it("upgrading twice is harmless: the same request, the same op, and no second mint", async () => {
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [bundledPick()], slot: "meal-2",
      at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    const record = await readDeferred(h, out.entry.id);
    online();

    // Online for the mint, but the POST is lost: the commit lands in the outbox.
    const first = await drainDeferredPicks(h, { mint, fetchImpl: down() });
    expect(first.committed[0].result).toEqual({ status: "queued" });
    const mints = mint.mock.calls.length;
    const queued = (await allOps(h)).filter((o) => o.entity === "log_entries");
    expect(queued.map((o) => o.op_id)).toEqual([opIdFor(out.entry.id, undefined)]);
    const queuedItems = (queued[0].payload as unknown as LogCommitRequest).items;

    // A crash before the record was taken: the same record is drained again.
    await putMeta(h, deferredKey(out.entry.id), record);
    const bodies: LogCommitRequest[] = [];
    await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });

    expect(mint.mock.calls.length).toBe(mints);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].entry_id).toBe(out.entry.id);
    // The second upgrade built the very request the first one queued: one op id, one write.
    expect(bodies[0].items).toEqual(queuedItems);
    const ops = (await allOps(h)).filter((o) => o.entity === "log_entries");
    expect(ops.length).toBeLessThanOrEqual(1);
    expect(ops.every((o) => o.op_id === opIdFor(out.entry.id, undefined))).toBe(true);
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(await readAllDeferred(h)).toEqual([]);
  });

  it("spaces out a record that keeps missing and never drops it", async () => {
    const { mint } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [bundledPick()], slot: "meal-2",
      at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    for (let i = 0; i < 6; i += 1) await drainDeferredPicks(h, { mint, now: 1_000 });
    const record = await readDeferred(h, out.entry.id);
    // Five free tries, then the sixth drain finds it spaced out and leaves it alone.
    expect(record?.attempts).toBe(5);
    expect(record?.nextAttemptAt).toBeGreaterThan(1_000);
    const calls = mint.mock.calls.length;
    await drainDeferredPicks(h, { mint, now: 1_000 });
    expect(mint.mock.calls.length).toBe(calls);
  });

  it("stays a local card when signed out: there is no account to send it as", async () => {
    const out = await commitOrDeferPickedFoods({ picks: [bundledPick()], slot: "meal-2",
      at: AT, tz: TZ, account: null });
    expect(out).toMatchObject({ status: "no_ref", reason: "signed_out" });
    expect(await readAllDeferred(h)).toEqual([]);
  });

  it("the sheet's own path: prepare answers no_ref unresolved, and deferPickedCommit keeps it", async () => {
    const { mint } = flakyMinter();
    const input = { picks: [bundledPick()], slot: "meal-2" as const, at: AT, tz: TZ, mint };
    const prepared = await preparePickedCommit(input);
    expect(prepared).toMatchObject({ status: "no_ref", reason: "unresolved" });
    if (prepared.status === "ready") throw new Error("ready");
    const out = await deferPickedCommit(input, prepared);
    expect(out.status).toBe("deferred");
  });
});

describe("gap 1: an account food with no known unit weight", () => {
  it("is sent as a count with an unknown mass, never an invented one, and defers like any pick", async () => {
    const card: LoggedFood = { id: "acct-1", foodId: POUCH.id, name: POUCH.name,
      portionLabel: "1 pouch", qty: 2, grams: 200, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      at: AT.toISOString() };
    const { mint, online } = flakyMinter();
    const out = await commitOrDeferPickedFoods({ picks: [{ source: "account", food: POUCH, card }],
      slot: "meal-1", at: AT, tz: TZ, mint, fetchImpl: vi.fn() as unknown as typeof fetch });
    if (out.status !== "deferred") throw new Error(out.status);
    expect(out.entry.items?.[0].grams).toBeNull();
    expect(out.entry.massUnknown).toBe(true);

    online();
    const bodies: LogCommitRequest[] = [];
    await drainDeferredPicks(h, { mint, fetchImpl: okFetch(bodies) });
    expect(bodies[0].items[0]).toMatchObject({ grams: null, qty: 2, unit: "pouch",
      per_unit: { protein: 2, carbohydrate: 14, fat_total: 1 } });
  });
});
