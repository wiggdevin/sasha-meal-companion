/**
 * Onboarding v2 — barrel for the facts-flow components.
 */
export { GoalPillRow } from "@/components/Onboarding/facts/GoalPillRow";
export { SexChipRow } from "@/components/Onboarding/facts/SexChipRow";
export { FactQuestion, QUESTION, type FactAnswer } from "@/components/Onboarding/facts/FactQuestion";
export {
  PlaybackSentence, firstMissingField, firstUnconfirmedField, hasAnyHighConfidence, REQUIRED_FACT_ORDER,
  type PlaybackSentenceProps,
} from "@/components/Onboarding/facts/PlaybackSentence";
export {
  heightImperial, weightImperial, ageFromBirthYear, birthYearFromAge,
} from "@/components/Onboarding/facts/unit-echo";
export * from "@/components/Onboarding/facts/types";
