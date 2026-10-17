// @vitest-environment jsdom
/** W123: "You logged this before" names the earlier day, and says nothing without a match. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Store } from "@/lib/types";

const REF = "aaaaaaaa-0000-4000-8000-000000000001";
const days = {
  "2026-10-12": { extras: [{ id: "e1", foodId: "meal", name: "Banana", portionLabel: "1", qty: 1, grams: 120,
    macros: { kcal: 100, protein: 1, carbs: 25, fat: 0 }, rev: 2, at: "2026-10-12T08:00:00.000Z",
    items: [{ id: "i1", seq: 1, food_ref_id: REF, grams: 120, qty: 1, unit: "each", snapshot: {},
      foodId: REF, name: "Banana", portionLabel: "1", macros: { kcal: 100, protein: 1, carbs: 25, fat: 0 } }] }] },
};
vi.mock("@/lib/store", () => ({ loadStore: () => ({ days }) as unknown as Store }));

afterEach(cleanup);

describe("LoggedBeforeLine", async () => {
  const { default: LoggedBeforeLine } = await import("./LoggedBeforeLine");
  it("says when the same foods were logged before", () => {
    render(<LoggedBeforeLine refs={[REF]} />);
    expect(screen.getByText(/You logged this before, on/)).toBeTruthy();
  });
  it("says nothing for a line no food was matched to", () => {
    const { container } = render(<LoggedBeforeLine refs={[null]} />);
    expect(container.textContent).toBe("");
  });
});
