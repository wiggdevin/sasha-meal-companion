import { describe, expect, it } from "vitest";
import { classifyMedical, MEDICAL_DEFLECTION } from "@/lib/coach/deflect";

const MEDICAL = [
  "is my colitis getting worse", "do I have a flare right now", "should I stop my mesalamine",
  "what dose of prednisone should I take", "can I halve my azathioprine",
  "is this blood in my stool normal", "do I need a colonoscopy", "am I in remission",
  "what is my calprotectin telling me", "should I see my GI about this",
  "diagnose this pain in my left side", "is this a symptom of ulcerative colitis",
  "how severe is my flare", "can I come off my medication", "what medication should I be on",
  "is it safe to take ibuprofen with colitis", "do I have anaemia",
  "should I take a supplement for my anaemia", "is my inflammation going down",
  "prescribe me something for the cramping",
];

const NUTRITION = [
  "what should I eat now", "how much protein am I short", "can I have a yoghurt",
  "is white rice ok before training", "how many carbs on Wednesday", "what is my calorie target",
  "did I hit my fibre yesterday", "suggest a meal from my Eats list", "is banana a safe carb",
  "how much chicken is 40 g of protein", "what did I eat on Tuesday", "log 150 g of rice",
  "am I eating enough fat", "what is my weight trend", "how close am I to my protein target",
  "give me a floor day plan", "what can I eat that is not cooked", "how many calories in this",
  "should I eat before or after the gym", "what is my expenditure estimate",
];

describe("classifyMedical", () => {
  it("deflects twenty medical phrasings", () => {
    for (const text of MEDICAL) expect(classifyMedical(text).deflect, text).toBe(true);
  });

  it("lets twenty nutrition phrasings through", () => {
    for (const text of NUTRITION) expect(classifyMedical(text).deflect, text).toBe(false);
  });

  it("names which patterns matched, so a false positive is reviewable", () => {
    expect(classifyMedical("should I stop my mesalamine").matched.length).toBeGreaterThan(0);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(classifyMedical("IS MY COLITIS GETTING WORSE?!").deflect).toBe(true);
  });

  it("returns a byte-identical deflection string every time", () => {
    expect(MEDICAL_DEFLECTION).toBe(MEDICAL_DEFLECTION.normalize("NFC"));
    expect(MEDICAL_DEFLECTION).toContain("your doctor");
    expect(MEDICAL_DEFLECTION).not.toContain("!");
  });

  it("refers without naming a condition or a specialty", () => {
    // The matcher still catches condition words; the reply the user reads must not assume one,
    // because any account can ask a medical question (Grok pass 1). Refer, do not prescribe.
    expect(MEDICAL_DEFLECTION)
      .not.toMatch(/colitis|crohn|\bibd\b|ulcerative|\bgi\b|\buc\b|flare|gut/i);
    expect(MEDICAL_DEFLECTION).toMatch(/doctor|clinician/i);
  });
});

/**
 * Panel round 2, item 1. "What do I have left to eat today?" was deflected in 70 ms with zero
 * model calls, because the `diagnosis` rule carried a bare `do i have`. A pattern matcher may
 * over-deflect a medical question; it may not eat a question about the user's food.
 */
describe("a food question is never a medical one", () => {
  it.each([
    "What do I have left to eat today?",
    "Do I have a snack planned?",
    "What do I have for meal 3?",
    "Do I have enough protein left?",
    "What do I have in my avoid list?",
  ])("answers %j itself", (text) => {
    expect(classifyMedical(text).deflect).toBe(false);
  });

  it.each([
    "Do I have colitis?",
    "do i have UC",
    "Do I have ulcerative colitis?",
    "Do I have Crohn's?",
    "Do I have IBD?",
  ])("still deflects %j", (text) => {
    const result = classifyMedical(text);
    expect(result.deflect).toBe(true);
    expect(result.matched).toContain("diagnosis");
  });

  it("still deflects a flare question, which is its own rule", () => {
    expect(classifyMedical("Do I have a flare?").matched).toContain("flare-now");
  });
});
