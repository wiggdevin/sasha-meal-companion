"use client";
import { accountHandle } from "@/lib/device/account";

/**
 * T12b's client boundary for reading and writing the four body-profile fields on the normalized
 * `user_settings` row. The legacy localStorage settings object never carries these values.
 *
 * Reads retain T11b's strict stored-row validation. Writes use the shared atomic whole-row
 * `mutateUserSettings` path, then signal every mounted consumer to refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { EMPTY_BODY_PROFILE, PROFILE_UNAVAILABLE, profileState, type BodyProfile,
  type ProfileState, type Sex }
  from "@/lib/tdee";
import { getRow } from "@/lib/sync/idb";
import type { BodyFatSource } from "@/lib/types";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { SYNCED_EVENT } from "@/lib/sync/client";

/** Fired after a successful save; anything showing the profile reloads on it. */
export const BODY_PROFILE_CHANGED_EVENT = "meal-companion:body-profile-changed";

/** What the surfaces print when the IndexedDB read itself failed — retryable, unlike "not set". */
export const PROFILE_READ_ERROR = "Couldn't read your profile.";

/** A birth year cannot be later than the calendar year in which this client is running. */
export const MAX_BIRTH_YEAR = new Date().getFullYear();

/** One bus per page. A module-level `EventTarget` behaves the same in a browser and under Node
 *  (where `globalThis` is not an event target), so the tests drive the real signal path. */
const bus: EventTarget | null = typeof EventTarget === "function" ? new EventTarget() : null;

/** Where the sync client announces a pull: `window` in the browser, `globalThis` in Node. */
function pageTarget(): EventTarget | null {
  if (typeof window !== "undefined") return window as unknown as EventTarget;
  const target = globalThis as { dispatchEvent?: unknown };
  return typeof target.dispatchEvent === "function" ? globalThis as unknown as EventTarget : null;
}

/** The four `user_settings` columns of T11b, in schema order. */
export type BodyProfileColumns = {
  height_cm: number | null; birth_year: number | null; sex: Sex | null; body_fat_pct: number | null;
  /** Step C provenance: written by the source picker, cleared by any new value without one. */
  body_fat_source?: BodyFatSource | null; body_fat_measured_on?: string | null;
};

type Row = Record<string, unknown> & { rev?: number };

/**
 * The four columns at the strict client-read boundary. It keeps the database's physical ranges
 * and additionally refuses a future birth year:
 * `height_cm` 50–260, `birth_year` 1900–current year, `sex` female|male,
 * `body_fat_pct` 3–70, each
 * nullable and each omitted when the row does not carry it. `z.number()` is strict on type, so a
 * boolean (`Number(true)` is 1) or a string cannot stand in for a measurement.
 */
const ProfileRowSchema = z.object({
  height_cm: z.number().min(50).max(260).nullable().optional(),
  birth_year: z.number().int().min(1900).max(MAX_BIRTH_YEAR).nullable().optional(),
  sex: z.enum(["female", "male", "unspecified"]).nullable().optional(),
  body_fat_pct: z.number().min(3).max(70).nullable().optional(),
});

/**
 * The one boundary between a stored row and the profile the surfaces read. A stored row that could
 * not have been stored — out of range, or a boolean where a number belongs — THROWS, so the read
 * reaches the consumer as the retryable error `PROFILE_READ_ERROR` describes instead of a silently
 * coerced profile (split audit, finding 3). Only an absent row is an empty profile.
 */
export function profileFromRow(row: Row | undefined | null): BodyProfile {
  if (!row) return { ...EMPTY_BODY_PROFILE };
  const parsed = ProfileRowSchema.safeParse(row);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`${PROFILE_READ_ERROR} The stored row is not a profile (${fields}).`);
  }
  const { height_cm, birth_year, sex, body_fat_pct } = parsed.data;
  return { heightCm: height_cm ?? null, birthYear: birth_year ?? null, sex: sex ?? null,
    bodyFatPct: body_fat_pct ?? null };
}

export async function loadBodyProfile(): Promise<BodyProfile> {
  const h = accountHandle();
  return profileFromRow((await getRow(h, "user_settings", USER_SETTINGS_KEY)) as Row | undefined);
}

/** The four columns as the sync payload spells them. `null` clears; an omitted key is not an option. */
export function profileToColumns(profile: BodyProfile): BodyProfileColumns {
  return { height_cm: profile.heightCm, birth_year: profile.birthYear, sex: profile.sex,
    body_fat_pct: profile.bodyFatPct };
}

/** Tell every profile consumer that a successful local save landed. */
export function publishBodyProfile(): void {
  bus?.dispatchEvent(new Event(BODY_PROFILE_CHANGED_EVENT));
  pageTarget()?.dispatchEvent(new Event(BODY_PROFILE_CHANGED_EVENT));
}

/**
 * Load once, then again whenever a save lands or a sync pull settles. A rejected read reaches
 * `onError` and never `apply`, so consumers show a retry rather than an empty profile.
 */
export type BodyProfileSubscription = { stop: () => void; retry: () => void };

export function subscribeBodyProfile(apply: (profile: BodyProfile) => void,
    onError?: (error: unknown) => void): BodyProfileSubscription {
  let live = true;
  const reload = () => {
    void loadBodyProfile().then(
      (next) => { if (!live) return; onError?.(null); apply(next); },
      (error: unknown) => { if (live) onError?.(error); },
    );
  };
  reload();
  const signals = [BODY_PROFILE_CHANGED_EVENT, SYNCED_EVENT];
  for (const signal of signals) bus?.addEventListener(signal, reload);
  const page = pageTarget();
  page?.addEventListener(SYNCED_EVENT, reload);
  return {
    retry: reload,
    stop: () => {
      live = false;
      for (const signal of signals) bus?.removeEventListener(signal, reload);
      page?.removeEventListener(SYNCED_EVENT, reload);
    },
  };
}

/**
 * The shared read: the stored profile, refreshed on a save or a pull.
 *
 * `state` is the same fact in the shape the TDEE lines take, and it is the one a surface must use
 * when it needs to tell "the row is empty" from "the row could not be read" (T11b eighth-round
 * finding 5): a failed read keeps the last good profile visible here for the FORM, but reports
 * `unavailable` to the lines, which withhold the lines that would otherwise claim the fields are
 * unset. `profile` is null until the first read lands, which is the same `unavailable`.
 */
export type BodyProfileRead = {
  profile: BodyProfile | null;
  state: ProfileState;
  status: "loading" | "ready" | "error";
  error: unknown;
  retry: () => void;
};

export function useBodyProfile(): BodyProfileRead {
  const [read, setRead] = useState<{ profile: BodyProfile | null;
    status: "loading" | "ready" | "error"; error: unknown }>(
    { profile: null, status: "loading", error: null });
  const subscription = useRef<BodyProfileSubscription | null>(null);

  useEffect(() => {
    const sub = subscribeBodyProfile(
      (profile) => setRead({ profile, status: "ready", error: null }),
      // Keep the last good profile visible; the flag is what turns "missing" into "retry".
      (error) => setRead((prev) => ({ ...prev, status: "error", error })),
    );
    subscription.current = sub;
    return sub.stop;
  }, []);

  const retry = useCallback(() => {
    setRead((prev) => ({ ...prev, status: "loading", error: null }));
    subscription.current?.retry();
  }, []);

  return {
    profile: read.profile,
    state: read.status === "ready" ? profileState(read.profile) : PROFILE_UNAVAILABLE,
    status: read.status,
    error: read.error,
    retry,
  };
}

/**
 * Merge one field into the stored row and queue the WHOLE row: `_sync_upsert` replaces every
 * column it is sent, so a payload carrying only the edited field would blank the targets, slot
 * times and water goals. T11b's migration then keeps these four against an older phone's payload.
 *
 * The mirror row, its speculative rev and its op are committed by `mutateUserSettings` in ONE
 * IndexedDB transaction, which is also the read that produced the payload (Sol audit findings 1
 * and 7, T11b fourth-audit finding 1): the row this merges into cannot be one another writer has
 * already replaced, the rev the next writer reads is the one this op will land on, and if the
 * write rejects, the stored row is untouched and the caller can show a retry instead of a value
 * that only exists in memory.
 */
export async function saveBodyProfile(patch: Partial<BodyProfileColumns>): Promise<BodyProfile> {
  const h = accountHandle();
  const saved = await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const payload = { ...stored, ...patch } as Record<string, unknown>;
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: profileFromRow(payload),
    };
  });
  publishBodyProfile();
  return saved;
}
