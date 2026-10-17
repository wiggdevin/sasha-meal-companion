/**
 * Per-source ingest tokens (spec §5). The plaintext is returned once at issue and never stored; the
 * lookup is by hash and the comparison is constant-time (spec §8).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OauthTokens } from "@/lib/health/contract";
import { openOauth, sealOauth } from "@/lib/server/crypto";
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

/**
 * The key a rotation is moving away from (W080), optional and server-only. While it is set,
 * a sealed value that the current key cannot open is tried under it, so tokens sealed before the
 * re-seal script ran stay readable during the swap. Remove it once the script has finished.
 */
export function previousHealthTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.HEALTH_TOKEN_KEY_PREVIOUS;
  return raw ? Buffer.from(raw, "base64") : null;
}

/** Opens under the current key, else the previous one. The current key's failure is the error. */
export function openOauthAnyKey(sealed: string): OauthTokens {
  try {
    return openOauth(sealed);
  } catch (error) {
    const previous = previousHealthTokenKey();
    if (!previous) throw error;
    try { return openOauth(sealed, previous); } catch { throw error; }
  }
}

export type ResealResult = { sealed: string; changed: boolean };

/**
 * Re-seals one stored value under `newKey`. A value that already opens under `newKey` is left
 * alone (`changed: false`), so a run that stopped half way can be repeated. A value that opens
 * under neither key throws. The result is opened again under `newKey` before it is returned.
 */
export function resealOauth(sealed: string, oldKey: Buffer, newKey: Buffer): ResealResult {
  try {
    openOauth(sealed, newKey);
    return { sealed, changed: false };
  } catch { /* not under the new key: fall through to the old one */ }
  const tokens = openOauth(sealed, oldKey);
  const next = sealOauth(tokens, newKey);
  const check = openOauth(next, newKey);
  if (JSON.stringify(check) !== JSON.stringify(tokens)) throw new Error("re-seal round trip differs");
  return { sealed: next, changed: true };
}
