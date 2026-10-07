// @vitest-environment jsdom

/**
 * Phase 18 W2a UI hand-off (spec §7.2): AllergenFindingLines is the one shared renderer for the
 * barcode card, a scanned label and a matched capture item — fixing its copy fixes the held
 * finding's text everywhere it renders. A held finding's own `text` is the generic
 * `HELD_ALLERGEN_TEXT` (lib/policy/allergen-holds.ts), with no allergen name; two held findings
 * on the same food would otherwise read as two identical, unexplained lines. This names the
 * allergen in front of the imported constant, never retyping its words, and leaves every other
 * finding's text (which already names its own allergen) unchanged.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AllergenFindingLines from "@/components/coach/editors/AllergenFindingLines";
import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";

afterEach(() => { cleanup(); });

describe("AllergenFindingLines: a held finding names its allergen", () => {
  it("prefixes the held finding's text with the allergen's label", () => {
    render(<AllergenFindingLines findings={[
      { allergen: "peanut", outcome: "unknown", text: HELD_ALLERGEN_TEXT },
    ]} />);

    expect(screen.getByText(`Peanut: ${HELD_ALLERGEN_TEXT}`)).toBeTruthy();
  });

  it("gives each held allergen its own distinguishable line", () => {
    render(<AllergenFindingLines findings={[
      { allergen: "peanut", outcome: "unknown", text: HELD_ALLERGEN_TEXT },
      { allergen: "dairy", outcome: "unknown", text: HELD_ALLERGEN_TEXT },
    ]} />);

    expect(screen.getByText(`Peanut: ${HELD_ALLERGEN_TEXT}`)).toBeTruthy();
    expect(screen.getByText(`Dairy: ${HELD_ALLERGEN_TEXT}`)).toBeTruthy();
  });

  it("leaves a non-held finding's own text unchanged", () => {
    render(<AllergenFindingLines findings={[
      { allergen: "dairy", outcome: "present", text: "Contains dairy" },
      { allergen: "gluten", outcome: "unknown", text: "Check the label for gluten" },
    ]} />);

    expect(screen.getByText("Contains dairy")).toBeTruthy();
    expect(screen.getByText("Check the label for gluten")).toBeTruthy();
  });
});
