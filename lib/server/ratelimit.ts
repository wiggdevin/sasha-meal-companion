/**
 * Shared fixed-window rate limiter (scale S2). The count lives in Postgres
 * (`rate_limit_hit`, migration 20261218090000), so every serverless instance shares one window
 * and a cold start forgets nothing.
 *
 * Every request the limiter lets through was counted by the database. The per-instance Map below
 * only remembers keys the database already REFUSED in their current window, and answers those 429
 * without a round trip; it can never allow anything on its own.
 *
 * When the database call fails, `failure` decides: `fail_closed` (the default) answers 503 with a
 * retry hint; `fail_open` lets the request through with a logged warning. Fail open is for cheap
 * reads of the caller's own data only. Every route that can reach a model, and every expensive or
 * write-amplifying route, stays fail closed (tests/server/ratelimit-call-sites.test.ts).
 *
 * Keys are per user, per token or per IP (lib/server/request-ip.ts), so no row is shared by all users; the
 * cron jobs' static keys are the deliberate exception.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";

export type LimiterFailurePolicy = "fail_closed" | "fail_open";
export const DEFAULT_FAILURE_POLICY: LimiterFailurePolicy = "fail_closed";

/** Seconds a client is told to wait when the limiter itself is unavailable. */
export const UNAVAILABLE_RETRY_SECONDS = 5;

export type RateLimitHit = { allowed: boolean; remaining: number; resetAt: number };
export type RateLimitStore = {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitHit>;
};

/** An HttpError that carries a Retry-After value; `jsonError` sends it as the header. */
export class RetryableHttpError extends HttpError {
  constructor(status: number, code: string, message: string, public retryAfterSeconds: number,
    options?: { cause?: unknown }) {
    super(status, code, message, options);
  }
}

/** The database store: one `rate_limit_hit` call, which increments and answers atomically. */
export function dbRateLimitStore(client: () => SupabaseClient = adminClient): RateLimitStore {
  return {
    async hit(key, limit, windowSeconds) {
      const { data, error } = await client().rpc("rate_limit_hit", {
        p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
      });
      if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        { allowed?: unknown; remaining?: unknown; reset_at?: unknown } | undefined;
      const resetAt = typeof row?.reset_at === "string" ? Date.parse(row.reset_at) : NaN;
      if (typeof row?.allowed !== "boolean" || typeof row.remaining !== "number"
        || !Number.isFinite(resetAt)) {
        throw new Error("rate_limit_hit returned an unexpected row");
      }
      return { allowed: row.allowed, remaining: row.remaining, resetAt };
    },
  };
}

/**
 * A window in this process's memory, opened by the key's first hit (so a unit test never
 * straddles an epoch-aligned boundary). Unit tests only (see `defaultStore`).
 */
export function memoryRateLimitStore(): RateLimitStore & { clear(): void } {
  const windows = new Map<string, { resetAt: number; count: number }>();
  return {
    async hit(key, limit, windowSeconds) {
      const now = Date.now();
      const current = windows.get(key);
      const open = current !== undefined && now < current.resetAt;
      const resetAt = open ? current.resetAt : now + windowSeconds * 1000;
      const count = open ? Math.min(current.count, limit) + 1 : 1;
      windows.set(key, { resetAt, count });
      return { allowed: count <= limit, remaining: Math.max(limit - count, 0), resetAt };
    },
    clear: () => windows.clear(),
  };
}

const memory = memoryRateLimitStore();

/**
 * The database everywhere except a unit-test run (NODE_ENV=test, which Next.js never sets), where
 * route tests run without a database; tests of the database path inject it with
 * `setRateLimitStore`.
 */
function defaultStore(): RateLimitStore {
  return process.env.NODE_ENV === "test" ? memory : dbRateLimitStore();
}

let store: RateLimitStore | null = null;

/** Replace the store. Tests only; `null` restores the default. */
export function setRateLimitStore(next: RateLimitStore | null): void {
  store = next;
}

/** Keys the database refused, until their window resets. Never holds an allowed key. */
const refused = new Map<string, number>();

function sweep(now: number): void {
  if (refused.size < 1000) return;
  for (const [key, resetAt] of refused) {
    if (now >= resetAt) refused.delete(key);
  }
}

function tooMany(resetAt: number, now: number): RetryableHttpError {
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return new RetryableHttpError(429, "rate_limited", `Too many requests. Try again in ${seconds} s.`,
    seconds);
}

export async function enforceRateLimit(
  key: string, limit: number, windowSeconds: number,
  failure: LimiterFailurePolicy = DEFAULT_FAILURE_POLICY,
): Promise<number | null> {
  const now = Date.now();
  const known = refused.get(key);
  if (known !== undefined) {
    if (now < known) throw tooMany(known, now);
    refused.delete(key);
  }
  let hit: RateLimitHit;
  try {
    hit = await (store ?? defaultStore()).hit(key, limit, windowSeconds);
  } catch (cause) {
    if (failure === "fail_open") {
      console.warn("rate limiter unavailable; allowing the request (fail open)", {
        key_prefix: key.split(":")[0], error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
    throw new RetryableHttpError(503, "rate_limit_unavailable",
      `Busy right now. Try again in ${UNAVAILABLE_RETRY_SECONDS} s.`, UNAVAILABLE_RETRY_SECONDS,
      { cause });
  }
  if (!hit.allowed) {
    refused.set(key, hit.resetAt);
    sweep(now);
    throw tooMany(hit.resetAt, now);
  }
  // The window's end on the store's clock, for a caller that must place itself inside the window.
  return hit.resetAt;
}

/** Windows of `enforceInstanceRateLimit`, in this process only. */
const instanceWindows = memoryRateLimitStore();
let instanceKeys = 0;

/**
 * W047 (scale step 7): a pre-auth flood guard that costs no database round trip. The window lives
 * in this instance's memory only, so it bounds what one IP can make ONE instance do before the
 * session check; the shared count is the per-account limit after it, which every caller of this
 * keeps. Only for the reviewed single-read GETs (diet, constraints, rule review), never in place
 * of a shared limit on a write, a model route or an expensive read.
 */
export async function enforceInstanceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  // Bounded memory: start over rather than grow without end (a fresh window only ever allows more).
  if (++instanceKeys > 10_000) { instanceWindows.clear(); instanceKeys = 0; }
  const hit = await instanceWindows.hit(key, limit, windowSeconds);
  if (!hit.allowed) throw tooMany(hit.resetAt, Date.now());
}

/** Forget every refused key and the test store's windows. Tests only. */
export function resetRateLimits(): void {
  refused.clear();
  memory.clear();
  instanceWindows.clear();
  instanceKeys = 0;
}
