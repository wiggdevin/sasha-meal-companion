/** @vitest-environment jsdom */
/**
 * Smoke coverage for the /design gallery (app/design/DesignGallery.tsx): every entry added for
 * the 2026-10-03 UI (docs/design/KIT.md §12) renders with its static fixtures, with no network
 * and no device store. This is deliberately shallow — each component's own spec owns its
 * behaviour; this just proves the gallery page still mounts them all.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DesignGallery from "@/app/design/DesignGallery";
import DesignPage from "@/app/design/page";

afterEach(() => { cleanup(); });

describe("the /design gallery", () => {
  it("renders every primitive block without throwing", () => {
    expect(() => render(<DesignGallery />)).not.toThrow();
  });

  it("shows the Thinking indicator, inline and compact", () => {
    render(<DesignGallery />);
    expect(screen.getByText("Reading your photo…")).toBeTruthy();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("colours the calorie figure through KcalText", () => {
    render(<DesignGallery />);
    const figure = screen.getByText("537");
    expect(figure.className).toContain("kcal");
  });

  it("opens an anchored Sheet pop-up, not a bottom sheet", () => {
    render(<DesignGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Open a sheet" }));
    const dialog = screen.getByRole("dialog", { name: "Edit meal" });
    expect(dialog.querySelector(".sheet-handle")).toBeNull();
  });

  it("renders the PlanComposer's ask box", () => {
    render(<DesignGallery />);
    expect(screen.getByRole("textbox", { name: "Ask for a meal idea" })).toBeTruthy();
  });

  it("renders the meal card swipe tray at every reveal stage", () => {
    render(<DesignGallery />);
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("Delete armed")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Clear Lunch" }).length).toBeGreaterThan(0);
  });

  it("renders PhotoResult for a plate and a menu", () => {
    render(<DesignGallery />);
    // A plate's foods are checked in the capture editor before anything logs (AI audit B3).
    expect(screen.getByRole("button", { name: "Check and log" })).toBeTruthy();
    // A menu's picks are image cards (U25): a tap opens the larger card, which logs.
    const picks = screen.getByRole("list", { name: "Menu picks" });
    const card = Array.from(picks.querySelectorAll("button[aria-expanded]"))
      .find((button) => button.closest("[data-recipe-card]")?.textContent?.includes("Grilled salmon, greens"))!;
    fireEvent.click(card);
    expect(screen.getByRole("button", { name: "Log Grilled salmon, greens" })).toBeTruthy();
  });

  it("renders DocumentPlan's matched meal and left-out foods", () => {
    render(<DesignGallery />);
    expect(screen.getByText("Honey (1 tsp): Not in your foods yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use for this meal" })).toBeTruthy();
  });

  it("shows the new colour tokens by name", () => {
    render(<DesignGallery />);
    expect(screen.getByText("orange-warm rim")).toBeTruthy();
    expect(screen.getByText("sage-wash / sage-ink")).toBeTruthy();
    expect(screen.getByText("field")).toBeTruthy();
  });

  it("mounts the Cards section: every CardFrame size, level and tone", () => {
    render(<DesignPage />);
    const cards = screen.getByRole("region", { name: "Cards" });
    for (const size of ["sm", "md", "lg"]) expect(cards.querySelector(`.card-${size}`)).toBeTruthy();
    for (const tone of ["ivory", "recess", "olive"]) expect(cards.querySelector(`.card-${tone}`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Card again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Whole card is a button" }));
    expect(screen.getByText("Taps: 1")).toBeTruthy();
  });
});
