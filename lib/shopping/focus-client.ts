"use client";

/**
 * The phone's copy of the account's shopping focus (Phase 18 W11, D7): the stored end and the
 * dated list/pantry keys `GET /api/shopping/focus` answers, held per account in memory. Every
 * generator on the phone reads it through the verified eligible set (`focusOf`,
 * lib/foods/rule-marks.ts): the day layout (`resolveDay`) and the swap sheet.
 *
 * Refreshed after every successful sync pass (lib/sync/post-sync.ts, at most once a minute) and
 * at once after a focus write or Undo here. A change fires `SYNCED_EVENT`, so Today re-plans.
 * An account without Shopping access (404), a failed read, or a read whose body does not parse
 * holds no focus — fail-safe: no focus never blocks a plan, so it is always the safe state to
 * fall back to (Sol W11 r2 BLOCK: a failed refresh used to keep whatever was held before it,
 * which could resurrect an "on" state a later write had already turned off).
 *
 * A successful write applies the POST's own answer (its `until`, off means `null`) to the cache
 * at once, before any refresh is even asked for, so that write is never undone by a refresh that
 * fails afterwards. Every apply to the held state — a write, a GET, a 404, a failure — carries a
 * per-account ticket minted when that read or write STARTED; an apply is dropped whenever a
 * higher ticket has already been applied, so an older in-flight GET can never overwrite a newer
 * result or a newer write, however the two resolve relative to each other.
 *
 * The server decides every timestamp; this module never sends one.
 */
import { accountFetch, accountJson, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import type { FocusKey, FocusState } from "@/lib/shopping/focus";

const REFRESH_MS = 60_000;
const held = new Map<string, { state: FocusState | null; at: number; id: string; ticket: number }>();
/** The highest ticket minted so far for each account (read or write); never decreases. */
const tickets = new Map<string, number>();

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

/** Mints the next ticket for `userId` (monotonic per account) and remembers it as the latest issued. */
function mintTicket(userId: string): number {
  const next = (tickets.get(userId) ?? 0) + 1;
  tickets.set(userId, next);
  return next;
}

/**
 * Applies `state` for `userId` under `ticket`, unless a higher ticket was applied already — a
 * read or write that started before a later one that has already landed loses, whichever order
 * the two resolve in. Fires SYNCED_EVENT when the applied state differs from what was held.
 */
function applyFocus(userId: string, state: FocusState | null, ticket: number, now: number): void {
  const prior = held.get(userId);
  if (prior && ticket < prior.ticket) return;
  const id = identity(state);
  const before = prior?.id ?? "none";
  held.set(userId, { state, at: now, id, ticket });
  if (before !== id) globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
}

/**
 * Holds `state` for `userId` directly, as the account's current truth (tests, and the Undo path
 * once it has the server's answer): always wins over any ticket issued before now.
 */
export function holdShoppingFocus(userId: string, state: FocusState | null, now = Date.now()): void {
  applyFocus(userId, state, mintTicket(userId), now);
}

/** The focus held for `userId` (the current account when omitted), or null. */
export function heldShoppingFocus(userId?: string): FocusState | null {
  const id = userId ?? currentAccountOrNull()?.userId;
  return id ? held.get(id)?.state ?? null : null;
}

/** Forgets every held focus and every ticket (tests, sign-out). */
export function forgetShoppingFocus(): void {
  held.clear();
  tickets.clear();
}

/**
 * Reads the account's focus from the server. `force` skips the once-a-minute throttle. A 404
 * (no Shopping access), any other failed response, an unreadable body or a thrown error all
 * apply "no focus" — fail-safe, and never a reason to fail a sync pass. The ticket minted here
 * before the request is sent is what keeps this call from clobbering a write or another read
 * that landed first (see `applyFocus`).
 */
export async function refreshShoppingFocus(h: AccountHandle, force = false): Promise<void> {
  const last = held.get(h.userId);
  if (!force && last && Date.now() - last.at < REFRESH_MS) return;
  const ticket = mintTicket(h.userId);
  try {
    const zone = deviceZone();
    const query = new URLSearchParams({ date: deviceDay(), ...(zone ? { zone } : {}) });
    const res = await accountFetch(h, `/api/shopping/focus?${query}`, { cache: "no-store" }, { budget: "prefs" });
    if (!res.ok) { applyFocus(h.userId, null, ticket, Date.now()); return; }
    const state = parseFocusState(await accountJson<unknown>(h, res));
    applyFocus(h.userId, state, ticket, Date.now());
  } catch {
    // Fail-safe: an unreadable answer is no different from a failed one — hold no focus.
    applyFocus(h.userId, null, ticket, Date.now());
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
  // Minted here, before the request is even sent: the ticket reflects when this write STARTED, not
  // when it returned. A later-starting write or read always gets a higher ticket, so it always wins
  // over this one regardless of resolve order; a read that started before this write always loses to
  // it below, whichever of the two resolves first (newest-start wins, per `applyFocus`'s ticket order).
  const ticket = mintTicket(h.userId);
  const zone = deviceZone();
  const res = await accountFetch(h, "/api/shopping/focus", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ on, ...(days !== undefined ? { days } : {}), date: deviceDay(),
      ...(zone ? { zone } : {}) }),
  }, { budget: "prefs" });
  if (!res.ok) throw new Error("shopping-focus request failed");
  const body = await accountJson<Partial<FocusWriteAnswer>>(h, res);
  if (typeof body?.actionId !== "string") throw new Error("shopping-focus answer was invalid");
  const until = body.until ?? null;
  // Apply the server's own answer to the cache at once (requirement 1 of the Sol r2 fix): off
  // is exact and needs no refresh; on holds no keys yet (coverage under-counts, never blocks)
  // until the refresh below fills them in.
  applyFocus(h.userId, until === null ? null : { until, keys: [] }, ticket, Date.now());
  // Not awaited: the write has already taken effect above, and a slow or failing refresh must
  // never hold up — or undo — the write's own answer (it can only ever replace it with a newer,
  // more complete read, per `applyFocus`'s ticket order).
  void refreshShoppingFocus(h, true);
  return { actionId: body.actionId, until, previous: body.previous ?? null };
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
