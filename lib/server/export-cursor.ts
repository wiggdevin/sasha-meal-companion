/**
 * The one-string cursor the kinds that page by a single opaque value use: a recipe id, a
 * `kind:id` pair, a local date. The log's triple cursor stays in export.ts.
 *
 * It lives here rather than in either of them because T6's `streamWater` (export-water.ts) pages
 * by a date while `streamRecipes`/`streamFavorites` (export.ts) page by an id, and a value import
 * between those two files would be a cycle.
 *
 * W012 (A126, A133): a cursor reaches a PostgREST filter, so every value is checked against the
 * shape of the column it continues (a real calendar date, a strict ISO instant, a uuid) before any
 * filter is built. A malformed cursor is a 422, never a Postgres cast error or an altered `or()`.
 */
import "server-only";
import { HttpError } from "@/lib/server/auth";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `YYYY-MM-DD` naming a real calendar day (`2026-02-30` is not one). */
export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A timestamptz as PostgREST writes it: date, time, optional fraction, then Z or an offset. */
export function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && isLocalDate(value.slice(0, 10))
    && !Number.isNaN(Date.parse(value));
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function malformed(): HttpError {
  return new HttpError(422, "bad_request", "malformed cursor");
}

export function encodeTextCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeTextCursor(raw: string): string {
  const value = Buffer.from(raw, "base64url").toString("utf8");
  if (value.length === 0) throw malformed();
  return value;
}

/** A text cursor that continues a `local_date` column. */
export function decodeDateCursor(raw: string): string {
  const value = decodeTextCursor(raw);
  if (!isLocalDate(value)) throw malformed();
  return value;
}

/** A text cursor that continues a uuid `id` column. */
export function decodeIdCursor(raw: string): string {
  const value = decodeTextCursor(raw);
  if (!isUuid(value)) throw malformed();
  return value;
}
