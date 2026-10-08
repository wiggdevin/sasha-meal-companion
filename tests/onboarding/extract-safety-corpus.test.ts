// Onboarding v2 P0 (2026-10-07 live QA): the opener's free text reaches the extraction model only
// past the local safety check. Replays the W5b fixed corpus (tests/fixtures/taste-safety-corpus.ts):
// every symptom sentence and every allergy, condition, clinician or medicine sentence must stay
// local (zero model calls). Diet practices ("I'm vegan", "I keep kosher") are not medical and may
// still be read for diet flags; ordinary opener speech must never be refused.
import { describe, expect, it } from "vitest";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

const CORPUS = [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS];

/** W5b "rules" sentences that name an allergen, condition, procedure, clinician or medicine. */
const MEDICAL_RULE = /allerg|epipen|intoleran|sensitiv|celiac|crohn|ibs|diabet|blood|warfarin|metformin|dietitian|doctor|pregnan|gout|kidney|cholesterol|surgery|reflux|disease|thyroid|asthma|ana?emi/i;

describe("onboarding opener safety gate replays the W5b corpus", () => {
  it("keeps every W5b symptom sentence local", () => {
    const leaked = CORPUS.filter((c) => c.reason === "symptom")
      .filter((c) => !onboardingSafetyCheck(c.text).blocked).map((c) => c.text);
    expect(leaked).toEqual([]);
  });

  it("keeps every W5b allergy, condition, clinician and medicine sentence local", () => {
    const medical = CORPUS.filter((c) => c.reason === "rules" && MEDICAL_RULE.test(c.text));
    expect(medical.length).toBeGreaterThan(15);
    const leaked = medical.filter((c) => !onboardingSafetyCheck(c.text).blocked).map((c) => c.text);
    expect(leaked).toEqual([]);
  });

  it.each([
    "I want to lose fat, I'm 24, female, 5'5 and 150 lb",
    "Born 2001, 165 cm, 68 kg, mostly sitting at a desk job",
    "I lift three times a week and want to build muscle",
    "I'm tired of guessing what to eat",
    "I want more energy for my runs",
    "I don't cook much, quick stuff please",
    "I'm a nurse on night shifts and want to maintain",
    "Gaining weight is the goal, I'm 6 ft 1",
  ])("never refuses ordinary opener speech: %s", (text) => {
    expect(onboardingSafetyCheck(text)).toEqual({ blocked: false });
  });
});
