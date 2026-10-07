import "server-only";

import { sanityPayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import {
  FACET_THRESHOLDS,
  NOT_HUMAN_FOOD_THRESHOLDS,
  PORTION_LEVEL_THRESHOLDS,
  type ProbabilityBand,
} from "@/lib/foods/facet-thresholds";
import type { FacetCacheKey } from "@/lib/foods/facets";
import { facetCacheKey, readFacets } from "@/lib/foods/facets";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import { facetState } from "@/lib/foods/facet-questions";
import { deterministicSanity } from "@/lib/log/sanity-deterministic";
import {
  PORTION_LEVELS,
  type PortionLevel,
  type SanityCheckOptions,
  type SanityDraft,
  type SanityResult,
  type SanityWarning,
  type SanityWarningLevel,
} from "@/lib/log/sanity-types";

export {
  PORTION_LEVELS,
  type CheckSanity,
  type DeterministicSanity,
  type PortionLevel,
  type SanityAnnotation,
  type SanityCheckOptions,
  type SanityDraft,
  type SanityResult,
  type SanityStatus,
  type SanityWarning,
  type SanityWarningLevel,
  type TypicalServing,
} from "@/lib/log/sanity-types";
export { deterministicSanity } from "@/lib/log/sanity-deterministic";

/**
 * Runs after a draft renders (or on an explicit check). Callers must never await it on a commit
 * path. Deterministic warnings resolve without I/O; every cache/provider failure becomes unknown.
 */
export async function checkSanity(
  draft: SanityDraft,
  options: SanityCheckOptions = {},
): Promise<SanityResult> {
  const deterministic = deterministicSanity(draft);
  if (deterministic.warnings.length > 0) return deterministic;
  if (options.signal?.aborted) return { sanityStatus: "unknown", warnings: [] };

  try {
    const cachedNotFood = await cachedNotHumanFood(draft.facetKey);
    if (cachedNotFood === "present") return resultWithNotFood(draft.itemId);

    const needsNotFood = cachedNotFood !== "absent";
    const needsPortion = hasAnyAmount(draft.amounts);
    if (!needsNotFood && !needsPortion) return { sanityStatus: "unknown", warnings: [] };

    const answers = await systemOne(sanityPayload(providerState(draft),
      { notHumanFood: needsNotFood, portion: needsPortion }), {
      deadlineMs: 3_000,
      userId: options.userId,
      signal: options.signal,
    });
    if (!answers) return { sanityStatus: "unknown", warnings: [] };

    if (needsNotFood && !validNoulAnswer(answers.not_human_food)) {
      return { sanityStatus: "unknown", warnings: [] };
    }
    if (needsPortion && !validPortionAnswer(answers.portion_level)) {
      return { sanityStatus: "unknown", warnings: [] };
    }

    const notHumanFood = answers.not_human_food;
    if (notHumanFood) {
      const outcome = probabilityOutcome(
        notHumanFood.noul,
        NOT_HUMAN_FOOD_THRESHOLDS.mark,
      );
      if (outcome === "present") return resultWithNotFood(draft.itemId);
      if (outcome === "unknown") return { sanityStatus: "unknown", warnings: [] };
    }

    const portionLevel = answers.portion_level;
    if (portionLevel) {
      const portion = portionResult(draft.itemId, portionLevel.probabilities);
      if (portion) return portion;
      return { sanityStatus: "unknown", warnings: [] };
    }
    return { sanityStatus: "unknown", warnings: [] };
  } catch {
    return { sanityStatus: "unknown", warnings: [] };
  }
}

function providerState(draft: SanityDraft): {
  food: FacetFoodInput;
  amounts: SanityDraft["amounts"];
} {
  return {
    food: facetState(draft.food),
    amounts: {
      gramsPerServing: finite(draft.amounts.gramsPerServing)
        ? draft.amounts.gramsPerServing : null,
      kcalPerServing: finite(draft.amounts.kcalPerServing)
        ? draft.amounts.kcalPerServing : null,
    },
  };
}

async function cachedNotHumanFood(
  key: FacetCacheKey | null | undefined,
): Promise<"present" | "absent" | "unknown"> {
  if (!key) return "unknown";
  const result = await readFacets([key], ["human_food"]);
  const humanFood = result.get(facetCacheKey(key))?.human_food;
  if (!humanFood) return "unknown";
  const humanOutcome = probabilityOutcome(humanFood.p, FACET_THRESHOLDS.human_food.mark);
  if (humanOutcome === "present") return "absent";
  if (humanOutcome === "absent") return "present";
  return "unknown";
}

function portionResult(
  itemId: string,
  probabilities: Record<string, number>,
): SanityResult | null {
  const ranked = PORTION_LEVELS.map((level, index) => ({
    level,
    p: probabilities[String(index)],
  })).filter((entry): entry is { level: PortionLevel; p: number } => finite(entry.p))
    .sort((a, b) => b.p - a.p);
  const selected = ranked[0];
  if (!selected) return null;
  const outcome = probabilityOutcome(
    selected.p,
    PORTION_LEVEL_THRESHOLDS[selected.level].warn,
  );
  if (outcome !== "present") return null;
  if (selected.level === "typical") return { sanityStatus: "ok", warnings: [] };
  return {
    sanityStatus: "warn",
    warnings: [portionWarning(itemId, selected.level, portionMessage(selected.level))],
  };
}

function validNoulAnswer(answer: unknown): answer is { noul: number } {
  return isRecord(answer) && answer.type === "noul" && probability(answer.noul);
}

function validPortionAnswer(
  answer: unknown,
): answer is { probabilities: Record<string, number> } {
  return isRecord(answer)
    && answer.type === "score"
    && validPortionDistribution(answer.probabilities);
}

function validPortionDistribution(value: unknown): value is Record<string, number> {
  if (!isRecord(value) || Object.keys(value).length !== PORTION_LEVELS.length) return false;
  return PORTION_LEVELS.every((_level, index) => probability(value[String(index)]));
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probabilityOutcome(
  probability: number,
  threshold: ProbabilityBand,
): "present" | "absent" | "unknown" {
  if (probability >= threshold.present) return "present";
  if (probability <= threshold.absent) return "absent";
  return "unknown";
}

function resultWithNotFood(itemId: string): SanityResult {
  return {
    sanityStatus: "warn",
    warnings: [{
      itemId,
      kind: "not_food",
      level: "not_food",
      message: "This may not be food or drink intended for people.",
    }],
  };
}

function portionWarning(
  itemId: string,
  level: SanityWarningLevel,
  message: string,
): SanityWarning {
  return { itemId, kind: "portion", level, message };
}

function portionMessage(level: Exclude<PortionLevel, "typical">): string {
  const messages = {
    far_too_small: "This looks far too small for one serving.",
    small: "This looks like a small serving.",
    large: "This looks like a large serving.",
    far_too_large: "This looks far too large for one serving.",
  } as const;
  return messages[level];
}

function hasAnyAmount(amounts: SanityDraft["amounts"]): boolean {
  return finite(amounts.gramsPerServing) || finite(amounts.kcalPerServing);
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
