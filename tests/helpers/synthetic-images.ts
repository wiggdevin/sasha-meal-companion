/**
 * Minimal, fully well-formed JPEG and PNG byte fixtures — never a real photo — small enough to
 * inline in a test, but complete enough for lib/media/strip-metadata.ts's marker/chunk walk to
 * parse successfully (unlike a bare signature-only stub, which that walk correctly refuses as
 * unparseable). Shared by tests that exercise anything downstream of the W12 metadata strip:
 * tests/media/strip-metadata.test.ts, tests/plan/plan-inspire.test.ts,
 * tests/server/pantry-photo.test.ts and tests/tenancy/admin-media.test.ts.
 */

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** One JPEG marker segment: FF <marker> <len hi> <len lo> <payload>; `len` counts itself. */
function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/** One PNG chunk: <len><type><data><crc>. The CRC is never checked by this codebase's own
 *  strip/validate paths, which copy or drop whole chunks — any 4 bytes serve as a stand-in. */
function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

/**
 * A minimal single-scan baseline JPEG: SOI, DQT, a 1x1 SOF0, a trivial DHT, SOS, one byte of scan
 * data, EOI. Optional extra marker segments (e.g. an APP1/EXIF block) are spliced in right after
 * SOI, exactly where a real encoder would put them, so a caller can build a "has metadata to
 * strip" fixture without hand-rolling the rest of the structure.
 */
export function syntheticJpeg(extraMarkers: number[] = []): Uint8Array {
  const dqt = segment(0xdb, [0x00, ...Array(64).fill(1)]);
  const sof0 = segment(0xc0, [0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const dht = segment(0xc4, [0x00, 0x01, 0x01, ...Array(13).fill(0), 0x00]);
  const sos = segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return new Uint8Array([0xff, 0xd8, ...extraMarkers, ...dqt, ...sof0, ...dht, ...sos,
    0x12, 0xff, 0xd9]);
}

/**
 * A synthetic JPEG whose entropy-coded scan carries the two things a real phone/canvas encoder
 * can legally put in scan data: a byte-stuffed literal 0xFF (0xFF 0x00) and a restart marker
 * (0xFFD0, which — unlike every marker before SOS — carries no length field). Proves the
 * stripper's byte-stuffing/restart handling in `copyScanToEoi` doesn't mistake either for the
 * real EOI or for metadata, and doesn't let either corrupt the scan it copies.
 */
export function syntheticJpegWithStuffedScan(): Uint8Array {
  const dqt = segment(0xdb, [0x00, ...Array(64).fill(1)]);
  const sof0 = segment(0xc0, [0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const dht = segment(0xc4, [0x00, 0x01, 0x01, ...Array(13).fill(0), 0x00]);
  const sos = segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  // 0x12, then a literal 0xFF (stuffed as 0xFF 0x00), then a restart marker, then one more data
  // byte, then the real EOI.
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9];
  return new Uint8Array([0xff, 0xd8, ...dqt, ...sof0, ...dht, ...sos, ...scan]);
}

/** A synthetic JPEG whose APP1 segment carries a fake EXIF/GPS-flavoured block — never a real
 *  photo, just enough bytes to prove a stripper removes the whole segment. */
export function syntheticJpegWithExif(): Uint8Array {
  const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
    0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a,
    ...[..."GPS_LAT_LONG"].map((c) => c.charCodeAt(0))];
  return syntheticJpeg(segment(0xe1, exifPayload));
}

/** A minimal, complete PNG: signature, 1x1 IHDR, optional extra ancillary chunks, one IDAT,
 *  IEND. */
export function syntheticPng(extraChunks: number[] = []): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0]);
  const idat = pngChunk("IDAT", [0x01]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...extraChunks, ...idat, ...iend]);
}

/** A synthetic PNG carrying a fake eXIf (GPS-flavoured) chunk and a tEXt chunk. */
export function syntheticPngWithMetadata(): Uint8Array {
  const exif = pngChunk("eXIf", [0x4d, 0x4d, 0x00, 0x2a, ...[..."GPS"].map((c) => c.charCodeAt(0))]);
  const text = pngChunk("tEXt", [...[..."Comment"].map((c) => c.charCodeAt(0)), 0,
    ...[..."hi"].map((c) => c.charCodeAt(0))]);
  return syntheticPng([...exif, ...text]);
}

/**
 * A synthetic PNG with TWO IDAT chunks and a tEXt chunk placed AFTER both of them, before IEND —
 * a legal chunk order some encoders produce (split image data, trailing metadata) that a stripper
 * walking "until IDAT" rather than "until IEND" would miss entirely. Proves the chunk walk is
 * order-independent: it keeps scanning past IDAT and still drops metadata that comes later.
 */
export function syntheticPngWithTrailingMetadataAfterIdat(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0]);
  const idat1 = pngChunk("IDAT", [0x01]);
  const idat2 = pngChunk("IDAT", [0x02]);
  const text = pngChunk("tEXt", [...[..."Comment"].map((c) => c.charCodeAt(0)), 0,
    ...[..."trailing"].map((c) => c.charCodeAt(0))]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...idat1, ...idat2, ...text, ...iend]);
}

/** A synthetic PNG carrying an `iCCP` chunk (an embedded colour profile) — not one of the five
 *  named text/time chunks a drop-list would catch, but still a chunk this codebase never needs to
 *  forward to a vision model, and the PNG spec permits private/future ancillary chunks of any
 *  name. Proves the stripper keeps only an explicit allowlist rather than dropping a fixed list. */
export function syntheticPngWithIccProfile(): Uint8Array {
  const iccp = pngChunk("iCCP", [...[..."sRGB"].map((c) => c.charCodeAt(0)), 0, 0,
    ...[..."NOT_METADATA_BUT_NOT_NEEDED"].map((c) => c.charCodeAt(0))]);
  return syntheticPng([...iccp]);
}

/** A structurally "complete" PNG (signature through IEND) that never carries an IHDR or an IDAT
 *  — no pixel data at all. Proves the stripper refuses this instead of forwarding an empty shell
 *  to the provider. */
export function syntheticPngWithNoImageData(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...iend]);
}

/** A PNG with a syntactically valid (13-byte) IHDR declaring zero width and height, a real IDAT
 *  and a real IEND — structurally "complete" but a degenerate, pixel-free image (second Sol
 *  review round). */
export function syntheticPngWithZeroDimensions(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(0), ...u32be(0), 8, 2, 0, 0, 0]);
  const idat = pngChunk("IDAT", [0x01]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...idat, ...iend]);
}

/** A PNG with a normal, nonzero-dimension IHDR but a zero-length IDAT chunk (and only that one
 *  IDAT) — syntactically valid chunks, real IEND, but zero bytes of actual image data (second Sol
 *  review round). */
export function syntheticPngWithEmptyIdat(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0]);
  const idat = pngChunk("IDAT", []);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...idat, ...iend]);
}
