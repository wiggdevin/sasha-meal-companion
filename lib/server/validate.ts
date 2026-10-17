/** Shared input parsers for route params and query strings (W069): a malformed date, id or limit
 *  answers 400, never a Postgres error. Pure; no server-only imports so lib/health can use it. */
import { HttpError } from "@/lib/server/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A real calendar date: the shape alone lets 2026-02-31 roll over and 2026-13-01 throw. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The id, or a 400 naming `what`. */
export function parseUuid(value: string, what = "id"): string {
  if (!isUuid(value)) throw new HttpError(400, "bad_request", `Invalid ${what}.`);
  return value;
}

/** An integer in [min, max] from a query value; `null` (absent) gives `fallback`. */
export function parseLimit(raw: string | null, opts: { min?: number; max: number; fallback: number }): number {
  if (raw === null) return opts.fallback;
  const min = opts.min ?? 1;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > opts.max) {
    throw new HttpError(400, "bad_request", `limit must be a whole number ${min}..${opts.max}.`);
  }
  return value;
}
