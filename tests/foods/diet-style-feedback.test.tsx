// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const diet = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/foods/diet-client", () => ({ loadDiet: diet.load, saveDiet: diet.save }));

import { DietStyleCard } from "@/components/AvoidsView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  diet.load.mockResolvedValue({ dietPrefs: { flags: ["vegetarian"] }, rev: 1 });
  diet.save.mockReset();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows a violet saved state and restores the previous diet style from Undo", async () => {
  const saved = deferred<{ dietPrefs: { flags: ["vegetarian", "vegan"] }; rev: number }>();
  diet.save.mockReturnValueOnce(saved.promise)
    .mockResolvedValueOnce({ dietPrefs: { flags: ["vegetarian"] }, rev: 3 });
  render(<DietStyleCard />);

  fireEvent.click(await screen.findByRole("button", { name: "Edit diet style and exclusions" }));
  fireEvent.click(screen.getByRole("button", { name: "Vegan" }));
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

  const card = screen.getByRole("region", { name: "Diet style" });
  expect(card.getAttribute("data-feedback-state")).toBe("pending");
  await act(async () => saved.resolve({ dietPrefs: { flags: ["vegetarian", "vegan"] }, rev: 2 }));
  expect(card.getAttribute("data-feedback-state")).toBe("changed");
  expect(screen.getByRole("status").textContent).toContain("Diet style changed.");

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByText("Diet style restored.");
  expect(diet.save).toHaveBeenNthCalledWith(1, ["vegetarian", "vegan"], 1);
  expect(diet.save).toHaveBeenNthCalledWith(2, ["vegetarian"], 2);
  expect(screen.queryByText("Vegan")).toBeNull();
});
