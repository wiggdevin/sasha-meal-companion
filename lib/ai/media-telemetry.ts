/**
 * Size-only telemetry for a photo sent to a model (W155): the byte length of the stripped image,
 * one structured log line per provider attempt. Nothing else is recorded — no content, hash,
 * dimensions or EXIF — and there is no `ai_calls` column (no migration).
 */

export type ImageBytesRecord = { purpose: string; image_bytes: number };

export function recordImageBytes(purpose: string, bytes: Uint8Array): ImageBytesRecord {
  const record: ImageBytesRecord = { purpose, image_bytes: bytes.byteLength };
  console.info("[media-telemetry]", record);
  return record;
}
