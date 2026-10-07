/**
 * Personal access tokens for the privileged boundary (architecture.md §2.2).
 * The raw token is shown once at creation; only the SHA-256 hash is stored.
 */

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "smc_";

/** SHA-256 of the raw token. 32 bytes. */
export function hashToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Exact-match scope check. A longer scope string never satisfies a shorter one. */
export function hasScope(scopes: string[], required: string): boolean {
  return Array.isArray(scopes) && scopes.includes(required);
}

/** 32 random bytes, base64url, prefixed `smc_`, with the hash to store. */
export function mintToken(): { raw: string; hash: Buffer } {
  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/**
 * PostgREST sends RPC arguments as JSON, and a Buffer would serialize as
 * `{type:"Buffer",data:[…]}`. A `bytea` argument has to arrive as the hex
 * literal `\x…` instead.
 */
export function toBytea(hash: Buffer): string {
  return `\\x${hash.toString("hex")}`;
}
