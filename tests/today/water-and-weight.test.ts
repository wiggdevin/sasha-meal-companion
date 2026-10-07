/**
 * T8's Today glue: the water read and the morning-weight write, kept out of `app/page.tsx`.
 *
 * No renderer here — this repo has no DOM test environment and `renderToStaticMarkup` never runs an
 * effect — so the hook's two moving parts are exercised through the functions it is built from:
 * `readWater` (the read, tagged with the date it was made for) and `waterLineFor` (the guard that
 * decides whether a read still describes the day on screen). Driving those directly is what makes a
 * late answer for yesterday an actual, reproducible interleaving rather than a claim.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRead, deleteMorningWeight, headerPillLb, latestWeighInKg, readWater, saveMorningWeight,
  TARGETS_PARTIAL_MESSAGE, waterLineFor,
  type DatedWater,
} from "@/lib/today/water-and-weight";
import { HEALTH_DAILY_CACHE_NAME } from "@/lib/health-client";
import { defaultSettings, getDay, loadStore, saveStore } from "@/lib/store";
import { putRow } from "@/lib/sync/idb";
import { TargetRevisionQueuedError } from "@/lib/targets/client";
import { resetTestAccount } from "@/tests/helpers/account";
import { bindAccount, type AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const TZ = "America/Los_Angeles";

/** lib/store.ts is synchronous localStorage; the repo's other client suites stub it the same way. */
function stubLocalStorage(): void {
  const cells = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => void cells.set(k, String(v)),
    removeItem: (k: string) => void cells.delete(k),
    clear: () => cells.clear(),
    key: (i: number) => [...cells.keys()][i] ?? null,
    get length() { return cells.size; },
  } as Storage;
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  stubLocalStorage();
  // lib/store.ts memoises the store in module scope, so a fresh localStorage is not a fresh store.
  saveStore({ ...loadStore(), settings: defaultSettings(), days: {} });
});

describe("the water line", () => {
  /**
   * The bug this guards: navigation moves to Thursday while Wednesday's read is still in flight, the late
   * answer lands last, and the card paints Wednesday's cups under Thursday's date.
   */
  it("never paints one day's cups under another day's date", async () => {
    await putRow(h, "water_log", "2026-09-17", { local_date: "2026-09-17", cups: 3 });
    await putRow(h, "water_log", "2026-09-18", { local_date: "2026-09-18", cups: 9 });

    // Both reads in flight; the one for the previous day resolves last.
    const wednesday = readWater("2026-09-17", "training-10");
    const thursday = readWater("2026-09-18", "training-10");
    let state: DatedWater | undefined;
    state = await thursday;
    state = await wednesday;

    // Viewing Thursday, holding Wednesday's answer: the card shows nothing rather than 3 cups.
    expect(waterLineFor(state, "2026-09-18")).toBeUndefined();
    expect(waterLineFor(await thursday, "2026-09-18")).toEqual({ cups: 9, goal: 8, unit: "oz", goalMode: "auto" });
  });

  /**
   * The re-read after a tap had no such guard: log a cup on Thursday, switch to Wednesday before
   * IndexedDB answers, and the state ended up tagged Thursday — so Wednesday's line showed nothing
   * until the next sync event happened to come along.
   */
  it("drops a re-read that lands after navigation moves to another day", async () => {
    await putRow(h, "water_log", "2026-09-17", { local_date: "2026-09-17", cups: 3 });
    await putRow(h, "water_log", "2026-09-18", { local_date: "2026-09-18", cups: 9 });

    const wednesday = await readWater("2026-09-17", "training-10");
    const thursday = await readWater("2026-09-18", "training-10");

    // Thursday's re-read comes back while Wednesday is the day on screen.
    expect(applyRead(thursday, "2026-09-17", wednesday)).toBe(wednesday);
    // And is kept when it is still the day on screen.
    expect(applyRead(thursday, "2026-09-18", wednesday)).toBe(thursday);
    // Nothing held yet, and an answer for another day: still nothing, never the wrong day.
    expect(applyRead(thursday, "2026-09-17", undefined)).toBeUndefined();
  });

  it("reads the day's cups against the goal for its type", async () => {
    await putRow(h, "water_log", "2026-09-17", { local_date: "2026-09-17", cups: 3 });
    await putRow(h, "user_settings", "settings",
      { water_goal_cups_training: 10, water_goal_cups_rest: 6 });

    expect(await readWater("2026-09-17", "training-10"))
      .toMatchObject({ date: "2026-09-17", cups: 3, goal: 10, goalMode: "manual" });
    expect(await readWater("2026-09-17", "rest"))
      .toMatchObject({ date: "2026-09-17", cups: 3, goal: 6 });
  });

  it("reads a day with no row as zero cups", async () => {
    expect(await readWater("2026-09-17", "training-10"))
      .toEqual({ date: "2026-09-17", cups: 0, goal: 8, unit: "oz", goalMode: "auto" });
  });

  it("reads the auto goal from the weight it is given, with the training-day cups", async () => {
    // 215 lb: 128 oz on a rest day, 144 oz (18 cups) on a training day.
    expect(await readWater("2026-09-17", "rest", 97.52)).toMatchObject({ goal: 16, goalMode: "auto" });
    expect(await readWater("2026-09-17", "training-10", 97.52)).toMatchObject({ goal: 18 });
  });
});

describe("the morning weight", () => {
  const stored = () => getDay("2026-09-17")?.weightLb;

  it("writes locally before the network is touched, and keeps it when the post fails", async () => {
    const order: string[] = [];
    const message = await saveMorningWeight("2026-09-17", 170, () => {
      order.push(`stored:${stored()}`);
    }, { fetchImpl: async () => { order.push("posted"); throw new TypeError("offline"); } });

    expect(message).toBeNull();
    expect(order).toEqual(["stored:170", "posted"]);
    expect(stored()).toBe(170);
  });

  /**
   * A refusal means the server will never hold that number, so leaving it on the phone puts Today
   * and the server permanently at odds — the pill would keep showing a weight that does not exist.
   */
  it("puts the previous weight back when the server refuses the new one", async () => {
    saveStore({ ...loadStore(), days: { "2026-09-17":
      { date: "2026-09-17", weightLb: 169, updatedAt: "2026-09-17T00:00:00.000Z" } } });

    const refused = { status: 422, message: "That weight looks wrong. Check it and try again." };
    const message = await saveMorningWeight("2026-09-17", 10, () => {}, {
      fetchImpl: async () => new Response(JSON.stringify(refused),
        { status: 422, headers: { "content-type": "application/json" } }),
    });

    expect(message).toBe("That weight looks wrong. Check it and try again.");
    expect(stored()).toBe(169);
  });

  // PR #248 review r1 #4: the weigh-in answers after another account is bound. Nothing of the
  // answer touches that account: no revert of its day, no target derivation, no callback.
  it("writes nothing into the new account when the weigh-in answers after a switch", async () => {
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let answer!: (r: Response) => void;
    const writeTargets = vi.fn();
    const stored = vi.fn();
    const pending = saveMorningWeight("2026-09-17", 10, stored, {
      fetchImpl: () => new Promise<Response>((r) => { answer = r; }), writeTargets,
      detailed: true,
    });
    await vi.waitFor(() => expect(answer).toBeDefined());
    bindAccount(B);
    saveStore({ ...loadStore(), days: { "2026-09-17":
      { date: "2026-09-17", weightLb: 10, updatedAt: "2026-09-17T00:00:00.000Z" } } });
    stored.mockClear();
    answer(new Response(JSON.stringify({ status: 422, message: "no" }),
      { status: 422, headers: { "content-type": "application/json" } }));
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(getDay("2026-09-17")?.weightLb).toBe(10); // B's own day untouched
    expect(writeTargets).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
  });

  it("clears the day again when there was no previous weight to put back", async () => {
    const message = await saveMorningWeight("2026-09-17", 10, () => {}, {
      fetchImpl: async () => new Response("{}",
        { status: 422, headers: { "content-type": "application/json" } }),
    });

    expect(message).toBe("Could not save that weight.");
    expect(stored()).toBeUndefined();
  });

  /**
   * Two Saves for the same day, overlapping. Each captured its own "previous" value, so the loser's
   * revert wiped the winner's number: A(10) captured `undefined`, B(171) captured 10, and A's 422
   * put `undefined` back over B's accepted 171. The FAB now disables Save while one is in flight,
   * and the revert itself refuses to touch a value that is no longer the one it wrote.
   */
  it("does not let an earlier refusal wipe a later weight that was accepted", async () => {
    let releaseA: () => void = () => {};
    const parked = new Promise<void>((resolve) => { releaseA = resolve; });

    const a = saveMorningWeight("2026-09-17", 10, () => {}, {
      fetchImpl: async () => {
        await parked;
        return new Response("{}", { status: 422, headers: { "content-type": "application/json" } });
      },
    });
    await Promise.resolve();
    await saveMorningWeight("2026-09-17", 171, () => {}, {
      fetchImpl: async () => new Response(JSON.stringify({ kg: 77.564, sampleId: "s" }),
        { status: 200, headers: { "content-type": "application/json" } }),
    });
    releaseA();
    await a;

    expect(stored()).toBe(171);
  });

  it("tells the caller to repaint after a revert as well as after the write", async () => {
    const repaints = vi.fn();
    await saveMorningWeight("2026-09-17", 10, repaints, {
      fetchImpl: async () => new Response("{}", { status: 422 }),
    });
    expect(repaints).toHaveBeenCalledTimes(2);
  });

  it("writes a new target revision from the latest effective weigh-in before caching it", async () => {
    saveStore({
      ...loadStore(),
      settings: {
        ...loadStore().settings,
        sex: "female",
        birthYear: 1996,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "moderate",
        goal: "recomp",
        trainingWeekdays: [1, 3, 4, 5],
      },
    });
    const revision = {
      id: "00000000-0000-4000-8000-000000000001",
      revision: 2,
      source: "derived" as const,
      effectiveFrom: "2026-09-19",
      training: { kcal: 2016, protein: 154, carbs: 190, fat: 71 },
      rest: { kcal: 1864, protein: 154, carbs: 152, fat: 71 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null },
      inputs: {
        effectiveDate: "2026-09-19",
        weightKg: 77.111,
        weightSource: "weigh-in" as const,
        trainingWeekdays: [1, 3, 4, 5],
        activity: "moderate" as const,
        goal: "recomp" as const, goalRateBpWeek: 0,
        formulaName: "profile-energy-v1",
      },
    };
    const writeTargets = vi.fn(async () => ({ revision }));

    await saveMorningWeight("2026-09-19", 170, () => {}, {
      fetchImpl: async () => Response.json({ kg: 77.1107029, sampleId: "s" }),
      writeTargets,
      targetDate: "2026-09-19",
    });

    expect(writeTargets).toHaveBeenCalledWith(expect.objectContaining({
      today: "2026-09-19",
      latestWeighInKg: 77.111,
      trainingWeekdays: [1, 3, 4, 5],
      source: "derived",
    }), expect.objectContaining({ fetchImpl: expect.any(Function), queueOnFailure: true }));
    expect(loadStore().settings.activeTargetProfile).toEqual(revision);
  });

  it("projects the revision in force when the write lands after local midnight, not when it was sent", async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T23:59:59.000Z") });
    try {
      const current = {
        id: "00000000-0000-4000-8000-000000000008", revision: 8, source: "derived" as const,
        effectiveFrom: "2026-09-18",
        training: { kcal: 2016, protein: 154, carbs: 190, fat: 71 },
        rest: { kcal: 1864, protein: 154, carbs: 152, fat: 71 },
        pins: { trainingKcal: null, restKcal: null, proteinG: null },
        inputs: { effectiveDate: "2026-09-18", weightKg: 60, weightSource: "weigh-in" as const,
          trainingWeekdays: [1, 3, 4, 5], activity: "moderate" as const, goal: "recomp" as const,
          goalRateBpWeek: 0, formulaName: "profile-energy-v1" },
      };
      // Another write already pinned tomorrow's revision before this weigh-in ever landed.
      const nextDay = { ...current, id: "00000000-0000-4000-8000-000000000009", revision: 9,
        effectiveFrom: "2026-10-06", inputs: { ...current.inputs, effectiveDate: "2026-10-06" } };
      saveStore({
        ...loadStore(),
        settings: {
          ...loadStore().settings,
          sex: "female",
          birthYear: 1996,
          heightCm: 165,
          weightKg: 60,
          activityLevel: "moderate",
          goal: "recomp",
          trainingWeekdays: [1, 3, 4, 5],
          activeTargetProfile: current,
          targetHistory: [current, nextDay],
          targetHistorySince: current.effectiveFrom,
        },
      });

      let resolveFn!: (value: { revision: typeof current }) => void;
      const writeTargets = vi.fn<(input: { today: string }) => Promise<{ revision: typeof current }>>(
        () => new Promise((resolve) => { resolveFn = resolve; }));

      const savePromise = saveMorningWeight("2026-10-05", 170, () => {}, {
        fetchImpl: async () => Response.json({ kg: 77.1107029, sampleId: "s" }),
        writeTargets: writeTargets as never,
      });

      await vi.waitFor(() => expect(writeTargets).toHaveBeenCalled());
      // The request itself is still dated the day it was actually sent.
      expect(writeTargets.mock.calls[0]?.[0]).toMatchObject({ today: "2026-10-05" });

      vi.setSystemTime(new Date("2026-10-06T00:00:05.000Z"));
      resolveFn({ revision: { ...current, id: "00000000-0000-4000-8000-000000000010",
        revision: 10, effectiveFrom: "2026-10-05",
        inputs: { ...current.inputs, effectiveDate: "2026-10-05" } } });
      await savePromise;

      // The cache projects whatever is in force the moment the write actually landed — the day
      // after, where another write had already pinned a revision — never the day it was sent.
      expect(loadStore().settings.activeTargetProfile?.id).toBe(nextDay.id);
    } finally {
      vi.useRealTimers();
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it("does not let a backdated sample replace a newer effective weigh-in", async () => {
    saveStore({
      ...loadStore(),
      settings: {
        ...loadStore().settings,
        sex: "female",
        birthYear: 1996,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "moderate",
        goal: "recomp",
        trainingWeekdays: [1, 3, 4, 5],
      },
      days: {
        "2026-09-18": { date: "2026-09-18", weightLb: 165 },
      },
    });
    const writeTargets = vi.fn();

    await saveMorningWeight("2026-09-17", 170, () => {}, {
      fetchImpl: async () => Response.json({ kg: 77.1107029, sampleId: "s" }),
      writeTargets,
      targetDate: "2026-09-19",
    });

    expect(writeTargets).not.toHaveBeenCalled();
  });

  it("marks a weigh-in target revision manual while any target pin is active", async () => {
    saveStore({
      ...loadStore(),
      settings: {
        ...loadStore().settings,
        sex: "female",
        birthYear: 1996,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "moderate",
        goal: "recomp",
        trainingWeekdays: [1, 3, 4, 5],
        trainingKcal: 2200,
      },
    });
    const writeTargets = vi.fn(async (input) => ({
      revision: {
        id: "00000000-0000-4000-8000-000000000001",
        revision: 1,
        source: input.source,
        effectiveFrom: input.today,
        training: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
        rest: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
        pins: { trainingKcal: 2200, restKcal: null, proteinG: null },
        inputs: { effectiveDate: input.today, weightKg: input.latestWeighInKg,
          weightSource: "weigh-in" as const, trainingWeekdays: [1, 3, 4, 5],
          activity: "moderate" as const, goal: "recomp" as const, goalRateBpWeek: 0,
          formulaName: "profile-energy-v1" },
      },
    }));

    await saveMorningWeight("2026-09-19", 170, () => {}, {
      fetchImpl: async () => Response.json({ kg: 77.1107029, sampleId: "s" }),
      writeTargets: writeTargets as never,
      targetDate: "2026-09-19",
    });

    expect(writeTargets).toHaveBeenCalledWith(expect.objectContaining({
      source: "manual",
      settings: expect.objectContaining({ trainingKcal: 2200 }),
    }), expect.any(Object));
  });

  it("returns partial success after the weight lands but its target revision is queued", async () => {
    saveStore({
      ...loadStore(),
      settings: {
        ...loadStore().settings,
        sex: "female",
        birthYear: 1996,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "moderate",
        goal: "recomp",
        trainingWeekdays: [1, 3, 4, 5],
      },
    });
    const requestId = "00000000-0000-4000-8000-000000000099";

    const result = await saveMorningWeight("2026-09-19", 170, () => {}, {
      detailed: true,
      fetchImpl: async () => Response.json({ kg: 77.1107029, sampleId: "s" }),
      writeTargets: vi.fn(async () => { throw new TargetRevisionQueuedError(requestId); }),
      targetDate: "2026-09-19",
    });

    expect(result).toEqual({
      ok: true,
      partial: "targets",
      message: TARGETS_PARTIAL_MESSAGE,
      previousTargetRevisionId: null,
      targetRequestId: requestId,
    });
    expect(getDay("2026-09-19")?.weightLb).toBe(170);
  });

  it("finds the newest effective weigh-in across local and synchronized health data", () => {
    saveStore({
      ...loadStore(),
      days: {
        "2026-09-17": { date: "2026-09-17", weightLb: 170 },
        "2026-09-21": { date: "2026-09-21", weightLb: 165 },
      },
    });
    localStorage.setItem(`smc:u:${h.userId}:${HEALTH_DAILY_CACHE_NAME}`, JSON.stringify({
      fetchedAt: "2026-09-19T12:00:00.000Z",
      response: { days: [{ local_date: "2026-09-18", body_mass_kg: 76.5,
        steps: null, active_kcal: null, sleep_minutes: null, resting_heart_rate: null,
        hrv_sdnn: null, readiness_score: null, sources: [], provenance: {
          body_mass: { kind: "health_auto_export", end: "2026-09-18T12:00:00.000Z" },
        } }], sources: [] },
    }));

    expect(latestWeighInKg("2026-09-19")).toBe(76.5);
    expect(latestWeighInKg("2026-09-17")).toBeCloseTo(77.111, 3);
  });

  it("deletes the named morning weight and treats an already-absent row as undone", async () => {
    for (const status of [204, 404]) {
      const fetchImpl = vi.fn(async () => new Response(null, { status }));
      await expect(deleteMorningWeight("2026-09-17", { fetchImpl }))
        .resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/health/weigh-in?date=2026-09-17",
        expect.objectContaining({ method: "DELETE" }),
      );
    }
  });

  it("reports that the weight was kept when the delete has no successful answer", async () => {
    const reason = "Weight kept — edit it in Settings";
    await expect(deleteMorningWeight("2026-09-17", {
      fetchImpl: async () => new Response(null, { status: 503 }),
    })).resolves.toEqual({ ok: false, reason });
    await expect(deleteMorningWeight("2026-09-17", {
      fetchImpl: async () => { throw new TypeError("offline"); },
    })).resolves.toEqual({ ok: false, reason });
  });
});

describe("the header pill", () => {
  it("shows nothing for a day the cache has never covered", () => {
    expect(headerPillLb("2026-09-17", undefined)).toBeNull();
  });

  it("shows the weight typed on this device for that day", () => {
    expect(headerPillLb("2026-09-17", 170)).toBe(170);
  });
});

// Keeps the zone helper honest: `saveMorningWeight` must not invent one.
describe("the request the phone sends", () => {
  it("carries the day and the device's own zone", async () => {
    let body: unknown;
    await saveMorningWeight("2026-09-17", 170, () => {}, {
      tz: TZ,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return new Response(JSON.stringify({ kg: 77.111, sampleId: "s" }), { status: 200 });
      },
    });
    expect(body).toEqual({ localDate: "2026-09-17", lb: 170, tz: TZ });
  });
});
