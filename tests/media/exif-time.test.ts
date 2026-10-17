/**
 * W125: the plate photo's shot time, read on the phone from the original JPEG's Exif block.
 */
import { describe, expect, it } from "vitest";
import { exifShotTime, readExifShotFields } from "@/lib/media/exif-time";

/** A minimal JPEG: SOI, an APP1 Exif block holding IFD0 → Exif IFD, then EOI. */
function jpegWith(fields: { local?: string; offset?: string }, little = true, extraApp0 = true): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff];
  const u32 = (v: number) => little
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
    : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0)).concat(0);
  // Header (8) + IFD0 with one entry (2 + 12 + 4 = 18) → Exif IFD at 26.
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(26), ...u32(0));
  const tags: [number, number[]][] = [];
  if (fields.local) tags.push([0x9003, ascii(fields.local)]);
  if (fields.offset) tags.push([0x9011, ascii(fields.offset)]);
  const exifStart = 26;
  let data = exifStart + 2 + tags.length * 12 + 4;
  const blobs: number[] = [];
  tiff.push(...u16(tags.length));
  for (const [tag, bytes] of tags) {
    if (bytes.length <= 4) {
      const padded = [...bytes, 0, 0, 0, 0].slice(0, 4);
      tiff.push(...u16(tag), ...u16(2), ...u32(bytes.length), ...padded);
    } else {
      tiff.push(...u16(tag), ...u16(2), ...u32(bytes.length), ...u32(data));
      blobs.push(...bytes);
      data += bytes.length;
    }
  }
  tiff.push(...u32(0), ...blobs);
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const app0 = extraApp0 ? [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46] : [];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xd9]);
}

describe("exifShotTime (W125)", () => {
  it("reads DateTimeOriginal with its offset as an exact instant, either byte order", () => {
    for (const little of [true, false]) {
      const at = exifShotTime(jpegWith({ local: "2026:10:17 08:15:30", offset: "+02:00" }, little));
      expect(at?.toISOString()).toBe("2026-10-17T06:15:30.000Z");
    }
  });

  it("reads a time with no offset in the phone's own zone", () => {
    const at = exifShotTime(jpegWith({ local: "2026:10:17 08:15:30" }));
    expect(at?.getHours()).toBe(8);
    expect(at?.getMinutes()).toBe(15);
    expect(at?.getDate()).toBe(17);
  });

  it("answers null for no Exif, a zeroed date, an impossible one, or not a JPEG", () => {
    expect(exifShotTime(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(exifShotTime(jpegWith({}))).toBeNull();
    expect(exifShotTime(jpegWith({ local: "0000:00:00 00:00:00" }))).toBeNull();
    expect(exifShotTime(jpegWith({ local: "2026:02:30 08:00:00" }))).toBeNull();
    expect(exifShotTime(new TextEncoder().encode("\x89PNG not a jpeg"))).toBeNull();
  });

  it("never throws on a truncated block", () => {
    const whole = jpegWith({ local: "2026:10:17 08:15:30", offset: "+02:00" });
    for (let cut = 0; cut < whole.length; cut += 3) {
      expect(() => readExifShotFields(whole.subarray(0, cut))).not.toThrow();
    }
  });
});
