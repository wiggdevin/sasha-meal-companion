/**
 * Phase 13 §9 R3 (slice 0): deepFreeze's job is to freeze a payload before it leaves the module
 * that minted it -- structure, not values a getter computes on demand. `lib/ai/gemini-payloads.ts`
 * gives a payload's media a `bytes` getter that copies up to 4 MiB on every read, so the caller
 * can never corrupt the builder's own copy. Walking that getter just to freeze whatever it
 * returns pays for a copy nobody asked for, on every mint. This pins that deepFreeze never reads
 * an accessor property, only the data properties it actually needs to recurse into.
 */
import { describe, expect, it } from "vitest";
import { deepFreeze } from "@/lib/ai/freeze";

describe("deepFreeze", () => {
  it("freezes an object without invoking a getter it finds along the way", () => {
    let reads = 0;
    const media = {
      mimeType: "image/jpeg",
      get bytes() { reads += 1; return new Uint8Array(4); },
    };
    deepFreeze({ purpose: "coach-transcribe", media });

    expect(reads).toBe(0);
  });

  it("still deep-freezes the object, and the getter still works after freezing", () => {
    let reads = 0;
    const media = {
      mimeType: "image/jpeg",
      get bytes() { reads += 1; return new Uint8Array([reads]); },
    };
    const frozen = deepFreeze({ media });

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.media)).toBe(true);
    expect(() => { (frozen.media as { mimeType: string }).mimeType = "changed"; }).toThrow(TypeError);
    expect([...frozen.media.bytes]).toEqual([1]);
    expect([...frozen.media.bytes]).toEqual([2]);
  });

  it("still freezes plain data properties, nested objects included", () => {
    const frozen = deepFreeze({ purpose: "coach", parts: [{ text: "hi" }] });

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.parts)).toBe(true);
    expect(Object.isFrozen(frozen.parts[0])).toBe(true);
  });
});
