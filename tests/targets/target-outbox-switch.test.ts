/**
 * PR #248 review r2 #4: a queued target revision never replays over a newer one the server already
 * accepted. The newest intent is written to the queue before its send, so an answer lost to a switch
 * leaves THAT record (idempotent through its request id) — not the older one — to replay.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStore, __resetStoreCache, loadStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import { AccountChanged, bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import {
  drainPendingTargetRevisions, persistDerivedTargetRevision, persistDerivedTargetRevisionSet,
  readPendingTargetRevisions, restoreTargetRevisionOnline, TargetRevisionQueuedError,
} from "@/lib/targets/client";

const A = "00000000-0000-4000-8000-000000000010";
const B = "00000000-0000-4000-8000-000000000011";

const revision = {
  id: "00000000-0000-4000-8000-000000000020", revision: 2, source: "derived" as const,
  effectiveFrom: "2026-09-19",
  training: { kcal: 2100, protein: 120, carbs: 228, fat: 80 },
  rest: { kcal: 1800, protein: 120, carbs: 153, fat: 80 },
  pins: { trainingKcal: null, restKcal: null, proteinG: null },
  inputs: { effectiveDate: "2026-09-19", weightKg: 61, weightSource: "weigh-in" as const,
    trainingWeekdays: [1], activity: "moderate" as const, goal: "recomp" as const,
    formulaName: "profile-energy-v1" },
};

let h: AccountHandle;

function input(weightKg: number) {
  return { settings: { ...loadStore().settings, weightKg }, latestWeighInKg: weightKg,
    today: "2026-09-19", trainingWeekdays: [1], source: "derived" as const };
}

const down = () => vi.fn(async () => new Response(null, { status: 503 }));
const acceptedThenSwitch = () => vi.fn(async () => { bindAccount(B); return Response.json({ revision }); });
const sentWeights = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map((c) =>
  (JSON.parse(String((c[1] as RequestInit).body)) as { settings: { weightKg: number } }).settings.weightKg);

async function queue170(): Promise<void> {
  await expect(persistDerivedTargetRevisionSet(input(60), { queueOnFailure: true, fetchImpl: down() }))
    .rejects.toBeInstanceOf(TargetRevisionQueuedError);
}

function backToA(): AccountHandle {
  unbindAccount();
  h = bindAccount(A);
  return h;
}

beforeEach(async () => {
  h = await resetTestAccount(A);
  globalThis.indexedDB = new IDBFactory();
  const cells = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => { cells.set(k, v); },
    removeItem: (k: string) => { cells.delete(k); },
  });
  __resetStoreCache();
  saveStore({ ...defaultStore(), settings: { ...defaultStore().settings, sex: "female",
    birthYear: 1996, heightCm: 165, weightKg: 60, activityLevel: "moderate", goal: "recomp" } },
  { silent: true });
});

describe("target revisions across a lost answer", () => {
  it("replays the accepted newer revision, never the older queued one (queued path)", async () => {
    await queue170();
    await expect(persistDerivedTargetRevisionSet(input(61),
      { queueOnFailure: true, fetchImpl: acceptedThenSwitch() })).rejects.toBeInstanceOf(AccountChanged);
    const a = backToA();
    const drain = vi.fn<typeof fetch>(async () => Response.json({ revision }));
    await drainPendingTargetRevisions(a, { fetchImpl: drain });
    expect(sentWeights(drain)).toEqual([61]);
    expect(await readPendingTargetRevisions(a)).toEqual([]);
  });

  it("replays the accepted newer revision, never the older queued one (direct path)", async () => {
    await queue170();
    await expect(persistDerivedTargetRevision(input(61), acceptedThenSwitch(), h))
      .rejects.toBeInstanceOf(AccountChanged);
    const a = backToA();
    const drain = vi.fn<typeof fetch>(async () => Response.json({ revision }));
    await drainPendingTargetRevisions(a, { fetchImpl: drain });
    expect(sentWeights(drain)).toEqual([61]);
  });

  it("retires the older queued revision once a newer direct one is accepted", async () => {
    await queue170();
    await persistDerivedTargetRevision(input(61), vi.fn(async () => Response.json({ revision })), h);
    expect(await readPendingTargetRevisions(h)).toEqual([]);
  });

  // PR #248 review r3 #3: a restore carries no request id the server dedupes on, so it is never
  // queued (as on main): a lost answer must not leave a restore to replay later.
  it("never queues a restore, even when its answer is lost to a switch", async () => {
    await queue170();
    const before = await readPendingTargetRevisions(h);
    await expect(restoreTargetRevisionOnline("rev-1", "2026-09-19", acceptedThenSwitch(), h))
      .rejects.toBeInstanceOf(AccountChanged);
    const a = backToA();
    expect(await readPendingTargetRevisions(a)).toEqual(before);
  });

  it("keeps the older queued revision when a newer direct one fails outright", async () => {
    await queue170();
    const before = await readPendingTargetRevisions(h);
    await expect(persistDerivedTargetRevision(input(61), down(), h)).rejects.toThrow();
    expect(await readPendingTargetRevisions(h)).toEqual(before);
  });
});
