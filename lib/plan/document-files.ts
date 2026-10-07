/**
 * What the Plan panel's "+" accepts, and the checks both ends run on it. Pure, no I/O.
 *
 * Supported: a photo (any image the phone can open; it is resized to a JPEG and goes through the
 * media pipeline like the camera's), a PDF, and a plain-text or CSV file. Not supported: Word
 * (.docx) — the repo has no parser for it and adds no dependency for one.
 *
 * Why these limits:
 *  - A PDF travels inside the JSON request body, because the media bucket only admits JPEG, PNG and
 *    audio (supabase/migrations/20260920090100_phase4_media_bucket.sql) and widening it is a
 *    production migration. Vercel caps a function request body at 4.5 MB, and base64 grows the
 *    file by a third, so a PDF may be at most 3 MB.
 *  - A photo may be up to 10 MB before the resize; what is uploaded is the resized JPEG.
 *  - A text file is read on the phone; at most MAX_DOCUMENT_TEXT characters are sent.
 *  - At most MAX_DOCUMENT_PAGES pages are read: a longer PDF is refused when its page count can be
 *    read, and the model is told to read only that many pages when it cannot.
 */

export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 3 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_DOCUMENT_TEXT = 30_000;
export const MAX_DOCUMENT_PAGES = 10;

/** The "+" input's accept list. */
export const DOCUMENT_ACCEPT = "image/*,application/pdf,.pdf,text/plain,.txt,text/csv,.csv";

export type DocumentFileKind = "image" | "pdf" | "text";

export type DocumentFileCheck = { ok: true; kind: DocumentFileKind } | { ok: false; message: string };

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const UNSUPPORTED_FILE = "I can read a photo, a PDF, or a .txt or .csv file. Save a Word file as PDF first.";

/** The kind of a picked file from its declared type and name, and whether its size is allowed. */
export function checkDocumentFile(file: { name: string; type: string; size: number }): DocumentFileCheck {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  const kind: DocumentFileKind | null = type.startsWith("image/") ? "image"
    : type === "application/pdf" || name.endsWith(".pdf") ? "pdf"
      : type === "text/plain" || type === "text/csv" || /\.(txt|csv)$/.test(name) ? "text" : null;
  if (!kind) return { ok: false, message: UNSUPPORTED_FILE };
  if (file.size === 0) return { ok: false, message: "That file is empty." };
  const max = kind === "image" ? MAX_IMAGE_FILE_BYTES : kind === "pdf" ? MAX_PDF_BYTES : MAX_TEXT_FILE_BYTES;
  if (file.size > max) {
    return { ok: false, message: kind === "text"
      ? "That text file is too long. Keep it under 256 KB."
      : `That ${kind === "pdf" ? "PDF" : "photo"} is over ${MB(max)}. Try a smaller one.` };
  }
  return { ok: true, kind };
}

/** The file's own first bytes: a JPEG, a PNG, a PDF, or none of them. */
export function sniffBytes(bytes: Uint8Array): "image/jpeg" | "image/png" | "application/pdf" | null {
  const starts = (sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // "%PDF-"
  return null;
}

/**
 * A PDF's page count without a parser, or null when it cannot be read: the page objects
 * (`/Type /Page`) when they are visible, else the largest `/Count`. A PDF that keeps its objects in
 * compressed streams shows neither; it is then bounded by size and by the prompt alone.
 */
export function pdfPageCount(bytes: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  if (pages > 0) return pages;
  const counts = [...text.matchAll(/\/Count\s+(\d{1,6})/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

export const TOO_MANY_PAGES = `That PDF has more than ${MAX_DOCUMENT_PAGES} pages. Send just the pages with the plan.`;
