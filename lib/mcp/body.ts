/**
 * The MCP request body and the scopes it needs (audit 2026-10-10 A059, A102, A131). The route reads
 * the body only after the token is verified, through a byte-capped stream, and every JSON-RPC
 * message in it names the scopes it needs: a known tool its own scope, every other message
 * (`tools/list`, an unknown tool, a notification) "read". Nothing is dropped, so a batch that mixes
 * a read tool with a write tool needs both.
 */

import { HttpError } from "@/lib/server/auth";
import type { TokenScope } from "@/lib/server/privileged";

export const MAX_BODY_BYTES = 64 * 1024;

const tooLarge = () => new HttpError(413, "too_large", `Body over ${MAX_BODY_BYTES} bytes.`);

/** 413 on a declared Content-Length over the cap: a header read, no body bytes. */
export function rejectDeclaredOversize(req: Request): void {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw tooLarge();
}

/** Reads at most MAX_BODY_BYTES; one byte more cancels the stream and answers 413. */
export async function readCappedText(req: Request): Promise<string> {
  rejectDeclaredOversize(req);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type Message = Record<string, unknown>;

const isObject = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON-RPC messages in a body: 400 on bad JSON, an empty batch or a non-object element. */
export function parseMessages(raw: string): Message[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "Body is not JSON.");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0 || !list.every(isObject)) {
    throw new HttpError(400, "bad_request", "Body must be a JSON-RPC message or a batch of them.");
  }
  return list;
}

/** Every scope the messages need. `toolScopes` is looked up by own property only. */
export function scopesForMessages(
  messages: Message[], toolScopes: Record<string, TokenScope>,
): Set<TokenScope> {
  const required = new Set<TokenScope>();
  for (const message of messages) {
    const params = isObject(message.params) ? message.params : {};
    const name = params.name;
    const known = message.method === "tools/call" && typeof name === "string"
      && Object.hasOwn(toolScopes, name);
    required.add(known ? toolScopes[name as string] : "read");
  }
  return required;
}
