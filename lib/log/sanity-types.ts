/** Dependency-free sanity contracts shared by server checks and browser-visible draft schemas. */

export const PORTION_LEVELS = [
  "far_too_small",
  "small",
  "typical",
  "large",
  "far_too_large",
] as const;

export type PortionLevel = (typeof PORTION_LEVELS)[number];
export type SanityStatus = "pending" | "ok" | "warn" | "unknown";
export type SanityWarningLevel = "tiny" | "implausible" | "not_food" | PortionLevel;

export type SanityWarning = {
  itemId: string;
  kind: "not_food" | "portion";
  level: SanityWarningLevel;
  message: string;
  suggestedGrams?: number;
};

export type SanityFoodInput = {
  name: string;
  brand?: string | null;
  description?: string | null;
  preparation?: string | null;
  ingredientsText?: string | null;
};

export type SanityFacetKey = { foodKey: string; inputHash: string };

export type SanityDraft = {
  itemId: string;
  food: SanityFoodInput;
  amounts: { gramsPerServing: number | null; kcalPerServing: number | null };
  facetKey?: SanityFacetKey | null;
};

export type SanityResult = {
  sanityStatus: SanityStatus;
  warnings: SanityWarning[];
};

export type SanityCheckOptions = { signal?: AbortSignal; userId?: string };
export type DeterministicSanity = (draft: SanityDraft) => SanityResult;
export type CheckSanity = (
  draft: SanityDraft,
  options?: SanityCheckOptions,
) => Promise<SanityResult>;

export type SanityAnnotation = { status: SanityStatus; warnings: SanityWarning[] };
export type TypicalServing = { grams: number; label: string };
