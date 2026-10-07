/**
 * T7 (F-03): a note that reads like the food hurt earns one inline offer —
 * "Move to Avoid?" — and one tap moves it (the note stays, so "hurt on 9/12"
 * is still on record). @testing-library/react is not installed and no
 * dependency may be added (Sol audit, 2026-09-12): the decision is the pure
 * `noteSuggestsAvoid`/`applyAvoidOffer` pair and the offer row is asserted with
 * `renderToStaticMarkup` — the tests/health/sparkline.test.ts pattern. The
 * tap itself is a manual phone gate.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FoodSheet from "@/components/FoodSheet";
import type { Food } from "@/lib/foods";

const NOOP = () => {};
const gone: Food = { id: "chicken", name: "Chicken breast", role: "protein", unit: "oz",
  perUnit: { protein: 8.8, carbs: 0, fat: 1 }, status: "eats",
  updatedAt: "2026-09-20T00:00:00.000Z" };

function render(food: Food): string {
  return renderToStaticMarkup(
    <FoodSheet food={food} onSetStatus={NOOP} onSetNote={NOOP} onClose={NOOP} />,
  );
}

describe("FoodSheet — a bad note offers Move to Avoid", () => {
  it("shows the offer under the note", () => {
    expect(render({ ...gone, note: "hated it and made me feel tired" })).toContain(
      "Sounds like this one hurt. Move to Avoid?",
    );
  });

  it("stays away for an ordinary note", () => {
    expect(render({ ...gone, note: "great with rice" })).not.toContain("Move to Avoid?");
  });

  it("never offers to move a food already on Avoid", () => {
    expect(render({ ...gone, status: "avoid", note: "hurt on 9/12" })).not.toContain(
      "Move to Avoid?",
    );
  });
});
