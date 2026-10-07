/**
 * The privileged server boundary (architecture.md §2.2). MCP tokens are opaque
 * strings, not Supabase JWTs, so they cannot produce auth.uid() and this path
 * does not claim RLS. It resolves exactly one user_id from the token row and
 * refuses to call the callback without it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { hashToken, hasScope, toBytea } from "@/lib/server/tokens";

export type TokenUser = { userId: string; tokenId: string; scopes: string[] };

type TokenRow = { id: string; user_id: string | null; scopes: string[] | null };

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function withTokenUser<T>(
  req: Request,
  scope: "read" | "log:write" | "constraints:write",
  fn: (ctx: TokenUser, admin: SupabaseClient) => Promise<T>,
): Promise<T> {
  const raw = bearer(req);
  if (!raw) throw new HttpError(401, "unauthorized", "Bearer token required.");

  const admin = adminClient();
  const { data, error } = await admin.rpc("lookup_api_token", {
    p_token_hash: toBytea(hashToken(raw)),
  });
  if (error) throw new HttpError(401, "unauthorized", "Token lookup failed.");

  const row = (Array.isArray(data) ? data[0] : data) as TokenRow | undefined;
  // lookup_api_token returns no row for unknown, revoked and expired alike.
  if (!row || typeof row.user_id !== "string" || row.user_id.length === 0) {
    throw new HttpError(401, "unauthorized", "Unknown, revoked or expired token.");
  }

  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  if (!hasScope(scopes, scope)) {
    throw new HttpError(403, "forbidden", `Token lacks the "${scope}" scope.`);
  }

  return fn({ userId: row.user_id, tokenId: row.id, scopes }, admin);
}
