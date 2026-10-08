// Onboarding v2 G14: the opener's local safety check (lib/coach/onboarding-safety.ts) replayed
// against the W5b keep-local corpus and a U.S. medicine list, before the chat-onboarding flag
// goes back on. A blocked sentence never reaches a model; the tap-only safety card asks instead.
//
// The opener is narrower than the taste check on purpose: a diet practice ("I'm vegan", "I keep
// kosher", "I do keto") and a training phrase ("I'm bulking") stay readable, because the model may
// only suggest diet-hint chips the user confirms. Everything else in the corpus is blocked, and
// the count of readable corpus sentences may only go down (add a pattern, never loosen one).
import { describe, expect, it } from "vitest";
import { namesMedicine, onboardingSafetyCheck, US_MEDICINE_NAMES } from "@/lib/coach/onboarding-safety";
import { PROFILE_SYNONYMS } from "@/lib/coach/profile-synonyms.generated";
import {
  ACCEPTANCE_LOCAL, HEALTH_CORPUS, PLAIN,
} from "@/tests/fixtures/taste-safety-corpus";
import REDTEAM from "@/tests/fixtures/taste-safety-redteam.json";

const MEDICATION_PROFILES = [
  "insulin_or_sulfonylurea", "hypothyroid_levothyroxine", "glp1_medication", "warfarin", "maoi",
  "linezolid", "statin_grapefruit", "immunosuppressant_grapefruit", "lithium",
  "antibiotic_mineral_binding", "bisphosphonate", "ace_arb_spironolactone", "sglt2_inhibitor",
  "disulfiram", "metronidazole",
];

const blocked = (text: string) => onboardingSafetyCheck(text).blocked;

describe("medicine names (G14)", () => {
  it.each([
    "Ozempic", "Wegovy", "Mounjaro", "Zepbound", "semaglutide", "tirzepatide", "liraglutide",
    "Saxenda", "Victoza", "Trulicity", "Rybelsus", "GLP-1", "glp1", "GLP 1",
  ])("blocks %s in an ordinary opener", (name) => {
    expect(onboardingSafetyCheck(`I'm 41, female, 210 lb, on ${name}, want to lose weight`))
      .toEqual({ blocked: true, reason: "medical" });
  });

  it("blocks every brand and generic name of the offered medication profiles", () => {
    const synonyms = PROFILE_SYNONYMS.filter(({ id }) => MEDICATION_PROFILES.includes(id))
      .flatMap(({ synonyms: names }) => names);
    expect(synonyms.length).toBeGreaterThan(60);
    for (const name of synonyms) expect(namesMedicine(`I take ${name} daily`), name).toBe(true);
  });

  it("blocks every name on the U.S. medicine list", () => {
    for (const name of US_MEDICINE_NAMES) expect(blocked(`I've been on ${name} since spring`), name).toBe(true);
  });

  it("matches whole words only", () => {
    expect(namesMedicine("I really like to cook")).toBe(false); // "alli" inside "really"
    expect(namesMedicine("factos")).toBe(false);
    expect(namesMedicine("I want to lose 10 lb")).toBe(false);
  });
});

describe("the W5b keep-local corpus through the opener", () => {
  const corpus = [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS];

  it("blocks every symptom sentence", () => {
    const misses = corpus.filter((c) => c.reason === "symptom" && !blocked(c.text)).map((c) => c.text);
    expect(misses).toEqual([]);
  });

  it.each([
    "I have high blood pressure", "I take blood thinners, so I limit vitamin K foods",
    "my cardiologist told me to cut saturated fat", "my gastroenterologist put me on a low FODMAP diet",
    "I just had bariatric surgery so I eat small portions", "I have a feeding tube",
    "on antibiotics right now, avoiding dairy", "I'm on Accutane so no greasy food",
    "I'm on Lipitor so I avoid grapefruit", "I take Adderall and it kills my appetite",
    "I'm expecting and craving weird combos", "morning sickness means I can barely eat anything",
    "nursing right now so alcohol is out", "trying to conceive so I cut out alcohol",
    "ED recovery, meals are hard", "I binge and then feel guilty", "I purge after big meals",
    "I restrict my eating most days", "T1D here, I count carbs always", "bp has been high so cutting salt",
    "RX diet from my doc, low sodium only", "my dr put me on a special plan", "I have celiacs disease",
    "diarea after eating dairy", "nausious after greasy food", "peanuts send me to the ER",
    "nuts are strictly forbidden for my son", "my toddler has an egg issue",
    "I have a condition that affects what I eat", "I follow a special diet for health reasons",
    "I have a dairy thing", "nuts are an issue for me", "dairy is my kryptonite",
  ])("blocks %s", (text) => {
    expect(blocked(text)).toBe(true);
  });

  it("keeps diet practices and plain taste readable", () => {
    for (const text of ["I'm vegan", "I keep kosher", "I do keto", "I'm bulking", ...PLAIN]) {
      expect(blocked(text), text).toBe(false);
    }
  });

  it("never lets more of the corpus through than it does today (ratchet)", () => {
    const all = [...corpus.map((c) => c.text), ...(REDTEAM as string[])];
    const readable = all.filter((text) => !blocked(text));
    expect(all.length).toBeGreaterThan(600);
    // Measured 2026-10-08 after the G14 patterns; lower it when a pattern lands, never raise it.
    expect(readable.length).toBeLessThanOrEqual(READABLE_CEILING);
  });
});

describe("ordinary openers stay readable", () => {
  it.each([
    "I'm 34, 5'6\", 170 lb, female, want to lose weight",
    "I want to build muscle, I work on my feet all day",
    "I lift Mon, Wed and Fri", "3 meals a day, first one around 7am", "about a pound a week",
    "mostly sitting at a desk job, want to lose fat", "I'm a nurse and on my feet",
    "I play soccer with my kids on weekends", "I run and my legs get sore", "I like to cook",
    "I'm 5 foot 10 and weigh 200 pounds", "I want to gain muscle and eat 5 times a day",
    "I'm vegan and want to lose 20 pounds", "keep my weight, I train 4 days a week",
    "I want to drop 2 pounds a week", "the main thing is I want more energy",
  ])("reads %s", (text) => {
    expect(onboardingSafetyCheck(text)).toEqual({ blocked: false });
  });
});

/** 274 of 647 on 2026-10-08: diet practices, training phrases and food-only taste lines. */
const READABLE_CEILING = 274;
