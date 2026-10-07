/**
 * How a capture's media reaches Gemini: inline bytes or one Files API upload. Split out of
 * lib/ai/adapter.ts (the file-size baseline's note); the upload and delete transports stay there.
 */
import type { Part } from "@google/genai";
import type { Media } from "@/lib/ai/payloads";

export type UploadedFile = { uri: string; name: string };

/** Inline bytes below this, Files API at or above it (architecture §4.2). */
export const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Inline media below INLINE_LIMIT_BYTES; otherwise upload once via the Files API (§4.2), before
 * the retry loop. `media.bytes` (lib/ai/gemini-payloads.ts) returns a fresh copy on every read by
 * design, so it is read only once here and reused for both the length check and the inline
 * encoding — review round 2 (sol lens, FIX) flagged the previous two-reads-per-request cost as an
 * unverified latency risk against the §7 p95 gates (docs/audit/code/s0-sol-r4.md:60).
 */
export async function withMediaPart(
  parts: readonly Part[], media: Media | undefined, uploadMedia: (media: Media) => Promise<UploadedFile>
): Promise<{ parts: Part[]; uploaded: UploadedFile | null }> {
  if (!media) return { parts: [...parts], uploaded: null };
  const bytes = media.bytes;
  if (bytes.byteLength < INLINE_LIMIT_BYTES) {
    const data = Buffer.from(bytes).toString("base64");
    return { parts: [...parts, { inlineData: { mimeType: media.mimeType, data } }], uploaded: null };
  }
  const uploaded = await uploadMedia(media);
  return { parts: [...parts, { fileData: { mimeType: media.mimeType, fileUri: uploaded.uri } }], uploaded };
}
