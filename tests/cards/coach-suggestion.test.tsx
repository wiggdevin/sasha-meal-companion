// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CoachSuggestion from "@/components/CoachSuggestion";
import type { CoachSuggestion as Suggestion } from "@/lib/coach/types";

afterEach(cleanup);

const suggestion = (verdict: Suggestion["verdict"]): Suggestion => ({
  foodRefId: "food-1", name: "Oat drink", grams: 200, reason: null, verdict,
});

describe("CoachSuggestion", () => {
  it("explains that unverified means food rules were not checked, not nutrition or taste", () => {
    render(<CoachSuggestion suggestion={suggestion("unverified")} />);
    expect(screen.getByText("Unverified")).toBeTruthy();
    fireEvent.click(screen.getByText("Unverified"));
    expect(screen.getByText(/Could not verify this food against your food rules/)).toBeTruthy();
    expect(screen.getByText(/nothing about its nutrition or taste/)).toBeTruthy();
  });

  it("keeps the log action limited to allowed suggestions", () => {
    const onLog = vi.fn();
    const { rerender } = render(<CoachSuggestion suggestion={suggestion("unverified")} onLog={onLog} />);
    expect(screen.queryByRole("button", { name: "Log this" })).toBeNull();
    rerender(<CoachSuggestion suggestion={suggestion("allowed")} onLog={onLog} />);
    fireEvent.click(screen.getByRole("button", { name: "Log this" }));
    expect(onLog).toHaveBeenCalledOnce();
  });
});
