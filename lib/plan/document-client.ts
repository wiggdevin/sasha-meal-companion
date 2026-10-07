"use client";
/**
 * The phone half of the Plan panel's "+": check the picked file (type, size, PDF pages), send it to
 * POST /api/plan/document, and parse what comes back before the panel shows any of it. A photo is
 * resized and uploaded through the same media pipeline as the camera's; a PDF travels as base64 in
 * the body; a text file is read here and sent as text.
 */
import { AccountChanged, accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import {
  checkDocumentFile, MAX_DOCUMENT_PAGES, MAX_DOCUMENT_TEXT, pdfPageCount, sniffBytes, TOO_MANY_PAGES,
} from "@/lib/plan/document-files";
import { documentResultSchema, type DocumentRequest, type DocumentResult } from "@/lib/plan/document-types";
import { InspireError, uploadPlanPhoto } from "@/lib/plan/inspire-client";
import type { SlotId } from "@/lib/types";

export type DocumentContext = { localDate: string; slot: SlotId; slotTime: string; targetKcal?: number };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The request body for one picked file, or an InspireError the panel shows as it is. */
async function bodyFor(h: AccountHandle, file: File, ctx: DocumentContext): Promise<DocumentRequest> {
  const checked = checkDocumentFile(file);
  if (!checked.ok) throw new InspireError(checked.message);
  const targetKcal = ctx.targetKcal && ctx.targetKcal >= 100 && ctx.targetKcal <= 3000
    ? Math.round(ctx.targetKcal) : undefined;
  const base = { localDate: ctx.localDate, slot: ctx.slot, slotTime: ctx.slotTime,
    ...(targetKcal ? { targetKcal } : {}) };
  if (checked.kind === "image") {
    const { mediaPath } = await uploadPlanPhoto(h, file);
    return { kind: "image", mediaPath, ...base };
  }
  if (checked.kind === "pdf") {
    const bytes = await bytesOf(file);
    if (sniffBytes(bytes) !== "application/pdf") throw new InspireError("That file isn’t a readable PDF.");
    const pages = pdfPageCount(bytes);
    if (pages !== null && pages > MAX_DOCUMENT_PAGES) throw new InspireError(TOO_MANY_PAGES);
    return { kind: "pdf", data: toBase64(bytes), ...base };
  }
  const text = new TextDecoder().decode(await bytesOf(file)).replace(/\u0000/g, "").trim();
  if (!text) throw new InspireError("That file has no text in it.");
  return { kind: "text", text: text.slice(0, MAX_DOCUMENT_TEXT), ...base };
}

export async function readPlanDocument(h: AccountHandle, file: File, ctx: DocumentContext): Promise<DocumentResult> {
  const body = await bodyFor(h, file, ctx);
  let res: Response;
  try {
    res = await accountFetch(h, "/api/plan/document", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, { budget: "coach" });
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    throw new InspireError("That took too long. Try again.");
  }
  const json = await accountJson<unknown>(h, res).catch(() => null);
  if (!res.ok) {
    const message = (json as { message?: unknown } | null)?.message;
    throw new InspireError(typeof message === "string" ? message : "Couldn’t read that file. Try again.");
  }
  const parsed = documentResultSchema.safeParse(json);
  if (!parsed.success) throw new InspireError("Couldn’t read that file. Try again.");
  return parsed.data as DocumentResult;
}
