/**
 * A barcode in a photo the user already took (U18, 2026-10-04; owner: "If we have the camera button,
 * you should just have the camera button, and the user can take images of their food, their meals,
 * menus, and nutrition facts"). The dock has one Camera; before a picked photo goes to the AI as a
 * plate, menu or label, its still is read once by the same zxing worker the live scanner uses
 * (lib/barcode/worker.ts). A code found here takes the barcode path; nothing found, the photo path.
 *
 * One frame cannot reach the live scanner's two-reading quorum (lib/barcode/quorum.ts), so the
 * GTIN check digit is the guard instead, and a still holding two different valid codes is left to
 * the photo path rather than guessed.
 */
import { isGtin } from "@/lib/barcode/gtin";
import type { ScanReply, ScanRequest } from "@/lib/barcode/client";

/** The longest side the still is drawn at: enough for a pack's bars, small enough to decode fast. */
export const STILL_MAX_SIDE = 1600;
/** A still that takes longer than this to decode goes to the photo path instead. */
export const STILL_DECODE_MS = 5000;

type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;

export type StillDeps = {
  /** The decoder; defaults to the scanner's own worker. */
  createWorker?: () => WorkerLike;
  /** The photo as pixels; defaults to `createImageBitmap` drawn onto a canvas. */
  toImageData?: (file: Blob, maxSide: number) => Promise<ImageData>;
  timeoutMs?: number;
};

/** Scale a width × height so its longest side is at most `maxSide` (never upscales). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function canvasImageData(file: Blob, maxSide: number): Promise<ImageData> {
  // `from-image` applies the photo's EXIF rotation, so a portrait shot is read upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxSide);
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(size.width, size.height)
      : Object.assign(document.createElement("canvas"), size);
    const context = canvas.getContext("2d", { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("No 2D canvas.");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return context.getImageData(0, 0, size.width, size.height);
  } finally {
    bitmap.close();
  }
}

function scannerWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** The one valid GTIN in a reply, or null for none, a decoder error, or two different codes. */
export function gtinFromReply(reply: ScanReply): string | null {
  if (reply.error) return null;
  const codes = new Set(reply.results.map((result) => result.text.trim()).filter(isGtin));
  return codes.size === 1 ? [...codes][0] : null;
}

/**
 * The barcode in a still photo, or null. Never throws: any failure (no canvas, an image the
 * browser cannot open, a decoder error, the time running out) means "no barcode here", and the
 * caller sends the photo the usual way.
 */
export async function readBarcodeFromStill(file: Blob, deps: StillDeps = {}): Promise<string | null> {
  let worker: WorkerLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const data = await (deps.toImageData ?? canvasImageData)(file, STILL_MAX_SIDE);
    worker = (deps.createWorker ?? scannerWorker)();
    const live = worker;
    const reply = await new Promise<ScanReply | null>((resolve) => {
      const onMessage = (event: Event) => {
        const answer = (event as MessageEvent<ScanReply>).data;
        if (answer?.id !== 1) return;
        live.removeEventListener("message", onMessage);
        resolve(answer);
      };
      live.addEventListener("message", onMessage);
      timer = setTimeout(() => { live.removeEventListener("message", onMessage); resolve(null); },
        deps.timeoutMs ?? STILL_DECODE_MS);
      live.postMessage({ id: 1, data } satisfies ScanRequest);
    });
    return reply ? gtinFromReply(reply) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    worker?.terminate();
  }
}
