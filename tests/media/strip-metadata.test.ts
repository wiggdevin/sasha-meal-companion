import { describe, expect, it } from "vitest";
import { stripImageMetadata, UnparseableImage } from "@/lib/media/strip-metadata";
import { syntheticJpeg, syntheticJpegWithExif, syntheticPng, syntheticPngWithMetadata }
  from "../helpers/synthetic-images";

describe("stripImageMetadata (JPEG)", () => {
  it("drops the APP1/EXIF block, keeping SOI, the image markers and the scan to EOI", () => {
    const stripped = stripImageMetadata(syntheticJpegWithExif(), "image/jpeg");
    const text = Buffer.from(stripped).toString("latin1");
    // Byte test (acceptance 5): no EXIF signature and no GPS filler text survive.
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS_LAT_LONG");
    // SOI and EOI are preserved, and the image markers (DQT/SOF0/DHT/SOS) are still present.
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
    expect([...stripped]).toContain(0xc0); // SOF0 marker byte survives somewhere in the stream
  });

  it("round-trips a JPEG with no metadata to strip, unchanged", () => {
    const plain = syntheticJpeg();
    expect([...stripImageMetadata(plain, "image/jpeg")]).toEqual([...plain]);
  });

  it("drops trailing padding after the real EOI instead of refusing it", () => {
    const padded = new Uint8Array(256);
    padded.set(syntheticJpeg());
    const stripped = stripImageMetadata(padded, "image/jpeg");
    expect(stripped[stripped.length - 1]).toBe(0xd9);
    expect(stripped[stripped.length - 2]).toBe(0xff);
  });

  it("refuses a file that is not a JPEG", () => {
    expect(() => stripImageMetadata(new Uint8Array([0, 1, 2, 3]), "image/jpeg"))
      .toThrow(UnparseableImage);
  });

  it("refuses a truncated JPEG", () => {
    const truncated = syntheticJpegWithExif().slice(0, 10);
    expect(() => stripImageMetadata(truncated, "image/jpeg")).toThrow(UnparseableImage);
  });
});

describe("stripImageMetadata (PNG)", () => {
  it("drops eXIf and tEXt chunks, keeping IHDR, IDAT and IEND", () => {
    const stripped = stripImageMetadata(syntheticPngWithMetadata(), "image/png");
    const text = Buffer.from(stripped).toString("latin1");
    expect(text).not.toContain("eXIf");
    expect(text).not.toContain("tEXt");
    expect(text).not.toContain("Comment");
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
  });

  it("round-trips a PNG with no metadata to strip, unchanged", () => {
    const plain = syntheticPng();
    expect([...stripImageMetadata(plain, "image/png")]).toEqual([...plain]);
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => stripImageMetadata(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/png"))
      .toThrow(UnparseableImage);
  });

  it("refuses a PNG with no IEND", () => {
    const withoutEnd = syntheticPng().slice(0, 16); // signature + partial IHDR, no IDAT/IEND
    expect(() => stripImageMetadata(withoutEnd, "image/png")).toThrow(UnparseableImage);
  });
});
