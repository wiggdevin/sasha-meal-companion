/**
 * Self-serve account deletion, server side (`POST /api/account/delete`).
 *
 * Order, chosen so a failure at any step leaves nothing orphaned and a retry finishes the job:
 *
 *  1. Storage: every object under `media/<user id>/` is removed while the account still exists.
 *     If Storage fails, nothing else has changed: the account is whole and the user can retry.
 *  2. `delete_account(user)` (migration 20261231190000): ONE transaction removes every row the
 *     account owns — the rows no cascade reaches, its job-cursor retry keys and rate-limit
 *     windows, then the `auth.users` row, which every account table cascades from. It either
 *     happens whole or not at all, so the database never holds half an account.
 *  3. The Auth admin API delete: GoTrue's own confirmation that the user is gone. After step 2 it
 *     answers "user not found", which counts as done; if a GoTrue ever kept state outside the
 *     auth row, this is the call that clears it.
 *
 * Every step is retry-safe: a removed object is not listed again, the function answers
 * `already_gone` for an account it already deleted, and the admin delete accepts "not found".
 * Shared catalog tables are never touched (the function deletes by account id only).
 *
 * Not reached: the nightly whole-database JSON backup in the `backups` bucket. It holds every
 * account at once and is replaced daily; a deleted account leaves it as those copies age out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { MEDIA_BUCKET } from "@/lib/server/media";

/** How recently the user must have signed in (a fresh code) to delete the account. */
export const RECENT_SIGN_IN_SECONDS = 10 * 60;

const PAGE = 1000;
const REMOVE_BATCH = 100;
/** At most this many list-and-remove passes (50,000 objects) before the request gives up. */
const MAX_PASSES = 50;
const MAX_DEPTH = 3;

export type AccountDeleteResult = { status: "deleted" | "already_gone" };

type AmrEntry = { method?: unknown; timestamp?: unknown };

/** The newest authentication time in the session's claims (seconds), or null. */
export function lastSignInAt(claims: { amr?: unknown } | null | undefined): number | null {
  const amr = Array.isArray(claims?.amr) ? (claims.amr as AmrEntry[]) : [];
  const times = amr.map((e) => e?.timestamp).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return times.length ? Math.max(...times) : null;
}

/**
 * 401 `reauth_required` unless the session's own sign-in (its `amr` timestamp, which a token
 * refresh does not move) is within RECENT_SIGN_IN_SECONDS. The phone then sends a sign-in code.
 */
export async function requireRecentSignIn(client: SupabaseClient, now: number = Date.now()): Promise<void> {
  const { data, error } = await client.auth.getClaims();
  const at = error ? null : lastSignInAt(data?.claims as { amr?: unknown } | undefined);
  if (at === null || now / 1000 - at > RECENT_SIGN_IN_SECONDS || at - now / 1000 > 60) {
    throw new HttpError(401, "reauth_required", "Confirm it is you with a sign-in code first.");
  }
}

/** Every object path under `prefix` (one level of folders per depth). */
async function listObjects(admin: SupabaseClient, prefix: string, depth = 0): Promise<string[]> {
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).list(prefix, { limit: PAGE, offset: 0 });
  if (error) throw new HttpError(503, "storage_unavailable", "Could not reach your files. Try again.", { cause: error });
  const paths: string[] = [];
  for (const entry of data ?? []) {
    const path = `${prefix}/${entry.name}`;
    // A folder has no id; objects do.
    if (entry.id === null || entry.id === undefined) {
      if (depth < MAX_DEPTH) paths.push(...await listObjects(admin, path, depth + 1));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** Removes every `media/<userId>/` object. Lists again after each pass until nothing is left. */
export async function removeAccountMedia(admin: SupabaseClient, userId: string): Promise<number> {
  let removed = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const paths = await listObjects(admin, userId);
    if (paths.length === 0) return removed;
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const { error } = await admin.storage.from(MEDIA_BUCKET).remove(paths.slice(i, i + REMOVE_BATCH));
      if (error) throw new HttpError(503, "storage_unavailable", "Could not remove your files. Try again.", { cause: error });
    }
    removed += paths.length;
  }
  throw new HttpError(503, "storage_unavailable", "Too many files to remove at once. Try again.");
}

/** PostgREST's "no such function" (PGRST202) and Postgres' undefined_function (42883). */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "42883" || error?.code === "PGRST202";
}

function isUserNotFound(error: { status?: number; code?: string } | null): boolean {
  return error?.status === 404 || error?.code === "user_not_found";
}

/** Steps 1-3 above, for the session-verified `userId` only. */
export async function deleteAccount(admin: SupabaseClient, userId: string): Promise<AccountDeleteResult> {
  await removeAccountMedia(admin, userId);

  const { data, error } = await admin.rpc("delete_account", { p_user_id: userId });
  if (isMissingFunction(error)) {
    throw new HttpError(503, "account_deletion_unavailable", "Account deletion is not available yet.", { cause: error });
  }
  if (error) throw new HttpError(502, "account_delete_failed", "Could not delete your account. Try again.", { cause: error });
  const status = (data as { status?: unknown } | null)?.status;
  if (status !== "deleted" && status !== "already_gone") {
    throw new HttpError(502, "account_delete_failed", "Could not delete your account. Try again.");
  }

  const auth = await admin.auth.admin.deleteUser(userId);
  if (auth.error && !isUserNotFound(auth.error as { status?: number; code?: string })) {
    throw new HttpError(502, "account_delete_failed", "Could not finish deleting your account. Try again.", { cause: auth.error });
  }
  return { status };
}
