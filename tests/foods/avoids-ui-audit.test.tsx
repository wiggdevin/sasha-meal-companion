// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §8 (food rules and Avoids): the rules card reloads when the connection comes
 * back, the rule review card never flashes its "carried over" wording, the affected-meals sheet
 * reads dates and meal names, and food favorites on the Foods page are plain tags.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const constraints = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: constraints.load, saveConstraints: constraints.save,
}));
const review = vi.hoisted(() => ({ load: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/rule-review-client", () => ({
  loadRuleReview: review.load, submitRuleReview: review.submit,
}));

import AvoidRules from "@/components/AvoidRules";
import RuleReviewCard from "@/components/RuleReviewCard";
import FavoritesStrip from "@/components/FavoritesStrip";
import { instanceWhen } from "@/components/AvoidImpact";
import type { FavoriteRow } from "@/lib/favorites";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  constraints.load.mockReset();
  review.load.mockReset();
});

const PROFILE = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
  conditions: [], notes: null };

describe("food rules card", () => {
  it("loads the rules once the device is back online after an offline open", async () => {
    let onLine = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
    constraints.load.mockResolvedValueOnce(null).mockResolvedValue({ profile: PROFILE, rev: 1 });
    render(<AvoidRules />);
    await screen.findByText("Your rules load when you are back online.");
    onLine = true;
    act(() => { window.dispatchEvent(new Event("online")); });
    await screen.findByText("No food rules yet");
    expect(constraints.load).toHaveBeenCalledTimes(2);
  });

  it("shows a custom rule's validation error inside the custom rules card", async () => {
    render(<AvoidRules initial={PROFILE} />);
    fireEvent.click(screen.getByRole("radio", { name: "ingredient" }));
    const input = screen.getByRole("textbox", { name: "Custom food rule" });
    fireEvent.change(input, { target: { value: "no garlic please" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(input.getAttribute("aria-describedby")).toBeTruthy());
    const error = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(error?.closest("section")?.textContent).toContain("Custom rules");
  });
});

describe("rule review card", () => {
  it("renders nothing while the check is loading", () => {
    review.load.mockReturnValue(new Promise(() => {}));
    const { container } = render(<RuleReviewCard />);
    expect(container.textContent).toBe("");
  });

  it("says only that the check failed, never the carried-over wording", async () => {
    review.load.mockResolvedValue(null);
    render(<RuleReviewCard />);
    await screen.findByText("Could not check your food rules.");
    expect(screen.queryByText(/carried over/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("rule review card offline", () => {
  it("stays quiet offline and checks again when the connection returns", async () => {
    let onLine = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
    review.load.mockResolvedValueOnce(null).mockResolvedValue(null);
    const { container } = render(<RuleReviewCard />);
    await waitFor(() => expect(review.load).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe("");
    onLine = true;
    act(() => { window.dispatchEvent(new Event("online")); });
    await screen.findByText("Could not check your food rules.");
    expect(review.load).toHaveBeenCalledTimes(2);
  });
});

describe("affected meals labels", () => {
  it("reads a date and the meal's name, never an ISO date or slot id", () => {
    expect(instanceWhen({ date: "2026-10-19", slot: "meal-3" })).toBe("Mon, Oct 19 · Meal 3");
    expect(instanceWhen({ date: "2026-10-19", slot: "unknown" })).toBe("Mon, Oct 19 · Meal");
  });
});

describe("favorites on the Foods page", () => {
  it("draws a food favorite as a tag, not a link to the page it is on", () => {
    const rows = [
      { kind: "food", id: "f1", name: "Greek yogurt", sort: 1 },
      { kind: "recipe", id: "r1", name: "Lentil soup", sort: 2 },
    ] as unknown as FavoriteRow[];
    const markup = renderToStaticMarkup(<FavoritesStrip initial={rows} limit={6} />);
    expect(markup).not.toMatch(/<a[^>]*href="\/foods"[^>]*>Greek yogurt/);
    expect(markup).toContain("Greek yogurt");
    expect(markup).toMatch(/<a[^>]*href="\/foods#recipes"/);
  });
});
