/**
 * Browser-path identity (architecture.md §2.1).
 *
 * getClaims() verifies the JWT signature. getSession() only reads the cookie
 * and proves nothing, so it is never used here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequestClient } from "@/lib/supabase/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** The underlying failure (a DB error, say). Logged server-side for 5xx, never sent. */
    options?: { cause?: unknown },
  ) {
    super(message ?? code, options);
    this.name = "HttpError";
  }
}

/** The header a client sends to say which account started the request (Phase 9 §0.5a). */
export const ACCOUNT_HEADER = "x-smc-account";

export async function requireUser(req: Request): Promise<{ userId: string; client: SupabaseClient }> {
  const client = createRequestClient(req);
  const { data, error } = await client.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string" || userId.length === 0) {
    throw new HttpError(401, "unauthorized", "Sign in to continue.");
  }
  // Two tabs of one phone share one cookie: a tab still bound to A can send A's request under B's
  // session. A missing header is a tab of the old build (PR #248 review r3 #1): it may show A while
  // the cookie is B's, so it gets nothing. 401 on purpose — the old build reads it as a lapsed
  // session and keeps its writes queued (origin/main lib/log-commit-client.ts:49,
  // lib/sync/client.ts:204-225); the service worker v3 reload then moves the tab to this build.
  const claimed = req.headers.get(ACCOUNT_HEADER);
  if (claimed === null) {
    throw new HttpError(401, "account_header_required", "This app was updated. Reload to continue.");
  }
  if (claimed !== userId) {
    throw new HttpError(409, "account_mismatch", "This request belongs to another account on this device.");
  }
  return { userId, client };
}
