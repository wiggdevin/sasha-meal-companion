/**
 * Per-source ingest tokens (spec §5). The plaintext is returned once at issue and never stored; the
 * lookup is by hash and the comparison is constant-time (spec §8).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashToken, toBytea } from "@/lib/server/tokens";

export const HEALTH_TOKEN_PREFIX = "smh_";

export function issueSourceToken(): { raw: string; hash: Buffer } {
  const raw = `${HEALTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/** PostgREST returns bytea as the hex literal `\x…`. */
function fromBytea(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value.startsWith("\\x")) return null;
  return Buffer.from(value.slice(2), "hex");
}

export async function resolveSourceByToken(admin: SupabaseClient, raw: string):
    Promise<{ id: string; userId: string; kind: string } | null> {
  if (typeof raw !== "string" || !raw.startsWith(HEALTH_TOKEN_PREFIX)) return null;
  const hash = hashToken(raw);
  const { data, error } = await admin.from("health_sources")
    .select("id, user_id, kind, token_hash")
    .eq("token_hash", toBytea(hash))
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;

  const stored = fromBytea((data as { token_hash: unknown }).token_hash);
  if (!stored || stored.length !== hash.length || !timingSafeEqual(stored, hash)) return null;

  const row = data as { id: string; user_id: string; kind: string };
  return { id: row.id, userId: row.user_id, kind: row.kind };
}
