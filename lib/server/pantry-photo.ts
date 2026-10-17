/**
 * W12: pantry from a photo (docs/specs/phase-18-open-world-foods.md §W12). Draft, then
 * confirm-first write — no `shopping_pantry` row exists until the user confirms what the photo
 * showed (acceptance 1, 2). The boundary (owner decision 2026-10-05,
 * docs/decisions/2026-10-05-pantry-photo-privacy-boundary.md):
 *
 *   user-started capture → (phone: resizeImage, EXIF dropped) → server strips any remaining
 *   metadata and refuses what it cannot parse → the OpenRouter `photoToIdeas` pin only, deny +
 *   zdr routing, no Gemini fallback → the fixed prompt, no slot calories, no profile/rule/
 *   condition/account data → only `kind: "ingredients"` names are kept.
 *
 * This reuses the Plan sheet's exact `photoToIdeas` builder (lib/ai/openrouter-payloads.ts
 * inspirePhotoPayload) so the `ai_calls` row this writes is indistinguishable in purpose from
 * every other photoToIdeas call (acceptance 4) — but, unlike lib/server/plan-inspire.ts, there is
 * no Gemini fallback leg here at all: boundary item 5 says the route fails with "Try again
 * later" rather than reach a provider whose zero-data-retention routing is not this app's to set.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AttestationRefused } from "@/lib/ai/attestation";
import { SchemaRejection } from "@/lib/ai/call";
import { planPhotoModel } from "@/lib/ai/models";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { inspirePhotoPayload } from "@/lib/ai/openrouter-payloads";
import { INSPIRE_MAX_OUTPUT_TOKENS, inspirePhotoSchema, type InspirePhotoOutput } from "@/lib/ai/inspire";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { cleanIngredients } from "@/lib/plan/inspire-types";
import { stripImageMetadata, UnparseableImage } from "@/lib/media/strip-metadata";
import type { IngredientIdentity, PantryItem } from "@/lib/shopping/types";
import { putPantry } from "@/lib/shopping/repository";
import { HttpError } from "@/lib/server/auth";
import { fetchOwnedObject as fetchOwnedObjectImpl } from "@/lib/server/media";
import { recordImageBytes } from "@/lib/ai/media-telemetry";

/** Mirrors lib/server/plan-inspire.ts MAX_INSPIRE_PHOTO_BYTES: the only upload path to this route
 *  is `resizeImage` output (1600 px, JPEG q 0.8), well under this ceiling. */
export const MAX_PANTRY_PHOTO_BYTES = 2.5 * 1024 * 1024;
/** No same-key fallback to budget around here (there is no fallback leg) — a single attempt
 *  inside the propose-style client deadline. */
const PHOTO_TIMEOUT_MS = 8_000;

/** The file's own first bytes, never the stored content type (same check as plan-inspire.ts). */
function imageKind(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  const starts = (sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

export type PantryPhotoDraft = { items: string[] };

export type PantryPhotoDeps = {
  fetchObject?: typeof fetchOwnedObjectImpl;
  generate?: typeof generateOpenRouter;
};

/**
 * Reads the uploaded photo, strips its metadata server-side, asks `photoToIdeas` what it shows,
 * and returns the ingredient names it recognised. Writes nothing (acceptance 1).
 */
export async function draftPantryPhoto(
  admin: SupabaseClient, userId: string, mediaPath: string, deps: PantryPhotoDeps = {},
): Promise<PantryPhotoDraft> {
  const fetchObject = deps.fetchObject ?? fetchOwnedObjectImpl;
  const media = await fetchObject(admin, userId, mediaPath);
  const kind = imageKind(media.bytes);
  if (!/^image\/(jpeg|png)$/.test(media.mimeType) || kind === null) {
    throw new HttpError(415, "unsupported_media", "Use a JPEG or PNG photo.");
  }
  if (media.bytes.byteLength > MAX_PANTRY_PHOTO_BYTES) {
    throw new HttpError(413, "too_large", "That photo is too large. Try taking it again.");
  }
  let stripped: Uint8Array;
  try {
    stripped = stripImageMetadata(media.bytes, kind);
  } catch (e) {
    if (!(e instanceof UnparseableImage)) throw e;
    throw new HttpError(422, "unreadable_photo", "That photo couldn’t be read. Try another one.");
  }
  if (!deps.generate && !openRouterConfigured()) {
    throw new HttpError(503, "provider_unavailable", "Try again later.");
  }
  let model: InspirePhotoOutput;
  try {
    recordImageBytes("pantryPhoto", stripped);
    model = await (deps.generate ?? generateOpenRouter)({
      payload: inspirePhotoPayload({ bytes: stripped, mimeType: kind }, { as: "ingredients" }),
      userId, admin, schema: inspirePhotoSchema, modelId: planPhotoModel(),
      maxOutputTokens: INSPIRE_MAX_OUTPUT_TOKENS,
      timeoutMs: PHOTO_TIMEOUT_MS, attemptTimeoutMs: PHOTO_TIMEOUT_MS,
    });
  } catch (e) {
    // No Gemini fallback leg, ever (boundary item 5) — every failure here ends the request.
    if (e instanceof AttestationRefused) throw new HttpError(503, "provider_unavailable", "Try again later.");
    if (e instanceof HttpError) throw e;
    if (e instanceof SchemaRejection) {
      throw new HttpError(422, "schema_invalid", "I couldn’t read that photo. Try another one.");
    }
    console.error("pantry photo failed", {
      error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 300) } : "non-Error",
    });
    throw new HttpError(503, "provider_unavailable", "Try again later.");
  }
  // Acceptance 7: only kind:"ingredients" names are kept — a plate, menu or unknown read (even
  // forced toward "ingredients") contributes nothing to the pantry draft.
  const items = model.kind === "ingredients" ? cleanIngredients(model.ingredients) : [];
  return { items };
}

export type ConfirmedPantryPhotoItem = { name: string; grams: number | null };
/** One item the batch could not write — surfaced instead of discarded, so a mid-batch failure
 *  (e.g. item 3 of 5 collides with stock already in the pantry) never leaves the caller unsure
 *  whether the OTHER items landed. */
export type FailedPantryPhotoItem = { name: string; status: number; code: string; message: string };
export type ConfirmPantryPhotoResult = { written: PantryItem[]; failed: FailedPantryPhotoItem[] };

/** An ungrounded, free-text purchase identity for a photo-named item — the same shape capture
 *  uses for an item the catalog search never resolved (`foodRefId: null` = ungrounded, the
 *  existing rule-marks path still screens it by name, lib/shopping/rule-marks.ts). */
function photoIdentity(name: string): IngredientIdentity {
  return { foodRefId: null, foodDbId: null, catalogFoodRevisionId: null,
    purchaseState: "as_purchased", variantKey: name.trim().toLowerCase().slice(0, 120) };
}

/**
 * A stable, valid UUID derived from the batch's own `requestId` and an item's position in it.
 * `shopping_pantry.request_id` is a `uuid` column (Sol review BLOCK: the earlier `${requestId}:
 * ${index}` string is not one, and Postgres refuses every insert in this batch) — this keeps the
 * per-item idempotency `putPantry` needs (the same requestId+index always derives the same UUID,
 * so an exact retry of the whole confirm call still no-ops into the same rows) without needing a
 * uuid column that stores anything but a uuid. Not a security token: derived, not secret.
 */
function itemRequestId(requestId: string, index: number): string {
  const hex = createHash("sha256").update(`${requestId}:${index}`).digest("hex").slice(0, 32);
  const version = `4${hex.slice(13, 16)}`; // version nibble forced to 4
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20); // variant bits
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

/**
 * Writes one `shopping_pantry` row per confirmed item, `source: 'photo'` (acceptance 2). Null
 * grams are allowed — the draft never estimates a weight, only a name. Each item gets its own
 * derived request id (`itemRequestId`) so the idempotency key stays unique and valid inside one
 * confirm call while still letting an exact retry of the whole batch no-op into the same rows
 * (lib/shopping/repository.ts putPantry).
 *
 * One item's failure (most often `pantry_identity_exists`, a 409 when the photo names something
 * already confirmed, but any write failure — an HttpError or otherwise, Sol review WARN) does not
 * abort the rest of the batch: an all-or-nothing loop would throw on the first failure and return
 * nothing, so a 3-of-5 failure would silently leave items 1 and 2 written in the database while
 * the caller saw one opaque error for the whole request and no way to know anything had landed.
 * Every item is attempted; `written` and `failed` together account for all of them, in order.
 */
export async function confirmPantryPhoto(
  client: SupabaseClient, userId: string, items: readonly ConfirmedPantryPhotoItem[], requestId: string,
): Promise<ConfirmPantryPhotoResult> {
  const written: PantryItem[] = [];
  const failed: FailedPantryPhotoItem[] = [];
  for (const [index, item] of items.entries()) {
    try {
      written.push(await putPantry(client, userId,
        { name: item.name, identity: photoIdentity(item.name), confirmedGrams: item.grams },
        null, itemRequestId(requestId, index), "photo"));
    } catch (e) {
      if (e instanceof HttpError) {
        failed.push({ name: item.name, status: e.status, code: e.code, message: e.message });
      } else {
        console.error("pantry photo confirm: unexpected write failure", { name: item.name, error: e });
        failed.push({ name: item.name, status: 500, code: "internal", message: "Could not save this item. Try again." });
      }
    }
  }
  return { written, failed };
}
