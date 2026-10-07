import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { AccountChanged, bindAccount, type AccountHandle } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({
  addCups: vi.fn(),
  undoAddedCups: vi.fn(),
  drainWeighIns: vi.fn(),
  cancelPendingTargetRevision: vi.fn(),
  getDay: vi.fn(),
  loadStore: vi.fn(),
  restoreTargetRevisionOnline: vi.fn(),
  saveMorningWeight: vi.fn(),
  saveStore: vi.fn(),
  saveWeighIn: vi.fn(),
  syncProfileSettings: vi.fn(),
  updateDay: vi.fn(),
}));

vi.mock("@/lib/water-client", () => ({ addCups: mocks.addCups, undoAddedCups: mocks.undoAddedCups,
  addCupsWithRev: async (date: string, cups: number) => ({ cups: await mocks.addCups(date, cups), rev: 7 }) }));
vi.mock("@/lib/store", () => ({
  getDay: mocks.getDay,
  loadStore: mocks.loadStore,
  saveStore: mocks.saveStore,
  updateDay: mocks.updateDay,
}));
vi.mock("@/lib/targets/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/targets/client")>()),
  cancelPendingTargetRevision: mocks.cancelPendingTargetRevision,
  restoreTargetRevisionOnline: mocks.restoreTargetRevisionOnline,
}));
vi.mock("@/lib/today/water-and-weight", async (orig) => ({
  ...(await orig<typeof import("@/lib/today/water-and-weight")>()),
  saveMorningWeight: mocks.saveMorningWeight,
}));
vi.mock("@/lib/health/weigh-in-client", () => ({
  drainWeighIns: mocks.drainWeighIns,
  saveWeighIn: mocks.saveWeighIn,
}));
vi.mock("@/lib/coach/apply-profile", () => ({
  targetPredecessorFor: vi.fn(() => undefined),
  syncProfileSettings: mocks.syncProfileSettings,
}));

import { applyLogWater, applyLogWeight, undoLogWater, undoLogWeight }
  from "@/lib/coach/apply-body";

const DATE = "2026-09-19";
const PREVIOUS_TARGET_ID = "00000000-0000-4000-8000-000000000001";
const RESTORED_TARGET = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: 3,
  source: "derived" as const,
  effectiveFrom: DATE,
  training: { kcal: 2100, protein: 120, carbs: 228, fat: 80 },
  rest: { kcal: 1800, protein: 120, carbs: 153, fat: 80 },
  pins: { trainingKcal: null, restKcal: null, proteinG: null },
  inputs: { effectiveDate: DATE, weightKg: 57, weightSource: "weigh-in" as const,
    trainingWeekdays: [1, 3, 4, 5], activity: "moderate" as const,
    goal: "recomp" as const, formulaName: "profile-energy-v1" },
};

let h: AccountHandle;

beforeEach(async () => {
  vi.clearAllMocks();
  h = await resetTestAccount();
  mocks.addCups.mockResolvedValue(2);
  mocks.drainWeighIns.mockResolvedValue({ posted: 0, pending: 0 });
  mocks.getDay.mockReturnValue({ date: DATE, weightLb: 125 });
  mocks.loadStore.mockReturnValue({ settings: {
    activeTargetProfile: { id: PREVIOUS_TARGET_ID },
  } });
  mocks.cancelPendingTargetRevision.mockResolvedValue(undefined);
  mocks.restoreTargetRevisionOnline.mockResolvedValue(RESTORED_TARGET);
  mocks.saveMorningWeight.mockResolvedValue({ ok: true, previousTargetRevisionId: PREVIOUS_TARGET_ID });
  mocks.saveWeighIn.mockResolvedValue(null);
});

describe("coach body logging", () => {
  it("logs millilitres through the cup-additive Today client and undo subtracts them", async () => {
    const result = await applyLogWater({
      kind: "log_water", actionId: "water", flagged: [], date: DATE, ml: 480,
    });
    expect(mocks.addCups).toHaveBeenCalledWith(DATE, 2);
    if (result.status !== "applied" || result.token.kind !== "log_water") {
      throw new Error("expected water token");
    }
    expect(result.token).toMatchObject({ cups: 2, after: 2, afterRev: 7 });
    mocks.undoAddedCups.mockResolvedValueOnce(true);
    await undoLogWater(result.token);
    expect(mocks.undoAddedCups).toHaveBeenLastCalledWith(DATE, 2, 2, 7);
  });

  it("refuses to subtract when the day no longer holds what the add left (a correction since)", async () => {
    mocks.undoAddedCups.mockResolvedValueOnce(false);
    await expect(undoLogWater({ kind: "log_water", date: DATE, cups: 2, after: 6 }))
      .rejects.toThrow("Water has changed since");
  });

  it("an old token without the count after does not run at all", async () => {
    mocks.addCups.mockClear();
    await expect(undoLogWater({ kind: "log_water", date: DATE, cups: 2 })).rejects.toThrow("Edit the count");
    expect(mocks.addCups).not.toHaveBeenCalled();
    expect(mocks.undoAddedCups).not.toHaveBeenCalled();
  });

  it.each([[500, 2], [120, 1], [150, 1], [600, 3], [1000, 4]])(
    "logs %i ml as %i whole cups, the only amount the water log stores", async (ml, cups) => {
      const result = await applyLogWater({ kind: "log_water", actionId: "water", flagged: [], date: DATE, ml });
      expect(mocks.addCups).toHaveBeenLastCalledWith(DATE, cups);
      expect(result.status === "applied" && result.token.kind === "log_water" && result.token.cups).toBe(cups);
    });

  it.each([20, 100, 119])("does not promote a %i ml sip to a whole cup", async (ml) => {
    mocks.addCups.mockClear();
    const result = await applyLogWater({ kind: "log_water", actionId: "water", flagged: [], date: DATE, ml });
    expect(result.status).toBe("failed");
    expect(mocks.addCups).not.toHaveBeenCalled();
  });

  it("converts kg to the pounds accepted by the T8 client and restores the prior value on undo", async () => {
    // The target revision dates by the phone's own local day (targetDayFor), so `now` is local noon
    // on DATE: a fixed UTC instant would roll to the next day in zones east of UTC+9.
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "America/Denver", now: new Date(`${DATE}T12:00:00`) });
    expect(mocks.saveMorningWeight).toHaveBeenCalledWith(
      DATE, expect.closeTo(128.09, 2), expect.any(Function),
      { tz: "America/Denver", fetchImpl: undefined, targetDate: DATE,
        detailed: true, predecessor: undefined },
    );
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    await undoLogWeight(result.token, { now: new Date("2026-09-20T12:00:00") }); // local noon, next day
    expect(mocks.updateDay).toHaveBeenCalledWith(DATE, { weightLb: 125 });
    expect(mocks.saveWeighIn).toHaveBeenCalledWith(DATE, 125, {
      tz: "America/Denver", fetchImpl: undefined, account: h,
    });
    expect(mocks.drainWeighIns).toHaveBeenCalledWith(h, {
      tz: "America/Denver", fetchImpl: undefined,
    });
    expect(mocks.updateDay.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.drainWeighIns.mock.invocationCallOrder[0]);
    expect(mocks.restoreTargetRevisionOnline).toHaveBeenCalledWith(
      PREVIOUS_TARGET_ID, "2026-09-20", undefined, h,
    );
    expect(mocks.syncProfileSettings).toHaveBeenCalledWith(expect.objectContaining({
      trainingKcal: null,
      restKcal: null,
      proteinG: null,
      activeTargetProfile: RESTORED_TARGET,
    }), h, ["trainingKcal", "restKcal", "proteinG"]);
    expect(mocks.saveStore.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.syncProfileSettings.mock.invocationCallOrder[0]);
    expect(mocks.saveStore).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ activeTargetProfile: RESTORED_TARGET }),
    }));
  });

  describe("on a Los Angeles device with an Auckland account", () => {
    // 23:30 on 2026-10-05 in Los Angeles is 19:30 on 2026-10-06 in Auckland.
    const NOW = new Date("2026-10-06T06:30:00.000Z");
    let savedTz: string | undefined;
    beforeEach(() => {
      savedTz = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
    });
    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    it("dates the weight's target write and its Undo restore by the device's local day", async () => {
      const result = await applyLogWeight({ kind: "log_weight", actionId: "travel-weight",
        flagged: [], date: DATE, kg: 58.1 }, { tz: "Pacific/Auckland", now: NOW });
      expect(mocks.saveMorningWeight).toHaveBeenCalledWith(DATE, expect.any(Number),
        expect.any(Function), expect.objectContaining({ targetDate: "2026-10-05" }));
      if (result.status !== "applied" || result.token.kind !== "log_weight") {
        throw new Error("expected weight token");
      }
      await undoLogWeight(result.token, { now: NOW });
      expect(mocks.restoreTargetRevisionOnline).toHaveBeenCalledWith(
        PREVIOUS_TARGET_ID, "2026-10-05", undefined, h);
    });
  });

  it("receives the first-write predecessor from the same request as the weigh-in revision", async () => {
    const complete = { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
      activityLevel: "moderate", goal: "recomp", trainingWeekdays: [1, 3, 4, 5],
      trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
      rampOverride: null, slotTimes: {}, shiftMinutes: 0, changedAt: null };
    mocks.loadStore.mockReturnValue({ settings: complete });
    mocks.saveMorningWeight.mockResolvedValueOnce({
      ok: true,
      previousTargetRevisionId: RESTORED_TARGET.id,
    });

    const result = await applyLogWeight({ kind: "log_weight", actionId: "first-weight",
      flagged: [], date: DATE, kg: 58.1 }, { tz: "America/Denver" });

    expect(mocks.saveStore).not.toHaveBeenCalled();
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    expect((result.token as typeof result.token & { previousTargetRevisionId?: string })
      .previousTargetRevisionId).toBe(RESTORED_TARGET.id);
  });

  it("returns an applied partial result and Undo token when only target persistence is queued", async () => {
    const requestId = "00000000-0000-4000-8000-000000000099";
    mocks.saveMorningWeight.mockResolvedValueOnce({
      ok: true,
      partial: "targets",
      message: "Weight saved; targets will refresh on the next sync",
      previousTargetRevisionId: PREVIOUS_TARGET_ID,
      targetRequestId: requestId,
    });

    const result = await applyLogWeight({ kind: "log_weight", actionId: "partial-weight",
      flagged: [], date: DATE, kg: 58.1 }, { tz: "America/Denver" });

    expect(result).toMatchObject({
      status: "applied",
      ok: true,
      partial: "targets",
      message: "Weight saved; targets will refresh on the next sync",
      token: { kind: "log_weight", date: DATE, targetRequestId: requestId },
    });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    await undoLogWeight(result.token);
    expect(mocks.cancelPendingTargetRevision).toHaveBeenCalledWith(requestId, h);
  });

  it("keeps the new local weight when the server refuses to restore the prior one", async () => {
    const currentLb = 128.09;
    const fetchImpl = vi.fn();
    mocks.getDay.mockReturnValueOnce({ date: DATE, weightLb: 125 })
      .mockReturnValue({ date: DATE, weightLb: currentLb });
    mocks.saveWeighIn.mockResolvedValueOnce("That weight looks wrong.");
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-restore-refused", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }

    await expect(undoLogWeight(result.token)).rejects.toThrow(
      "Weight kept — edit it in Settings",
    );
    expect(mocks.saveWeighIn).toHaveBeenCalledWith(DATE, 125, { tz: "UTC", fetchImpl, account: h });
    expect(mocks.updateDay).not.toHaveBeenCalled();
    expect(mocks.getDay()).toEqual({ date: DATE, weightLb: currentLb });
  });

  it("keeps the new local weight when a 500 leaves the restore queued", async () => {
    const currentLb = 128.09;
    const fetchImpl = vi.fn();
    mocks.getDay.mockReturnValueOnce({ date: DATE, weightLb: 125 })
      .mockReturnValue({ date: DATE, weightLb: currentLb });
    // T8's save client returns null for a retryable 500 and parks the write; the drain result is
    // the observable distinction between an accepted restore and one the server never accepted.
    mocks.saveWeighIn.mockResolvedValueOnce(null);
    mocks.drainWeighIns.mockResolvedValueOnce({ posted: 0, pending: 1 });
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-restore-500", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }

    await expect(undoLogWeight(result.token)).rejects.toThrow(
      "Weight kept — edit it in Settings",
    );
    expect(mocks.drainWeighIns).toHaveBeenCalledWith(h, { tz: "UTC", fetchImpl });
    expect(mocks.updateDay).not.toHaveBeenCalled();
    expect(mocks.getDay()).toEqual({ date: DATE, weightLb: currentLb });
  });

  it("removes a newly-created weight locally and from the server on undo", async () => {
    mocks.getDay.mockReturnValue(undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-new", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    await undoLogWeight(result.token);
    expect(mocks.updateDay).toHaveBeenCalledWith(DATE, { weightLb: undefined });
    expect(mocks.drainWeighIns).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/health/weigh-in?date=${DATE}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mocks.updateDay.mock.invocationCallOrder[0])
      .toBeGreaterThan(fetchImpl.mock.invocationCallOrder[0]);
    expect(mocks.saveWeighIn).not.toHaveBeenCalled();
  });

  it("keeps a new local weight when its pending upsert cannot drain", async () => {
    const currentLb = 128.09;
    const fetchImpl = vi.fn();
    mocks.drainWeighIns.mockResolvedValueOnce({ posted: 0, pending: 1 });
    mocks.getDay.mockReturnValueOnce(undefined)
      .mockReturnValue({ date: DATE, weightLb: currentLb });
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-pending", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }

    await expect(undoLogWeight(result.token)).rejects.toThrow(
      "Weight kept — edit it in Settings",
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.updateDay).not.toHaveBeenCalled();
    expect(mocks.getDay()).toEqual({ date: DATE, weightLb: currentLb });
  });

  // PR #248 review r4 #1: an Undo that A started must not delete B's weigh-in for that date.
  it("sends no DELETE for B when the account changes during the drain", async () => {
    mocks.getDay.mockReturnValue(undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-switch", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    mocks.drainWeighIns.mockImplementationOnce(async () => {
      bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      return { posted: 0, pending: 0 };
    });
    await expect(undoLogWeight(result.token)).rejects.toBeInstanceOf(AccountChanged);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.updateDay).not.toHaveBeenCalled();
  });

  it("fails honestly when a newly-created weight cannot be deleted", async () => {
    mocks.getDay.mockReturnValue(undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const result = await applyLogWeight({
      kind: "log_weight", actionId: "weight-delete-fails", flagged: [], date: DATE, kg: 58.1,
    }, { tz: "UTC", fetchImpl });
    if (result.status !== "applied" || result.token.kind !== "log_weight") {
      throw new Error("expected weight token");
    }
    await expect(undoLogWeight(result.token))
      .rejects.toThrow("Weight kept — edit it in Settings");
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/health/weigh-in?date=${DATE}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mocks.updateDay).not.toHaveBeenCalled();
  });

  it("undo: a restore landing after local midnight projects the day it lands on, not the day it was sent", async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T23:59:59.000Z") });
    try {
      // Another write already pinned tomorrow's revision before this Undo ever ran.
      const nextDay = { ...RESTORED_TARGET, id: "00000000-0000-4000-8000-000000000099",
        revision: 50, effectiveFrom: "2026-10-06",
        inputs: { ...RESTORED_TARGET.inputs, effectiveDate: "2026-10-06" } };
      mocks.loadStore.mockReturnValue({ settings: {
        activeTargetProfile: { id: PREVIOUS_TARGET_ID },
        targetHistory: [nextDay],
        targetHistorySince: "2026-10-06",
      } });
      let resolveFn!: (value: typeof RESTORED_TARGET) => void;
      mocks.restoreTargetRevisionOnline.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFn = resolve; }));

      const result = await applyLogWeight({
        kind: "log_weight", actionId: "midnight-weight", flagged: [], date: DATE, kg: 58.1,
      }, { tz: "UTC" });
      if (result.status !== "applied" || result.token.kind !== "log_weight") {
        throw new Error("expected weight token");
      }

      const undoPromise = undoLogWeight(result.token);
      await vi.waitFor(() => expect(mocks.restoreTargetRevisionOnline).toHaveBeenCalled());
      // The restore request itself is still dated the day Undo was actually tapped.
      expect(mocks.restoreTargetRevisionOnline.mock.calls.at(-1)?.[1]).toBe("2026-10-05");

      vi.setSystemTime(new Date("2026-10-06T00:00:05.000Z"));
      resolveFn({ ...RESTORED_TARGET, effectiveFrom: "2026-10-05",
        inputs: { ...RESTORED_TARGET.inputs, effectiveDate: "2026-10-05" } });
      await undoPromise;

      // The cache projects whatever is in force the moment the restore actually landed — the
      // day after, where another write had already pinned a revision — never the day it was sent.
      expect(mocks.saveStore).toHaveBeenCalledWith(expect.objectContaining({
        settings: expect.objectContaining({
          activeTargetProfile: expect.objectContaining({ id: nextDay.id }),
        }),
      }));
    } finally {
      vi.useRealTimers();
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });
});
