import { describe, expect, it, vi } from "vitest";
import type { ScanReply } from "@/lib/barcode/client";
import { fitWithin, gtinFromReply, readBarcodeFromStill, STILL_MAX_SIDE } from "@/lib/barcode/still";

/** A stand-in for the zxing worker: answers each posted frame with `reply` (or never). */
function fakeWorker(reply: ((id: number) => ScanReply) | null) {
  const listeners = new Set<(event: Event) => void>();
  const worker = {
    posted: [] as unknown[],
    terminate: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: (event: Event) => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: (event: Event) => void) => { listeners.delete(listener); }),
    postMessage: vi.fn((message: { id: number }) => {
      worker.posted.push(message);
      if (!reply) return;
      queueMicrotask(() => listeners.forEach((listener) =>
        listener({ data: reply(message.id) } as unknown as Event)));
    }),
  };
  return worker;
}

const pixels = { width: 4, height: 4, data: new Uint8ClampedArray(64) } as unknown as ImageData;
const photo = new Blob(["jpeg"], { type: "image/jpeg" });
const EAN = "4006381333931"; // a valid EAN-13
const OTHER = "036000291452"; // a valid UPC-A

describe("fitWithin", () => {
  it("scales the longest side down to the cap and never up", () => {
    expect(fitWithin(4032, 3024, STILL_MAX_SIDE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, STILL_MAX_SIDE)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, STILL_MAX_SIDE)).toEqual({ width: 800, height: 600 });
  });
});

describe("gtinFromReply", () => {
  it("keeps one valid code and refuses a bad check digit, an error or two different codes", () => {
    expect(gtinFromReply({ id: 1, results: [{ text: EAN, format: "EAN-13" }] })).toBe(EAN);
    expect(gtinFromReply({ id: 1, results: [{ text: EAN, format: "EAN-13" }, { text: EAN, format: "EAN-13" }] }))
      .toBe(EAN);
    expect(gtinFromReply({ id: 1, results: [{ text: "4006381333932", format: "EAN-13" }] })).toBeNull();
    expect(gtinFromReply({ id: 1, results: [], error: true })).toBeNull();
    expect(gtinFromReply({ id: 1, results: [{ text: EAN, format: "EAN-13" }, { text: OTHER, format: "UPC-A" }] }))
      .toBeNull();
  });
});

describe("readBarcodeFromStill", () => {
  it("posts one downscaled frame to the scanner's worker and returns the code it read", async () => {
    const worker = fakeWorker((id) => ({ id, results: [{ text: EAN, format: "EAN-13" }] }));
    const toImageData = vi.fn(async () => pixels);
    await expect(readBarcodeFromStill(photo, { createWorker: () => worker, toImageData })).resolves.toBe(EAN);
    expect(toImageData).toHaveBeenCalledWith(photo, STILL_MAX_SIDE);
    expect(worker.posted).toEqual([{ id: 1, data: pixels }]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("returns null when the photo holds no barcode", async () => {
    const worker = fakeWorker((id) => ({ id, results: [] }));
    await expect(readBarcodeFromStill(photo, { createWorker: () => worker, toImageData: async () => pixels }))
      .resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("gives up after the time limit and still frees the worker", async () => {
    const worker = fakeWorker(null);
    await expect(readBarcodeFromStill(photo, {
      createWorker: () => worker, toImageData: async () => pixels, timeoutMs: 5,
    })).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("returns null when the image cannot be opened, without starting a worker", async () => {
    const createWorker = vi.fn(() => fakeWorker(null));
    await expect(readBarcodeFromStill(photo, {
      createWorker, toImageData: async () => { throw new Error("decode failed"); },
    })).resolves.toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
  });
});
