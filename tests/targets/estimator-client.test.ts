import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";
const enqueue = vi.fn();
vi.mock("@/lib/sync/outbox", () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));
const {
  decideProposalOnline, EXPENDITURE_CACHE_NAME, enqueueGuarded, fetchExpenditure, fetchTargets,
  PullOnlyEntityError, readCache, shouldMountWeightTrend, writeCache,
} = await import("@/lib/estimator-client");

let h: AccountHandle;
const store = new Map<string, string>();
beforeEach(async () => {
  h = await resetTestAccount();
  enqueue.mockReset();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
});

describe("the outbox guard", () => {
  it("refuses to enqueue an op for either pull-only entity", async () => {
    for (const entity of ["target_profiles", "target_proposals"] as const) {
      await expect(enqueueGuarded(h, { op_id: "o1", entity, entity_id: "x", kind: "update",
        base_rev: 1, payload: {}, client_ts: "2026-09-11T00:00:00.000Z" }))
        .rejects.toBeInstanceOf(PullOnlyEntityError);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("still enqueues an ordinary entity", async () => {
    enqueue.mockResolvedValue({});
    await enqueueGuarded(h, { op_id: "o1", entity: "water_log", entity_id: "2026-09-11",
      kind: "update", base_rev: 1, payload: {}, client_ts: "2026-09-11T00:00:00.000Z" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("caches", () => {
  it("stamps an as-of date and survives a bad payload", () => {
    writeCache(h, EXPENDITURE_CACHE_NAME, { status: "estimating" }, "2026-09-11");
    expect(readCache(h, EXPENDITURE_CACHE_NAME)).toEqual(
      { asOf: "2026-09-11", value: { status: "estimating" } });
    store.set(`smc:u:${h.userId}:expenditure`, "{not json");
    expect(readCache(h, EXPENDITURE_CACHE_NAME)).toBeNull();
  });
  it("falls back to the cache when the fetch fails", async () => {
    writeCache(h, EXPENDITURE_CACHE_NAME, { status: "estimating" }, "2026-09-10");
    const out = await fetchExpenditure(h, async () => { throw new Error("offline"); });
    expect(out).toEqual({ asOf: "2026-09-10", value: { status: "estimating" }, stale: true });
  });
});

describe("fetchTargets", () => {
  // Finding #77: a failed fetch used to resolve to null, the same value the pre-fetch
  // "nothing loaded yet" state already holds — Settings could never tell the two apart.
  it("rejects instead of silently resolving to null when the network request fails", async () => {
    await expect(fetchTargets(async () => { throw new Error("offline"); })).rejects.toThrow();
  });
  it("rejects instead of silently resolving to null on a non-2xx response", async () => {
    await expect(fetchTargets(async () => new Response("{}", { status: 500 }))).rejects.toThrow();
  });
  it("resolves with the parsed targets on success", async () => {
    const targets = {
      id: "t1", mode: "grams" as const,
      resolved: {
        training: { kcal: 2400, protein: 135, fat: 70, carbs: 250 },
        rest: { kcal: 2100, protein: 135, fat: 70, carbs: 190 },
      },
      raisedToFloor: false,
    };
    const result = await fetchTargets(async () => new Response(JSON.stringify(targets), { status: 200 }));
    expect(result).toEqual(targets);
  });
});

describe("decideProposalOnline", () => {
  it("refuses offline rather than queueing an approval", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(decideProposalOnline("pr1", "approve")).rejects.toThrow(/connection/i);
  });
});

describe("shouldMountWeightTrend", () => {
  it("mounts only past burn-in with at least 20 weigh-ins (F-091)", () => {
    expect(shouldMountWeightTrend("burn_in", 40)).toBe(false);
    expect(shouldMountWeightTrend("estimating", 19)).toBe(false);
    expect(shouldMountWeightTrend("estimating", 20)).toBe(true);
    expect(shouldMountWeightTrend("held", 25)).toBe(true);
  });

  it("gates an exp-3 row on its phase, not on the weigh-in count", () => {
    // A provisional estimate is `burn_in` and may rest on fewer than 20 weigh-ins (step E).
    expect(shouldMountWeightTrend("burn_in", 8, "provisional")).toBe(true);
    expect(shouldMountWeightTrend("estimating", 14, "adaptive")).toBe(true);
    expect(shouldMountWeightTrend("held", 3, "provisional")).toBe(true);
    expect(shouldMountWeightTrend("burn_in", 40, "starting")).toBe(false);
    expect(shouldMountWeightTrend("held", 40, "starting")).toBe(false);
    // No phase: the exp-2 status rule.
    expect(shouldMountWeightTrend("estimating", 19, null)).toBe(false);
    expect(shouldMountWeightTrend("estimating", 20, undefined)).toBe(true);
  });
});
