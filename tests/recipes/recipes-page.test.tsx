import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FoodsPage from "@/app/foods/page";
import RecipesPage from "@/app/recipes/page";

vi.mock("@/components/FoodsTabs", () => ({ default: () => <div data-testid="foods-tabs" /> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { redirect } from "next/navigation";

describe("the Foods tab", () => {
  it("is the tabs and nothing else", () => {
    const markup = renderToStaticMarkup(<FoodsPage />);
    expect(markup).toContain('data-testid="foods-tabs"');
  });
});

describe("the old Recipes route", () => {
  it("sends her to the recipes section of the Foods tab", () => {
    RecipesPage();
    expect(redirect).toHaveBeenCalledWith("/foods#recipes");
  });
});
