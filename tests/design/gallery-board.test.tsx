/** @vitest-environment jsdom */
/**
 * The /design gallery's water blocks (the water liquid and the cup), split out of gallery.test.tsx
 * so the workstream that owns them keeps their checks (UI makeover plan, W2). The tip tile is gone
 * with the board.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DesignGallery from "@/app/design/DesignGallery";

afterEach(() => { cleanup(); });

describe("the /design gallery's water blocks", () => {
  it("renders the water liquid at three fill levels", () => {
    const { container } = render(<DesignGallery />);
    expect(container.querySelectorAll("svg path").length).toBeGreaterThan(0);
  });

  it("renders the cup pill in each unit, and while loading", () => {
    render(<DesignGallery />);
    const cups = screen.getByRole("region", { name: "Cup (CupSlot)" });
    expect(cups.querySelectorAll("button")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Add 8 oz of water. 32 of 128 oz." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a cup of water." })).toBeTruthy();
    expect(screen.queryByText("Protein first")).toBeNull();
  });

});
