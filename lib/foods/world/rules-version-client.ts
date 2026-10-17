/**
 * The phone half of the D11 freshness check (Phase 18 W2b): before any new suggestion, read the
 * server's current token (`GET /api/foods/rules-version`) and use an admitted set only if it was
 * computed under that token. A rule written on another device moves the token, so the next new
 * suggestion refetches its admission, and an admission still stamped with the old token is never
 * used. Offline, nothing new is suggested; the last plan stays on screen (owner question 6).
 *
 * W8 calls `freshAdmission` before layout fill, swaps, coach cards and recipes. A closed account
 * reads the token only for its eligible cache (W047 d, lib/foods/eligible-client.ts); its answers
 * are unchanged.
 */
import { accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import { freshness, parseRulesToken, sameRulesToken, type RulesToken } from "@/lib/foods/world/freshness";

/** The server's current token, or null when it cannot be read (offline, an error, a bad body). */
export async function readRulesToken(account: AccountHandle): Promise<RulesToken | null> {
  try {
    const res = await accountFetch(account, "/api/foods/rules-version", { cache: "no-store" },
      { budget: "prefs" });
    if (!res.ok) return null;
    return parseRulesToken(await accountJson<unknown>(account, res));
  } catch {
    return null;
  }
}

/**
 * The token plus the account's effective food world (`world`, Sol r2 BLOCK): the server reads it
 * through `effectiveFoodWorld`, so an account taken off the release list or put on hold answers
 * `closed`. A held open snapshot is used only while this says `open`; a missing or unknown value
 * (an older server) is never `open`. Null when the token cannot be read.
 */
export type RulesState = {
  token: RulesToken; world: "open" | "closed" | null;
  /**
   * W047 (d): the next instant (ms) a confirmed hard rule opens, closes or expires; null when none
   * will; undefined when the server did not say (an older server, an unreadable profile, a bad
   * value), which allows no cache.
   */
  ruleBoundaryAt?: number | null;
};

export async function readRulesState(account: AccountHandle): Promise<RulesState | null> {
  try {
    const res = await accountFetch(account, "/api/foods/rules-version", { cache: "no-store" },
      { budget: "prefs" });
    if (!res.ok) return null;
    const raw = await accountJson<unknown>(account, res);
    const token = parseRulesToken(raw);
    if (!token) return null;
    const world = (raw as { world?: unknown }).world;
    const boundary = (raw as { ruleBoundaryAt?: unknown }).ruleBoundaryAt;
    const at = typeof boundary === "string" ? Date.parse(boundary) : NaN;
    return { token, world: world === "open" || world === "closed" ? world : null,
      ...(boundary === null ? { ruleBoundaryAt: null } : Number.isFinite(at) ? { ruleBoundaryAt: at } : {}) };
  } catch {
    return null;
  }
}

export type Admission = Readonly<{ token: RulesToken | null }>;

export type FreshAdmissionDeps<T extends Admission> = {
  readToken: () => Promise<RulesToken | null>;
  /** A fresh admission read (W8: `GET /api/foods/eligible?v=3`). May throw. */
  refetch: () => Promise<T>;
};

/**
 * The admission a new suggestion may use, or null when none may be (offline, or the rules kept
 * moving). `held` is reused only while its token is the server's current one; otherwise one fresh
 * read is taken and used only if the server still reports the token it was computed under.
 */
export async function freshAdmission<T extends Admission>(held: T | null,
  deps: FreshAdmissionDeps<T>): Promise<T | null> {
  const current = await deps.readToken();
  if (held && freshness(held.token, current).fresh) return held;
  if (current === null) return null;
  let next: T;
  try {
    next = await deps.refetch();
  } catch {
    return null;
  }
  if (sameRulesToken(next.token, current)) return next;
  // The rules moved during the refetch: accept it only when it is the newest admission.
  const after = await deps.readToken();
  return after !== null && sameRulesToken(next.token, after) ? next : null;
}
