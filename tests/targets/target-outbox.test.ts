import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStore, __resetStoreCache, loadStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const USER_ID = "00000000-0000-4000-8000-000000000010";

const {
  drainPendingTargetRevisions, persistDerivedTargetRevisionSet, readPendingTargetRevisions,
  TargetRevisionQueuedError,
} = await import("@/lib/targets/client");

const revision = {
  id: "00000000-0000-4000-8000-000000000020",
  revision: 2,
  source: "derived" as const,
  effectiveFrom: "2026-09-19",
  training: { kcal: 2100, protein: 120, carbs: 228, fat: 80 },
  rest: { kcal: 1800, protein: 120, carbs: 153, fat: 80 },
  pins: { trainingKcal: null, restKcal: null, proteinG: null },
  inputs: { effectiveDate: "2026-09-19", weightKg: 60, weightSource: "weigh-in" as const,
    trainingWeekdays: [1, 3, 4, 5], activity: "moderate" as const,
    goal: "recomp" as const, formulaName: "profile-energy-v1" },
};

function stubLocalStorage(): void {
  const cells = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
    removeItem: (key: string) => { cells.delete(key); },
  });
}

beforeEach(async () => {
  h = await resetTestAccount(USER_ID);
  globalThis.indexedDB = new IDBFactory();
  stubLocalStorage();
  __resetStoreCache();
  saveStore({ ...defaultStore(), settings: { ...defaultStore().settings,
    sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
    activityLevel: "moderate", goal: "recomp", trainingWeekdays: [1, 3, 4, 5],
  } }, { silent: true });
});

describe("the target revision retry outbox", () => {
  it("keeps a failed write account-scoped, then retries it and refreshes the cache", async () => {
    const settings = loadStore().settings;
    const first = persistDerivedTargetRevisionSet({ settings, latestWeighInKg: 60,
      today: "2026-09-19", trainingWeekdays: [1, 3, 4, 5], source: "derived" }, {
      queueOnFailure: true,
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
    });

    await expect(first).rejects.toBeInstanceOf(TargetRevisionQueuedError);
    const queued = await readPendingTargetRevisions(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ownerId: USER_ID });

    const retry = vi.fn<typeof fetch>(async () => Response.json({ revision }));
    await expect(drainPendingTargetRevisions(h, { fetchImpl: retry }))
      .resolves.toEqual({ posted: 1, pending: 0 });
    expect(JSON.parse(String(retry.mock.calls[0][1]?.body))).toMatchObject({
      requestId: queued[0].requestId,
    });
    expect(loadStore().settings.activeTargetProfile).toEqual(revision);
  });
});

// GPT-6 Sol BLOCK (onb2-p0): onboarding's "Use this plan" retry after a lost answer. The server
// dedupes on the request id (`write_target_revision`, migration 20261023091000), so a retry is
// only safe when it sends the SAME id; the caller now mints it once and passes it on every call.
describe("a target write retried after a lost answer", () => {
  it("sends the caller's one request id on the first attempt and on the retry", async () => {
    const { persistDerivedTargetRevision } = await import("@/lib/targets/client");
    const settings = loadStore().settings;
    const input = { settings, latestWeighInKg: 60, today: "2026-09-19",
      trainingWeekdays: [1, 3, 4, 5], source: "derived" as const };
    const requestId = "00000000-0000-4000-8000-0000000000aa";
    const lost = vi.fn<typeof fetch>(async () => { throw new TypeError("network lost"); });
    await expect(persistDerivedTargetRevision(input, lost, h, requestId)).rejects.toThrow();
    const ok = vi.fn<typeof fetch>(async () => Response.json({ revision }));
    await expect(persistDerivedTargetRevision(input, ok, h, requestId)).resolves.toEqual(revision);
    const sent = [lost, ok].map((f) => JSON.parse(String(f.mock.calls[0][1]?.body)).requestId);
    expect(sent).toEqual([requestId, requestId]);
  });
});
