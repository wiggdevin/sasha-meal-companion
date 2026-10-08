/**
 * The server half of the W12 privacy boundary (docs/specs/phase-18-open-world-foods.md §W12,
 * boundary item 4): "The server strips any remaining EXIF, XMP, GPS or other metadata block
 * before the call, and refuses a file it cannot parse."
 *
 * The phone already re-encodes through `resizeImage` (lib/media/resize.ts — a canvas round trip
 * that carries no metadata forward), but the server never trusted that alone: this strips again,
 * from the raw bytes, and refuses anything it cannot confidently parse rather than guess. The
 * input is always a single-scan, canvas-produced JPEG or a simple PNG (W12's upload path forces
 * `resizeImage` first) — this does not attempt to parse progressive/multi-scan JPEGs or PNGs with
 * unusual chunk ordering; either refuses as unparseable rather than risk leaving a block in.
 */

export class UnparseableImage extends Error {}

/** `data` big-endian to `[start, start+4)`. */
function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * Copies the entropy-coded scan data that follows SOS, up to and including the first real EOI
 * (0xFFD9), honouring byte-stuffing (0xFF 0x00 = a literal 0xFF in the data) and restart markers
 * (0xFFD0-0xFFD7, which carry no length field and no metadata). Anything after that EOI — for
 * example zero padding a caller added to reach a fixed buffer size — is trailing junk, not image
 * data, and is dropped rather than inspected: dropping it can never leave a metadata block in.
 */
function copyScanToEoi(bytes: Uint8Array, start: number, out: number[]): void {
  let k = start;
  while (k + 1 < bytes.length) {
    if (bytes[k] !== 0xff) { out.push(bytes[k]); k += 1; continue; }
    const next = bytes[k + 1];
    // The standard (ITU-T T.81 B.1.1.5) allows any number of 0xFF fill bytes before a marker
    // code; drop the stray fill byte and re-examine the next pair rather than refuse it.
    if (next === 0xff) { k += 1; continue; }
    if (next === 0xd9) { out.push(0xff, 0xd9); return; } // EOI
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { out.push(bytes[k], next); k += 2; continue; }
    throw new UnparseableImage("malformed JPEG: unexpected marker inside scan data");
  }
  throw new UnparseableImage("malformed JPEG: no EOI after scan data");
}

/**
 * Drops every APPn (0xFFE0-0xFFEF, which carries EXIF/APP1 and XMP) and COM (0xFFFE) marker
 * segment before the first scan (SOS, 0xFFDA); keeps every other marker (SOI, DQT, SOF, DHT, …)
 * byte for byte. From SOS onward, only the real scan data up to the first EOI is kept
 * (`copyScanToEoi`) — this does not attempt multi-scan (progressive) JPEGs; see the module
 * comment on why that is an explicit non-goal here.
 */
function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new UnparseableImage("not a JPEG (missing SOI)");
  }
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new UnparseableImage("malformed JPEG: expected a marker");
    // Fill bytes (any number of 0xFF) may precede a marker code (ITU-T T.81 B.1.1.5); skip them
    // without emitting them — they carry no metadata and decoders do not require them back.
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j += 1;
    if (j >= bytes.length) throw new UnparseableImage("truncated JPEG: fill bytes with no marker");
    i = j - 1;
    const marker = bytes[i + 1];
    if (marker === 0xd8) throw new UnparseableImage("malformed JPEG: unexpected SOI");
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(0xff, marker); i += 2; continue; } // RST
    if (i + 4 > bytes.length) throw new UnparseableImage("truncated JPEG segment");
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) {
      throw new UnparseableImage("malformed JPEG: bad segment length");
    }
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn or COM
    if (!isMetadata) for (let k = i; k < i + 2 + length; k++) out.push(bytes[k]);
    if (marker === 0xda) { copyScanToEoi(bytes, i + 2 + length, out); return Uint8Array.from(out); }
    i += 2 + length;
  }
  throw new UnparseableImage("malformed JPEG: no scan (SOS) found");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * Default-deny, not default-allow (Sol review BLOCK: a drop-list let an `iCCP` chunk, or any
 * other ancillary chunk this list never named — the PNG spec permits private, application-
 * specific ancillary chunks of any four-letter name — carry metadata straight through). Only
 * these chunks are kept: the three required ones (IHDR, IDAT, IEND), PLTE for a palette image,
 * and the handful of colour/transparency chunks that change what the pixels mean rather than
 * describe anything about the photo or its origin (tRNS, gAMA, cHRM, sRGB, bKGD). Everything else
 * — eXIf, tEXt/zTXt/iTXt, tIME, iCCP, any private or future ancillary chunk — is dropped.
 */
const PNG_KEEP_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "bKGD"]);

/**
 * Keeps only `PNG_KEEP_CHUNKS`, dropping every other chunk (including its own CRC) whole —
 * removing a chunk never invalidates another chunk's CRC. Refuses a file whose first chunk is not
 * IHDR, whose IHDR does not declare a real nonzero width and height, that carries no IDAT bytes,
 * that never reaches IEND, or whose chunk lengths run past the buffer.
 *
 * This checks PNG container structure, not pixel content: it does not inflate the IDAT stream
 * (that would need a zlib decoder, well past what a metadata-privacy gate needs). A second Sol
 * review round reproduced a structurally "complete" PNG — valid IHDR/IDAT/IEND chunks, syntactically
 * well-formed — whose IHDR declared a zero width/height, or whose only IDAT chunk carried zero
 * bytes: both are degenerate, pixel-free "images" rather than a metadata leak, so they are refused
 * here on the same cheap, header-only checks (IHDR's declared dimensions, IDAT's total byte count)
 * rather than by decoding the compressed stream.
 */
function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, idx) => bytes[idx] === b)) {
    throw new UnparseableImage("not a PNG (missing signature)");
  }
  const out: number[] = [...PNG_SIGNATURE];
  let i = 8;
  let sawEnd = false;
  let idatBytes = 0;
  let chunkCount = 0;
  while (i < bytes.length) {
    if (i + 8 > bytes.length) throw new UnparseableImage("truncated PNG chunk header");
    const length = u32(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (chunkCount === 0 && type !== "IHDR") throw new UnparseableImage("malformed PNG: first chunk is not IHDR");
    chunkCount += 1;
    const total = 8 + length + 4; // length field + type + data + crc
    if (length < 0 || i + total > bytes.length) throw new UnparseableImage("truncated PNG chunk data");
    if (type === "IHDR") {
      if (length !== 13) throw new UnparseableImage("malformed PNG: IHDR is not 13 bytes");
      const width = u32(bytes, i + 8);
      const height = u32(bytes, i + 12);
      if (width === 0 || height === 0) throw new UnparseableImage("malformed PNG: zero width or height");
    }
    if (type === "IDAT") idatBytes += length;
    if (PNG_KEEP_CHUNKS.has(type)) for (let k = i; k < i + total; k++) out.push(bytes[k]);
    i += total;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd) throw new UnparseableImage("malformed PNG: no IEND found");
  if (idatBytes === 0) throw new UnparseableImage("malformed PNG: no image data in any IDAT chunk");
  return Uint8Array.from(out);
}

/**
 * Strips EXIF, XMP, GPS and other metadata blocks from a JPEG or PNG's bytes. Throws
 * `UnparseableImage` for anything it cannot confidently parse — callers refuse the upload rather
 * than send an unverified byte stream to a model.
 */
export function stripImageMetadata(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png"): Uint8Array {
  return mimeType === "image/jpeg" ? stripJpegMetadata(bytes) : stripPngMetadata(bytes);
}
