import { describe, expect, it } from "vitest";
import {
  followUpSubject, gaveNoAmount, MAX_CHOICES, portionFollowUps, type FollowUpItem,
} from "@/lib/capture/follow-ups";
import type { DraftItem } from "@/lib/capture/types";
import type { CachedPortion } from "@/lib/db/catalog-cache";

function item(seq: number, label: string, confidence: number, patch: Partial<DraftItem> = {}): DraftItem {
  return { seq, label, foodRefId: `ref-${seq}`, catalogFoodRevisionId: seq, grams: 150, qty: 1,
    unit: "whole", portionId: null, confidence, policy: { verdict: "unverified" },
    alternatives: [], autoResolved: true, ...patch };
}
const portion = (id: number, description: string, gramWeight: number, isDefault = false): CachedPortion =>
  ({ id, description, gramWeight, isDefault });
const PORTIONS = [portion(1, "small", 100), portion(2, "sandwich", 180, true), portion(3, "large", 260)];
const shown = (items: DraftItem[]): FollowUpItem[] => items.map((i) => ({ seq: i.seq, portionId: null }));

describe("portion follow-ups", () => {
  it("asks about a low-confidence item with no amount, default portion first", () => {
    const proposed = [item(0, "a Turkey sandwich with cheese", 0.4)];
    const [question] = portionFollowUps(proposed, shown(proposed), () => PORTIONS);
    expect(question.question).toBe("How much of the turkey sandwich with cheese did you have?");
    expect(question.choices.map((p) => p.id)).toEqual([2, 1, 3]);
    expect(question.answeredPortionId).toBeNull();
  });

  it("asks at most two, least confident first", () => {
    const proposed = [item(0, "toast", 0.5), item(1, "soup", 0.2), item(2, "salad", 0.3)];
    const questions = portionFollowUps(proposed, shown(proposed), () => PORTIONS);
    expect(questions.map((q) => q.seq)).toEqual([1, 2]);
  });

  it("leaves confident items, stated amounts, removed items and portionless foods alone", () => {
    const proposed = [
      item(0, "rice", 0.9),
      item(1, "eggs", 0.3, { qty: 2 }),
      item(2, "chicken", 0.3, { qty: 150, unit: "g" }),
      item(3, "soup", 0.3),
      item(4, "mystery stew", 0.3),
    ];
    const current = [...shown(proposed).slice(0, 3), { seq: 3, removed: true, portionId: null },
      { seq: 4, portionId: null }];
    expect(portionFollowUps(proposed, current, (row) => (row.seq === 4 ? [] : PORTIONS))).toEqual([]);
  });

  it("marks the chosen portion as the answer, and caps the choices", () => {
    const many = Array.from({ length: 7 }, (_, i) => portion(10 + i, `p${i}`, 50 + i));
    const proposed = [item(0, "bagel", 0.4)];
    const [question] = portionFollowUps(proposed, [{ seq: 0, portionId: 11 }], () => many);
    expect(question.choices).toHaveLength(MAX_CHOICES);
    expect(question.answeredPortionId).toBe(11);
  });

  it("reads the model's no-amount rule and tidies the subject", () => {
    expect(gaveNoAmount({ qty: 1, unit: "whole" })).toBe(true);
    expect(gaveNoAmount({ qty: 2, unit: "whole" })).toBe(false);
    expect(gaveNoAmount({ qty: 1, unit: "slice" })).toBe(false);
    expect(followUpSubject("The BLT")).toBe("BLT");
    expect(followUpSubject("an Apple")).toBe("apple");
  });
});
