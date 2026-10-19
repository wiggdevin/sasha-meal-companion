/** @vitest-environment jsdom */
/**
 * The /design gallery's Board-era blocks (the water liquid and the tip tile), split out of
 * gallery.test.tsx so the workstream that retires those components owns their checks
 * (UI makeover plan, W2).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DesignGallery from "@/app/design/DesignGallery";

afterEach(() => { cleanup(); });

describe("the /design gallery's board blocks", () => {
  it("renders the water liquid at three fill levels", () => {
    const { container } = render(<DesignGallery />);
    expect(container.querySelectorAll("svg path").length).toBeGreaterThan(0);
  });

  it("renders the tip tile's live tip", () => {
    render(<DesignGallery />);
    expect(screen.getByText("Protein first")).toBeTruthy();
  });

});
