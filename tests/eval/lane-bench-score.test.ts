/** Pure scoring of the Phase 13 lane bench (the bench itself never runs in CI). */
import { describe, expect, it } from "vitest";
import {
  beatsIncumbent, isCorrect, percentile, summarise, type Attempt, type LaneRow,
} from "@/scripts/eval/lane-bench/score";

const row = (over: Partial<LaneRow>): LaneRow => ({ lane: "ui", model: "m", n: 10, p50Ms: 500,
  p95Ms: 1000, schemaValidRate: 1, accuracy: 0.9, costUsd: 0, costPerCallUsd: 0, unknownCost: 0,
  ...over });

describe("lane bench scoring", () => {
  it("takes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });

  it("scores exact numbers, never substrings (Sol r1 finding 4)", () => {
    expect(isCorrect({ number: 550 }, { answer: "550 left", value: 550 })).toBe(true);
    expect(isCorrect({ number: 550 }, { answer: "You have 5500 left", value: 5500 })).toBe(false);
    expect(isCorrect({ number: 550 }, { answer: "550", value: "550" })).toBe(true);
    expect(isCorrect({ number: 550 }, { answer: "550", value: "550 kcal" })).toBe(false);
    expect(isCorrect({ number: 550 }, { answer: "5500", value: "5500" })).toBe(false);
    expect(isCorrect({ number: 2000 }, { answer: "2,000", value: "2,000" })).toBe(true);
  });

  it("scores booleans and words exactly, from the value alone", () => {
    expect(isCorrect({ boolean: true }, { value: false })).toBe(false);
    expect(isCorrect({ boolean: true }, { answer: "Yes", value: true })).toBe(true);
    expect(isCorrect({ boolean: true }, { answer: "Yes", value: "true" })).toBe(true);
    expect(isCorrect({ boolean: true }, { answer: "Yes", value: "yes, but not really" })).toBe(false);
    expect(isCorrect({ word: "lunch" }, { answer: "Lunch", value: " Lunch " })).toBe(true);
    expect(isCorrect({ word: "lunch" }, { answer: "lunch and dinner", value: "lunch and dinner" }))
      .toBe(false);
  });

  it("scores a chart block point by point, never by count alone (Sol r2 finding 8)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const block = (points: { x: string; y: number }[], extra: Record<string, unknown> = {}) =>
      ({ chart: "kcal_week", series: [{ label: "kcal eaten", points }], unit: "kcal",
        caption: "Mon was 1800 and Tue 2,000.", ...extra });
    expect(isCorrect(expected, block([{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }]))).toBe(true);
    expect(isCorrect(expected, block([{ x: "Mon", y: 1800 }, { x: "Tue", y: 2100 }]))).toBe(false);
    expect(isCorrect(expected, block([{ x: "Tue", y: 2000 }, { x: "Mon", y: 1800 }]))).toBe(false);
    expect(isCorrect(expected, block([{ x: "Mon", y: 1800 }]))).toBe(false);
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    expect(isCorrect(expected, block(both, { unit: "g" }))).toBe(false);
    expect(isCorrect(expected, block(both, { caption: "You ate 5000 kcal on Monday." })))
      .toBe(false);
    expect(isCorrect(expected, block(both, { series: [{ label: "steps", points: both }] })))
      .toBe(false);
    // Numbers that are x labels ("W5", "09-21") are not invented values.
    const weeks = { chart: "weight_trend" as const, points: [["W1", 82.1], ["W5", 80.7]] as
      [string, number][], unit: "kg", label: ["weight"] };
    expect(isCorrect(weeks, { chart: "weight_trend", unit: "kg", caption: "From 82.1 kg in W1 to 80.7 kg in W5.",
      series: [{ label: "Weight", points: [{ x: "W1", y: 82.1 }, { x: "W5", y: 80.7 }] }] }))
      .toBe(true);
  });

  it("attributes caption numbers per point, never by pooled membership (r4 finding 8)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    const block = (caption: string, extra: Record<string, unknown> = {}) =>
      ({ chart: "kcal_week", series: [{ label: "kcal eaten", points: both }], unit: "kcal",
        caption, ...extra });
    // Both values are present, but swapped onto the wrong day: still wrong.
    expect(isCorrect(expected, block("Mon was 2000 kcal and Tue was 1800 kcal."))).toBe(false);
    // Reproduced from GPT-6 Sol r4: correct points, but a caption that swaps the attribution
    // and a series label naming the wrong thing (evidence, not just a pooled-set coincidence).
    expect(isCorrect(expected, {
      chart: "kcal_week", unit: "kcal",
      series: [{ label: "Calories burned", points: both }],
      caption: "Mon was 2000 kcal and Tue was 1800 kcal.",
    })).toBe(false);
    // A caption naming no day at all is not held to per-point attribution.
    expect(isCorrect(expected, block("Calories ranged from 1800 to 2000 this week."))).toBe(true);
  });

  it("matches the series label as a whole word, never a substring (r4 new finding)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    const block = (label: string) => ({ chart: "kcal_week", unit: "kcal",
      series: [{ label, points: both }], caption: "Mon was 1800 and Tue 2,000." });
    // "Calorie intake" is a different word from "burned" below: "calorie" is only a substring
    // of "calories", not the word itself, once plurals are excluded from consideration.
    expect(isCorrect(expected, block("Calorie intake"))).toBe(true);
    expect(isCorrect(expected, block("kcal eaten"))).toBe(true);
  });

  it("accepts a bare plural of the series-label word, and rejects a qualifier that reverses it", () => {
    const kcal = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const macros = { chart: "macros_today" as const,
      points: [["protein", 140], ["carbs", 230]] as [string, number][], unit: "g",
      label: ["macro"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    const kcalBlock = (label: string) => ({ chart: "kcal_week", unit: "kcal",
      series: [{ label, points: both }], caption: "Mon was 1800 and Tue 2,000." });
    // A bare "add an s" plural is accepted, same as the capture scorer already allows for foods.
    expect(isCorrect(kcal, kcalBlock("Calories"))).toBe(true);
    expect(isCorrect(macros, { chart: "macros_today", unit: "g",
      series: [{ label: "Macros", points: [{ x: "protein", y: 140 }, { x: "carbs", y: 230 }] }],
      caption: "Protein 140 g and carbs 230 g." })).toBe(true);
    // "Kcal burned" and "Calories burned" contain an accepted word, but name the opposite
    // quantity from what this app ever charts (calories eaten — there is no expenditure
    // tracking here): a contradicting qualifier is rejected even once plurals are allowed.
    expect(isCorrect(kcal, kcalBlock("Kcal burned"))).toBe(false);
    expect(isCorrect(kcal, kcalBlock("Calories burned"))).toBe(false);
  });

  it("never lets a label already claimed by one number silently absorb a second, false one", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    const block = (caption: string) => ({ chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points: both }], caption });
    // Mon's real value is stated once, correctly, then a second, false "Mon" value that happens
    // to equal Tue's real number. Nearest-neighbour search alone reuses Tue's already-claimed
    // slot and lets the coincidence pass; a label already claimed by an earlier number must never
    // absorb another, so the second, false claim is rejected instead.
    expect(isCorrect(expected, block(
      "Mon was 1800 kcal, Tue was 2000 kcal, and Mon was 2000 kcal too."))).toBe(false);
  });

  it("attributes a bunched 'labels then numbers' caption in order, not by nearest neighbour", () => {
    const expected = { chart: "kcal_week" as const,
      points: [["Mon", 1800], ["Tue", 2000], ["Wed", 2000]] as [string, number][],
      unit: "kcal", label: ["kcal", "calorie"] };
    const points = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }, { x: "Wed", y: 2000 }];
    const block = (caption: string) => ({ chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points }], caption });
    // All three labels are named before any number: nearest-preceding-label alone would
    // attribute every number to Wed (the last label seen) instead of pairing the two lists, in
    // the order they were written, one to one.
    expect(isCorrect(expected, block("Mon, Tue, Wed: 1800, 2000, 2000 kcal."))).toBe(true);
    // Same bunched shape, values out of order relative to the labels: still wrong.
    expect(isCorrect(expected, block("Mon, Tue, Wed: 2000, 1800, 2000 kcal."))).toBe(false);
  });

  it("rejects a caption whose stated trend contradicts the actual points (GPT-6 Sol review " +
    "round 2, reproduced: 'Calories fell from Mon to Tue' for Mon 1800 -> Tue 2000, a rise, " +
    "scored correct because isCorrect checked point values but never a caption's own direction " +
    "claim)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const points = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    const block = (caption: string) => ({ chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points }], caption });
    // Every point and number is correct; only the caption's own claimed direction is a lie.
    expect(isCorrect(expected, block("Calories fell from Mon to Tue."))).toBe(false);
    expect(isCorrect(expected, block("Calories dropped from Mon to Tue."))).toBe(false);
    // The true direction, stated the same way, still passes.
    expect(isCorrect(expected, block("Calories rose from Mon to Tue."))).toBe(true);
    // A flat week: neither "rose" nor "fell" is a true claim about it.
    const flat = { chart: "kcal_week" as const, points: [["Mon", 2000], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const flatPoints = [{ x: "Mon", y: 2000 }, { x: "Tue", y: 2000 }];
    expect(isCorrect(flat, { chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points: flatPoints }],
      caption: "Calories held steady from Mon to Tue." })).toBe(true);
    expect(isCorrect(flat, { chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points: flatPoints }],
      caption: "Calories rose from Mon to Tue." })).toBe(false);
  });

  it("rejects a contradicting qualifier in the caption, not only in the series label " +
    "(GPT-6 Sol review round 1, BLOCK #4)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    // The series label is clean ("Calories"), but the caption itself claims the app charts
    // calories BURNED — the opposite of what this app ever tracks (calories eaten, no expenditure
    // tracking). Every point and number is otherwise correct, so only a caption-level check catches
    // this: checking CONTRADICTING_QUALIFIERS against the series label alone lets it through.
    expect(isCorrect(expected, {
      chart: "kcal_week", unit: "kcal",
      series: [{ label: "Calories", points: both }],
      caption: "Calories burned rose to 2000 kcal by Tuesday, up from 1800 Monday.",
    })).toBe(false);
  });

  it("does not fail a truthful caption for restating an already-correct value with no label " +
    "left to pair it to (GPT-6 Sol review round 1, BLOCK #4)", () => {
    const expected = { chart: "kcal_week" as const, points: [["Mon", 1800], ["Tue", 2000]] as
      [string, number][], unit: "kcal", label: ["kcal", "calorie"] };
    const both = [{ x: "Mon", y: 1800 }, { x: "Tue", y: 2000 }];
    // Both points are named and correctly attributed; the caption then repeats Tue's own value
    // again in a closing remark that names no day. That trailing "2000" is truthful (it is Tue's
    // real value), not a false claim about a third, unnamed point, so it must not fail the caption
    // check — distinct from the "Mon was 2000 kcal too" case below, where the same shape of
    // trailing number IS a false claim about a specific, already-claimed label.
    expect(isCorrect(expected, {
      chart: "kcal_week", unit: "kcal",
      series: [{ label: "kcal eaten", points: both }],
      caption: "Mon was 1800 kcal and Tue was 2000 kcal, staying near 2000 kcal by week end.",
    })).toBe(true);
  });

  it("scores reply buttons as exact allowed choices", () => {
    const expected = { replies: { allowed: ["breakfast", "lunch", "dinner"],
      include: ["lunch", "dinner"] } };
    expect(isCorrect(expected, { options: ["Lunch", "Dinner"] })).toBe(true);
    expect(isCorrect(expected, { options: ["Lunch", "not dinner"] })).toBe(false);
    expect(isCorrect(expected, { options: ["Lunch", "Dinner", "Snack"] })).toBe(false);
    expect(isCorrect(expected, { options: ["Lunch"] })).toBe(false);
  });

  it("scores capture items by label and count", () => {
    expect(isCorrect({ labels: ["egg", "toast"], items: 2 },
      { items: [{ label: "Eggs" }, { label: "Toast" }] })).toBe(true);
    expect(isCorrect({ labels: ["egg"], items: 1 },
      { items: [{ label: "Eggs" }, { label: "Toast" }] })).toBe(false);
  });

  it("never matches a different food that merely starts with the same letters (r4 finding)", () => {
    // Reproduced from GPT-6 Sol r4: "eggplant" is not "egg" (or "eggs") — a vegetable is not a
    // dairy/protein item, however it stems.
    expect(isCorrect({ labels: ["egg"], items: 1 },
      { items: [{ label: "eggplant", qty: 1, grams: 100 }] })).toBe(false);
    // A real inflection of the expected word still matches.
    expect(isCorrect({ labels: ["egg"], items: 1 },
      { items: [{ label: "eggs", qty: 1, grams: 50 }] })).toBe(true);
    // An irregular form needs its own accepted spelling, listed explicitly.
    expect(isCorrect({ labels: [["oat", "oats", "oatmeal"]], items: 1 },
      { items: [{ label: "oatmeal" }] })).toBe(true);
    expect(isCorrect({ labels: ["oat"], items: 1 }, { items: [{ label: "oatmeal" }] })).toBe(false);
  });

  it("checks quantity when the fixture states one, not only the label (r4 finding)", () => {
    expect(isCorrect({ labels: ["egg"], items: 1, qty: [2] },
      { items: [{ label: "eggs", qty: 2 }] })).toBe(true);
    // Right food, wrong amount: still wrong.
    expect(isCorrect({ labels: ["egg"], items: 1, qty: [2] },
      { items: [{ label: "eggs", qty: 1 }] })).toBe(false);
  });

  it("checks a stated gram weight, in the grams field, even when a later food's weight goes " +
    "unstated (fixtures k3) — GPT-6 Sol review round 2, correct finding: k3's earlier fixture " +
    "checked `qty: 150` for a 150 g chicken breast, which the production schema can never let a " +
    "model return (`qty` caps at 100; it counts servings, not grams — lib/ai/schemas.ts). The " +
    "fixture now checks the `grams` field a model can actually produce.", () => {
    const expect150 = { labels: ["chicken", "rice"], items: 2, grams: [150] };
    expect(isCorrect(expect150,
      { items: [{ label: "chicken breast", qty: 1, grams: 150 }, { label: "rice", qty: 1 }] }))
      .toBe(true);
    // A 15 g answer for the 150 g chicken breast is wrong, however the rice is stated.
    expect(isCorrect(expect150,
      { items: [{ label: "chicken breast", qty: 1, grams: 15 }, { label: "rice", qty: 1 }] }))
      .toBe(false);
  });

  it("checks the stated gram weight, not only the label and count (GPT-6 Sol review round 2, " +
    "reproduced: 'two eggs and a slice of toast' extracted as two KILOGRAMS of eggs and one " +
    "kilogram of toast previously scored correct, because isCorrect never read `grams`)", () => {
    const expected = { labels: ["egg", "toast"], items: 2, qty: [2, 1], grams: [100, 30] };
    expect(isCorrect(expected, { items: [
      { label: "eggs", qty: 2, grams: 100 },
      { label: "toast", qty: 1, grams: 30 },
    ] })).toBe(true);
    // Same labels, same counts, the amount off by 20x (grams misread as kilograms): must fail.
    expect(isCorrect(expected, { items: [
      { label: "eggs", qty: 2, grams: 2000 },
      { label: "toast", qty: 1, grams: 1000 },
    ] })).toBe(false);
    // A reasonable estimation slack is still allowed — this is a model's weight estimate, not an
    // exact reading the way a stated qty count is.
    expect(isCorrect(expected, { items: [
      { label: "eggs", qty: 2, grams: 110 },
      { label: "toast", qty: 1, grams: 28 },
    ] })).toBe(true);
  });

  it("never lets one item satisfy two distinct expected foods", () => {
    expect(isCorrect({ labels: ["egg", "egg"], items: 1 },
      { items: [{ label: "eggs" }] })).toBe(false);
  });

  it("summarises one row per lane and model, with unknown usage kept out of cost", () => {
    const attempt = (latencyMs: number, correct: boolean, costUsd: number | null): Attempt => ({
      lane: "ui", model: "m", caseId: "u1", latencyMs, schemaValid: costUsd !== null, correct,
      inputTokens: costUsd === null ? null : 1, outputTokens: costUsd === null ? null : 1,
      costUsd });
    expect(summarise([attempt(100, true, 0.001), attempt(300, false, null)])).toEqual([{
      lane: "ui", model: "m", n: 2, p50Ms: 100, p95Ms: 300, schemaValidRate: 0.5, accuracy: 0.5,
      costUsd: 0.001, costPerCallUsd: 0.001, unknownCost: 1 }]);
  });

  it("applies §3.2 inside the lane budget (Sol r1 finding 3)", () => {
    const pin = row({});
    const gates = { budgetMs: 4_000, p95MustNotRise: false };
    expect(beatsIncumbent(row({ p95Ms: 800 }), pin, gates)).toBe(true);
    expect(beatsIncumbent(row({ accuracy: 0.85, p95Ms: 500 }), pin, gates)).toBe(false);
    expect(beatsIncumbent(row({ accuracy: 0.96, p95Ms: 3_000 }), pin, gates)).toBe(true);
    expect(beatsIncumbent(row({ accuracy: 0.96, p95Ms: 5_000 }), pin, gates)).toBe(false);
    // Faster than the pin but over the budget: never.
    const slowPin = row({ p95Ms: 6_000 });
    expect(beatsIncumbent(row({ p95Ms: 5_000 }), slowPin, gates)).toBe(false);
  });

  it("never picks a model that renders less often or gets nothing right, however fast", () => {
    const gates = { budgetMs: null, p95MustNotRise: false };
    expect(beatsIncumbent(row({ accuracy: 0, schemaValidRate: 0, p95Ms: 1 }),
      row({ accuracy: 0, schemaValidRate: 0, p95Ms: 2 }), gates)).toBe(false);
    expect(beatsIncumbent(row({ schemaValidRate: 0.9, p95Ms: 100 }), row({}), gates)).toBe(false);
  });

  it("never lets a more accurate model raise a §7-gated lane's p95 (coach turn, capture)", () => {
    const pin = row({ p95Ms: 1_000 });
    const gated = { budgetMs: null, p95MustNotRise: true };
    expect(beatsIncumbent(row({ accuracy: 1, p95Ms: 1_200 }), pin, gated)).toBe(false);
    expect(beatsIncumbent(row({ accuracy: 1, p95Ms: 1_000 }), pin, gated)).toBe(true);
    expect(beatsIncumbent(row({ accuracy: 1, p95Ms: 1_200 }), pin,
      { budgetMs: null, p95MustNotRise: false })).toBe(true);
  });
});
