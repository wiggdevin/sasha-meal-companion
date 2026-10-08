"use client";

/**
 * The phone's copy of the account's shopping focus (Phase 18 W11, D7): the stored end and the
 * dated list/pantry keys `GET /api/shopping/focus` answers, held per account in memory. Every
 * generator on the phone reads it through the verified eligible set (`focusOf`,
 * lib/foods/rule-marks.ts): the day layout (`resolveDay`) and the swap sheet.
 *
 * Refreshed after every successful sync pass (lib/sync/post-sync.ts, at most once a minute) and
 * at once after a focus write or Undo here. A change fires `SYNCED_EVENT`, so Today re-plans.
 * An account without Shopping access (404) or a failed read holds no focus: ranking is unchanged.
 *
 * The server decides every timestamp; this module never sends one.
 */
import { accountFetch, accountJson, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import type { FocusKey, FocusState } from "@/lib/shopping/focus";

const REFRESH_MS = 60_000;
const held = new Map<string, { state: FocusState | null; at: number; id: string }>();

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A GET body as a FocusState, or null when it is not one (never a partial state). */
export function parseFocusState(body: unknown): FocusState | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { until?: unknown; keys?: unknown };
  const until = row.until === null ? null
    : typeof row.until === "string" && Number.isFinite(Date.parse(row.until)) ? row.until : undefined;
  if (until === undefined || !Array.isArray(row.keys)) return null;
  const keys: FocusKey[] = [];
  for (const entry of row.keys) {
    const key = entry as Partial<FocusKey>;
    if (typeof key?.key !== "string" || !key.key || typeof key.from !== "string" || !ISO_DAY.test(key.from)
      || typeof key.to !== "string" || !ISO_DAY.test(key.to)) return null;
    keys.push({ key: key.key, from: key.from, to: key.to });
  }
  return { until, keys };
}

function identity(state: FocusState | null): string {
  return state ? JSON.stringify([state.until, state.keys]) : "none";
}

/** Holds `state` for `userId`; fires SYNCED_EVENT when it differs from what was held. */
export function holdShoppingFocus(userId: string, state: FocusState | null, now = Date.now()): void {
  const id = identity(state);
  const before = held.get(userId)?.id ?? "none";
  held.set(userId, { state, at: now, id });
  if (before !== id) globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
}

/** The focus held for `userId` (the current account when omitted), or null. */
export function heldShoppingFocus(userId?: string): FocusState | null {
  const id = userId ?? currentAccountOrNull()?.userId;
  return id ? held.get(id)?.state ?? null : null;
}

/** Forgets every held focus (tests, sign-out). */
export function forgetShoppingFocus(): void {
  held.clear();
}

/**
 * Reads the account's focus from the server. `force` skips the once-a-minute throttle. A 404
 * (no Shopping access) holds none; any other failure keeps what was held.
 */
export async function refreshShoppingFocus(h: AccountHandle, force = false): Promise<void> {
  const last = held.get(h.userId);
  if (!force && last && Date.now() - last.at < REFRESH_MS) return;
  try {
    const zone = deviceZone();
    const query = new URLSearchParams({ date: deviceDay(), ...(zone ? { zone } : {}) });
    const res = await accountFetch(h, `/api/shopping/focus?${query}`, { cache: "no-store" }, { budget: "prefs" });
    if (res.status === 404) { holdShoppingFocus(h.userId, null); return; }
    if (!res.ok) return;
    const state = parseFocusState(await accountJson<unknown>(h, res));
    if (state) holdShoppingFocus(h.userId, state);
  } catch {
    // Keep what was held: a ranking preference, never a reason to fail a sync pass.
  }
}

export type FocusWriteAnswer = { actionId: string; until: string | null; previous: string | null };

function deviceZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

function deviceDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Turns focus on (`days` from now, or the D7 default) or off. The server decides the end; the
 * phone sends only its own day and zone as hints. Re-reads the held focus afterwards.
 */
export async function writeShoppingFocus(h: AccountHandle, on: boolean, days?: number): Promise<FocusWriteAnswer> {
  const zone = deviceZone();
  const res = await accountFetch(h, "/api/shopping/focus", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ on, ...(days !== undefined ? { days } : {}), date: deviceDay(),
      ...(zone ? { zone } : {}) }),
  }, { budget: "prefs" });
  if (!res.ok) throw new Error("shopping-focus request failed");
  const body = await accountJson<Partial<FocusWriteAnswer>>(h, res);
  if (typeof body?.actionId !== "string") throw new Error("shopping-focus answer was invalid");
  await refreshShoppingFocus(h, true);
  return { actionId: body.actionId, until: body.until ?? null, previous: body.previous ?? null };
}

/** Thrown when an Undo found a later choice already in place; nothing was changed. */
export class ShoppingFocusSuperseded extends Error {
  constructor() { super("A later shopping-focus choice is in place."); this.name = "ShoppingFocusSuperseded"; }
}

/** Undoes one write by its id: the server restores what it recorded, only while that write is latest. */
export async function undoShoppingFocusWrite(h: AccountHandle, actionId: string): Promise<void> {
  const res = await accountFetch(h, "/api/shopping/focus/undo", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId }),
  }, { budget: "prefs" });
  if (!res.ok) throw new Error("shopping-focus undo failed");
  const body = await accountJson<{ status?: unknown }>(h, res);
  await refreshShoppingFocus(h, true);
  if (body?.status === "superseded") throw new ShoppingFocusSuperseded();
  if (body?.status !== "undone") throw new Error("shopping-focus undo answer was invalid");
}
