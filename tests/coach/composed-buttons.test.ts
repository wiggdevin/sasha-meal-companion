// The card's own rule (components/CoachComposedCard.tsx) and the lib twin record_coach_undo mirrors
// (review t4r6 #3) must name the same "Put it in" slot; the SQL side is held to composedButtons in
// tests/migrations/coach-undo-sql.test.ts.
import { describe, expect, it } from "vitest";
import { defaultSlot } from "@/components/CoachComposedCard";
import { composedButtons } from "@/lib/coach/composed-buttons";

const items = [{ foodRefId: "egg", grams: 100 }];
const cards = [
  { items, slot: null },
  { items, slot: "meal-3" },
  { items, slot: null, pendingSlots: [{ slot: "meal-2", label: "Meal 2" }] },
  { items, slot: "meal-1",
    pendingSlots: [{ slot: "meal-2", label: "Meal 2" }, { slot: "meal-4", label: "Meal 4" }] },
];

describe("composedButtons", () => {
  it.each(cards)("offers the card's default slot first, and Put it in only with a slot (%o)", (card) => {
    const offers = composedButtons(card);
    const first = defaultSlot(card as never);
    expect(offers.slots[0] ?? null).toBe(first);
    expect(offers.kinds.includes("set_slot_meal")).toBe(first !== null);
    expect(offers.kinds).toEqual(expect.arrayContaining(["log_meal", "save_recipe"]));
  });

  it("offers nothing on a card with no foods, which renders nothing", () => {
    expect(composedButtons({ items: [], slot: "meal-3" })).toEqual({ kinds: [], slots: [] });
  });

  it("offers every pending meal when the card shows a choice of more than one", () => {
    expect(composedButtons(cards[3]).slots).toEqual(["meal-1", "meal-2", "meal-4"]);
    expect(composedButtons(cards[2]).slots).toEqual(["meal-2"]);
  });
});
