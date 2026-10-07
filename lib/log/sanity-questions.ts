/**
 * The fixed Jev questions for the log sanity check (purpose `log_sanity`). The payload builder
 * (lib/ai/payloads.ts sanityPayload) chooses among them from typed flags; no caller writes
 * question text (Phase 13 §9 R3).
 */
import { noul, score } from "@/lib/ai/jev-types";

export const NOT_HUMAN_FOOD_QUESTION = noul(
  "Is this item not a food or drink intended for humans to consume?",
  {
    true: "It is pet food, packaging, a non-food object, or a supplement sold only as a dose.",
    false: "It is food, drink, or a food ingredient intended for humans, even if preparation is required.",
  },
);

export const PORTION_LEVEL_QUESTION = score(
  "Judge the semantic plausibility of this already-normalized per-serving amount. Do no arithmetic or unit conversion.",
  [
    "Far too small to be a plausible serving of this food in the stated context.",
    "Small but still a plausible serving of this food in the stated context.",
    "A typical plausible serving of this food in the stated context.",
    "Large but still a plausible serving of this food in the stated context.",
    "Far too large to be a plausible serving of this food in the stated context.",
  ] as const,
);
