// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SexChipRow } from "@/components/Onboarding/facts/SexChipRow";
import { PREFER_NOT_TO_SAY_NOTE } from "@/components/Onboarding/facts/types";

afterEach(cleanup);

describe("SexChipRow", () => {
  it("renders Female, Male and Prefer not to say as equal, unselected chips with no default", () => {
    render(<SexChipRow onSelect={() => {}} />);
    for (const label of ["Female", "Male", "Prefer not to say"]) {
      const chip = screen.getByRole("button", { name: label });
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("requires its own tap for Prefer not to say and shows the owner-approved note, with no explanation of why", () => {
    const onSelect = vi.fn();
    render(<SexChipRow onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Prefer not to say" }));
    expect(onSelect).toHaveBeenCalledWith("unspecified");
  });

  it("shows the reassurance line only once Prefer not to say is the selected value", () => {
    render(<SexChipRow value="unspecified" onSelect={() => {}} />);
    expect(screen.getByText(PREFER_NOT_TO_SAY_NOTE)).toBeTruthy();
  });

  it("shows no reassurance line for male or female", () => {
    render(<SexChipRow value="male" onSelect={() => {}} />);
    expect(screen.queryByText(PREFER_NOT_TO_SAY_NOTE)).toBeNull();
  });
});
