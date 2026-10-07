/**
 * Phase 18 W1c, acceptance 2 (docs/specs/phase-18-open-world-foods.md D9 item 2): a refresh with the
 * same model id, prompt and rubric changes no stored probability. Also the `pair_plausibility`
 * purpose: registered as D0, and its builder sends catalog names and a stated occasion only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_REGISTRY } from "@/lib/ai/call-registry";
import { LANES } from "@/lib/ai/lanes";
import { jevProvenance, pairPlausibilityPayload } from "@/lib/ai/payloads";
import { PAIR_QUESTION, type PairItem } from "@/lib/foods/pairing/questions";
import {
  emptyStore, LABEL_STORE_PATH, labelKey, labelsFor, mergeLabels, missingItems, readStore, storeText,
} from "@/scripts/pairing/labels";
import { fixedPairs, reproducibilitySample } from "@/scripts/pairing/pairs";

const model = LANES.judge.model;
const sample = reproducibilitySample(fixedPairs());
const item: PairItem = { id: "poultry__rice__main", anchor: "Chicken breast, roasted", sides: ["White rice, cooked"], occasion: "lunch or dinner" };

describe("acceptance 2: the label store", () => {
  it("the committed store covers the whole live sample (≤ 60 items) under the current model, prompt and rubric", () => {
    expect(sample.length).toBeLessThanOrEqual(60);
    const store = readStore();
    expect(missingItems(store, sample, model)).toEqual([]);
    expect(labelsFor(store, sample, model).size).toBe(sample.length);
    expect(readFileSync(LABEL_STORE_PATH, "utf8")).toBe(storeText(store));
  });

  it("a refresh never rewrites a stored probability", () => {
    const store = readStore();
    const before = storeText(store);
    const reasked = sample.map((one) => ({ item: one, p: 0.123 }));
    expect(storeText(mergeLabels(store, reasked, model))).toBe(before);
  });

  it("keys on the model id, prompt, rubric and item, not the batch or the id order", () => {
    expect(labelKey(model, item)).toBe(labelKey(model, { ...item }));
    expect(labelKey(model, item)).toBe(labelKey(model, { ...item, id: "another-id" }));
    expect(labelKey("other-model", item)).not.toBe(labelKey(model, item));
    expect(labelKey(model, { ...item, occasion: "snack" })).not.toBe(labelKey(model, item));
  });

  it("a new model id adds labels beside the old ones and overwrites nothing", () => {
    const one = mergeLabels(emptyStore(), [{ item, p: 0.9 }], model);
    const two = mergeLabels(one, [{ item, p: 0.2 }], "jev-next");
    expect(two.labels).toHaveLength(2);
    expect(labelsFor(two, [item], model).get(item.id)).toBe(0.9);
    expect(labelsFor(two, [item], "jev-next").get(item.id)).toBe(0.2);
    expect(missingItems(two, [item], model)).toEqual([]);
  });
});

describe("the pair_plausibility purpose", () => {
  it("is registered for Jev as D0 with its builder", () => {
    expect(CALL_REGISTRY.pair_plausibility).toEqual({ provider: "typesafe", dataClass: "D0", builder: "pairPlausibilityPayload" });
  });

  it("sends names and the occasion only, with the frozen question per item", () => {
    const smuggled = { ...item, userId: "u1", note: "allergic to peanuts" } as PairItem;
    const payload = pairPlausibilityPayload({ items: [smuggled] });
    expect(jevProvenance(payload)).toBe("pair_plausibility");
    expect(payload.state).toEqual({ items: { [item.id]: { anchor: item.anchor, sides: item.sides, occasion: item.occasion } } });
    const question = (payload.questions as Record<string, { instructions: string; criteria: unknown }>)[item.id];
    expect(question.instructions).toBe(`Evaluate only state.items["${item.id}"]. ${PAIR_QUESTION.instructions}`);
    expect(question.criteria).toEqual(PAIR_QUESTION.criteria);
  });

  it("refuses malformed items", () => {
    expect(() => pairPlausibilityPayload({ items: [{ ...item, id: "Bad Id!" }] })).toThrow(/slug/);
    expect(() => pairPlausibilityPayload({ items: [{ ...item, anchor: "<script>" }] })).toThrow(/catalog/);
    expect(() => pairPlausibilityPayload({ items: [{ ...item, sides: [] }] })).toThrow(/catalog/);
    expect(() => pairPlausibilityPayload({ items: [{ ...item, occasion: "brunch" as never }] })).toThrow(/occasion/);
  });

  it("asks every fixed pair with a valid item (no catalog name fails the builder)", () => {
    const pairs = fixedPairs();
    expect(() => pairPlausibilityPayload({ items: pairs.slice(0, 2000).map((pair) => ({ id: pair.id, anchor: pair.anchorName,
      sides: [pair.sideName], occasion: pair.occasion })) })).not.toThrow();
  });
});
