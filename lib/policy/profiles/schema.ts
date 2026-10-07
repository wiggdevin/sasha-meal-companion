/**
 * Phase 13 §9 R5: build-time JSON schema validation for
 * docs/research/dietary-profiles.draft.json, "every profile reference resolving" — every facet,
 * citation and cross-profile reference the JSON uses must resolve inside it, before any profile
 * imports (lib/policy/profiles/loader.ts refuses to import from an invalid document). Pure: no
 * I/O, takes already-parsed JSON.
 */
import { z } from "zod";
import { FACETS, NEW_FACETS, isTemplateFacet } from "@/lib/foods/facet-vocabulary";
import { EVIDENCE_STRENGTHS, HARD_BASES } from "@/lib/policy/profiles/types";

const CATEGORIES = [
  "allergy_intolerance", "religious_cultural", "ethical_lifestyle", "medical_condition",
  "medication_interaction", "life_stage", "goal", "clinician_directive", "texture_swallowing",
  "preference_aversion",
] as const;

const citationSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  url: z.string().min(1),
});

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Usually boolean; a few profiles (kosher wait hours, "ask") use a string or number default. */
  default: z.union([z.boolean(), z.string(), z.number()]),
  effect: z.string().optional(),
}).passthrough();

const flexExceptionSchema = z.object({
  facet: z.string().min(1),
  strength: z.string().min(1),
}).passthrough();

const flexModelSchema = z.object({
  base: z.object({ facet: z.string().min(1) }).passthrough().optional(),
  exceptions: z.array(flexExceptionSchema).optional(),
}).passthrough().nullable();

const profileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: z.enum(CATEGORIES),
  synonyms: z.array(z.string()),
  hard_avoid_facets: z.array(z.string()),
  soft_limit_facets: z.array(z.string()),
  prefer_facets: z.array(z.string()),
  target_modifiers: z.record(z.string(), z.unknown()),
  requires_user_confirmation: z.boolean(),
  clinician_note: z.boolean(),
  evidence: z.object({ strength: z.enum(EVIDENCE_STRENGTHS), note: z.string().nullable() }),
  citations: z.array(citationSchema),
  hard_basis: z.enum(HARD_BASES).nullable(),
  do: z.array(z.string()),
  dont: z.array(z.string()),
  jev_design: z.string(),
  options: z.array(optionSchema),
  time_window: z.record(z.string(), z.unknown()).nullable(),
  flex_model: flexModelSchema,
  conflicts: z.array(z.string()),
  existing_facets_used: z.array(z.string()),
  new_facets_needed: z.array(z.string()),
});

const newFacetSchema = z.object({
  id: z.string().min(1),
  primitive: z.enum(["noul", "score", "choice"]),
  jev_question: z.string().min(1),
  value: z.number(),
}).passthrough();

export const dietaryProfilesDocumentSchema = z.object({
  version: z.string(),
  date: z.string(),
  profiles: z.array(profileSchema),
  new_facets: z.array(newFacetSchema),
  sources: z.record(z.string(), z.object({ ref: z.string(), url: z.string() })),
  ambiguous_phrases: z.record(z.string(), z.unknown()),
  existing_facet_fixes: z.array(z.object({ facet: z.string(), fix: z.string(), value: z.number() })),
});

export type DietaryProfilesDocument = z.infer<typeof dietaryProfilesDocumentSchema>;
export type RawProfile = z.infer<typeof profileSchema>;

export type ValidationIssue = { path: string; message: string };
export type ValidationResult =
  | { valid: true; data: DietaryProfilesDocument }
  | { valid: false; issues: readonly ValidationIssue[] };

/** A profile id string may carry a parenthetical annotation ("keto (if on SGLT2i)"); the id is
 *  only the text before it. */
function baseProfileId(ref: string): string {
  const at = ref.indexOf(" (");
  return at < 0 ? ref : ref.slice(0, at);
}

function knownFacet(facet: string, newFacetIds: ReadonlySet<string>): boolean {
  return (FACETS as readonly string[]).includes(facet)
    || newFacetIds.has(facet)
    || (NEW_FACETS as readonly string[]).includes(facet)
    || isTemplateFacet(facet);
}

/**
 * Validates shape (zod) then resolves every cross-reference the document makes: a profile's
 * facet lists, its `conflicts`, `ambiguous_phrases[].activate_until_clarified`, and
 * `existing_facet_fixes[].facet` all resolve; every citation id resolves in `sources`. Returns
 * every issue found, not just the first — the caller (loader.ts, and its build-time test) can
 * refuse the whole document on any one.
 */
export function validateDietaryProfilesDocument(raw: unknown): ValidationResult {
  const parsed = dietaryProfilesDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const data = parsed.data;
  const issues: ValidationIssue[] = [];
  const profileIds = new Set(data.profiles.map((p) => p.id));
  const newFacetIds = new Set(data.new_facets.map((f) => f.id));
  const sourceIds = new Set(Object.keys(data.sources));

  for (const [index, profile] of data.profiles.entries()) {
    const at = (suffix: string) => `profiles[${index}:${profile.id}].${suffix}`;
    for (const key of ["hard_avoid_facets", "soft_limit_facets", "prefer_facets",
      "existing_facets_used", "new_facets_needed"] as const) {
      for (const facet of profile[key]) {
        if (key === "existing_facets_used"
          ? !(FACETS as readonly string[]).includes(facet)
          : !knownFacet(facet, newFacetIds)) {
          issues.push({ path: at(key), message: `unresolved facet reference "${facet}"` });
        }
      }
    }
    if (profile.flex_model) {
      const baseFacet = profile.flex_model.base?.facet;
      if (baseFacet !== undefined && !knownFacet(baseFacet, newFacetIds)) {
        issues.push({ path: at("flex_model.base"), message: `unresolved facet reference "${baseFacet}"` });
      }
      for (const [i, exception] of (profile.flex_model.exceptions ?? []).entries()) {
        if (!knownFacet(exception.facet, newFacetIds)) {
          issues.push({
            path: at(`flex_model.exceptions[${i}]`),
            message: `unresolved facet reference "${exception.facet}"`,
          });
        }
      }
    }
    for (const conflict of profile.conflicts) {
      if (!profileIds.has(baseProfileId(conflict))) {
        issues.push({ path: at("conflicts"), message: `unresolved profile reference "${conflict}"` });
      }
    }
    for (const citation of profile.citations) {
      if (!sourceIds.has(citation.id)) {
        issues.push({ path: at("citations"), message: `unresolved source reference "${citation.id}"` });
      }
    }
  }

  for (const [phrase, entry] of Object.entries(data.ambiguous_phrases)) {
    if (phrase === "_rule" || typeof entry !== "object" || entry === null) continue;
    const activate = (entry as { activate_until_clarified?: unknown }).activate_until_clarified;
    if (!Array.isArray(activate)) continue;
    for (const ref of activate) {
      if (typeof ref === "string" && !profileIds.has(baseProfileId(ref))) {
        issues.push({
          path: `ambiguous_phrases["${phrase}"].activate_until_clarified`,
          message: `unresolved profile reference "${ref}"`,
        });
      }
    }
  }

  for (const [index, fix] of data.existing_facet_fixes.entries()) {
    if (!(FACETS as readonly string[]).includes(fix.facet)) {
      issues.push({
        path: `existing_facet_fixes[${index}]`,
        message: `unresolved facet reference "${fix.facet}"`,
      });
    }
  }

  return issues.length > 0 ? { valid: false, issues } : { valid: true, data };
}
