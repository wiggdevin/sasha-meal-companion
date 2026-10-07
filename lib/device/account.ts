/**
 * Which account this phone acts for now (spec Phase 9 §0.1). Every device primitive takes the
 * handle this module gives out and calls `assertCurrent` before it writes, so work that started
 * as one account cannot settle under another.
 */
import { DEADLINES, DeadlineExceeded, fetchWithDeadline, type Budget } from "@/lib/fetch-with-deadline";

export type AccountHandle = Readonly<{ userId: string; epoch: number }>;

export class AccountNotBound extends Error {
  constructor() { super("No account is bound on this device."); this.name = "AccountNotBound"; }
}
export class AccountChanged extends Error {
  constructor() { super("The account changed while this work was running."); this.name = "AccountChanged"; }
}

let epoch = 0;
let bound: string | null = null;
let ready = false;
/** Leaving (lib/device/departure.ts): no new work may start, accepted work may finish. */
let closing = false;
/** Counts handle checks: work still running shows up here (the departure waits for quiet). */
let activity = 0;
const readyListeners = new Set<(h: AccountHandle) => void>();
const goneListeners = new Set<(h: AccountHandle) => void>();

function snapshot(): AccountHandle | null {
  return bound === null ? null : { userId: bound, epoch };
}

/** Unbinds whatever is bound (a no-op epoch bump when nothing is) and returns the old handle. */
export function unbindAccount(): AccountHandle | null {
  const previous = snapshot();
  epoch += 1;
  bound = null;
  ready = false;
  closing = false;
  if (previous) for (const fn of [...goneListeners]) fn(previous);
  return previous;
}

/**
 * The first step of leaving: `accountHandle()` refuses new work and the gone listeners stop sync,
 * but the account stays bound, so work already running (holding its handle) can finish.
 */
export function closeAccount(): void {
  const h = snapshot();
  if (h === null || closing) return;
  closing = true;
  ready = false;
  for (const fn of [...goneListeners]) fn(h);
}

export function isAccountClosing(): boolean { return closing; }

/** A number that changes while work of the bound account runs (for the departure's quiet wait). */
export function accountActivity(): number { return activity; }

/** Same id → the same handle (a token refresh is not a switch). A new id unbinds first. */
export function bindAccount(userId: string): AccountHandle {
  if (bound === userId) return { userId, epoch };
  if (bound !== null) unbindAccount();
  epoch += 1;
  bound = userId;
  ready = false;
  closing = false;
  return { userId, epoch };
}

export function currentAccountOrNull(): AccountHandle | null { return snapshot(); }

/** The entry point of new work. Refused while the account is closing: nothing new starts. */
export function accountHandle(): AccountHandle {
  const h = snapshot();
  if (!h) throw new AccountNotBound();
  if (closing) throw new AccountChanged();
  return h;
}

export function isCurrent(h: AccountHandle): boolean {
  activity += 1;
  return h.epoch === epoch && h.userId === bound;
}

export function assertCurrent(h: AccountHandle): void {
  if (!isCurrent(h)) throw new AccountChanged();
}

/** For a `catch` that falls back to something: an account change is never a fallback case. */
export function rethrowAccountChanged(e: unknown): void {
  if (e instanceof AccountChanged) throw e;
}

/** After legacy adoption finished for this handle: sync and account screens may start. */
export function markAccountReady(h: AccountHandle): void {
  assertCurrent(h);
  if (closing) throw new AccountChanged();
  if (ready) return; // already announced for this bind
  ready = true;
  for (const fn of [...readyListeners]) fn(h);
}

export function isAccountReady(): boolean { return ready && bound !== null; }

/** Fires at once when an account is already ready. */
export function onAccountReady(fn: (h: AccountHandle) => void): () => void {
  readyListeners.add(fn);
  const h = snapshot();
  if (ready && h) fn(h);
  return () => { readyListeners.delete(fn); };
}

export function onAccountGone(fn: (h: AccountHandle) => void): () => void {
  goneListeners.add(fn);
  return () => { goneListeners.delete(fn); };
}

/** The header that names the account a request started as (spec §0.5a). The server answers
 *  `409 account_mismatch` when it is not the session's user. */
export const ACCOUNT_HEADER = "x-smc-account";

/** Fired when the server says the session belongs to another account: AuthGate re-reads it. */
export const SESSION_CHECK_EVENT = "smc:session-check";

/**
 * The only way client code calls an app `/api/` route. Checks the handle before the send AND after
 * the response resolves (audit plan r2 finding 8), and adds `x-smc-account`.
 */
export async function accountFetch(
  h: AccountHandle, input: string, init: RequestInit = {},
  opts: { budget?: Budget; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  assertCurrent(h);
  const started = Date.now();
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_HEADER, h.userId);
  const next: RequestInit = { ...init, headers };
  const res = await (opts.budget
    ? fetchWithDeadline(opts.budget, input, next, { fetchImpl: opts.fetchImpl })
    : (opts.fetchImpl ?? fetch)(input, next));
  assertCurrent(h);
  // The session cookie now belongs to another account (another tab signed in). For this account's
  // work that is the same fact as a local switch: nothing of the answer may be acted on, and no
  // caller may read it as a refusal that rolls back or drops this account's queued work.
  // The 409 body read counts against the same budget as the request (review t4r8 #4): a stalled
  // body must not outlive the deadline the caller asked for.
  if (res.status === 409 && await withinRemaining(isAccountMismatch(res), opts.budget, started)) {
    // The gate re-reads the session and leaves this account (reload boundary).
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
    throw new AccountChanged();
  }
  return res;
}

/** `work`, or DeadlineExceeded once what is left of `budget` since `started` runs out. */
async function withinRemaining<T>(work: Promise<T>, budget: Budget | undefined, started: number): Promise<T> {
  if (!budget) return work;
  const left = DEADLINES[budget] - (Date.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(budget, DEADLINES[budget])), Math.max(0, left));
  });
  void work.catch(() => undefined);
  try { return await Promise.race([work, over]); }
  finally { clearTimeout(timer); }
}

async function isAccountMismatch(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null;
    return body?.error === "account_mismatch";
  } catch {
    return false;
  }
}

/** Bodies from `accountFetch` are read only through these: each checks the handle after parsing. */
export async function accountJson<T>(h: AccountHandle, res: Response): Promise<T> {
  const body = (await res.json()) as T;
  assertCurrent(h);
  return body;
}

export async function accountText(h: AccountHandle, res: Response): Promise<string> {
  const body = await res.text();
  assertCurrent(h);
  return body;
}

export async function accountBlob(h: AccountHandle, res: Response): Promise<Blob> {
  const body = await res.blob();
  assertCurrent(h);
  return body;
}

export const ACCOUNT_KEY_PREFIX = "smc:u:";
export function accountKey(h: AccountHandle, name: string): string {
  return `${ACCOUNT_KEY_PREFIX}${h.userId}:${name}`;
}
