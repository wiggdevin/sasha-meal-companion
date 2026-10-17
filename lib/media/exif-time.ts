/**
 * When a plate photo was taken (W125, T2 "a time control defaulting to the photo's
 * DateTimeOriginal"). Read on the phone from the ORIGINAL file, before `resizeImage` re-encodes it
 * and drops every metadata block; nothing here leaves the phone except the instant it returns.
 *
 * Only a baseline JPEG's APP1 Exif block is read: IFD0, then the Exif IFD's DateTimeOriginal
 * (0x9003) and, when present, OffsetTimeOriginal (0x9011). Anything else (HEIC, PNG, a block that
 * does not parse) answers null and the capture keeps its other time. Pure, no DOM.
 */

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const ASCII = 2;
const LONG = 4;

/** The bytes a reader needs: the Exif block sits in the first APP segments, inside 64 KB. */
export const EXIF_SCAN_BYTES = 128 * 1024;

type Tiff = { view: DataView; start: number; little: boolean };

function u16(t: Tiff, at: number): number { return t.view.getUint16(t.start + at, t.little); }
function u32(t: Tiff, at: number): number { return t.view.getUint32(t.start + at, t.little); }

/** One IFD's entries as tag → { type, count, value offset field }. */
function entries(t: Tiff, ifd: number): Map<number, { type: number; count: number; field: number }> {
  const out = new Map<number, { type: number; count: number; field: number }>();
  const n = u16(t, ifd);
  for (let i = 0; i < n; i += 1) {
    const at = ifd + 2 + i * 12;
    out.set(u16(t, at), { type: u16(t, at + 2), count: u32(t, at + 4), field: at + 8 });
  }
  return out;
}

function ascii(t: Tiff, entry: { type: number; count: number; field: number } | undefined): string | null {
  if (!entry || entry.type !== ASCII || entry.count === 0 || entry.count > 64) return null;
  const at = entry.count <= 4 ? entry.field : u32(t, entry.field);
  let text = "";
  for (let i = 0; i < entry.count; i += 1) {
    const code = t.view.getUint8(t.start + at + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

/** The TIFF header inside an APP1 Exif segment, or null. */
function exifTiff(bytes: Uint8Array): Tiff | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xda || marker === 0xd9) return null; // scan data or end: no Exif before it
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    const body = i + 4;
    const isExif = marker === 0xe1 && body + 6 <= bytes.length
      && String.fromCharCode(...bytes.subarray(body, body + 4)) === "Exif"
      && bytes[body + 4] === 0 && bytes[body + 5] === 0;
    if (isExif) {
      const start = body + 6;
      if (start + 8 > bytes.length) return null;
      const order = String.fromCharCode(bytes[start], bytes[start + 1]);
      if (order !== "II" && order !== "MM") return null;
      const tiff = { view, start, little: order === "II" };
      return u16(tiff, 2) === 42 ? tiff : null;
    }
    i = body + length - 2;
  }
  return null;
}

/**
 * DateTimeOriginal as written ("YYYY:MM:DD HH:MM:SS") and its offset ("+02:00") when the camera
 * recorded one, or null. Never throws: a truncated or malformed block is simply no time.
 */
export function readExifShotFields(bytes: Uint8Array): { local: string; offset: string | null } | null {
  try {
    const tiff = exifTiff(bytes);
    if (tiff === null) return null;
    const ifd0 = entries(tiff, u32(tiff, 4));
    const pointer = ifd0.get(TAG_EXIF_IFD);
    if (!pointer || pointer.type !== LONG) return null;
    const exif = entries(tiff, u32(tiff, pointer.field));
    const local = ascii(tiff, exif.get(TAG_DATE_TIME_ORIGINAL));
    if (local === null) return null;
    return { local, offset: ascii(tiff, exif.get(TAG_OFFSET_TIME_ORIGINAL)) };
  } catch {
    return null;
  }
}

const LOCAL = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * The instant the photo was taken. With an offset it is exact; without one the camera's clock is
 * read as the phone's own zone, which is where a phone camera's clock is set. Null for a missing,
 * zeroed ("0000:00:00 …") or impossible date.
 */
export function exifShotTime(bytes: Uint8Array): Date | null {
  const fields = readExifShotFields(bytes);
  const m = fields ? LOCAL.exec(fields.local.trim()) : null;
  if (!fields || !m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null; // 30 February and kin
  const offset = fields.offset ? OFFSET.exec(fields.offset.trim()) : null;
  let at: Date;
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3]));
    at = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - minutes * 60_000);
  } else {
    at = new Date(y, mo - 1, d, h, mi, s);
  }
  return Number.isFinite(at.getTime()) ? at : null;
}

/** Reads the shot time off a picked file; null for anything that is not a readable JPEG. */
export async function shotTimeOf(file: Blob): Promise<Date | null> {
  try {
    return exifShotTime(new Uint8Array(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer()));
  } catch {
    return null;
  }
}
