/**
 * Phase 4 AI-capture wire types — spec §5, verbatim. Pure TypeScript, no imports beyond zod
 * and PolicyVerdict (contracts §5). Lane M implements the routes against these types; lane N's
 * client consumes them the same way.
 *
 * Commit is Phase 2's `LogCommitRequest` (lib/log/contract.ts) — no new commit type here.
 *
 * Pure. No I/O, no Supabase import.
 */

import { z } from "zod";
import type { PolicyVerdict } from "@/lib/policy/constraints";
import type { Provenance } from "@/lib/types";

/** Duplicated from lib/log/contract.ts's SLOT_IDS (not exported there, and that file is shared
 * — nobody edits it on a lane or pre-lane branch; contracts §5 says import or duplicate). */
const SLOT_IDS = [
  "coffee",
  "pouches-pre",
  "post-refuel",
  "meal-1",
  "meal-2",
  "meal-3",
  "meal-4",
  "meal-5",
  "meal-6",
  "hot-chocolate",
] as const;

const SIGN_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
] as const;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `media/<uid>/<uuid>.<ext>`, the only path the sign route mints. Every route that takes a media
 *  path from a request body checks it (W019); the server re-checks ownership (`ownedObjectKey`). */
export const MEDIA_PATH = /^media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|m4a|aac|mp3|wav)$/;

const MAX_SIGN_BYTES = 8_388_608; // 8 MiB, matches the §5 413 too_large object cap

// ---------------------------------------------------------------- /api/media/sign

export type SignRequest = { kind: "image" | "audio"; contentType: string; bytes: number };
/** `expiresInSeconds` is the upload token's real lifetime (two hours on hosted Supabase), not a
 *  promise the URL dies sooner (audit 2026-10-10 P10). */
export type SignResponse = { path: string; uploadUrl: string; expiresInSeconds: number };

export const signRequestSchema: z.ZodType<SignRequest> = z.object({
  kind: z.enum(["image", "audio"]),
  contentType: z.enum(SIGN_CONTENT_TYPES),
  bytes: z.number().int().min(1).max(MAX_SIGN_BYTES),
});

// ---------------------------------------------------------------- /api/log/propose

export type ProposeRequest =
  | { method: "text"; localDate: string; tz: string; slot?: string; text: string }
  | { method: "voice" | "label" | "photo"; localDate: string; tz: string; slot?: string; mediaPath: string };

/**
 * lib/coach/role-advice.ts's MealComponentRoleAdvice, restated so this pure wire file reaches no
 * Jev code (tests/coach/sanity-integration.test.ts); lib/server/capture.ts assigns one to the other.
 */
export type DraftRoleAdvice = {
  foodRefId: string;
  suggestedRole: "protein_anchor" | "carb_source" | "fat_source" | "produce_or_free" | "mixed_dish";
  proposedRole: "protein" | "carb" | "fat" | null;
  currentRole: "protein" | "carb" | "fat" | null;
  reason: string;
  confidence: number;
  requiresConfirmation: boolean;
};

export type DraftItem = {
  seq: number;
  label: string; // what the model called it
  foodRefId: string | null; // null = ungrounded, the user picks
  catalogFoodRevisionId: number | null;
  grams: number;
  qty: number;
  unit: string;
  portionId: number | null;
  confidence: number; // 0..1, from the model, clamped
  policy: PolicyVerdict;
  alternatives: { foodRefId: string; label: string; score: number;
    /** Exact catalog revision behind this server-grounded choice; absent in older saved drafts. */
    catalogFoodRevisionId?: number;
    /** W139: the search verdict for this choice, so a swap to it keeps a verdict. Advisory: the
     *  commit rechecks the chosen food. Absent in older saved drafts (the swap reads unverified). */
    policy?: PolicyVerdict }[]; // top 3 when not auto-resolved
  autoResolved: boolean;
  /**
   * Present only for a grounded food with no stored role on this account (task t2c), from the
   * same `meal-component-role` advice the coach's add_to_eats carries. Advisory: nothing was
   * saved; the user's yes goes through POST /api/foods/role/confirm once the food is on a list.
   */
  roleAdvice?: DraftRoleAdvice;
};

export type ProposeResponse = {
  draftId: string;
  method: ProposeRequest["method"];
  items: DraftItem[];
  labelFood?: {
    name: string;
    brand?: string;
    per100g: Record<string, number | null>;
    ingredientsText?: string;
    allergenTags: string[];
    /** Phase 13 §5: one line per allergen the account avoids, read off this printed label. */
    allergenWarnings?: { allergen: string; outcome: "present" | "absent" | "unknown"; text: string }[];
  }; // label method only
  notes: string[]; // "couldn't hear the amount", never an apology
  spend: { usedToday: number; softCap: number };
  /**
   * The two hops only the server can time, in ms (T0 §1): the model call, and grounding. The
   * client files them alongside its own marks so one run is one row set in `client_timings`.
   * Optional: an older client, or a draft rebuilt from the cache, simply has none.
   */
  timings?: { model: number; ground: number };
  /** Always a model read on this route (lib/types.ts `Provenance`); a barcode match is not. */
  provenance?: Provenance;
};

const proposeTextSchema = z.object({
  method: z.literal("text"),
  localDate: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
  tz: z.string().min(1).max(64),
  slot: z.enum(SLOT_IDS).optional(),
  text: z.string().min(1).max(2000),
});

const proposeMediaSchema = z.object({
  method: z.enum(["voice", "label", "photo"]),
  localDate: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
  tz: z.string().min(1).max(64),
  slot: z.enum(SLOT_IDS).optional(),
  mediaPath: z.string().regex(MEDIA_PATH, "must be media/<uid>/<uuid>.<ext>"),
});

export const proposeRequestSchema = z.discriminatedUnion("method", [
  proposeTextSchema,
  proposeMediaSchema,
]);
