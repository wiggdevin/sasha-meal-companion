"use client";

/**
 * Self-serve account deletion, phone side. Two calls:
 *
 * - `readAccountDeletionEnabled`: `GET /api/account/delete/enabled`. True only for 200
 *   `{ enabled: true }`; anything else (offline, 401, 404 from an older server, 5xx, another
 *   shape) reads as off, so Settings never shows a row the server would refuse.
 * - `requestAccountDeletion`: `POST /api/account/delete { confirm: "DELETE" }`, mapped to the
 *   outcomes the Settings row shows. Only `deleted` means the account is gone.
 */
import {
  accountFetch, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

export const ACCOUNT_DELETE_PATH = "/api/account/delete";
export const ACCOUNT_DELETE_ENABLED_PATH = "/api/account/delete/enabled";

export async function readAccountDeletionEnabled(
  h: AccountHandle, opts: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  try {
    const res = await accountFetch(h, ACCOUNT_DELETE_ENABLED_PATH,
      { cache: "no-store", credentials: "same-origin" }, { budget: "prefs", fetchImpl: opts.fetchImpl });
    if (res.status !== 200) return false;
    const body = await accountJson<unknown>(h, res);
    return typeof body === "object" && body !== null && (body as { enabled?: unknown }).enabled === true;
  } catch (e) {
    rethrowAccountChanged(e);
    return false;
  }
}

export type AccountDeleteOutcome =
  | "deleted"           // 200: the account and its data are gone
  | "reauth_required"   // 401 reauth_required: confirm with a sign-in code, then try again
  | "signed_out"        // any other 401: the session is gone
  | "not_enabled"       // 404 not_enabled
  | "rate_limited"      // 429
  | "failed";           // anything else, a timeout or offline: not confirmed, safe to retry

export async function requestAccountDeletion(
  h: AccountHandle, opts: { fetchImpl?: typeof fetch } = {},
): Promise<AccountDeleteOutcome> {
  try {
    const res = await accountFetch(h, ACCOUNT_DELETE_PATH, {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }),
    }, { budget: "accountDelete", fetchImpl: opts.fetchImpl });
    const body = await accountJson<{ status?: unknown; error?: unknown } | null>(h, res)
      .catch((e: unknown) => { rethrowAccountChanged(e); return null; });
    if (res.status === 200) {
      return body?.status === "deleted" || body?.status === "already_gone" ? "deleted" : "failed";
    }
    const code = body?.error;
    if (res.status === 401) return code === "reauth_required" ? "reauth_required" : "signed_out";
    if (res.status === 404 && code === "not_enabled") return "not_enabled";
    if (res.status === 429) return "rate_limited";
    return "failed";
  } catch (e) {
    rethrowAccountChanged(e);
    return "failed";
  }
}
