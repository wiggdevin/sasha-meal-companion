/**
 * Phase 13 §9 R3 (slice 0), review round 2 (sol lens, FIX): gemini-payloads.ts's `media.bytes`
 * getter returns a fresh copy of the media buffer on every read (deliberately, so a caller can
 * never corrupt what the payload builder was given). `withMediaPart` used to read it twice on the
 * inline (< INLINE_LIMIT_BYTES) path -- once just to check its length, once to base64-encode it --
 * doubling an already-unnecessary full-buffer copy on top of the builder's own defensive one at
 * mint. docs/audit/code/s0-sol-r4.md:60 flagged this as an unverified latency cost against the §7
 * coach/capture p95 gates rather than a proven regression; this pins the actual read count so it
 * cannot silently regress back to reading the getter more than once per request.
 */
import { describe, expect, it } from "vitest";
import { INLINE_LIMIT_BYTES, withMediaPart, type UploadedFile } from "@/lib/ai/adapter";
import type { Media } from "@/lib/ai/payloads";

/** A Media whose `bytes` getter counts how many times it is read, each time on a fresh copy. */
function countingMedia(byteLength: number): { media: Media; reads: () => number } {
  const raw = new Uint8Array(byteLength).fill(9);
  let reads = 0;
  const media: Media = {
    mimeType: "image/jpeg",
    get bytes() { reads += 1; return new Uint8Array(raw); },
  };
  return { media, reads: () => reads };
}

describe("withMediaPart", () => {
  it("passes parts through unchanged and reads nothing when there is no media", async () => {
    const parts = [{ text: "hi" }];
    const out = await withMediaPart(parts, undefined, async () => {
      throw new Error("should not upload");
    });
    expect(out).toEqual({ parts: [{ text: "hi" }], uploaded: null });
    expect(out.parts).not.toBe(parts);
  });

  it("reads an inline (< INLINE_LIMIT_BYTES) media's bytes exactly once", async () => {
    const { media, reads } = countingMedia(1024);
    const out = await withMediaPart([{ text: "hi" }], media, async () => {
      throw new Error("should not upload: this is inline-sized");
    });
    expect(reads()).toBe(1);
    expect(out.uploaded).toBeNull();
    expect(out.parts[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: Buffer.from(new Uint8Array(1024).fill(9)).toString("base64") },
    });
  });

  it("reads an over-limit media's bytes exactly once itself, before handing it to uploadMedia", async () => {
    const { media, reads } = countingMedia(INLINE_LIMIT_BYTES + 1);
    const uploaded: UploadedFile = { uri: "files/abc", name: "abc" };
    const out = await withMediaPart([{ text: "hi" }], media, async (m) => {
      expect(m).toBe(media);
      return uploaded;
    });
    // withMediaPart's own length check reads the getter once; uploadMedia is handed the Media
    // object itself (not its already-read bytes) and reads it again inside its own scope, which
    // this function does not count -- that boundary is the injected upload port's, not the
    // request-shaping helper's, to own.
    expect(reads()).toBe(1);
    expect(out.uploaded).toEqual(uploaded);
    expect(out.parts[1]).toEqual({ fileData: { mimeType: "image/jpeg", fileUri: uploaded.uri } });
  });
});
