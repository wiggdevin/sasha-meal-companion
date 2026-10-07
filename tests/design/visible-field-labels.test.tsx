/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AddFoodSheet from "@/components/AddFoodSheet";
import CaptureSheet from "@/components/CaptureSheet";
import CatalogSearch from "@/components/CatalogSearch";
import LogFoodSheet from "@/components/LogFoodSheet";
import RecipeFoodSearch from "@/components/RecipeFoodSearch";
import RecipeSheet from "@/components/RecipeSheet";
import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import { defaultSettings } from "@/lib/store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => cleanup());

function expectVisibleLabel(text: string): void {
  const label = screen.getByText(text, { selector: "label > span, label" });
  expect(label.className.split(/\s+/)).not.toContain("sr-only");
}

const noop = () => {};

describe("fields identify themselves before focus", () => {
  it("labels the custom food name, one of AddFoodSheet's labelled fields", () => {
    render(<AddFoodSheet existing={{}} onAdd={noop} onClose={noop} startCustom />);
    expectVisibleLabel("Food name");
  });

  it("labels Add food search", () => {
    render(<AddFoodSheet existing={{}} onAdd={noop} onClose={noop} />);
    expectVisibleLabel("Search foods");
  });

  it("labels text capture", () => {
    render(<CaptureSheet open initialMode="text" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    expectVisibleLabel("What you ate");
  });

  it("labels catalog search", () => {
    render(<CatalogSearch mine={{}} onPick={noop} />);
    expectVisibleLabel("Search foods");
  });

  it("labels the meal name and note", () => {
    render(<LogFoodSheet mode="meal" mine={{}} slot="meal-1" onAdd={noop}
      onSomethingElse={noop} onClose={noop} onCapture={noop} />);
    expectVisibleLabel("Meal name");
    expectVisibleLabel("Note");
  });

  it("labels bundled food search", () => {
    render(<LogFoodSheet mode="food" mine={{}} slot="meal-1" onAdd={noop}
      onSomethingElse={noop} onClose={noop} onCapture={noop} />);
    expectVisibleLabel("Search foods");
  });

  it("labels recipe food search", () => {
    render(<RecipeFoodSearch query="" mine={{}} onQuery={noop} onPick={noop} />);
    expectVisibleLabel("Search foods");
  });

  it("labels the recipe name", () => {
    render(<RecipeSheet onClose={noop} onSaved={noop} />);
    expectVisibleLabel("Recipe name");
  });

  it("keeps disabled onboarding primaries the system primary", () => {
    // Disabled, a system button fades to 40 % and keeps its size (DESIGN.md §Buttons, 2026-10-04).
    const first = render(<OnboardingFlow initial={0} initialSettings={defaultSettings()} />);
    expect(screen.getByRole("button", { name: "Next" }).className.split(/\s+/))
      .toEqual(expect.arrayContaining(["btn", "btn-primary"]));
    first.unmount();

    render(<OnboardingFlow initial={5} initialSettings={defaultSettings()} />);
    const usePlan = screen.getByRole("button", { name: "Use this plan" }) as HTMLButtonElement;
    expect(usePlan.disabled).toBe(true);
    expect(usePlan.className.split(/\s+/))
      .toEqual(expect.arrayContaining(["btn", "btn-primary"]));
    expect(usePlan.className).not.toContain("bg-white");
  });
});
