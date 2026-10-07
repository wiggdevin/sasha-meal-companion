/**
 * Oura tokens are sealed before they reach Postgres (spec §4): AES-256-GCM, a fresh 12-byte IV per
 * seal, the 16-byte tag appended, the whole thing base64. HEALTH_TOKEN_KEY is server-only and never
 * appears under a NEXT_PUBLIC_ name (spec §8).
 *
 * No "server-only" import here: app/api/mcp/route.ts reaches this lane's modules and Phase 0's route
 * tests load that route under vitest, where the marker throws (see lib/server/log.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { OauthTokens } from "@/lib/health/contract";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function healthTokenKey(): Buffer {
  const raw = process.env.HEALTH_TOKEN_KEY;
  if (!raw) throw new Error("HEALTH_TOKEN_KEY not set");
  return Buffer.from(raw, "base64");
}

function assertKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("HEALTH_TOKEN_KEY must decode to 32 bytes");
  return key;
}

export function sealOauth(plain: OauthTokens, key: Buffer = healthTokenKey()): string {
  const k = assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function openOauth(sealed: string, key: Buffer = healthTokenKey()): OauthTokens {
  const k = assertKey(key);
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  // final() throws on a tag mismatch — a tampered or wrongly-keyed value never returns a value.
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as OauthTokens;
}
