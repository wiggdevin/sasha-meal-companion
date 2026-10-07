import { describe, expect, it, vi } from "vitest";
import { nextBestAction, type NextActionFlags } from "@/lib/coach/next-action";

const NONE: NextActionFlags = {
  hasUnloggedMealToday: false, hasPendingProfileConfirmation: false,
  hasUncheckedLabelFood: false, hasSuggestionsAvailable: false,
};

describe("nextBestAction — deterministic ranking", () => {
  it("returns null when nothing in turn state is eligible", async () => {
    expect(await nextBestAction(NONE)).toBeNull();
  });

  it("picks the single eligible action when only one flag is set", async () => {
    expect(await nextBestAction({ ...NONE, hasSuggestionsAvailable: true }))
      .toEqual({ kind: "pick_suggestion", label: "Pick from your suggestions" });
  });

  it("food-safety follow-ups outrank logging on an unlogged day", async () => {
    const result = await nextBestAction({
      hasUnloggedMealToday: true, hasPendingProfileConfirmation: true,
      hasUncheckedLabelFood: true, hasSuggestionsAvailable: true,
    });
    expect(result?.kind).toBe("confirm_rule");
  });

  it("an unchecked label outranks logging on an unlogged day", async () => {
    expect((await nextBestAction({ ...NONE, hasUnloggedMealToday: true,
      hasUncheckedLabelFood: true }))?.kind).toBe("check_label");
  });

  it("logging outranks picking a suggestion on an unlogged day", async () => {
    expect((await nextBestAction({ ...NONE, hasUnloggedMealToday: true,
      hasSuggestionsAvailable: true }))?.kind).toBe("log_meal");
  });

  it("a suggestion never outranks a pending confirmation or an unchecked label", async () => {
    const result = await nextBestAction({
      ...NONE, hasPendingProfileConfirmation: true, hasSuggestionsAvailable: true,
    });
    expect(result?.kind).toBe("confirm_rule");
  });

  it("never calls Jev when there is no tie", async () => {
    const jevChoice = vi.fn();
    await nextBestAction({ ...NONE, hasUnloggedMealToday: true }, jevChoice);
    expect(jevChoice).not.toHaveBeenCalled();
  });
});

describe("nextBestAction — the tie (confirm_rule vs. check_label)", () => {
  const TIE: NextActionFlags = {
    ...NONE, hasUnloggedMealToday: true,
    hasPendingProfileConfirmation: true, hasUncheckedLabelFood: true,
  };

  it("calls Jev with exactly the tied candidates and follows its choice", async () => {
    const jevChoice = vi.fn().mockResolvedValue("check_label");
    const result = await nextBestAction(TIE, jevChoice);
    expect(jevChoice).toHaveBeenCalledWith(["confirm_rule", "check_label"]);
    expect(result?.kind).toBe("check_label");
  });

  it("falls back to the fixed order when Jev has no port", async () => {
    expect((await nextBestAction(TIE))?.kind).toBe("confirm_rule");
  });

  it("falls back to the fixed order when Jev declines (returns null)", async () => {
    const jevChoice = vi.fn().mockResolvedValue(null);
    expect((await nextBestAction(TIE, jevChoice))?.kind).toBe("confirm_rule");
  });

  it("falls back to the fixed order when Jev errors, never throwing", async () => {
    const jevChoice = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(nextBestAction(TIE, jevChoice)).resolves.toEqual({
      kind: "confirm_rule", label: "Confirm this rule",
    });
  });

  it("ignores a Jev answer outside the tied set", async () => {
    const jevChoice = vi.fn().mockResolvedValue("pick_suggestion");
    expect((await nextBestAction(TIE, jevChoice))?.kind).toBe("confirm_rule");
  });
});
