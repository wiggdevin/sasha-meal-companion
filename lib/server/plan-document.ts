/**
 * The Plan panel's "+": one meal plan, recipe or menu the person uploaded, read by one registered
 * OpenRouter call (`documentToPlan`, lib/ai/document.ts), with a Gemini twin on provider failure,
 * and routed by what it is:
 *  - a meal plan: days and meals, screened; the meal matching this slot is grounded through the
 *    coach's food search and policy check (lib/plan/document-ground.ts). Nothing is placed here;
 *    the panel places it only after a tap, through the same set_slot_meal path as a coach card;
 *  - a recipe: a title and food names, which the panel turns into a coach planning ask (planSource);
 *  - a menu: dishes screened against the account's rules and Avoid list, the three nearest the
 *    slot's kcal (the same menu screen as a menu photo, lib/server/plan-menu.ts);
 *  - anything else: "other".
 * The document's text is untrusted data, never instructions: it reaches the model fenced as data,
 * the model's reply is schema-parsed, and every name passes the food vocabulary screen. The
 * account's rules never reach the model.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { AttestationRefused } from "@/lib/ai/attestation";
import { generateStructured, SchemaRejection } from "@/lib/ai/adapter";
import { DOCUMENT_MAX_OUTPUT_TOKENS, documentReadSchema, type DocumentReadOutput } from "@/lib/ai/document";
import { documentPlanGeminiPayload } from "@/lib/ai/gemini-payloads";
import { LANES } from "@/lib/ai/lanes";
import { planDocumentModel } from "@/lib/ai/models";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { documentPlanPayload, type DocumentPayloadInput } from "@/lib/ai/openrouter-payloads";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { providerFallbackWorthTrying } from "@/lib/ai/provider-fallback";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { cleanDays, cleanRecipeIngredients, matchMeal } from "@/lib/plan/document-clean";
import { MAX_DOCUMENT_PAGES, MAX_PDF_BYTES, pdfPageCount, sniffBytes, TOO_MANY_PAGES } from "@/lib/plan/document-files";
import { groundDocumentMeal, itemTotals, type DocumentGroundPorts } from "@/lib/plan/document-ground";
import type { DocumentRequest, DocumentResult } from "@/lib/plan/document-types";
import { cleanIngredients, dishTitle } from "@/lib/plan/inspire-types";
import { cleanMenu } from "@/lib/plan/photo-result";
import { HttpError } from "@/lib/server/auth";
import { fetchOwnedObject } from "@/lib/server/media";
import { MAX_INSPIRE_PHOTO_BYTES } from "@/lib/server/plan-inspire";
import { defaultMenuSearch, screenMenu } from "@/lib/server/plan-menu";
import { readPolicyProfile, type PolicyProfile } from "@/lib/server/policy-profile";
import { byModel } from "@/lib/provenance";

const DOCUMENT_BUDGET_MS = 40_000;
const DOCUMENT_PRIMARY_MS = 18_000;
const UNAVAILABLE = "Reading files isn’t available right now.";

export type DocumentDeps = {
  fetchObject?: typeof fetchOwnedObject;
  generate?: typeof generateOpenRouter;
  generateGemini?: typeof generateStructured;
  /** The account's food rules, read only when a matched meal or a menu needs screening. */
  readPolicy?: (admin: SupabaseClient, userId: string) => Promise<PolicyProfile | ConstraintProfile>;
  searchFoods?: DocumentGroundPorts["searchFoods"];
};

/** The request's file as payload input: its type sniffed from its bytes, its size and pages bounded. */
async function source(admin: SupabaseClient, userId: string, req: DocumentRequest,
  deps: DocumentDeps): Promise<DocumentPayloadInput> {
  if (req.kind === "text") {
    if (!req.text.trim()) throw new HttpError(422, "empty_document", "That file has no text in it.");
    return { kind: "text", text: req.text };
  }
  if (req.kind === "image") {
    const media = await (deps.fetchObject ?? fetchOwnedObject)(admin, userId, req.mediaPath);
    const kind = sniffBytes(media.bytes);
    if (!/^image\/(jpeg|png)$/.test(media.mimeType) || (kind !== "image/jpeg" && kind !== "image/png")) {
      throw new HttpError(415, "unsupported_media", "Use a JPEG or PNG photo.");
    }
    if (media.bytes.byteLength > MAX_INSPIRE_PHOTO_BYTES) {
      throw new HttpError(413, "too_large", "That photo is too large. Try another one.");
    }
    return { kind: "image", bytes: media.bytes };
  }
  const bytes = new Uint8Array(Buffer.from(req.data, "base64"));
  if (bytes.byteLength > MAX_PDF_BYTES) throw new HttpError(413, "too_large", "That PDF is over 3 MB.");
  if (sniffBytes(bytes) !== "application/pdf") throw new HttpError(415, "unsupported_media", "That isn’t a PDF.");
  const pages = pdfPageCount(bytes);
  if (pages !== null && pages > MAX_DOCUMENT_PAGES) throw new HttpError(413, "too_many_pages", TOO_MANY_PAGES);
  return { kind: "pdf", bytes };
}

export async function readDocument(admin: SupabaseClient, client: SupabaseClient, userId: string,
  req: DocumentRequest, deps: DocumentDeps = {}): Promise<DocumentResult> {
  const input = await source(admin, userId, req, deps);
  if (!deps.generate && !openRouterConfigured()) throw new HttpError(503, "provider_unavailable", UNAVAILABLE);
  let out: DocumentReadOutput;
  const started = Date.now();
  try {
    try {
      out = await (deps.generate ?? generateOpenRouter)({
        payload: documentPlanPayload(input), userId, admin, schema: documentReadSchema,
        modelId: planDocumentModel(), maxOutputTokens: DOCUMENT_MAX_OUTPUT_TOKENS,
        timeoutMs: DOCUMENT_PRIMARY_MS, attemptTimeoutMs: DOCUMENT_PRIMARY_MS - 2_000,
        abandonOnCapacity: true,
      });
    } catch (e) {
      const left = DOCUMENT_BUDGET_MS - (Date.now() - started);
      if (!providerFallbackWorthTrying(e) || left <= 0) throw e;
      out = await (deps.generateGemini ?? generateStructured)({
        payload: documentPlanGeminiPayload(input), userId, admin, schema: documentReadSchema,
        route: { provider: "google", modelId: LANES.plan.fallback },
        maxOutputTokens: DOCUMENT_MAX_OUTPUT_TOKENS, timeoutMs: left, attemptTimeoutMs: left,
      });
    }
  } catch (e) {
    if (e instanceof AttestationRefused) throw new HttpError(503, "provider_unavailable", UNAVAILABLE);
    if (e instanceof HttpError) throw e;
    if (e instanceof SchemaRejection) {
      throw new HttpError(422, "schema_invalid", "I couldn’t read that file. Try another one.");
    }
    console.error("plan document read failed", {
      error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 300) } : "non-Error",
    });
    throw new HttpError(503, "provider_unavailable", "I couldn’t read that file right now. Try again.");
  }
  // Every answer here, "nothing usable" included, is the document model's read.
  return { ...await route(admin, client, userId, req, out, deps), provenance: byModel("documentToPlan") };
}

function policy(admin: SupabaseClient, userId: string, deps: DocumentDeps) {
  return (deps.readPolicy ?? ((c, id) => readPolicyProfile(c, id, new Date()).then((r) => r.profile)))(admin, userId);
}

async function searchPort(admin: SupabaseClient, client: SupabaseClient, req: DocumentRequest,
  deps: DocumentDeps): Promise<DocumentGroundPorts["searchFoods"]> {
  return deps.searchFoods ?? defaultMenuSearch(admin, client, req.localDate);
}

/** The model's read, bounded, screened and routed by kind. */
async function route(admin: SupabaseClient, client: SupabaseClient, userId: string, req: DocumentRequest,
  out: DocumentReadOutput, deps: DocumentDeps): Promise<DocumentResult> {
  const title = dishTitle(out.title);
  if (out.kind === "meal_plan") {
    const days = cleanDays(out.days);
    if (days.length === 0) return { kind: "other" };
    const at = matchMeal(days, req);
    if (!at) return { kind: "meal_plan", title, days, match: null };
    const meal = days[at.day].meals[at.meal];
    const [profile, searchFoods] = await Promise.all([policy(admin, userId, deps), searchPort(admin, client, req, deps)]);
    const { items, left } = await groundDocumentMeal(userId, meal, profile, { searchFoods });
    return { kind: "meal_plan", title, days,
      match: { ...at, title: meal.name, items, left, totals: itemTotals(items) } };
  }
  if (out.kind === "recipe") {
    // Amounts stay here: the coach plans portions to the slot, so only the names travel on.
    const ingredients = cleanIngredients(cleanRecipeIngredients(out.ingredients).map((food) => food.name));
    return ingredients.length || title ? { kind: "recipe", title, ingredients } : { kind: "other" };
  }
  if (out.kind === "menu") {
    const candidates = cleanMenu(out.menu);
    if (candidates.length === 0) return { kind: "other" };
    const [profile, searchFoods] = await Promise.all([policy(admin, userId, deps), searchPort(admin, client, req, deps)]);
    return { kind: "menu", title, ingredients: [],
      menu: await screenMenu(userId, candidates, req.targetKcal, profile, searchFoods) };
  }
  return { kind: "other" };
}
