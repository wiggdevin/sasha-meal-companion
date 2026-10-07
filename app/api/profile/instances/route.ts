/**
 * Phase 13 slice 4 (§4, §9 R5): the only write path for `user_dietary_profiles`. Every write is an
 * explicit, named-facet confirmation the caller sent — never applied silently (onboarding and the
 * chat confirm card both go through this route, never a direct table write).
 *
 * RLS-scoped `client` from requireUser, same pattern as app/api/expenditure/route.ts. No admin
 * client: RLS already scopes every read and write to its own owner
 * (20261120090000_user_dietary_profiles.sql), so this route needs no
 * tests/tenancy/admin-entry-points.json entry.
 */
import { z } from "zod";
import { profileDefinition } from "@/lib/policy/profiles/catalog";
import {
  buildFoodPreferenceRule, FOOD_PREFERENCE_PROFILE_ID,
} from "@/lib/policy/profiles/food-preference-rule";
import {
  isOfferedProfile, offeredCatalogSummaries, profileSummary,
} from "@/lib/policy/profiles/catalog-summary";
import { buildProfileInstance, type RuleItemConfirmation } from "@/lib/policy/profiles/loader";
import type { ProfileInstance, RuleItem } from "@/lib/policy/profiles/types";
import {
  deleteAccountProfileInstance, legacyBackedProfileIds, mergeAccountProfileInstance,
  readAccountProfileInstances,
} from "@/lib/server/dietary-profiles";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024;
const confirmationSchema = z.object({ facet: z.string().min(1).max(160), confirmed: z.boolean() });
const profileConfirmationBody = z.object({
  profileId: z.string().min(1).max(160),
  confirmations: z.array(confirmationSchema).max(60),
  /** Yes/no variants (§4), each one the profile's own summary offers. */
  options: z.record(z.string().min(1).max(80), z.boolean()).optional(),
}).strict();
// Phase 13 slice 7 ("likes and dislikes"): a food preference names an open food, not a catalog
// profile id, so it goes through its own small confirmation shape instead of `confirmations`
// (which requires a `profileDefinition` — arbitrary food names have none). Same route, same
// underlying `user_dietary_profiles` write, per the map's "same confirm-card path" call.
const foodPreferenceBody = z.object({
  foodPreference: z.object({
    foodName: z.string().min(1).max(40),
    strength: z.enum(["prefer", "avoid"]),
    confirmed: z.boolean(),
  }),
}).strict();
const putBodySchema = z.union([profileConfirmationBody, foodPreferenceBody]);

/**
 * Every item decision the stored row already holds, with this request's on top: a facet the
 * request does not name keeps its stored confirmed/declined state (one tap per request never
 * un-confirms an earlier tap), and a facet it does name takes the request's answer.
 */
function mergedConfirmations(
  stored: ProfileInstance | null, incoming: readonly RuleItemConfirmation[],
): RuleItemConfirmation[] {
  const byFacet = new Map<string, RuleItemConfirmation>();
  for (const rule of stored?.rules ?? []) {
    if (rule.confirmation === "unconfirmed") continue;
    byFacet.set(rule.facet, { facet: rule.facet, confirmed: rule.confirmation === "confirmed" });
  }
  for (const confirmation of incoming) byFacet.set(confirmation.facet, confirmation);
  return [...byFacet.values()];
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`profile-instances:get:${userId}`, 60, 60);
    const [instances, legacy] = await Promise.all([
      readAccountProfileInstances(client, userId), legacyBackedProfileIds(client, userId),
    ]);
    return Response.json({
      instances, catalog: offeredCatalogSummaries(), legacyProfileIds: [...legacy],
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Replaces the one matching-facet rule in place, or appends it — never drops a sibling
 *  preference this account already confirmed for a different food. */
function mergedFoodPreferenceRules(existing: readonly RuleItem[], rule: RuleItem): RuleItem[] {
  const withoutThisFood = existing.filter((row) => row.facet !== rule.facet);
  return [...withoutThisFood, rule];
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`profile-instances:put:${userId}`, 20, 60);
    const body = await readJson(req, putBodySchema, MAX_BYTES);
    if ("foodPreference" in body) {
      const { foodName, strength, confirmed } = body.foodPreference;
      const confirmedAt = new Date().toISOString();
      const rule: RuleItem = {
        ...buildFoodPreferenceRule({ foodName, strength, confirmedAt, source: "user_stated" }),
        confirmation: confirmed ? "confirmed" : "declined",
      };
      // Same rev CAS as a profile confirmation: a racing tap for another food is never dropped.
      const instance = await mergeAccountProfileInstance(
        client, userId, FOOD_PREFERENCE_PROFILE_ID, (stored) => ({
          profileId: FOOD_PREFERENCE_PROFILE_ID, source: "user_stated", confirmedAt,
          rules: mergedFoodPreferenceRules(stored?.rules ?? [], rule),
        }));
      return Response.json({ instance });
    }
    const { profileId, confirmations, options = {} } = body;
    const definition = profileDefinition(profileId);
    const summary = profileSummary(profileId);
    // A gated condition pack is not in the offered catalog, so it cannot be saved either (§4).
    if (!definition || !summary || !isOfferedProfile(summary)) {
      throw new HttpError(404, "not_found", "That profile is not in the catalog.");
    }
    const knownFacets = new Set(definition.templates.map((template) => template.facet));
    for (const confirmation of confirmations) {
      if (!knownFacets.has(confirmation.facet)) {
        throw new HttpError(400, "unknown_facet",
          `"${confirmation.facet}" is not one of ${profileId}'s rule items.`);
      }
    }
    const offered = new Map(summary.options.map((option) => [option.id, option.default]));
    for (const id of Object.keys(options)) {
      if (!offered.has(id)) {
        throw new HttpError(400, "unknown_option", `"${id}" is not one of ${profileId}'s options.`);
      }
    }
    const confirmedAt = new Date().toISOString();
    const instance = await mergeAccountProfileInstance(client, userId, profileId, (stored) => {
      const built = buildProfileInstance(definition, {
        source: "user_stated", confirmedAt, confirmations: mergedConfirmations(stored, confirmations),
        // Catalog defaults, then what the account already chose, then this request's choice.
        options: { ...Object.fromEntries(offered), ...stored?.options, ...options },
      });
      return { profileId: built.profileId, source: built.source, confirmedAt: built.confirmedAt,
        rules: built.rules, options: built.options };
    });
    return Response.json({ instance });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`profile-instances:delete:${userId}`, 20, 60);
    const profileId = new URL(req.url).searchParams.get("profileId");
    if (!profileId) throw new HttpError(400, "bad_request", "profileId is required.");
    // A legacy preference flag re-synthesizes this profile on the next read, so deleting its row
    // would look like a Remove that silently comes back: send the user to the toggle instead.
    if ((await legacyBackedProfileIds(client, userId)).has(profileId)) {
      throw new HttpError(409, "legacy_flag", "Turn this off in your food preferences.");
    }
    await deleteAccountProfileInstance(client, userId, profileId);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
