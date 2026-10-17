import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import type { Settings, TargetRevision } from "@/lib/types";
import { deriveTargetRevision } from "@/lib/profile/derive";
import { defaultStore, __resetStoreCache, loadStore, saveStore } from "@/lib/store";
import { resolveTargets } from "@/lib/targets";
import { targetRevisionOn } from "@/lib/targets/revision";
import { resolveAccountDay } from "@/lib/server/account-day";
import { resetTestAccount } from "@/tests/helpers/account";
import type { ProfileSettings } from "@/lib/sync/user-settings";
import type { AccountHandle } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({
  mutateUserSettings: vi.fn(),
  latestWeighInKg: vi.fn(),
  persistTargetSet: vi.fn(),
  persistTarget: vi.fn(),
  restoreTarget: vi.fn(),
}));

vi.mock("@/lib/sync/outbox", () => ({
  mutateUserSettings: mocks.mutateUserSettings,
  USER_SETTINGS_KEY: "settings",
}));
vi.mock("@/lib/targets/client", async (original) => ({
  ...(await original<typeof import("@/lib/targets/client")>()),
  persistDerivedTargetRevision: mocks.persistTarget,
  persistDerivedTargetRevisionSet: mocks.persistTargetSet,
  restoreTargetRevisionOnline: mocks.restoreTarget,
}));
vi.mock("@/lib/today/water-and-weight", () => ({
  latestWeighInKg: mocks.latestWeighInKg,
}));

import { applySetTargets, applyUpdateProfile, targetPredecessorFor, undoSettingsAction }
  from "@/lib/coach/apply-profile";
const actualTargetsClient = await vi.importActual<typeof import("@/lib/targets/client")>(
  "@/lib/targets/client",
);

/**
 * The server's restore (lib/server/targets.ts restoreTargetRevision) writes a NEW row: the old
 * revision's numbers, effective on the restore date, with the next rev. The phone makes the
 * revision in force today current, so a mock must answer the way the server does.
 */
function restoresAs(revision: TargetRevision, rev = 99): void {
  mocks.restoreTarget.mockImplementationOnce(async (_id: string, effectiveFrom: string) => ({
    ...revision, revision: rev, effectiveFrom,
    inputs: { ...revision.inputs, effectiveDate: effectiveFrom },
  }));
}

function sameNumbers(revision: TargetRevision) {
  return { training: revision.training, rest: revision.rest, pins: revision.pins, revision: 99 };
}

let values: Map<string, string>;
let h: AccountHandle;

function profileAction(fields: Partial<Extract<CoachAction, { kind: "update_profile" }>>):
  Extract<CoachAction, { kind: "update_profile" }> {
  return { kind: "update_profile", actionId: "profile", flagged: [], ...fields };
}

function completeProfile() {
  return {
    sex: "female" as const,
    birthYear: 1992,
    heightCm: 165,
    weightKg: 58.1,
    activityLevel: "moderate" as const,
    goal: "maintain" as const,
    trainingWeekdays: [1, 3, 4, 5],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // A failed test can leave a queued `restoresAs` answer behind; never let it leak into the next.
  mocks.restoreTarget.mockReset();
  h = await resetTestAccount();
  mocks.mutateUserSettings.mockImplementation(async (_h, mutate) => mutate({ rev: 1 }).result);
  mocks.latestWeighInKg.mockReturnValue(null);
  mocks.persistTarget.mockImplementation(async (input) => ({
    ...deriveTargetRevision(input),
    id: "00000000-0000-4000-8000-000000000001",
    revision: 2,
  }));
  mocks.persistTargetSet.mockImplementation(async (input, options) => {
    const revision = {
      ...deriveTargetRevision(input),
      id: "00000000-0000-4000-8000-000000000001",
      revision: 2,
    };
    if (!options?.predecessor) return { revision };
    const prior = options.predecessor.input;
    return {
      revision,
      // `operation: "ramp"` is deleted (design §5.1): every predecessor derives.
      predecessor: {
        ...deriveTargetRevision(prior),
        id: "00000000-0000-4000-8000-000000000000",
        revision: 1,
      },
    };
  });
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  __resetStoreCache();
  saveStore(defaultStore(), { silent: true });
});

/**
 * Target writes stamped with the wrong calendar day: these four once failed whenever the machine's
 * local date differed from the UTC date, because a write with no zone dated its revision by UTC
 * while the phone resolves the revision in force on its LOCAL day. They run once at the real
 * clock and once in a fixed US evening below.
 */
// Noon on the phone's own calendar day, so the local-day rule names the same date in every zone.
function localNoon(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

const localDayCases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
  ["undoes a profile update and re-enqueues the restored profile snapshot", async () => {
    const initial = loadStore();
    const priorSettings: Settings = { ...initial.settings,
      sex: "female", birthYear: 1992, heightCm: 165, weightKg: 55,
      activityLevel: "moderate" as const, goal: "maintain" as const,
    };
    const approved = { ...deriveTargetRevision({ settings: priorSettings,
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...priorSettings, activeTargetProfile: approved } },
      { silent: true });
    restoresAs(approved);

    const applied = await applyUpdateProfile(profileAction({ weightKg: 58.1 }),
      { now: localNoon("2026-09-19") });
    if (applied.status !== "applied" || applied.token.kind !== "update_profile") {
      throw new Error("expected profile token");
    }
    await undoSettingsAction(applied.token);

    expect(loadStore().settings).toMatchObject({ weightKg: 55,
      activeTargetProfile: sameNumbers(approved) });
    expect(mocks.mutateUserSettings).toHaveBeenCalledTimes(2);
  }],

  ["sets the selected kcal pin without changing resolved protein", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings, ...completeProfile() } },
      { silent: true });
    // A saved revision is the only source of numbers now, so seed one before reading.
    const seededRevision = {
      ...deriveTargetRevision({
        settings: { ...loadStore().settings, ...completeProfile() },
        latestWeighInKg: null, today: "2026-09-19", trainingWeekdays: [1, 3, 4, 5],
      }),
      id: "00000000-0000-4000-8000-000000000002",
      revision: 1,
    };
    const seeded = loadStore();
    saveStore({ ...seeded, settings: { ...seeded.settings, activeTargetProfile: seededRevision } },
      { silent: true });
    const before = resolveTargets("training-10", loadStore().settings)!.macros.protein;
    await applySetTargets({
      kind: "set_targets", actionId: "targets", flagged: [], dayType: "training", kcal: 2300,
    });
    const settings = loadStore().settings;
    expect(settings.trainingKcal).toBe(2300);
    expect(settings.restKcal).toBeNull();
    expect(resolveTargets("training-10", settings)!.macros.protein).toBe(before);
    expect(mocks.mutateUserSettings).toHaveBeenCalledOnce();
    expect(mocks.persistTargetSet).toHaveBeenCalledWith(
      expect.objectContaining({ source: "manual" }),
      expect.objectContaining({ fetchImpl: undefined }));
  }],

  ["treats null as an explicit pin clear and persists the cleared revision", async () => {
    const initial = loadStore();
    const previousSettings = { ...initial.settings, ...completeProfile(),
      trainingKcal: 2300, restKcal: 1900, proteinG: 140,
    };
    const previousRevision = { ...deriveTargetRevision({ settings: previousSettings,
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5],
      source: "manual" }), id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...previousSettings,
      activeTargetProfile: previousRevision } }, { silent: true });
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = requestBody as {
        effectiveFrom: string;
        latestWeighInKg: number | null;
        trainingWeekdays: number[];
        settings: Settings;
      };
      const revision = deriveTargetRevision({
        settings: { ...defaultStore().settings, ...body.settings,
          trainingWeekdays: body.trainingWeekdays },
        latestWeighInKg: body.latestWeighInKg,
        today: body.effectiveFrom,
        trainingWeekdays: body.trainingWeekdays,
        source: "manual",
      });
      return Response.json({ revision: { ...revision,
        id: "00000000-0000-4000-8000-000000000009", revision: 9 } });
    });
    mocks.persistTargetSet.mockImplementationOnce((input, options) =>
      actualTargetsClient.persistDerivedTargetRevisionSet(input, options));

    await applySetTargets({
      kind: "set_targets", actionId: "clear-targets", flagged: [],
      dayType: "both", kcal: null, proteinG: null,
    }, { fetchImpl });

    expect(loadStore().settings).toMatchObject({
      trainingKcal: null, restKcal: null, proteinG: null,
    });
    const persistedInput = mocks.persistTargetSet.mock.calls.at(-1)?.[0];
    if (!persistedInput) throw new Error("expected persisted target input");
    expect(persistedInput?.settings).toMatchObject({
      trainingKcal: null, restKcal: null, proteinG: null,
    });
    expect(requestBody).toMatchObject({
      operation: "derive",
      settings: { trainingKcal: null, restKcal: null, proteinG: null },
    });
    const expected = deriveTargetRevision(persistedInput);
    expect(resolveTargets("training-10", loadStore().settings)!.macros)
      .toEqual(expected.training);
    expect(resolveTargets("rest", loadStore().settings)!.macros).toEqual(expected.rest);
  }],

  ["undo restores the prior Settings snapshot including activeTargetProfile", async () => {
    const initial = loadStore();
    const base = { ...initial.settings, ...completeProfile(), trainingKcal: 2100 };
    const approved = { ...deriveTargetRevision({ settings: base,
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...initial.settings,
      ...base, activeTargetProfile: approved,
    } }, { silent: true });
    restoresAs(approved);
    const applied = await applySetTargets({
      kind: "set_targets", actionId: "targets-undo", flagged: [],
      dayType: "both", kcal: 2300, proteinG: 140,
    });
    if (applied.status !== "applied"
      || (applied.token.kind !== "set_targets" && applied.token.kind !== "update_profile")) {
      throw new Error("expected settings token");
    }
    const afterApply = loadStore();
    saveStore({ ...afterApply, settings: { ...afterApply.settings, heightCm: 180 } },
      { silent: true });
    await undoSettingsAction(applied.token);
    expect(loadStore().settings).toMatchObject({
      trainingKcal: 2100, restKcal: null, proteinG: null,
      activeTargetProfile: sameNumbers(approved), heightCm: 180,
    });
  }],
];

describe("profile and target actions", () => {
  it("derives activeTargetProfile after an update completes the profile", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings,
      sex: "female", birthYear: 1992, heightCm: 165,
      activityLevel: "moderate", goal: "maintain",
    } }, { silent: true });
    await applyUpdateProfile(profileAction({ weightKg: 58.1 }),
      { now: localNoon("2026-09-19") });
    expect(loadStore().settings.activeTargetProfile).toMatchObject({
      training: { protein: 105 }, rest: { protein: 105 },
    });
    expect(mocks.mutateUserSettings).toHaveBeenCalledTimes(1);
  });

  it("does not derive targets while the profile is incomplete", async () => {
    await applyUpdateProfile(profileAction({ heightCm: 165 }),
      { now: localNoon("2026-09-19") });
    expect(loadStore().settings.heightCm).toBe(165);
    expect(loadStore().settings.activeTargetProfile).toBeUndefined();
  });

  // The four local-day cases live in `localDayCases` so they also run in a US evening.
  for (const [name, run] of localDayCases) it(name, run);

  it("undo restores the previous server revision before replacing the local cache", async () => {
    const initial = loadStore();
    const previous = {
      ...deriveTargetRevision({ settings: { ...initial.settings, ...completeProfile() },
        latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000009",
      revision: 8,
    };
    saveStore({ ...initial, settings: { ...initial.settings, ...completeProfile(),
      activeTargetProfile: previous,
    } }, { silent: true });
    const restored = { ...previous, id: "00000000-0000-4000-8000-000000000010", revision: 10,
      effectiveFrom: "2026-09-20", inputs: { ...previous.inputs, effectiveDate: "2026-09-20" } };
    mocks.restoreTarget.mockResolvedValueOnce(restored);

    const applied = await applySetTargets({
      kind: "set_targets", actionId: "targets-server-undo", flagged: [],
      dayType: "training", kcal: 2300,
    }, { now: localNoon("2026-09-19") });
    if (applied.status !== "applied" || applied.token.kind !== "set_targets") {
      throw new Error("expected settings token");
    }
    await undoSettingsAction(applied.token, {
      now: localNoon("2026-09-20"),
    });

    expect(mocks.restoreTarget).toHaveBeenCalledWith(
      previous.id,
      "2026-09-20",
      undefined,
      h,
    );
    expect(loadStore().settings.activeTargetProfile).toEqual(restored);
    expect(loadStore().settings.trainingKcal).toBeNull();
  });

  it("creates a derived predecessor before the first profile revision so Undo has authority", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings,
      // Complete but unsaved: no `activeTargetProfile.id` yet, so this write is
      // the account's first revision and its predecessor derives from the prior
      // numbers (design §5.4 — an incomplete prior has none to restore).
      sex: "female", birthYear: 1992, heightCm: 165, weightKg: 57.4,
      activityLevel: "moderate", goal: "maintain", trainingWeekdays: [1, 3, 4, 5],
    } }, { silent: true });
    const applied = await applyUpdateProfile(profileAction({ weightKg: 58.1 }),
      { now: localNoon("2026-09-19") });
    if (applied.status !== "applied" || applied.token.kind !== "update_profile") {
      throw new Error("expected profile token");
    }
    expect(mocks.persistTargetSet).toHaveBeenCalledOnce();
    expect(mocks.persistTargetSet).toHaveBeenCalledWith(expect.any(Object), {
      fetchImpl: undefined,
      predecessor: expect.objectContaining({ operation: "derive" }),
      account: h,
    });
    expect(applied.token.previous.activeTargetProfile?.id)
      .toBe("00000000-0000-4000-8000-000000000000");
    const prior = applied.token.previous.activeTargetProfile;
    if (!prior || typeof prior.revision !== "number" || !prior.source || !prior.effectiveFrom
      || !prior.pins || !prior.inputs) throw new Error("expected predecessor revision");
    mocks.restoreTarget.mockResolvedValueOnce({
      ...prior,
      id: "00000000-0000-4000-8000-000000000011",
      revision: 3,
      effectiveFrom: "2026-09-20",
      inputs: { ...prior.inputs, effectiveDate: "2026-09-20" },
    });

    await undoSettingsAction(applied.token, {
      now: localNoon("2026-09-20"),
    });
    expect(mocks.restoreTarget).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000000", "2026-09-20", undefined, h);
  });

  it("does not publish a predecessor when the atomic first-write request fails", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings,
      // Complete but unsaved: no `activeTargetProfile.id` yet, so this write is
      // the account's first revision and its predecessor derives from the prior
      // numbers (design §5.4 — an incomplete prior has none to restore).
      sex: "female", birthYear: 1992, heightCm: 165, weightKg: 57.4,
      activityLevel: "moderate", goal: "maintain", trainingWeekdays: [1, 3, 4, 5],
    } }, { silent: true });
    mocks.persistTargetSet.mockRejectedValueOnce(new Error("targets unavailable"));

    await expect(applyUpdateProfile(profileAction({ weightKg: 58.1 }), {
      now: localNoon("2026-09-19"),
    })).rejects.toThrow("targets unavailable");

    expect(loadStore().settings.activeTargetProfile).toBeUndefined();
    expect(mocks.persistTarget).not.toHaveBeenCalled();
    expect(mocks.mutateUserSettings).not.toHaveBeenCalled();
  });

  it("marks update_profile manual when an existing pin remains in force", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings, ...completeProfile(),
      trainingKcal: 2200,
    } }, { silent: true });

    await applyUpdateProfile(profileAction({ heightCm: 166 }), {
      now: localNoon("2026-09-19"),
    });

    expect(mocks.persistTargetSet).toHaveBeenCalledWith(expect.objectContaining({
      source: "manual",
      settings: expect.objectContaining({ trainingKcal: 2200 }),
    }), expect.any(Object));
  });

  it("uses the newest phone weigh-in for profile and target recomputes", async () => {
    const initial = loadStore();
    const settings = { ...initial.settings, ...completeProfile() };
    const authority = { ...deriveTargetRevision({ settings, latestWeighInKg: null,
      today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...settings, activeTargetProfile: authority } },
      { silent: true });
    mocks.latestWeighInKg.mockReturnValue(57.25);

    await applySetTargets({ kind: "set_targets", actionId: "latest-weight", flagged: [],
      dayType: "training", kcal: 2300 },
    { now: localNoon("2026-09-19") });

    expect(mocks.persistTargetSet).toHaveBeenLastCalledWith(expect.objectContaining({
      latestWeighInKg: 57.25,
    }), expect.objectContaining({ fetchImpl: undefined }));
  });
});

describe("target writes in a US evening, when the local date is behind the UTC date", () => {
  // 19:30 on 2026-10-05 in Denver is 01:30 on 2026-10-06 in UTC.
  const EVENING = new Date("2026-10-06T01:30:00.000Z");
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Denver";
    vi.useFakeTimers({ toFake: ["Date"], now: EVENING });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("runs with the local date behind the UTC date", () => {
    expect(new Date().getDate()).toBe(5);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-10-06");
  });

  for (const [name, run] of localDayCases) it(name, run);

  it("dates a set_targets revision and its Undo restore by the local day, not the UTC day", async () => {
    const initial = loadStore();
    const base = { ...initial.settings, ...completeProfile() };
    const approved = { ...deriveTargetRevision({ settings: base,
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...base, activeTargetProfile: approved } },
      { silent: true });
    restoresAs(approved);

    const applied = await applySetTargets({
      kind: "set_targets", actionId: "evening", flagged: [], dayType: "training", kcal: 2300,
    });
    expect(mocks.persistTargetSet.mock.calls.at(-1)?.[0]).toMatchObject({ today: "2026-10-05" });
    expect(loadStore().settings.activeTargetProfile?.effectiveFrom).toBe("2026-10-05");
    if (applied.status !== "applied" || applied.token.kind !== "set_targets") {
      throw new Error("expected set_targets token");
    }
    await undoSettingsAction(applied.token);
    expect(mocks.restoreTarget.mock.calls.at(-1)?.[1]).toBe("2026-10-05");
  });

  it("dates an update_profile revision by the local day, not the UTC day", async () => {
    const initial = loadStore();
    saveStore({ ...initial, settings: { ...initial.settings, ...completeProfile() } },
      { silent: true });
    await applyUpdateProfile(profileAction({ weightKg: 60 }));
    expect(mocks.persistTargetSet.mock.calls.at(-1)?.[0]).toMatchObject({ today: "2026-10-05" });
    expect(loadStore().settings.activeTargetProfile?.effectiveFrom).toBe("2026-10-05");
  });
});

describe("write and resolve agree: a Los Angeles device on an Auckland account", () => {
  // 23:30 on 2026-10-05 in Los Angeles is 19:30 on 2026-10-06 in Auckland and 06:30 UTC.
  const NOW = new Date("2026-10-06T06:30:00.000Z");
  const AUCKLAND = "Pacific/Auckland";
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  function seedAucklandAccount() {
    const initial = loadStore();
    // The pull (lib/sync/client.ts) spreads the mirrored `user_settings.time_zone` into Settings.
    const zone: Pick<ProfileSettings, "timeZone"> = { timeZone: AUCKLAND };
    const base: Settings = { ...initial.settings, ...completeProfile(), ...zone };
    const approved = { ...deriveTargetRevision({ settings: base,
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    saveStore({ ...initial, settings: { ...base, activeTargetProfile: approved } },
      { silent: true });
    return { base, approved };
  }

  /** Answer like the server: derive from the posted body, dated by its `effectiveFrom`. */
  function serverDerives(revision: number) {
    const bodies: Array<{ effectiveFrom: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        effectiveFrom: string; latestWeighInKg: number | null;
        trainingWeekdays: number[]; settings: Settings;
      };
      bodies.push(body);
      return Response.json({ revision: { ...deriveTargetRevision({
        settings: { ...defaultStore().settings, ...body.settings,
          trainingWeekdays: body.trainingWeekdays },
        latestWeighInKg: body.latestWeighInKg, today: body.effectiveFrom,
        trainingWeekdays: body.trainingWeekdays, source: "manual",
      }), id: `00000000-0000-4000-8000-00000000000${revision}`, revision } });
    });
    mocks.persistTargetSet.mockImplementationOnce((input, options) =>
      actualTargetsClient.persistDerivedTargetRevisionSet(input, options));
    return { fetchImpl, bodies };
  }

  it("dates a new pin by the device day and keeps it in force there, then Undo restores it", async () => {
    const { approved } = seedAucklandAccount();
    const { fetchImpl, bodies } = serverDerives(9);
    // The coach passes the account's zone; it never dates a target.
    const applied = await applySetTargets({
      kind: "set_targets", actionId: "travel", flagged: [], dayType: "training", kcal: 2300,
    }, { tz: AUCKLAND, fetchImpl });

    expect(bodies.at(-1)?.effectiveFrom).toBe("2026-10-05");
    const settings = loadStore().settings;
    expect(settings.activeTargetProfile).toMatchObject({
      revision: 9, effectiveFrom: "2026-10-05", pins: { trainingKcal: 2300 },
    });
    expect(settings.trainingKcal).toBe(2300);
    // Today resolves to the new pinned revision's numbers (macro rounding moves kcal a little).
    expect(resolveTargets("training-10", settings)!.macros)
      .toEqual(settings.activeTargetProfile?.training);

    restoresAs(approved);
    if (applied.status !== "applied" || applied.token.kind !== "set_targets") {
      throw new Error("expected set_targets token");
    }
    await undoSettingsAction(applied.token, { tz: AUCKLAND });
    expect(mocks.restoreTarget.mock.calls.at(-1)?.[1]).toBe("2026-10-05");
    expect(loadStore().settings.activeTargetProfile).toMatchObject({
      revision: 99, effectiveFrom: "2026-10-05", pins: approved.pins,
    });
  });

  it("dates the derived predecessor by the same device day as the write", () => {
    const { base } = seedAucklandAccount();
    expect(targetPredecessorFor(base, { tz: AUCKLAND })?.input.today).toBe("2026-10-05");
    expect(targetPredecessorFor(base, {})?.input.today).toBe("2026-10-05");
  });

  it("a paired write dates its predecessor by the write's own captured day, whatever the clock says", () => {
    const { base } = seedAucklandAccount();
    expect(targetPredecessorFor(base, {}, "2026-10-04")?.input.today).toBe("2026-10-04");
  });
});

describe("deferred server responses crossing local midnight (round 3 regression)", () => {
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  /** A current revision in force well before midnight, plus one another write already pinned for tomorrow. */
  function seedWithFutureRevision() {
    const initial = loadStore();
    const base = { ...initial.settings, ...completeProfile() };
    const current = { ...deriveTargetRevision({ settings: base, latestWeighInKg: null,
      today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    const nextDay = { ...deriveTargetRevision({ settings: base, latestWeighInKg: null,
      today: "2026-10-06", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000009", revision: 9 };
    saveStore({ ...initial, settings: { ...base, activeTargetProfile: current,
      targetHistory: [current, nextDay], targetHistorySince: current.effectiveFrom } },
      { silent: true });
    return { base, current, nextDay };
  }

  it("set_targets: a response landing after midnight projects the day it lands on, not the day it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T23:59:59.000Z") });
    const { nextDay } = seedWithFutureRevision();

    let resolveFn!: (value: { revision: TargetRevision }) => void;
    mocks.persistTargetSet.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));

    const applyPromise = applySetTargets({
      kind: "set_targets", actionId: "midnight", flagged: [], dayType: "training", kcal: 2300,
    });
    await vi.waitFor(() => expect(mocks.persistTargetSet).toHaveBeenCalled());
    // The request itself is still dated the day it was actually sent.
    expect(mocks.persistTargetSet.mock.calls.at(-1)?.[0]).toMatchObject({ today: "2026-10-05" });

    vi.setSystemTime(new Date("2026-10-06T00:00:05.000Z"));
    resolveFn({ revision: { ...nextDay, revision: 10, effectiveFrom: "2026-10-05",
      id: "00000000-0000-4000-8000-000000000010",
      inputs: { ...nextDay.inputs, effectiveDate: "2026-10-05" } } });
    await applyPromise;

    const settings = loadStore().settings;
    // The cache projects whatever is in force the moment the write actually landed — the day
    // after, where another write had already pinned a revision — never the day it was sent.
    expect(settings.activeTargetProfile?.id).toBe(nextDay.id);
    expect(settings.activeTargetProfile).toEqual(targetRevisionOn(settings, "2026-10-06"));
  });

  it("undo: a restore landing after midnight projects the day it lands on, not the day it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T23:59:59.000Z") });
    const { current, nextDay } = seedWithFutureRevision();
    let resolveFn!: (value: TargetRevision) => void;
    mocks.restoreTarget.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));

    const token = { kind: "set_targets" as const,
      previous: { ...loadStore().settings, activeTargetProfile: current },
      fields: ["activeTargetProfile" as const] };
    const undoPromise = undoSettingsAction(token);
    await vi.waitFor(() => expect(mocks.restoreTarget).toHaveBeenCalled());
    // The restore request itself is still dated the day Undo was actually tapped.
    expect(mocks.restoreTarget.mock.calls.at(-1)?.[1]).toBe("2026-10-05");

    vi.setSystemTime(new Date("2026-10-06T00:00:05.000Z"));
    resolveFn({ ...current, revision: 11, effectiveFrom: "2026-10-05",
      id: "00000000-0000-4000-8000-000000000011",
      inputs: { ...current.inputs, effectiveDate: "2026-10-05" } });
    await undoPromise;

    const settings = loadStore().settings;
    expect(settings.activeTargetProfile?.id).toBe(nextDay.id);
    expect(settings.activeTargetProfile).toEqual(targetRevisionOn(settings, "2026-10-06"));
  });
});

// t24b: the phone's own day comes first, so a travelling phone never sees a revision dated after
// the day it dated the edit by; the account's stored zone dates a request that carries no day, and
// the server falls to the UTC day only when neither the account nor the request has a usable zone
// (lib/server/account-day.ts `resolveAccountDay`).
describe("t24b: account zone versus device zone", () => {
  it("a device travelling away from the account's saved zone (user_settings.time_zone) keeps its own day", () => {
    // Auckland has already turned Oct 6; a phone travelling in Denver is still on Oct 5.
    const now = new Date("2026-10-06T05:30:00Z");
    expect(resolveAccountDay({ purpose: "t", storedZone: "Pacific/Auckland",
      clientDay: "2026-10-05", now })).toEqual({ date: "2026-10-05", zone: null, source: "client_day" });
    expect(resolveAccountDay({ purpose: "t", storedZone: "Pacific/Auckland", now }))
      .toEqual({ date: "2026-10-06", zone: "Pacific/Auckland", source: "account_zone" });
  });

  it("server activeProfile/activeTargets callers fall back to the UTC day only when neither the account nor the request carries a usable zone", () => {
    const now = new Date("2026-10-06T05:30:00Z");
    expect(resolveAccountDay({ purpose: "activeProfile", now }))
      .toEqual({ date: "2026-10-06", zone: "UTC", source: "utc_last_resort" });
    expect(resolveAccountDay({ purpose: "activeProfile", requestZone: "Pacific/Auckland", now }).source)
      .toBe("request_zone");
    expect(resolveAccountDay({ purpose: "activeProfile", storedZone: "Pacific/Auckland", now }).source)
      .toBe("account_zone");
  });
});

describe("body-fat provenance on the profile path (step C)", () => {
  const scanned = { ...completeProfile(), bodyFatPct: 24, bodyFatSource: "dexa" as const,
    bodyFatMeasuredOn: "2026-09-01" };
  const now = new Date("2026-09-22T18:00:00Z");

  function seed(settings: Partial<Settings>): void {
    saveStore({ ...defaultStore(), settings: { ...defaultStore().settings, ...settings } },
      { silent: true });
  }
  const derivedSettings = () => mocks.persistTargetSet.mock.calls.at(-1)?.[0].settings as Settings;

  it("derives from Mifflin when a new value arrives without a source", async () => {
    seed(scanned);
    await applyUpdateProfile(profileAction({ bodyFatPct: 30 }), { now });
    expect(derivedSettings()).toMatchObject({ bodyFatPct: 30, bodyFatSource: null,
      bodyFatMeasuredOn: null });
    expect(loadStore().settings).toMatchObject({ bodyFatSource: null, bodyFatMeasuredOn: null });
  });

  it("derives from the picked scan when the source arrives on its own", async () => {
    seed({ ...scanned, bodyFatSource: null, bodyFatMeasuredOn: null });
    await applyUpdateProfile(profileAction({ bodyFatSource: "inbody",
      bodyFatMeasuredOn: "2026-09-10" }), { now });
    expect(derivedSettings()).toMatchObject({ bodyFatPct: 24, bodyFatSource: "inbody",
      bodyFatMeasuredOn: "2026-09-10" });
  });

  it("restores the scan label with the value on Undo", async () => {
    seed(scanned);
    const result = await applyUpdateProfile(profileAction({ bodyFatPct: 30 }), { now });
    if (result.status !== "applied") throw new Error(result.status);
    expect(result.token).toMatchObject({ fields: expect.arrayContaining(["bodyFatPct",
      "bodyFatSource", "bodyFatMeasuredOn"]) });
  });
});

describe("goal rate on the profile path (step D)", () => {
  const losing = { ...completeProfile(), goal: "lose_fat" as const, goalRateBpWeek: -25 };
  const now = new Date("2026-09-22T18:00:00Z");

  function seed(settings: Partial<Settings>): void {
    saveStore({ ...defaultStore(), settings: { ...defaultStore().settings, ...settings } },
      { silent: true });
  }
  const derivedSettings = () => mocks.persistTargetSet.mock.calls.at(-1)?.[0].settings as Settings;

  it("keeps the confirmed rate through an unrelated edit", async () => {
    seed(losing);
    await applyUpdateProfile(profileAction({ weightKg: 57 }), { now });
    expect(derivedSettings()).toMatchObject({ goal: "lose_fat", goalRateBpWeek: -25 });
  });

  it("gives a changed goal its default rate and lets Undo bring the old one back", async () => {
    const prior = { ...deriveTargetRevision({ settings: { ...defaultStore().settings, ...losing },
      latestWeighInKg: null, today: "2026-09-18", trainingWeekdays: [1, 3, 4, 5] }),
      id: "00000000-0000-4000-8000-000000000008", revision: 8 };
    seed({ ...losing, activeTargetProfile: prior });
    restoresAs(prior);
    const result = await applyUpdateProfile(profileAction({ goal: "gain_muscle" }), { now });
    expect(derivedSettings()).toMatchObject({ goal: "gain_muscle", goalRateBpWeek: 20 });
    expect(loadStore().settings.activeTargetProfile?.inputs?.goalRateBpWeek).toBe(20);
    if (result.status !== "applied" || result.token.kind !== "update_profile") {
      throw new Error("expected a profile token");
    }
    expect(result.token.fields).toEqual(expect.arrayContaining(["goal", "goalRateBpWeek"]));
    await undoSettingsAction(result.token, { now });
    expect(loadStore().settings).toMatchObject({ goal: "lose_fat", goalRateBpWeek: -25,
      activeTargetProfile: sameNumbers(prior) });
  });

  it("never fills in a rate for an account that has not confirmed one", async () => {
    seed({ ...losing, goalRateBpWeek: null });
    await applyUpdateProfile(profileAction({ weightKg: 57 }), { now });
    expect(derivedSettings()).toMatchObject({ goal: "lose_fat", goalRateBpWeek: null });
    expect(loadStore().settings.activeTargetProfile?.inputs?.goalRateBpWeek).toBe(0);
  });
});
