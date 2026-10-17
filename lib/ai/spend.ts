import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";

/**
 * Provider spend and per-local-day capture caps. The shared provider brake is an atomic
 * reservation against the per-user and global daily caps (`reserveSpend` / `settleSpend`); capture
 * call counts remain owned by `ai_calls_today`.
 *
 * `hard = 0` is the kill switch in the rollback plan (spec §11): it stops all provider spend while
 * leaving the sheet's Phase 2 search path intact, so it blocks at a used count of zero.
 *
 */

export type CapState = "ok" | "warn" | "blocked";

/**
 * Phase 13 §3.3 and §8 item 3 (slice 6): Google Search grounding on the `lookup` lane is priced
 * separately from tokens — $14 per 1,000 queries — and counts toward the same daily spend cap
 * `reserveSpend` enforces. One grounded lookup call can spend more than one query
 * (`groundingMetadata.webSearchQueries.length`); an ungrounded or failed call spends zero.
 */
export const GROUNDING_COST_PER_QUERY_USD = 14 / 1000;
/** Search queries one grounded call reserves for; a call that runs more is the bounded overshoot. */
export const GROUNDING_QUERIES_RESERVED = 10;
/** One OpenRouter attempt's reserved ALLOWANCE when no override is set. This app keeps no price
 *  table for OpenRouter's catalog, so this is a configured allowance, not a computed bound: an
 *  attempt that costs more is recorded in full and logged (the bounded overshoot). */
export const DEFAULT_OPENROUTER_ATTEMPT_CEILING_USD = 0.25;

export function groundingCostUsd(webSearchQueries: number): number {
  if (!Number.isFinite(webSearchQueries) || webSearchQueries <= 0) return 0;
  return webSearchQueries * GROUNDING_COST_PER_QUERY_USD;
}

const DEFAULT_SOFT = 30;
const DEFAULT_HARD = 100;
const DEFAULT_SPEND_CAP_USD = 2;
/** The whole deployment's daily ceiling across every account (scale S2), when the env is unset. */
export const DEFAULT_GLOBAL_SPEND_CAP_USD = 50;
/** OD01: what background calls, across every account, may commit in a UTC day, when the env is unset. */
export const DEFAULT_BACKGROUND_SPEND_CAP_USD = 10;
/** OD01: the part of each account's daily cap background calls may never use, when the env is unset. */
export const DEFAULT_INTERACTIVE_RESERVE_USD = 1;
/** How long a reservation holds its amount when the function that made it never settles. */
export const RESERVATION_TTL_SECONDS = 300;

function usdFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) {
    console.error(`${name} is not a non-negative number; using the default`, { value });
    return fallback;
  }
  return raw;
}

/** `AI_OPENROUTER_ATTEMPT_CEILING_USD`, which must be a number > 0 (else the default, logged). */
export function openRouterAttemptCeilingUsd(): number {
  const value = usdFromEnv("AI_OPENROUTER_ATTEMPT_CEILING_USD", DEFAULT_OPENROUTER_ATTEMPT_CEILING_USD);
  if (value > 0) return value;
  console.error("AI_OPENROUTER_ATTEMPT_CEILING_USD must be greater than 0; using the default", { value });
  return DEFAULT_OPENROUTER_ATTEMPT_CEILING_USD;
}

/** The provider-reported cost of one OpenRouter attempt, logged when it beats the allowance. */
export function openRouterAttemptCost(costUsd: number): number {
  const allowance = openRouterAttemptCeilingUsd();
  if (costUsd > allowance) {
    console.warn("OpenRouter attempt cost more than its configured allowance; recorded in full", {
      cost_usd: costUsd, allowance_usd: allowance,
    });
  }
  return costUsd;
}

/** One user's UTC-day cap (`AI_DAILY_SPEND_CAP_USD`, default $2). 0 is the kill switch. */
export function spendCapUsd(): number {
  return usdFromEnv("AI_DAILY_SPEND_CAP_USD", DEFAULT_SPEND_CAP_USD);
}

/** Every account's UTC-day total (`AI_GLOBAL_DAILY_SPEND_CAP_USD`, default $50). */
export function globalSpendCapUsd(): number {
  return usdFromEnv("AI_GLOBAL_DAILY_SPEND_CAP_USD", DEFAULT_GLOBAL_SPEND_CAP_USD);
}

/** OD01: background calls' UTC-day ceiling across every account (`AI_BACKGROUND_DAILY_SPEND_CAP_USD`,
 *  default $10). 0 stops background spend and leaves interactive turns alone. */
export function backgroundSpendCapUsd(): number {
  return usdFromEnv("AI_BACKGROUND_DAILY_SPEND_CAP_USD", DEFAULT_BACKGROUND_SPEND_CAP_USD);
}

/** OD01: the share of each account's cap kept for its own interactive turns
 *  (`AI_INTERACTIVE_RESERVE_USD`, default $1 of $2). Background calls for an account may commit at
 *  most its cap less this. */
export function interactiveReserveUsd(): number {
  return usdFromEnv("AI_INTERACTIVE_RESERVE_USD", DEFAULT_INTERACTIVE_RESERVE_USD);
}

/** A hold on the daily caps for one model call, released to its actual cost by `settleSpend`. */
export type SpendReservation = { id: string; amountUsd: number };

function unavailable(userId: string, error: unknown): HttpError {
  console.error("ai spend reservation failed; refusing the call (fail closed)", {
    user_id: userId, error: error instanceof Error ? error.message : error,
  });
  return new HttpError(503, "spend_unavailable", "The spend check is unavailable. Try again.",
    { cause: error });
}

const usd = (n: unknown): number => (typeof n === "number" ? n : Number(n));

/**
 * Shared Gemini/OpenRouter/Jev brake (scale S2): before any provider I/O, reserve the call's
 * maximum estimated cost against BOTH the user's daily cap and the global daily ceiling, in one
 * database transaction (`ai_spend_reserve`, migration 20261218090100) that every instance shares.
 * Refused when either would be exceeded (429 `spend_cap`, the copy the clients already show).
 * A background call (`background: true`, OD01, migration 20270103090000) also has to fit the
 * background ceiling and leave the account's interactive reserve untouched (both count open holds).
 * Any failure to reserve refuses the call (503 `spend_unavailable`): a model call is never made
 * blind to the caps.
 */
export async function reserveSpend(
  admin: SupabaseClient, userId: string, amountUsd: number, opts: { background?: boolean } = {},
): Promise<SpendReservation> {
  const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  const cap = spendCapUsd();
  const globalCap = globalSpendCapUsd();
  const background = opts.background === true;
  let result: { data: unknown; error: unknown };
  try {
    result = await admin.rpc("ai_spend_reserve_split", {
      p_user_id: userId, p_amount_usd: amount, p_user_cap_usd: cap,
      p_global_cap_usd: globalCap, p_ttl_seconds: RESERVATION_TTL_SECONDS,
      p_background: background, p_background_cap_usd: backgroundSpendCapUsd(),
      p_interactive_reserve_usd: interactiveReserveUsd(),
    });
  } catch (error) {
    throw unavailable(userId, error);
  }
  if (result.error) throw unavailable(userId, result.error);
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as {
    reservation_id?: unknown; allowed?: unknown; reason?: unknown; user_committed_usd?: unknown;
  } | null | undefined;
  if (!row || typeof row.allowed !== "boolean") {
    throw unavailable(userId, new Error("ai_spend_reserve returned an unexpected row"));
  }
  if (!row.allowed) {
    if (row.reason === "global_cap") {
      console.error("global daily AI spend ceiling reached; refusing model calls", {
        ceiling_usd: globalCap,
      });
      throw new HttpError(429, "spend_cap", "daily AI spend cap reached for today. Try again tomorrow.");
    }
    if (row.reason === "background_cap" || row.reason === "background_user_cap") {
      // Background work stops for the day; the account's own turns keep their reserve.
      console.warn("background AI spend limit reached; refusing the background call", {
        reason: row.reason, user_id: userId,
      });
      throw new HttpError(429, "spend_cap", "daily background AI spend limit reached for today.");
    }
    const spent = usd(row.user_committed_usd);
    throw new HttpError(429, "spend_cap",
      `daily AI spend cap reached: $${(Number.isFinite(spent) ? spent : cap).toFixed(2)} of $${cap.toFixed(2)}`);
  }
  if (typeof row.reservation_id !== "string") {
    throw unavailable(userId, new Error("ai_spend_reserve allowed without a reservation id"));
  }
  return { id: row.reservation_id, amountUsd: amount };
}

/**
 * Settles a reservation to the call's actual cost (0 releases a call that never reached a
 * provider). The full actual cost is recorded even when it beats the hold — that overrun is the
 * cap's bounded overshoot, so it is logged. Never throws: the caller already has its answer. One
 * retry; if both fail, the reservation stays open (it keeps counting against both caps) and
 * `ai_spend_sweep` reconciles it from the call's ai_calls row once it expires.
 */
export async function settleSpend(
  admin: SupabaseClient, reservation: SpendReservation, actualUsd: number,
  opts: { sweepChance?: number } = {},
): Promise<void> {
  const actual = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0;
  if (actual > reservation.amountUsd) {
    console.warn("ai call cost more than its reservation; recorded in full (bounded overshoot)", {
      reservation_id: reservation.id, reserved_usd: reservation.amountUsd, actual_usd: actual,
    });
  }
  let lastError: unknown = null;
  let settled = false;
  for (let attempt = 0; attempt < 2 && !settled; attempt++) {
    try {
      const { error } = await admin.rpc("ai_spend_settle", {
        p_reservation_id: reservation.id, p_actual_usd: actual,
      });
      if (error) lastError = error; else settled = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!settled) {
    console.error("ai spend settle failed; the reservation stays open for ai_spend_sweep to reconcile", {
      reservation_id: reservation.id, actual_usd: actual, error: lastError,
    });
  }
  if (Math.random() < (opts.sweepChance ?? SWEEP_CHANCE)) await sweepSpend(admin);
}

/** About one settle in 50 also runs the bounded sweep, in its own transaction after the settle. */
const SWEEP_CHANCE = 0.02;

/** Reconciles expired holds and prunes old rows (`ai_spend_sweep`). Never throws. */
export async function sweepSpend(admin: SupabaseClient): Promise<void> {
  try {
    const { error } = await admin.rpc("ai_spend_sweep", { p_max: 100 });
    if (error) console.error("ai_spend_sweep failed", { error });
  } catch (error) {
    console.error("ai_spend_sweep failed", { error });
  }
}

function readCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  // An unparseable cap reads as NaN, and `used >= NaN` is false — the brake would be silently off.
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function softCap(env: Record<string, string | undefined> = process.env): number {
  return readCap(env.CAPTURE_DAILY_SOFT_CAP, DEFAULT_SOFT);
}

export function hardCap(env: Record<string, string | undefined> = process.env): number {
  return readCap(env.CAPTURE_DAILY_HARD_CAP, DEFAULT_HARD);
}

export function capState(usedToday: number, soft: number, hard: number): CapState {
  if (hard === 0 || usedToday >= hard) return "blocked";
  if (soft > 0 && usedToday >= soft) return "warn";
  return "ok";
}
