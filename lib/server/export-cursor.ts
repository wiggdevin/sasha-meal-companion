/**
 * The one-string cursor the kinds that page by a single opaque value use: a recipe id, a
 * `kind:id` pair, a local date. The log's triple cursor stays in export.ts.
 *
 * It lives here rather than in either of them because T6's `streamWater` (export-water.ts) pages
 * by a date while `streamRecipes`/`streamFavorites` (export.ts) page by an id, and a value import
 * between those two files would be a cycle.
 */
import "server-only";
import { HttpError } from "@/lib/server/auth";

export function encodeTextCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeTextCursor(raw: string): string {
  const value = Buffer.from(raw, "base64url").toString("utf8");
  if (value.length === 0) throw new HttpError(422, "bad_request", "malformed cursor");
  return value;
}
