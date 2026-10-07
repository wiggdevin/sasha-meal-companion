/**
 * Onboarding v2, lane 3 — barrel for the facts-flow components (BRIEF.md §6 lane 3). Keeps
 * lane 2's shell import from this folder as one line, pending the dock-morph integration.
 */
export { GoalPillRow } from "@/components/Onboarding/facts/GoalPillRow";
export { SexChipRow } from "@/components/Onboarding/facts/SexChipRow";
export { BirthYearStepper } from "@/components/Onboarding/facts/BirthYearStepper";
export { SentenceChip } from "@/components/Onboarding/facts/SentenceChip";
export {
  PlaybackSentence, firstMissingField, hasAnyHighConfidence,
  type PlaybackSentenceProps,
} from "@/components/Onboarding/facts/PlaybackSentence";
export { heightEchoCm, weightEchoKg, birthYearEcho } from "@/components/Onboarding/facts/unit-echo";
export * from "@/components/Onboarding/facts/types";
