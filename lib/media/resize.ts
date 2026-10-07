/**
 * The client half of the media pipeline — architecture §4.2: 1600 px on the long edge, JPEG q 0.8,
 * EXIF dropped. Nothing strips the metadata explicitly: a canvas re-encode carries none forward,
 * which is why the resize is mandatory before any photo leaves the phone.
 *
 * `targetSize` is the whole of the arithmetic and is unit-tested. `resizeImage` is the DOM around
 * it and is covered by the phone gate in Task 12 — vitest runs with `environment: "node"`, so
 * there is no canvas to exercise here and none is faked.
 */

export type ResizeOptions = { longEdge: number; quality: number };

export const DEFAULT_RESIZE: ResizeOptions = { longEdge: 1600, quality: 0.8 };

/** Fit-inside, never enlarge. A dimension we cannot read collapses to 1 px rather than NaN. */
export function targetSize(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(longEdge)) {
    return { width: 1, height: 1 };
  }
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= longEdge) return { width: w, height: h };
  const scale = longEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Re-encodes to JPEG at `quality`. Throws when the browser gives us no 2D context or no blob. */
export async function resizeImage(file: Blob, options: ResizeOptions = DEFAULT_RESIZE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = targetSize(bitmap.width, bitmap.height, options.longEdge);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob === null ? reject(new Error("toBlob returned nothing")) : resolve(blob)),
        "image/jpeg",
        options.quality,
      );
    });
  } finally {
    bitmap.close();
  }
}
