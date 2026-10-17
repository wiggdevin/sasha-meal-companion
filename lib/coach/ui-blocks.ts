import { isFoodKey } from "@/lib/meals/food-key";
import { z } from "zod";
import type {
  SanityAnnotation, SanityWarning, TypicalServing,
} from "@/lib/log/sanity-types";
import { HARD_BASES, RULE_STRENGTHS } from "@/lib/policy/profiles/types";
import { provenanceSchema } from "@/lib/provenance";
import { DAILY_MOVEMENTS } from "@/lib/profile/activity-infer";
import { validateRate } from "@/lib/profile/rate-goal";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

export const sanityWarningSchema: z.ZodType<SanityWarning> = z.object({
  itemId: z.string().min(1).max(160),
  kind: z.enum(["not_food", "portion"]),
  level: z.enum([
    "tiny", "implausible", "not_food", "far_too_small", "small", "typical", "large",
    "far_too_large",
  ]),
  message: z.string().min(1).max(240),
  suggestedGrams: z.number().positive().max(5000).optional(),
});

export const sanityAnnotationSchema: z.ZodType<SanityAnnotation> = z.object({
  status: z.enum(["pending", "ok", "warn", "unknown"]),
  warnings: z.array(sanityWarningSchema).max(4),
});

export const typicalServingSchema: z.ZodType<TypicalServing> = z.object({
  grams: z.number().positive().max(5000),
  label: z.string().min(1).max(160),
});

export type { SanityAnnotation, TypicalServing } from "@/lib/log/sanity-types";

const sanityFields = {
  sanity: sanityAnnotationSchema.optional(),
  typicalServing: typicalServingSchema.optional(),
};

export const policyMarkSchema = z.object({
  facet: z.string().min(1).max(80),
  p: z.number().min(0).max(1).optional(),
  source: z.enum(["floor", "profile", "avoid", "ingredient", "category", "jev"]),
  outcome: z.enum(["present", "absent", "unknown"]),
});
export type PolicyMark = z.infer<typeof policyMarkSchema>;

const allergenFindingSchema = z.object({
  allergen: z.string().min(1).max(80),
  outcome: z.enum(["present", "absent", "unknown"]),
  text: z.string().min(1).max(240),
});

const policyVerdictSchema = z.object({
  verdict: z.enum(["allowed", "blocked", "unverified"]),
  reason: z.string().max(160).optional(),
  marks: z.array(policyMarkSchema).max(40).optional(),
  allergens: z.array(allergenFindingSchema.extend({ checkable: z.boolean() })).max(20).optional(),
});

const portionSchema = z.object({
  id: z.number().int(),
  description: z.string().min(1).max(160),
  gramWeight: z.number().positive(),
  isDefault: z.boolean(),
});

const barcodeMatchSchema = z.object({
  foodRefId: z.string().min(1),
  catalogFoodId: z.number().int().positive(),
  revisionId: z.number().int().positive(),
  description: z.string().min(1).max(240),
  brand: z.string().max(160).nullable(),
  source: z.enum(["fdc_foundation", "fdc_sr_legacy", "fdc_fndds", "fdc_branded", "off"]),
  qualityClass: z.enum(["analytical", "survey", "label", "crowd"]),
  qualityFlags: z.array(z.string().max(80)),
  per100g: z.record(z.string(), z.number().nullable()),
  portions: z.array(portionSchema),
  ingredientsText: z.string().max(10_000).nullable(),
  allergenTags: z.array(z.string().max(80)),
  attribution: z.string().max(240).nullable(),
  policy: policyVerdictSchema,
  ...sanityFields,
});

export const barcodeDraftSchema = z.object({
  status: z.literal("resolved"),
  gtin14: z.string().regex(/^\d{14}$/),
  cached: z.boolean(),
  match: barcodeMatchSchema,
  provenance: provenanceSchema.optional(),
});
export type ResolvedBarcodeDraft = z.infer<typeof barcodeDraftSchema>;

/** A food's macro-group advice (lib/coach/role-advice.ts): coach add actions and capture drafts. */
export const roleAdviceSchema = z.object({
  foodRefId: z.uuid(),
  suggestedRole: z.enum([
    "protein_anchor", "carb_source", "fat_source", "produce_or_free", "mixed_dish",
  ]),
  // Older saved coach actions have no display fields; keep their replay readable.
  proposedRole: z.enum(["protein", "carb", "fat"]).nullable().optional(),
  currentRole: z.enum(["protein", "carb", "fat"]).nullable().optional(),
  reason: z.string().min(1).max(240).optional(),
  confidence: z.number().min(0).max(1),
  requiresConfirmation: z.boolean(),
}).optional();

const draftItemSchema = z.object({
  seq: z.number().int().min(0),
  label: z.string().min(1).max(160),
  foodRefId: z.string().min(1).nullable(),
  catalogFoodRevisionId: z.number().int().positive().nullable(),
  grams: z.number().min(0).max(5000),
  qty: z.number().min(0).max(5000), // gram- and ml-denominated quantities (120 g) are ordinary; matches grams
  unit: z.string().min(1).max(32),
  portionId: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  policy: policyVerdictSchema,
  alternatives: z.array(z.object({
    foodRefId: z.string().min(1),
    catalogFoodRevisionId: z.number().int().positive().optional(),
    label: z.string().min(1).max(160),
    score: z.number(),
  })).max(3),
  autoResolved: z.boolean(),
  /** A new food's macro-group advice from /api/log/propose (task t2c); never persisted here. */
  roleAdvice: roleAdviceSchema,
  ...sanityFields,
});

export const proposeDraftSchema = z.object({
  draftId: z.string().min(1),
  method: z.enum(["text", "voice", "label", "photo"]),
  items: z.array(draftItemSchema).max(20),
  labelFood: z.object({
    name: z.string().min(1).max(160),
    brand: z.string().max(120).optional(),
    per100g: z.record(z.string(), z.number().nullable()),
    ingredientsText: z.string().max(4000).optional(),
    allergenTags: z.array(z.string().max(80)),
    allergenWarnings: z.array(allergenFindingSchema).max(20).optional(),
  }).optional(),
  notes: z.array(z.string().max(200)).max(10),
  spend: z.object({ usedToday: z.number().int().min(0), softCap: z.number().int().min(0) }),
  timings: z.object({ model: z.number().min(0), ground: z.number().min(0) }).optional(),
  provenance: provenanceSchema.optional(),
});

/** The two native drafts already consumed by the barcode and capture confirm editors. */
export const captureDraftSchema = z.union([barcodeDraftSchema, proposeDraftSchema]);
export type CaptureDraft = z.infer<typeof captureDraftSchema>;

export const logDraftBlockV1Schema = z.object({
  kind: z.literal("log_draft"),
  v: z.literal(1),
  id: z.string().min(1),
  source: z.enum(["barcode", "capture"]),
  method: z.enum(["photo", "label"]).optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.string().min(1).max(64).optional(),
  draft: captureDraftSchema,
  policy: z.object({
    blocked: z.boolean(),
    reason: z.string().max(160).optional(),
    blockedItemIds: z.array(z.string().min(1)).optional(),
  }),
  status: z.enum(["pending", "committed", "dismissed"]),
  entryIds: z.array(z.string().min(1)).optional(),
  /** Set when a transcript is read (lib/coach/message-view.ts), never trusted from storage. */
  provenance: provenanceSchema.optional(),
});

export const chartBlockV1Schema = z.object({
  kind: z.literal("chart"),
  v: z.literal(1),
  id: z.string().min(1),
  chart: z.enum(["weight_trend", "macros_today", "kcal_week"]),
  days: z.number().int().positive().optional(),
  series: z.array(z.object({
    label: z.string().min(1).max(80),
    points: z.array(z.object({ x: z.string().max(80), y: z.number() })),
  })),
  unit: z.string().max(32),
  caption: z.string().max(240),
  /**
   * `macros_today` only: the day holds a partly measured recipe serving, or its partial check could
   * not run (#21). "Consumed" is then a lower bound and what is left an upper bound ("at most").
   * Set by the server hydrator (lib/coach/blocks/hydrate-chart.ts), never by the model; absent
   * when the day is whole.
   */
  partial: z.boolean().optional(),
});

export const quickRepliesBlockV1Schema = z.object({
  kind: z.literal("quick_replies"),
  v: z.literal(1),
  id: z.string().min(1),
  options: z.array(z.string().trim().min(1).max(40)).min(2).max(4),
  /** Set when a transcript is read (lib/coach/message-view.ts), never trusted from storage. */
  provenance: provenanceSchema.optional(),
});

export const foodSearchBlockV1Schema = z.object({
  kind: z.literal("food_search"),
  v: z.literal(1),
  id: z.string().min(1),
  query: z.string().min(1).max(160),
  intent: z.enum(["log", "eats", "avoid"]),
  results: z.array(z.object({
    foodRefId: z.string().min(1),
    revisionId: z.string().min(1),
    name: z.string().min(1).max(160),
    kcalPer100g: z.number().optional(),
    status: z.enum(["eats", "avoid", "neutral"]),
    blocked: z.boolean().optional(),
  })),
  truncated: z.boolean(),
});

export const composedMealSchema = z.object({
  wish: z.string(),
  slot: z.string().nullable(),
  items: z.array(z.object({
    name: z.string(),
    foodRefId: z.string(),
    catalogFoodRevisionId: z.number().int().nullable(),
    grams: z.number(),
    kcalPer100g: z.number().nullable(),
    proteinPer100g: z.number().nullable(),
    carbsPer100g: z.number().nullable(),
    fatPer100g: z.number().nullable(),
    macros: z.object({ kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number() }),
    verdict: z.enum(["allowed", "blocked", "unverified"]),
    insteadOf: z.string().optional(),
    addedFor: z.enum(["fat", "carbs"]).optional(),
    // Phase 18 W6: the food's wire key for signal events. A malformed one is dropped, never fatal.
    foodKey: z.string().refine(isFoodKey).optional().catch(undefined),
  })),
  totals: z.object({ kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number() }),
  target: z.object({ kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number() }),
  flagged: z.array(z.string()),
  fitsTarget: z.boolean(),
  fitNote: z.string().nullable().optional(),
  // Phase 18 W9 (D12): an incoherent named combination's reason. The card shows it instead of a
  // fit line (fitNote stays null); a malformed shape never carries, it just drops the field.
  incomplete: z.object({ reason: z.string() }).optional(),
  // OD26: foods the user named that the meal does not hold. A malformed shape just drops the field.
  leftOut: z.array(z.object({ term: z.string(), why: z.enum(["over_limit", "not_found"]) })).optional().catch(undefined),
  rankNote: z.string().nullable().optional(),
  shortfallNote: z.string().nullable().optional(),
  anchorProtein: z.string().optional(),
  allItemsOnEats: z.boolean().optional(),
  pendingSlots: z.array(z.object({ slot: z.string(), label: z.string() })).optional(),
  provenance: provenanceSchema.optional(),
});

export const foodIdeasBlockV1Schema = z.object({
  kind: z.literal("food_ideas"),
  v: z.literal(1),
  id: z.string().min(1),
  ideas: z.array(composedMealSchema),
});

const recipeNutrientSchema = z.object({
  value: z.number().finite().nonnegative().nullable(),
  status: z.enum(["known", "estimated", "unknown"]),
  sourceRevisionId: z.number().int().positive().nullable(),
  sourceKey: z.string().nullable().optional(),
}).refine((value) => value.status === "unknown" ? value.value === null : value.value !== null);
const recipeNutritionSchema = z.record(z.string(), recipeNutrientSchema).refine((values) =>
  ["kcal", "protein", "carbs", "fat"].every((key) => values[key] !== undefined));
const recipeCandidateSchema: z.ZodType<RecipeCandidate> = z.object({
  sourceKind: z.literal("shared"), recipeId: z.string().min(1), revisionId: z.string().min(1),
  publicationState: z.enum(["draft", "published", "withdrawn", "superseded"]),
  withdrawalReason: z.string().nullable(), name: z.string().min(1), cuisine: z.string().nullable(),
  dishTags: z.array(z.string()), activeMinutes: z.number().finite().nonnegative().nullable(),
  totalMinutes: z.number().finite().nonnegative().nullable(), effort: z.enum(["none", "minimal", "standard"]),
  servings: z.number().finite().positive(), yieldGrams: z.number().finite().positive().nullable(),
  yieldStatus: z.enum(["known", "estimated", "unknown"]),
  minServingFraction: z.number().finite().positive(), maxServingFraction: z.number().finite().positive(),
  ingredients: z.array(z.object({
    seq: z.number().int().nonnegative(), name: z.string().min(1), foodRefId: z.string().nullable(),
    catalogFoodRevisionId: z.number().int().positive().nullable(), foodDbId: z.string().nullable().optional(),
    quantity: z.number().finite().positive(), unit: z.string().min(1), grams: z.number().finite().nonnegative().nullable(),
    state: z.enum(["raw", "cooked", "as_purchased"]), required: z.boolean(),
    purchaseGrams: z.number().finite().nonnegative().nullable(),
    purchaseConversionStatus: z.enum(["known", "estimated", "unknown"]),
    nutrition: recipeNutritionSchema,
    allergenEvidence: z.record(z.string(), z.enum(["present", "absent", "unknown"])),
  })).max(100),
  steps: z.array(z.object({ seq: z.number().int().nonnegative(), text: z.string().min(1) })).max(100),
  nutritionPerServing: recipeNutritionSchema,
  source: z.object({ author: z.string().min(1), sourceUrl: z.string().nullable(),
    rightsKind: z.enum(["original", "licensed", "link_only"]), rightsRecord: z.string().min(1),
    sourceRevision: z.string().min(1), kitchenTested: z.boolean() }),
  eligibility: z.object({ status: z.enum(["eligible", "blocked", "unknown"]),
    reasons: z.array(z.object({ code: z.string(), message: z.string(), ingredientSeq: z.number().int().optional() })) }),
}).refine((recipe) => recipe.minServingFraction <= recipe.maxServingFraction);

export const recipeResultsBlockV1Schema = z.object({
  kind: z.literal("recipe_results"), v: z.literal(1), id: z.string().min(1),
  recipes: z.array(z.unknown()).max(3).transform((rows) => rows.flatMap((row) => {
    const result = recipeCandidateSchema.safeParse(row);
    return result.success ? [result.data] : [];
  })).catch([]),
  limitations: z.array(z.string().max(240)).max(5).catch(["Some saved recipe details could not be restored."]),
  /**
   * False when no recipe carries every word of the wish: the cards are the closest recipes ("No
   * exact match"). Optional: absent on blocks saved before O4a and from a server that does not send it.
   */
  exactMatch: z.boolean().optional().catch(undefined),
});

/**
 * Generative UI (design system slice 3, 2026-09-22): the coach may emit a small tree of typed
 * nodes, and components/coach/blocks/ui.tsx draws it with the primitives in components/ui. Every
 * node is strict: no style, class, colour or HTML can pass. A card nests at most three deep.
 */
const uiText = z.object({
  type: z.literal("text"),
  variant: z.enum(["body", "caption", "eyebrow"]).default("body"),
  text: z.string().min(1).max(400),
}).strict();
const uiMetricRow = z.object({
  type: z.literal("metric_row"),
  items: z.array(z.object({
    label: z.string().min(1).max(40), value: z.string().min(1).max(40),
    delta: z.string().max(16).optional(),
  }).strict()).min(1).max(4),
}).strict();
const uiFoodItem = z.object({
  type: z.literal("food_item"),
  name: z.string().min(1).max(160), detail: z.string().max(240).optional(),
  grams: z.number().positive().max(5000).optional(),
}).strict();
const uiList = z.object({
  type: z.literal("list"),
  rows: z.array(z.object({
    title: z.string().min(1).max(160), meta: z.string().max(160).optional(),
    trailing: z.string().max(40).optional(),
  }).strict()).min(1).max(12),
}).strict();
const uiButtonGroup = z.object({
  type: z.literal("button_group"),
  actions: z.array(z.object({
    id: z.string().min(1).max(40), label: z.string().min(1).max(40),
    variant: z.enum(["primary", "outline", "quiet"]).default("outline"),
  }).strict()).min(1).max(3),
}).strict();
const uiLeaf = z.discriminatedUnion("type", [uiText, uiMetricRow, uiFoodItem, uiList, uiButtonGroup]);
const uiCard = (children: z.ZodTypeAny) => z.object({
  type: z.literal("card"),
  title: z.string().max(80).optional(),
  children: z.array(children).max(12),
}).strict();
const uiLevel3 = z.union([uiLeaf, uiCard(uiLeaf)]);
const uiLevel2 = z.union([uiLeaf, uiCard(uiLevel3)]);
export const uiNodeSchema = z.union([uiLeaf, uiCard(uiLevel2)]);
export type UiNode = z.infer<typeof uiNodeSchema>;
export type UiCardNode = Extract<UiNode, { type: "card" }>;

export const uiBlockV1Schema = z.object({
  kind: z.literal("ui"),
  v: z.literal(1),
  id: z.string().min(1),
  root: uiNodeSchema,
}).strict();

/**
 * Phase 13 slice 4 (§4, §9 R5): a stated-need proposal, never an applied change. `items` is the
 * exact, bounded set of facets the confirm card may tap `{facet, confirmed}` for — the same shape
 * app/api/profile/instances/route.ts validates against the catalog server-side, so a stale or
 * hand-edited client can propose nothing this block did not itself carry.
 */
export const dietaryProfileProposalBlockV1Schema = z.object({
  kind: z.literal("dietary_profile_proposal"),
  v: z.literal(1),
  id: z.string().min(1),
  profileId: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  do: z.array(z.string().max(240)).max(6),
  dont: z.array(z.string().max(240)).max(6),
  /** Item-level profile: each hard rule is confirmed on its own (catalog-summary needsOwnConfirmation). */
  requiresUserConfirmation: z.boolean(),
  items: z.array(z.object({
    facet: z.string().min(1).max(160),
    strength: z.enum(RULE_STRENGTHS),
    hardBasis: z.enum(HARD_BASES).nullable(),
  })).min(1).max(20),
}).strict();

/**
 * Phase 13 slice 7 (§6 "next best action", rev 2 retained): one deterministic chip under the
 * reply, naming the single next thing worth doing (lib/coach/next-action.ts). `action` is one of
 * the fixed NEXT_ACTION_KINDS — never free text — so a stale or hand-edited client can propose
 * nothing this module did not itself rank.
 */
export const nextActionChipBlockV1Schema = z.object({
  kind: z.literal("next_action_chip"),
  v: z.literal(1),
  id: z.string().min(1),
  action: z.enum(["log_meal", "confirm_rule", "check_label", "pick_suggestion"]),
  label: z.string().min(1).max(60),
  /** Set when a transcript is read (lib/coach/message-view.ts), never trusted from storage. */
  provenance: provenanceSchema.optional(),
}).strict();

export const uiBlockSchema = z.discriminatedUnion("kind", [
  uiBlockV1Schema,
  logDraftBlockV1Schema,
  chartBlockV1Schema,
  quickRepliesBlockV1Schema,
  foodSearchBlockV1Schema,
  foodIdeasBlockV1Schema,
  recipeResultsBlockV1Schema,
  dietaryProfileProposalBlockV1Schema,
  nextActionChipBlockV1Schema,
]);

export type LogDraftBlockV1 = z.infer<typeof logDraftBlockV1Schema>;
export type ChartBlockV1 = z.infer<typeof chartBlockV1Schema>;
export type QuickRepliesBlockV1 = z.infer<typeof quickRepliesBlockV1Schema>;
export type FoodSearchBlockV1 = z.infer<typeof foodSearchBlockV1Schema>;
export type FoodIdeasBlockV1 = z.infer<typeof foodIdeasBlockV1Schema>;
export type RecipeResultsBlockV1 = z.infer<typeof recipeResultsBlockV1Schema>;
export type UiBlockV1 = z.infer<typeof uiBlockV1Schema>;
export type DietaryProfileProposalBlockV1 = z.infer<typeof dietaryProfileProposalBlockV1Schema>;
export type NextActionChipBlockV1 = z.infer<typeof nextActionChipBlockV1Schema>;
export type UiBlock = z.infer<typeof uiBlockSchema>;

// ---- Onboarding v2 (BRIEF.md §5) — OnboardingFacts, additive ---------------------------------
//
// Not a UiBlock: nothing here renders as a coach card. This is the one shape both the local
// banded-regex fast path (lib/coach/onboarding-fast-path.ts) and the one bounded model
// extraction call (lib/server/coach-turn's onboarding hookup) fill in, partially or fully, so the
// playback-sentence renderer (components/coach/blocks/, Lane 3) reads a single typed shape
// regardless of which path answered. `confidence` carries a 0-1 score for every field the
// extractor touched, keyed by field name, so a field present with no confidence entry is a bug,
// not a silent "trust it" (BRIEF.md §5, confidence banding).
//
// Allergy/condition/medical text never has a place in this schema on purpose — the opener this
// feeds (goal, sex, birth year, height, weight, activity, diet flags, cooking effort) is the one
// the local W5b-style filter (lib/coach/onboarding-safety.ts) clears before either path runs; the
// allergy/condition card is a separate, tap-only UI with no model call at all (BRIEF.md §2/§3).

/** The non-"confidence" keys of `OnboardingFacts`, in extraction order. */
export const ONBOARDING_FACT_KEYS = [
  "goal", "sex", "birthYear", "heightCm", "weightKg", "activity", "dietFlags", "cookingEffort",
] as const;
export type OnboardingFactKey = (typeof ONBOARDING_FACT_KEYS)[number];

/**
 * Onboarding v2 G4 (question set §1a–§1b): the plan answers. Filled by a chip tap or by the
 * regex fast path (lib/coach/onboarding-fast-path-plan.ts) only — never by the model, whose
 * schema below leaves them out. `goalRateBpWeek` is the engine's preset for the chip the user
 * tapped (lib/profile/pace.ts, after the cap); `requestedPaceLbPerWeek` is a pace as spoken, for
 * `chipForRequestedPace`, never stored. `targetWeightKg` is a draft value for the estimate date
 * and is never stored. `firstMealTime` is 24-hour "HH:MM" (`shiftForFirstMeal`, lib/plan.ts).
 */
export const ONBOARDING_PLAN_FACT_KEYS = [
  "goalRateBpWeek", "requestedPaceLbPerWeek", "targetWeightKg", "trainingWeekdays",
  "dailyMovement", "mealsPerDay", "firstMealTime",
] as const;
export type OnboardingPlanFactKey = (typeof ONBOARDING_PLAN_FACT_KEYS)[number];
/** Every answer key a confidence entry may name. */
export const ONBOARDING_ANSWER_KEYS = [...ONBOARDING_FACT_KEYS, ...ONBOARDING_PLAN_FACT_KEYS] as const;
export type OnboardingAnswerKey = (typeof ONBOARDING_ANSWER_KEYS)[number];
export const ONBOARDING_DAILY_MOVEMENTS = DAILY_MOVEMENTS;
const RATE_PRESETS = [-75, -50, -25, 10, 20, 25] as const;

export const ONBOARDING_GOALS = ["lose_fat", "recomp", "maintain", "gain_muscle"] as const;
export const ONBOARDING_ACTIVITIES = [
  "sedentary", "light", "moderate", "active", "very_active",
] as const;
export const ONBOARDING_COOKING_EFFORTS = ["none", "minimal", "full"] as const;

/** 0-1, one entry per field the extractor actually set a value (or a dropped-field band) for.
 *  `partialRecord`, not `record`: a fresh draft, or one where only a few fields were ever
 *  touched, must not be forced to carry every key. */
const onboardingConfidenceSchema = z.partialRecord(
  z.enum(ONBOARDING_ANSWER_KEYS),
  z.number().min(0).max(1),
);

/**
 * BRIEF.md §5's `OnboardingFacts`. Every field is optional on its own (a partial read is still a
 * valid value — the gap-fill step asks only for what is still missing); `confidence` is required,
 * and may be `{}` for a fresh, nothing-yet-extracted draft.
 */
const onboardingFactsShape = z.object({
  goal: z.enum(ONBOARDING_GOALS).optional(),
  sex: z.enum(["male", "female", "unspecified"]).optional(),
  birthYear: z.number().int().min(1900).max(new Date().getUTCFullYear()).optional(),
  heightCm: z.number().positive().max(260).optional(),
  weightKg: z.number().positive().max(400).optional(),
  activity: z.enum(ONBOARDING_ACTIVITIES).optional(),
  /** Non-medical only (W5b already cleared whatever text this came from); free labels, not an
   *  enum — the existing PreferenceClassifier flag set stays the source of truth for Settings. */
  dietFlags: z.array(z.string().min(1).max(40)).max(12).optional(),
  cookingEffort: z.enum(ONBOARDING_COOKING_EFFORTS).optional(),
  goalRateBpWeek: z.number().int().refine((bp) => (RATE_PRESETS as readonly number[]).includes(bp),
    "goalRateBpWeek must be one of the engine's presets").optional(),
  requestedPaceLbPerWeek: z.number().positive().max(5).optional(),
  targetWeightKg: z.number().min(20).max(400).optional(),
  trainingWeekdays: z.array(z.number().int().min(0).max(6)).max(7)
    .refine((days) => new Set(days).size === days.length, "weekdays must not repeat").optional(),
  dailyMovement: z.enum(DAILY_MOVEMENTS).optional(),
  mealsPerDay: z.number().int().min(2).max(6).optional(),
  firstMealTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  confidence: onboardingConfidenceSchema,
}).strict();

/** Sol r1 WARN: the shape alone let a fact through with no matching confidence entry, despite
 *  the doc comment's claim. Enforced for real here: every key this value SETS must have a
 *  confidence score, `dietFlags` included (one score for the whole list, same as every other
 *  field) — a value with a fact and no confidence for it is rejected, not silently accepted. */
export const onboardingFactsSchema = onboardingFactsShape.superRefine((value, ctx) => {
  // A preset must also match the goal's direction when both are known.
  if (value.goal !== undefined && value.goalRateBpWeek !== undefined
    && !validateRate(value.goal, value.goalRateBpWeek)) {
    ctx.addIssue({ code: "custom", path: ["goalRateBpWeek"],
      message: "goalRateBpWeek is not a preset for the goal" });
  }
  for (const key of ONBOARDING_ANSWER_KEYS) {
    if (value[key] !== undefined && value.confidence[key] === undefined) {
      ctx.addIssue({
        code: "custom", path: ["confidence", key],
        message: `'${key}' is set but has no matching confidence entry`,
      });
    }
  }
});

export type OnboardingFacts = z.infer<typeof onboardingFactsSchema>;

/** BRIEF.md §5's three-way confidence band. `undefined` (the field was never set) is "none". */
export type OnboardingConfidenceBand = "high" | "ghost" | "dropped" | "none";

/** ≥0.85 auto-confirms in the playback sentence; ≤0.50 is dropped and asked plainly; the open
 *  middle band renders as a ghost chip that needs one tap. Shared by both extraction paths so a
 *  banding change can never drift between the regex and the model fallback. */
export function onboardingConfidenceBand(score: number | undefined): OnboardingConfidenceBand {
  // A non-finite score (NaN, +/-Infinity) is not a real confidence value: it must read as
  // "none" (absent), the same as never having a score at all, rather than falling through every
  // numeric comparison below (all false for NaN) into the open "ghost" middle band.
  if (score === undefined || !Number.isFinite(score)) return "none";
  if (score >= 0.85) return "high";
  if (score <= 0.5) return "dropped";
  return "ghost";
}

/**
 * Standing privacy rule (tests/ai/no-demographics-payload.test.ts, coordinator ruling): no AI
 * payload carries a demographic field. `sex` and `birthYear` are the two `OnboardingFacts`
 * fields that are, so the one bounded model call (lib/server/onboarding-extract.ts) is typed
 * and validated against this NARROWER schema instead of the full one above — a model reply that
 * tried to set either of those two keys is rejected outright (`.strict()`), not merely
 * undocumented. `heightCm`/`weightKg` are excluded too, by the same ruling, though they are not
 * demographic fields the privacy test itself guards: the account's own regex reader already
 * covers both reliably, so the model call's surface stays at exactly goal/activity/cookingEffort/
 * dietFlags. `sex` and `birthYear` are filled ONLY by lib/coach/onboarding-fast-path.ts.
 */
export const ONBOARDING_MODEL_FACT_KEYS = ["goal", "activity", "cookingEffort", "dietFlags"] as const;
export type OnboardingModelFactKey = (typeof ONBOARDING_MODEL_FACT_KEYS)[number];

const onboardingModelConfidenceSchema = z.partialRecord(
  z.enum(ONBOARDING_MODEL_FACT_KEYS),
  z.number().min(0).max(1),
);

const onboardingModelFactsShape = z.object({
  goal: z.enum(ONBOARDING_GOALS).optional(),
  activity: z.enum(ONBOARDING_ACTIVITIES).optional(),
  cookingEffort: z.enum(ONBOARDING_COOKING_EFFORTS).optional(),
  dietFlags: z.array(z.string().min(1).max(40)).max(12).optional(),
  confidence: onboardingModelConfidenceSchema,
}).strict();

export const onboardingModelFactsSchema = onboardingModelFactsShape.superRefine((value, ctx) => {
  for (const key of ONBOARDING_MODEL_FACT_KEYS) {
    if (value[key] !== undefined && value.confidence[key] === undefined) {
      ctx.addIssue({
        code: "custom", path: ["confidence", key],
        message: `'${key}' is set but has no matching confidence entry`,
      });
    }
  }
});

export type OnboardingModelFacts = z.infer<typeof onboardingModelFactsSchema>;

/**
 * The schema the PROVIDER is sent for the model extraction (`providerSchema`, lib/ai/adapter.ts).
 * `confidence` is a partial record in the parse schema above, which converts to an open map
 * (`additionalProperties: <number>`) that Gemini's structured output cannot express —
 * lib/ai/json-schema.ts refuses it, so every Gemini attempt failed before it was sent. Here the
 * same keys are listed one by one, each optional, under a strict object. The reply is still
 * parsed with `onboardingModelFactsSchema`.
 */
export const onboardingModelFactsProviderSchema = onboardingModelFactsShape.extend({
  confidence: z.object(Object.fromEntries(ONBOARDING_MODEL_FACT_KEYS.map((key) =>
    [key, z.number().min(0).max(1).optional()])) as Record<OnboardingModelFactKey,
    z.ZodOptional<z.ZodNumber>>).strict(),
}).strict();
