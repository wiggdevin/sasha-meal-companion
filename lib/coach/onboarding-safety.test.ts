import { describe, expect, it } from "vitest";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";

describe("onboardingSafetyCheck", () => {
  it("blocks a diagnosis/medication question (classifyMedical)", () => {
    expect(onboardingSafetyCheck("am I in remission from my colitis?")).toEqual(
      { blocked: true, reason: "medical" },
    );
    expect(onboardingSafetyCheck("my doctor put me on mesalamine")).toEqual(
      { blocked: true, reason: "medical" },
    );
  });

  it("blocks an allergen or named condition even inside an ordinary body-stat sentence", () => {
    expect(onboardingSafetyCheck("I'm allergic to peanuts, 28, want to build muscle"))
      .toEqual({ blocked: true, reason: "allergy_or_condition" });
    expect(onboardingSafetyCheck("I have Crohn's and I'm 165 lbs"))
      .toEqual({ blocked: true, reason: "allergy_or_condition" });
  });

  it("blocks a symptom even with no condition named", () => {
    expect(onboardingSafetyCheck("I get hives sometimes")).toEqual({ blocked: true, reason: "symptom" });
  });

  // Sol r1 BLOCK 1: these two were misses in an earlier draft.
  it("blocks a named symptom word with no cause-and-effect phrasing (migraines)", () => {
    expect(onboardingSafetyCheck("I have migraines")).toEqual({ blocked: true, reason: "symptom" });
  });

  it("blocks a food-causes-symptom statement by its construction, not a fixed phrase", () => {
    expect(onboardingSafetyCheck("dairy makes my stomach hurt")).toEqual({ blocked: true, reason: "symptom" });
    expect(onboardingSafetyCheck("eggs give me a headache")).toEqual({ blocked: true, reason: "symptom" });
  });

  // Sol r2 BLOCK 1: an anaphylaxis description with no digestive/skin word at all.
  it("blocks an airway/anaphylaxis description, not only digestive or skin symptoms", () => {
    expect(onboardingSafetyCheck("Peanuts make my throat close")).toEqual({ blocked: true, reason: "symptom" });
    expect(onboardingSafetyCheck("shellfish makes my throat tighten up")).toEqual({ blocked: true, reason: "symptom" });
  });

  it("blocks blood-in-stool language too, even classified as the medical pattern first", () => {
    expect(onboardingSafetyCheck("I get rectal bleeding sometimes").blocked).toBe(true);
  });

  // Final Sol review BLOCK: an over-the-counter medicine, or a medicine said without its name.
  it.each([
    "I take aspirin daily and want to lose weight",
    "I take ibuprofen most days, 5'9 180 lb",
    "on lisinopril, want to lose fat",
    "I take something every morning for my heart",
    "I'm on a pill for anxiety and want to build muscle",
    "taking 20 mg of something, want to maintain",
    "I'm on birth control and want to lose 10 lb",
    "I take amoxicillin and want to lose weight",
    "I take vitamin d, 5'7 140 lb",
    "currently on sertraline, want to lose fat",
    "started losartan last month, want to lose 15 lb",
    "I'm taking doxycycline, want to maintain",
  ])("blocks a medicine taken: %s", (text) => {
    expect(onboardingSafetyCheck(text)).toEqual({ blocked: true, reason: "medical" });
  });

  it.each([
    "I'm on a diet and want to lose 20 lb",
    "I'm on keto right now, 5'6 150 lb",
    "I take the stairs at work and lift three times a week",
    "I take spin classes twice a week and want to lose 10 lb",
    "I want to build muscle, I lift four days a week",
    "I'd like to lose some fat, mostly sitting at a desk",
  ])("still clears ordinary opener speech: %s", (text) => {
    expect(onboardingSafetyCheck(text)).toEqual({ blocked: false });
  });

  it("clears ordinary goal and body-stat speech, including the word 'weight'", () => {
    expect(onboardingSafetyCheck("I want to lose weight, I'm 34, 5'10, 165 lbs"))
      .toEqual({ blocked: false });
    expect(onboardingSafetyCheck("just want to maintain for now")).toEqual({ blocked: false });
    expect(onboardingSafetyCheck("I'm a 34 year old male")).toEqual({ blocked: false });
  });

  it("clears a plain, non-medical dietary word (the dietary free-text box's own W5b check, not this one, gates that)", () => {
    expect(onboardingSafetyCheck("I'm vegetarian and want to build muscle")).toEqual({ blocked: false });
  });

  it("never throws on non-string input", () => {
    expect(onboardingSafetyCheck(undefined as unknown as string)).toEqual({ blocked: false });
  });
});
