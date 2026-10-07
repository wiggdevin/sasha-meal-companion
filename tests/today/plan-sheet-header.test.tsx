// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { ResolvedSlot } from "@/lib/types";
import { LABELS_HIDDEN_MESSAGE, NO_MEAL_FIT_MESSAGE } from "@/lib/coach/suggest-messages";

const postTurn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: false, loading: false, unavailable: false, retry: vi.fn() }),
}));

import PlanSheet from "@/components/PlanSheet";
import PlanSheetHeader, { mealTitle, slotMealType } from "@/components/plan/PlanSheetHeader";

const target = { kcal: 111.4, protein: 37, carbs: 12.6, fat: 4 };
const slot = (time: string): ResolvedSlot => ({
  slot: "meal-1", label: "Meal 1", time, meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
});
const reply = (content: string) => ({ threadId: "t", messages: [{ id: "a", role: "assistant", content }],
  composed: [], suggestions: [], actions: [], draft: null });

beforeEach(async () => { await resetTestAccount(); postTurn.mockReset().mockResolvedValue(reply("Here you go.")); });
afterEach(cleanup);

describe("Plan panel header", () => {
  it("names the meal from the slot's clock time", () => {
    expect(["07:30", "12:30", "15:30", "19:00", "23:30"].map((time) => mealTitle(slotMealType("meal-1", time))))
      .toEqual(["Breakfast", "Lunch", "Snack", "Dinner", "Late meal"]);
    expect(slotMealType("snack-1", "08:00")).toBe("snack");
  });

  it("reads overline, serif title with the time, then the target as coloured chips", () => {
    const { container } = render(<PlanSheetHeader mode="plan" label="Meal 1" slot="meal-1" time="08:00"
      clock="8:00 am" target={target} />);
    const head = container.querySelector(".plan-head")!;
    expect(head.getAttribute("data-meal")).toBe("breakfast");
    expect(screen.getByText("Plan · Meal 1").className).toMatch(/text-overline.*uppercase.*text-section/);
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.className).toContain("font-display");
    expect(title.textContent).toBe("Breakfast8:00 am");
    const chips = screen.getByRole("list", { name: "Target for this meal" }).querySelectorAll("li");
    // Short labels on screen so the four fit one line; whole names for assistive tech.
    const shown = (chip: Element) => Array.from(chip.querySelectorAll('[aria-hidden="true"]'), (part) => part.textContent).join(" ");
    expect(Array.from(chips, shown)).toEqual(["111 kcal", "37g PRO", "13g CAR", "4g FAT"]);
    expect(Array.from(chips, (chip) => chip.querySelector(".sr-only")!.textContent))
      .toEqual(["111 calories", "37 grams protein", "13 grams carbs", "4 grams fat"]);
    expect(Array.from(chips, (chip) => chip.querySelector('[aria-hidden="true"]')!.className.split(" ").at(-1)))
      .toEqual(["kcal", "macro-ink-protein", "macro-ink-carbs", "macro-ink-fat"]);
    expect(head.querySelector(".plan-head-glyph svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("tints by meal type and says when there is no target yet", () => {
    const { container } = render(<PlanSheetHeader mode="log" label="Meal 3" slot="meal-3" time="19:00"
      clock="7:00 pm" target={undefined} />);
    expect(container.querySelector(".plan-head")!.getAttribute("data-meal")).toBe("dinner");
    expect(screen.getByText("Log · Meal 3")).toBeTruthy();
    expect(screen.getByText("Your targets will appear after your profile is ready")).toBeTruthy();
  });

  it("heads the panel in plan and log mode, keeping the dialog's name", async () => {
    render(<PlanSheet date="2026-10-04" slot={slot("08:00")} target={target} onClose={vi.fn()} onPlaced={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Plan Meal 1 · 8:00 am" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Breakfast8:00 am" })).toBeTruthy();
    await waitFor(() => expect(postTurn).toHaveBeenCalled());
    cleanup();
    render(<PlanSheet date="2026-10-04" slot={slot("12:30")} target={target} mode="log" onClose={vi.fn()} onPlaced={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Log Meal 1 · 12:30 pm" })).toBeTruthy();
    expect(screen.getByText("Log · Meal 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Lunch12:30 pm" })).toBeTruthy();
  });
});

describe("Plan panel messages are Notices", () => {
  const open = () => render(<PlanSheet date="2026-10-04" slot={slot("08:00")} target={target}
    onClose={vi.fn()} onPlaced={vi.fn()} />);

  it("shows the hidden-labels line as an attention notice with the next step", async () => {
    postTurn.mockResolvedValue(reply(LABELS_HIDDEN_MESSAGE));
    const { container } = open();
    await screen.findByText(LABELS_HIDDEN_MESSAGE);
    const notice = container.querySelector('.notice[data-tone="attention"]')!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe(`${LABELS_HIDDEN_MESSAGE}Tap another pick or tell me what you’d like.`);
  });

  it("shows no-fit copy as a neutral notice, and an empty answer as the empty notice", async () => {
    postTurn.mockResolvedValue(reply(NO_MEAL_FIT_MESSAGE));
    const { container } = open();
    await screen.findByText(NO_MEAL_FIT_MESSAGE);
    expect(container.querySelector('.notice[data-tone="neutral"]')!.textContent).toContain(NO_MEAL_FIT_MESSAGE);
    cleanup();
    postTurn.mockResolvedValue(reply("Here you go."));
    const second = open();
    await screen.findByText("No ready meal options yet");
    expect(screen.getByText("Here you go.").tagName).toBe("P");
    expect(second.container.querySelector('.notice[data-tone="neutral"]')!.textContent)
      .toBe("No ready meal options yetTap another pick or tell me what you’d like.");
  });

  it("shows a failed request as an error notice whose action retries", async () => {
    postTurn.mockReset().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(reply("Here you go."));
    const { container } = open();
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-tone")).toBe("error");
    expect(container.querySelector(".notice .btn-ink")!.textContent).toBe("Try again");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(2));
  });
});
