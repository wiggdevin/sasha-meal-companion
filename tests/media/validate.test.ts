import { describe, expect, it } from "vitest";
import { validateAudio, validateImage } from "@/lib/media/validate";

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  new DataView(b.buffer).setUint16(7, height);
  new DataView(b.buffer).setUint16(9, width);
  return b;
}

/** 16-bit mono 16 kHz: byteRate 32000, so `seconds` is dataBytes / 32000. */
function wav(seconds: number): Uint8Array {
  const data = Math.round(seconds * 32000);
  const b = new Uint8Array(44 + 4);
  const v = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0);           // RIFF
  b.set([0x57, 0x41, 0x56, 0x45], 8);           // WAVE
  b.set([0x66, 0x6d, 0x74, 0x20], 12);          // "fmt "
  v.setUint32(16, 16, true);                    // fmt chunk size
  v.setUint32(28, 32000, true);                 // byteRate
  b.set([0x64, 0x61, 0x74, 0x61], 36);          // "data"
  v.setUint32(40, data, true);                  // data size
  return b;
}

describe("validateImage", () => {
  it("accepts a JPEG and reports its dimensions", () => {
    expect(validateImage(jpeg(1600, 1200), "image/jpeg"))
      .toEqual({ ok: true, width: 1600, height: 1200 });
  });

  it("fails a PNG renamed .jpg", () => {
    expect(validateImage(png(100, 100), "image/jpeg"))
      .toEqual({ ok: false, reason: "declared image/jpeg but the bytes are image/png" });
  });

  it("fails a 4001 px image", () => {
    expect(validateImage(png(4001, 10), "image/png"))
      .toEqual({ ok: false, reason: "image is 4001x10; the limit is 4000 px on either edge" });
  });

  it("fails bytes that are no image at all", () => {
    expect(validateImage(new Uint8Array([1, 2, 3, 4]), "image/png").ok).toBe(false);
  });
});

describe("validateAudio", () => {
  it("accepts a 29 s WAV and reports its duration", () => {
    const out = validateAudio(wav(29), "audio/wav");
    expect(out.ok).toBe(true);
    expect(out.ok && Math.round(out.seconds)).toBe(29);
  });

  it("fails a 31 s clip", () => {
    expect(validateAudio(wav(31), "audio/wav"))
      .toEqual({ ok: false, kind: "duration", reason: "audio is 31.0 s; the limit is 30 s" });
  });

  it("fails an MP3 whose size alone proves it is over 30 s", () => {
    const mp3 = new Uint8Array(1_000_000);
    mp3.set([0x49, 0x44, 0x33], 0);           // ID3
    expect(validateAudio(mp3, "audio/mpeg").ok).toBe(false);
  });

  it("fails an audio MIME the bucket does not allow", () => {
    expect(validateAudio(wav(1), "audio/ogg"))
      .toEqual({ ok: false, kind: "type", reason: "audio/ogg is not an accepted audio type" });
  });
});
