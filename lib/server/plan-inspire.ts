/**
 * The plan sheet's "start from a photo or a link". A photo uses the registered OpenRouter
 * `photoToIdeas` call, with a Gemini twin on provider failure, to say what it shows:
 *  - a plate being eaten: a bounded estimate the sheet offers to log through the capture pipeline;
 *  - a menu: the dishes, screened against the account's own rules and Avoid list (blocked ones dropped,
 *    unclear ones carrying what to ask about, none ever called safe), then the three nearest the
 *    slot's kcal;
 *  - ingredients, a recipe or a dish to make: food names only, which the sheet turns into a coach
 *    planning turn, so the account's rules, Eats and slot targets still decide every card.
 * A link is a guarded fetch and a deterministic schema.org parse, with no model call at all.
 * The account's rules never reach the model; only the slot's kcal does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateStructured, SchemaRejection } from "@/lib/ai/adapter";
import { AttestationRefused } from "@/lib/ai/attestation";
import { inspirePhotoGeminiPayload } from "@/lib/ai/gemini-payloads";
import { LANES } from "@/lib/ai/lanes";
import { stripImageMetadata, UnparseableImage } from "@/lib/media/strip-metadata";
import { INSPIRE_MAX_OUTPUT_TOKENS, inspirePhotoSchema, type InspirePhotoOutput } from "@/lib/ai/inspire";
import { planPhotoModel } from "@/lib/ai/models";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { inspirePhotoPayload } from "@/lib/ai/openrouter-payloads";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { providerFallbackWorthTrying } from "@/lib/ai/provider-fallback";
import { cleanIngredients, dishTitle, type InspireRequest, type InspireResult } from "@/lib/plan/inspire-types";
import { cleanMenu, cleanPlate } from "@/lib/plan/photo-result";
import { parseRecipePage } from "@/lib/plan/recipe-jsonld";
import { HttpError } from "@/lib/server/auth";
import { fetchOwnedObject } from "@/lib/server/media";
import {
  defaultMenuSearch, readMenuProfile, screenMenu, type MenuProfile, type MenuSearch,
} from "@/lib/server/plan-menu";
import { fetchRecipePage } from "@/lib/server/recipe-url";
import { BY_APP, byModel } from "@/lib/provenance";

const PHOTO_BUDGET_MS = 20_000;
const PHOTO_PRIMARY_MS = 8_000;

/**
 * The largest photo this reads. The sheet uploads only `resizeImage` output (lib/media/resize.ts
 * DEFAULT_RESIZE: 1600 px long edge, JPEG q 0.8, about 1.9 MP), which lands well under 1.5 MB
 * even for a busy frame; 2.5 MB leaves headroom for that and refuses anything else in the user's
 * media prefix before it is base64'd into a billed model call.
 */
export const MAX_INSPIRE_PHOTO_BYTES = 2.5 * 1024 * 1024;

/** The file's own first bytes, not the stored content type: a JPEG SOI marker or the PNG signature. */
function imageKind(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  const starts = (sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

export type InspireDeps = {
  fetchObject?: typeof fetchOwnedObject;
  generate?: typeof generateOpenRouter;
  generateGemini?: typeof generateStructured;
  fetchPage?: typeof fetchRecipePage;
  /** The account's food rules, read only when a menu needs screening. */
  /** W014: the profile and the diet flags, read together (lib/server/plan-menu.ts readMenuProfile). */
  readPolicy?: (admin: SupabaseClient, userId: string) => Promise<MenuProfile>;
  /** The food search a menu's names are checked against the Avoid list with (lib/server/plan-menu.ts). */
  searchFoods?: MenuSearch;
};

async function menuPicks(admin: SupabaseClient, client: SupabaseClient, userId: string,
  raw: Parameters<typeof cleanMenu>[0], req: Extract<InspireRequest, { kind: "photo" }>, deps: InspireDeps) {
  const candidates = cleanMenu(raw);
  if (candidates.length === 0) return [];
  const [profile, searchFoods] = await Promise.all([
    (deps.readPolicy ?? readMenuProfile)(admin, userId),
    deps.searchFoods ?? defaultMenuSearch(admin, client, req.localDate),
  ]);
  return screenMenu(userId, candidates, req.targetKcal, profile, searchFoods);
}

export async function inspire(
  admin: SupabaseClient, client: SupabaseClient, userId: string, req: InspireRequest, deps: InspireDeps = {},
): Promise<InspireResult> {
  if (req.kind === "url") {
    const page = await (deps.fetchPage ?? fetchRecipePage)(req.url);
    // schema.org JSON-LD parsed in code: no model read the page.
    return { ...parseRecipePage(page), provenance: BY_APP };
  }
  const media = await (deps.fetchObject ?? fetchOwnedObject)(admin, userId, req.mediaPath);
  const kind = imageKind(media.bytes);
  if (!/^image\/(jpeg|png)$/.test(media.mimeType) || kind === null) {
    throw new HttpError(415, "unsupported_media", "Use a JPEG or PNG photo.");
  }
  if (media.bytes.byteLength > MAX_INSPIRE_PHOTO_BYTES) {
    throw new HttpError(413, "too_large", "That photo is too large. Try taking it again.");
  }
  // W12-F (follow-up noted in docs/specs/phase-18-open-world-foods.md §W12): the Plan sheet's own
  // photo path never verified an upload was free of metadata before this line — W12 built that
  // check for the pantry route and this applies the identical strip here, before either provider
  // leg, so an unparseable upload is refused before any call rather than only for pantry photos.
  let stripped: Uint8Array;
  try {
    stripped = stripImageMetadata(media.bytes, kind);
  } catch (e) {
    if (!(e instanceof UnparseableImage)) throw e;
    throw new HttpError(422, "unreadable_photo", "That photo couldn’t be read. Try another one.");
  }
  if (!deps.generate && !openRouterConfigured()) {
    throw new HttpError(503, "provider_unavailable", "Photo ideas aren’t available right now.");
  }
  let model: InspirePhotoOutput;
  const started = Date.now();
  try {
    try {
      model = await (deps.generate ?? generateOpenRouter)({
        payload: inspirePhotoPayload({ bytes: stripped, mimeType: kind },
          { as: req.as, targetKcal: req.targetKcal }), userId, admin, schema: inspirePhotoSchema,
        modelId: planPhotoModel(), maxOutputTokens: INSPIRE_MAX_OUTPUT_TOKENS,
        timeoutMs: PHOTO_PRIMARY_MS, attemptTimeoutMs: PHOTO_PRIMARY_MS, abandonOnCapacity: true,
      });
    } catch (e) {
      const left = PHOTO_BUDGET_MS - (Date.now() - started);
      if (!providerFallbackWorthTrying(e) || left <= 0) throw e;
      model = await (deps.generateGemini ?? generateStructured)({
        payload: inspirePhotoGeminiPayload({ bytes: stripped, mimeType: kind },
          { as: req.as, targetKcal: req.targetKcal }), userId, admin, schema: inspirePhotoSchema,
        route: { provider: "google", modelId: LANES.plan.fallback },
        maxOutputTokens: INSPIRE_MAX_OUTPUT_TOKENS, timeoutMs: left, attemptTimeoutMs: left,
      });
    }
  } catch (e) {
    if (e instanceof AttestationRefused) {
      throw new HttpError(503, "provider_unavailable", "Photo ideas aren’t available right now.");
    }
    if (e instanceof HttpError) throw e;
    if (e instanceof SchemaRejection) {
      throw new HttpError(422, "schema_invalid", "I couldn’t read that photo. Try another one.");
    }
    console.error("plan inspire photo failed", {
      error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 300) } : "non-Error",
    });
    throw new HttpError(503, "provider_unavailable", "I couldn’t read that photo right now. Try again.");
  }
  return { ...await photoResult(admin, client, userId, req, model, deps),
    provenance: byModel("photoToIdeas") };
}

/** The model's read, bounded and screened, routed by kind. A forced read wins over the model's. */
async function photoResult(admin: SupabaseClient, client: SupabaseClient, userId: string, req: Extract<InspireRequest, { kind: "photo" }>,
  out: InspirePhotoOutput, deps: InspireDeps): Promise<InspireResult> {
  const kind = req.as === "plate" || req.as === "menu" ? req.as
    : req.as === "ingredients" && (out.kind === "plate" || out.kind === "menu") ? "ingredients" : out.kind;
  const base = { title: dishTitle(out.title ?? out.plate?.title), ingredients: cleanIngredients(
    out.ingredients.length ? out.ingredients : (out.plate?.items.map((item) => item.name) ?? [])) };
  if (kind === "plate") {
    const plate = cleanPlate(out.plate);
    return plate ? { kind, ...base, plate } : { kind: "unknown", ...base };
  }
  if (kind === "menu") {
    // Only the screened dishes travel on: the model's food names never saw the rules (as a document menu).
    const menu = await menuPicks(admin, client, userId, out.menu, req, deps);
    return { kind, ...base, ingredients: [], menu };
  }
  return { kind, ...base };
}
