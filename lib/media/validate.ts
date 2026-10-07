/**
 * The server half of §4.2: a declared content type is a claim, so the bytes are read.
 *
 * Pure. No I/O, no decoding library — only the header fields we need, so a hostile file is never
 * handed to an image or audio decoder.
 *
 * Audio duration: WAV and MP4 carry it cheaply in a header. MP3 and bare ADTS AAC do not, so the
 * fallback divides by MAX_BITRATE_BPS — the CEILING bitrate — which yields a LOWER bound on the
 * true duration. A file that fails that test is certainly too long; one that passes may be longer
 * if it was encoded below 256 kbit/s. The client's 30 s hard stop and the 8 MB bucket cap are the
 * other two bounds.
 */

export const MAX_IMAGE_PIXELS = 4000;
export const MAX_AUDIO_SECONDS = 30;
const MAX_BITRATE_BPS = 256_000;

type ImageResult = { ok: true; width: number; height: number } | { ok: false; reason: string };
/**
 * A refusal says WHICH gate it failed, because the coach transcribe route owes a different
 * status to each (T7 §2): `type` is 415 — the object is not audio this can read — and `duration`
 * is 422, a clip longer than the 30 s the recorder is allowed to make.
 */
type AudioResult =
  | { ok: true; seconds: number }
  | { ok: false; kind: "type" | "duration"; reason: string };

const IMAGE_TYPES = ["image/jpeg", "image/png"];
/** What the bucket, the sign route and validateAudio accept. The client recorder may only pick from these. */
export const ACCEPTED_AUDIO_TYPES: readonly string[] = ["audio/mp4", "audio/aac", "audio/mpeg", "audio/wav"];

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) { at += 1; continue; }
    const marker = b[at + 1];
    if (SOF.has(marker)) {
      return { height: v.getUint16(at + 5), width: v.getUint16(at + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    at += 2 + v.getUint16(at + 2);
  }
  return null;
}

export function validateImage(bytes: Uint8Array, declared: string): ImageResult {
  if (!IMAGE_TYPES.includes(declared)) {
    return { ok: false, reason: `${declared} is not an accepted image type` };
  }
  const actual = sniffImage(bytes);
  if (actual === null) return { ok: false, reason: "the bytes are not a JPEG or a PNG" };
  if (actual !== declared) {
    return { ok: false, reason: `declared ${declared} but the bytes are ${actual}` };
  }
  const size = actual === "image/png" ? pngSize(bytes) : jpegSize(bytes);
  if (size === null) return { ok: false, reason: "the image header carries no dimensions" };
  if (size.width > MAX_IMAGE_PIXELS || size.height > MAX_IMAGE_PIXELS) {
    return { ok: false,
      reason: `image is ${size.width}x${size.height}; the limit is ${MAX_IMAGE_PIXELS} px on either edge` };
  }
  return { ok: true, width: size.width, height: size.height };
}

function sniffAudio(b: Uint8Array): "audio/wav" | "audio/mp4" | "audio/mpeg" | "audio/aac" | null {
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "audio/wav";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") return "audio/mp4";
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return (b[1] & 0x16) === 0x10 || (b[1] & 0x16) === 0x00 ? "audio/aac" : "audio/mpeg";
  }
  return null;
}

function wavSeconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= b.length) byteRate = v.getUint32(at + 16, true);
    if (id === "data") return byteRate > 0 ? size / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

function mp4Seconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at + 32 <= b.length; at += 1) {
    if (ascii(b, at, 4) !== "mvhd") continue;
    const version = b[at + 4];
    const base = at + 8;                                  // past type, version and flags
    if (version === 0 && base + 16 <= b.length) {
      const timescale = v.getUint32(base + 8);
      const duration = v.getUint32(base + 12);
      return timescale > 0 ? duration / timescale : null;
    }
    if (version === 1 && base + 28 <= b.length) {
      const timescale = v.getUint32(base + 16);
      const duration = Number(v.getBigUint64(base + 20));
      return timescale > 0 ? duration / timescale : null;
    }
    return null;
  }
  return null;
}

export function validateAudio(bytes: Uint8Array, declared: string): AudioResult {
  if (!ACCEPTED_AUDIO_TYPES.includes(declared)) {
    return { ok: false, kind: "type", reason: `${declared} is not an accepted audio type` };
  }
  const actual = sniffAudio(bytes);
  if (actual === null) {
    return { ok: false, kind: "type", reason: "the bytes are not a recognised audio container" };
  }
  // aac inside an mp4 container is the iOS case: audio/mp4 and audio/aac are interchangeable here.
  const family = (t: string): string => (t === "audio/aac" ? "audio/mp4" : t);
  if (family(actual) !== family(declared)) {
    return { ok: false, kind: "type", reason: `declared ${declared} but the bytes are ${actual}` };
  }
  const metadata = actual === "audio/wav" ? wavSeconds(bytes)
    : actual === "audio/mp4" ? mp4Seconds(bytes) : null;
  const seconds = metadata ?? (bytes.length * 8) / MAX_BITRATE_BPS;
  if (seconds > MAX_AUDIO_SECONDS) {
    return { ok: false, kind: "duration",
      reason: `audio is ${seconds.toFixed(1)} s; the limit is ${MAX_AUDIO_SECONDS} s` };
  }
  return { ok: true, seconds };
}
