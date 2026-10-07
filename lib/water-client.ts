/**
 * The client half of water — Phase 3 spec, "Client changes".
 *
 * `addCups` applies the same max rule the server applies (`greatest`, migration 20260919090300),
 * so an offline tap and a later pull agree. `setGoal` sends the WHOLE user_settings row: Phase 0's
 * _sync_upsert replaces every column from the payload, so a payload carrying only the goal would
 * blank their targets and slot times. Since T6 the goal is per day type: `setGoal` moves the column
 * for the viewed day's category, and always carries BOTH split goals plus the legacy one, because
 * the migration's omitted-key rule cannot help a phone that has never written them.
 *
 * 2026-10-03: the goal that applies is `resolveWaterGoal` (lib/water-goal.ts): auto from body
 * weight unless the account is in manual mode, and the unit and mode live in
 * `diet_prefs.water` (lib/water-prefs.ts). `setGoal` marks the account manual in the same op;
 * `setWaterPrefs` changes the unit or mode alone.
 */
import { AccountChanged, accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { clampGoal, goalColumnFor, goalFor, mergeCups, WATER_GOAL_MIN,
  type WaterGoalSettings } from "@/lib/water";
import { resolveWaterGoal, waterWeightKg } from "@/lib/water-goal";
import { dietPrefsWithWater, waterPrefsOfDietPrefs, waterUnitFor, type WaterGoalMode,
  type WaterPrefs } from "@/lib/water-prefs";
import type { WaterUnit } from "@/lib/water-units";
import { getRow, putRow, setLastError } from "@/lib/sync/idb";
import { enqueue, mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import type { DayType } from "@/lib/types";

const SETTINGS_KEY = USER_SETTINGS_KEY;

type Settings = Record<string, unknown> & WaterGoalSettings & { rev?: number };

/** One day's water as Today shows it: the count and the goal in cups, and how to read them. */
export type WaterRead = { cups: number; goal: number; unit: WaterUnit; goalMode: WaterGoalMode };

/** The water half of the settings row: the stored manual goals, the prefs and the profile weight. */
export type WaterSettings = { stored: WaterGoalSettings; prefs: WaterPrefs; profileWeightKg: number | null };

function waterSettingsOf(row: Settings | undefined): WaterSettings {
  return {
    stored: {
      water_goal_cups: row?.water_goal_cups ?? null,
      water_goal_cups_training: row?.water_goal_cups_training ?? null,
      water_goal_cups_rest: row?.water_goal_cups_rest ?? null,
    },
    prefs: waterPrefsOfDietPrefs(row?.diet_prefs),
    profileWeightKg: waterWeightKg(row?.weight_kg),
  };
}

export async function readWaterSettings(): Promise<WaterSettings> {
  const row = (await getRow(accountHandle(), "user_settings", SETTINGS_KEY)) as Settings | undefined;
  return waterSettingsOf(row);
}

/**
 * The day's cups and the goal that applies to it. `weightKg` is the caller's best weight (the
 * latest weigh-in, then the target revision's); the synced profile weight stands in without one.
 */
export async function getWater(
  localDate: string, dayType: DayType, weightKg?: number | null,
): Promise<WaterRead> {
  const h = accountHandle();
  const day = (await getRow(h, "water_log", localDate)) as { cups?: number } | undefined;
  const row = (await getRow(h, "user_settings", SETTINGS_KEY)) as Settings | undefined;
  const { stored, prefs, profileWeightKg } = waterSettingsOf(row);
  const goal = resolveWaterGoal({ dayType, stored, prefs, weightKg: waterWeightKg(weightKg, profileWeightKg) });
  return { cups: Number(day?.cups ?? 0), goal: goal.cups, unit: waterUnitFor(prefs), goalMode: goal.mode };
}

/** One line the user can read on the settings card — never a stack trace, never the body. Mirrors
 *  lib/sync/client.ts's shortMessage: a local write can fail the same way a sync push can. */
function shortMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "something went wrong";
  return raw.slice(0, 90);
}

export async function addCups(localDate: string, delta: number): Promise<number> {
  return writeCups(localDate, (current) => current + delta);
}

/** `addCups`, also answering the row revision the add left (the coach's water Undo binds it). */
export async function addCupsWithRev(
  localDate: string, delta: number,
): Promise<{ cups: number; rev: number | null }> {
  const h = accountHandle();
  const cups = await addCups(localDate, delta);
  const row = (await getRow(h, "water_log", localDate)) as { rev?: unknown } | undefined;
  return { cups, rev: typeof row?.rev === "number" ? row.rev : null };
}

/**
 * Take back cups an add put on the day, only while the day still holds exactly the count that add
 * left (`after`). Answers false, writing nothing, when anything changed the count since — another
 * add, the user's own correction, or this Undo already applied — so an Undo never subtracts twice
 * (review t4r7 #2).
 */
export async function undoAddedCups(
  localDate: string, cups: number, after: number, afterRev?: number,
): Promise<boolean> {
  let matched = false;
  // The revision too, when known (review t4r9 #5): 6 → 5 → 6 is the same count, not the same row.
  await writeCups(localDate, (current, rev) => {
    matched = current === after && (afterRev === undefined || rev === afterRev);
    return matched ? current - cups : current;
  });
  return matched;
}

/**
 * Set the day's count to `cups` (the dial's slider, the tile's scrub). Absolute: the change is
 * worked out from the stored count at write time, never from a count a screen rendered earlier,
 * so two quick sets land on the last one asked for instead of adding up (audit b4b #4).
 */
export async function setCups(
  localDate: string, cups: number, h: AccountHandle = accountHandle(),
): Promise<number> {
  return writeCups(localDate, () => cups, h);
}

/** Water writes run one at a time: each reads the count the one before it stored, and no two queue
 *  an op on the same base rev. */
let waterQueue: Promise<unknown> = Promise.resolve();

function writeCups(
  localDate: string, target: (current: number, rev: number | null) => number,
  h: AccountHandle = accountHandle(),
): Promise<number> {
  const run = waterQueue.then(() => writeCupsNow(h, localDate, target));
  waterQueue = run.catch(() => undefined);
  return run;
}

async function writeCupsNow(
  h: AccountHandle, localDate: string, target: (current: number, rev: number | null) => number,
): Promise<number> {
  try {
    assertCurrent(h);
    const row = (await getRow(h, "water_log", localDate)) as
      { cups?: number; rev?: number } | undefined;
    const current = Number(row?.cups ?? 0);
    const wanted = target(current, typeof row?.rev === "number" ? row.rev : null);
    const next = wanted >= current
      ? mergeCups(current, wanted)               // a cup the user drank is never un-drunk
      : Math.max(0, wanted);                     // their own correction, applied as the user asked
    // Already there (a set to the stored count): nothing to write or sync.
    if (row && Math.round(next) === current) return current;
    const rev = typeof row?.rev === "number" ? row.rev : null;
    // Whole cups only (an integer column); this also heals a stale fractional count left on the device.
    const payload = { local_date: localDate, cups: Math.round(next) };
    await putRow(h, "water_log", localDate, { ...row, ...payload, rev: (rev ?? 0) + 1 });
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "water_log", entity_id: localDate,
      kind: rev === null ? "create" : "update", base_rev: rev, payload,
      client_ts: new Date().toISOString() });
    return payload.cups;
  } catch (e) {
    // A tap that fails must be visible and retryable, never a silent unhandled rejection
    // (finding 66): record it where the settings card already reads a last-failure message.
    // Never into another account's database (Phase 9 §0.2).
    if (e instanceof AccountChanged) throw e;
    await setLastError(h, shortMessage(e));
    throw e;
  }
}

export async function setGoal(cups: number, dayType: DayType): Promise<number> {
  const h = accountHandle();
  const goal = clampGoal(cups);
  const column = goalColumnFor(dayType);
  // The goal is a whole-row write like the profile save, so it goes through the same atomic
  // read-modify-write (T11b audit finding 1): a private queue here would still let a save read the
  // pre-goal row and enqueue it back. `mutateUserSettings` owns the mirror's speculative rev, so
  // the save that follows this one queues N+1 — not the same N, which the server rejects.
  await mutateUserSettings(h, (row) => {
    const settings = row as Settings;
    const rev = typeof settings.rev === "number" ? settings.rev : null;
    const { rev: _rev, user_id: _userId, ...columns } = settings;
    void _rev; void _userId;
    // Materialize both split goals and the legacy column before enqueueing: an upgraded phone whose
    // IDB row predates T6 (legacy-only, or empty) has no split goal to send, and the server would
    // otherwise seed the one the user did not edit from the row's default rather than the goal the user set.
    const split = {
      water_goal_cups_training: goalFor("training-10", settings),
      water_goal_cups_rest: goalFor("rest", settings),
    };
    // `water_goal_cups` keeps whatever the user had; release A's column is never reset to the 8 the
    // server would substitute for an omitted key. It is never the source of a split goal here.
    const storedLegacy = Number(columns.water_goal_cups);
    const legacy = Number.isFinite(storedLegacy) && storedLegacy >= WATER_GOAL_MIN
      ? storedLegacy : split.water_goal_cups_training;
    // A goal set by hand puts the account in manual mode in the same op, so auto never overrides it.
    const materialized = { ...columns, ...split, water_goal_cups: legacy, [column]: goal,
      diet_prefs: dietPrefsWithWater(columns.diet_prefs, { goal: "manual" }) };
    return {
      row: { ...settings, ...materialized },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload: materialized, client_ts: new Date().toISOString() },
      result: goal,
    };
  });
  return goal;
}

/**
 * Change the water unit or goal mode. One key, `diet_prefs`, so the settings intent records only
 * that; every other key of the stored object (`flags`, `text`, `lifestyle`) is carried as stored.
 */
export async function setWaterPrefs(patch: WaterPrefs): Promise<WaterPrefs> {
  const h = accountHandle();
  return mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const dietPrefs = dietPrefsWithWater(row.diet_prefs, patch);
    const payload = { diet_prefs: dietPrefs };
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: waterPrefsOfDietPrefs(dietPrefs),
    };
  });
}
