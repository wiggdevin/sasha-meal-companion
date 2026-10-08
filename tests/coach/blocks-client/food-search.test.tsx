// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FoodSearchBlock from "@/components/coach/blocks/food_search";
import type { FoodSearchBlockV1 } from "@/lib/coach/ui-blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";

afterEach(cleanup);

const row = {
  foodRefId: "11111111-1111-4111-8111-111111111111",
  revisionId: "71",
  name: "White rice",
  kcalPer100g: 130,
  status: "neutral" as const,
  blocked: false,
};

function block(intent: FoodSearchBlockV1["intent"], overrides: Partial<FoodSearchBlockV1> = {}): FoodSearchBlockV1 {
  return { kind: "food_search", v: 1, id: `search-${intent}`, query: "white rice", intent,
    results: [row], truncated: false, ...overrides };
}

describe("food search block", () => {
  it.each([
    ["log", "Log", "logFood"],
    ["eats", "Favor", "markEats"],
    ["avoid", "Avoid", "markAvoid"],
  ] as const)("routes %s through its context callback", async (intent, label, callback) => {
    const handler = vi.fn();
    render(<FoodSearchBlock block={block(intent)} ctx={blockContext({ [callback]: handler })} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith({ foodRefId: row.foodRefId, revisionId: row.revisionId,
      name: row.name, blocked: false });
  });

  it("shows an already marked row instead of a redundant membership button", () => {
    render(<FoodSearchBlock block={block("eats", { results: [{ ...row, status: "eats" }] })}
      ctx={blockContext()} />);
    expect(screen.getByText("Favored")).toBeTruthy();
    expect(screen.getByText("Favor")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Favor" })).toBeNull();
  });

  it("shows blocked rows and calories without implying neutral is a safety result", () => {
    render(<FoodSearchBlock block={block("log", {
      results: [{ ...row, blocked: true }], truncated: true,
    })} ctx={blockContext()} />);

    // The number sits in its own calorie-coloured span (DESIGN.md §Colors, 2026-10-03).
    expect(screen.getByText((_, node) => node?.textContent === "130 kcal / 100 g"
      && node.tagName === "SPAN" && node.querySelector(".kcal")?.textContent === "130")).toBeTruthy();
    expect(screen.queryByText("Neutral")).toBeNull();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Search all foods" }).getAttribute("href"))
      .toBe("/foods?search=white%20rice");
  });

  it("describes existing Eats membership without claiming the food is a favorite", () => {
    render(<FoodSearchBlock block={block("eats", { results: [{ ...row, status: "eats" }] })}
      ctx={blockContext()} />);
    expect(screen.getByText("Favored")).toBeTruthy();
    expect(screen.queryByText("Favorite")).toBeNull();
  });

  it("marks an avoided result blocked and offers only an explicit log-anyway action", async () => {
    const logFood = vi.fn();
    render(<FoodSearchBlock block={block("log", {
      results: [{ ...row, status: "avoid", blocked: false }],
    })} ctx={blockContext({ logFood })} />);

    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log anyway" }));
    await waitFor(() => expect(logFood).toHaveBeenCalledWith(expect.objectContaining({ blocked: true })));
  });

  it("keeps row actions and the truncated link at least 44 px", () => {
    render(<FoodSearchBlock block={block("log", { truncated: true })} ctx={blockContext()} />);
    for (const target of [screen.getByRole("button", { name: "Log" }),
      screen.getByRole("link", { name: "Search all foods" })]) {
      expect(Number.parseFloat(target.style.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });
});
