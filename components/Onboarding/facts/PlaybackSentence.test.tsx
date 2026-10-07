// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackSentence } from "@/components/Onboarding/facts/PlaybackSentence";
import { SentenceChip } from "@/components/Onboarding/facts/SentenceChip";
import { emptyFacts, type OnboardingFacts } from "@/components/Onboarding/facts/types";

afterEach(cleanup);

const TODAY = new Date("2026-10-07T00:00:00.000Z");

const NOOP_PROPS = {
  onHoldEdit: () => {},
  onGhostConfirm: () => {},
  onEmptyTap: () => {},
  onBirthYearNudge: () => {},
  onConfirmAll: () => {},
};

describe("PlaybackSentence at zero confidence", () => {
  it("renders every required field as an empty slot and shows no That's me button", () => {
    render(<PlaybackSentence facts={emptyFacts()} today={TODAY} {...NOOP_PROPS} />);
    // VISUAL-SPEC.md §5's gap-prompt copy verbatim — never developer-style "[field?]" placeholder
    // text, never the bare field name (coord.md 2026-10-07; VISUAL-SPEC.md 2026-10-07).
    expect(screen.getByText("how old?")).toBeTruthy();
    expect(screen.getByText("add this")).toBeTruthy();
    expect(screen.getByText("how tall?")).toBeTruthy();
    expect(screen.getByText("and now?")).toBeTruthy();
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
    expect(screen.queryByText(/[[\]]/)).toBeNull();
    expect(screen.queryByText("That’s me")).toBeNull();
  });
});

describe("PlaybackSentence at partial confidence", () => {
  const facts: OnboardingFacts = {
    birthYear: 1992,
    heightCm: 178,
    confidence: { birthYear: 0.9, heightCm: 0.65 },
  };

  it("renders a high-confidence field as a value, a mid-confidence field as a ghost chip, and the rest as empty slots", () => {
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    // birthYear (0.9, high) renders through the in-chip stepper, which always shows the mapping.
    expect(screen.getByText(/34 → born 1992/)).toBeTruthy();
    // heightCm (0.65, mid) is a ghost chip needing its own tap, not an auto-confirmed value.
    const heightChip = screen.getByRole("button", { name: /height: 5'10" → 178 cm/i });
    expect(heightChip.getAttribute("data-chip-kind")).toBe("ghost");
    expect(screen.getByText("and now?")).toBeTruthy();
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
    // At least one high-confidence field exists, so the confirm-all affordance shows.
    expect(screen.getByText("That’s me")).toBeTruthy();
  });
});

describe("PlaybackSentence at full confidence", () => {
  const facts: OnboardingFacts = {
    birthYear: 1992, sex: "male", heightCm: 178, weightKg: 75, goal: "gain_muscle",
    confidence: { birthYear: 0.95, sex: 0.95, heightCm: 0.9, weightKg: 0.9, goal: 0.95 },
  };

  it("renders every field as a confirmed value and shows the That's me confirm", () => {
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.queryByText("how old?")).toBeNull();
    expect(screen.queryByText("add this")).toBeNull();
    expect(screen.getByRole("button", { name: /height: 5'10" → 178 cm/i })
      .getAttribute("data-chip-kind")).toBe("value");
    expect(screen.getByRole("button", { name: /weight: 165 lb → 75 kg/i })
      .getAttribute("data-chip-kind")).toBe("value");
    expect(screen.getByRole("button", { name: /goal: build muscle/i })).toBeTruthy();
    expect(screen.getByText("That’s me")).toBeTruthy();
  });

  it("calls onConfirmAll exactly once per tap on That's me, and nothing before it is tapped", () => {
    const onConfirmAll = vi.fn();
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS}
      onConfirmAll={onConfirmAll} />);
    expect(onConfirmAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("That’s me"));
    expect(onConfirmAll).toHaveBeenCalledTimes(1);
  });

  it("opens the editor, never silently re-saves, when a confirmed value chip is activated (Sol r3 re-plan)", () => {
    const onHoldEdit = vi.fn();
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} onHoldEdit={onHoldEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /weight: 165 lb → 75 kg/i }));
    expect(onHoldEdit).toHaveBeenCalledWith("weightKg");
  });
});

describe("PlaybackSentence with a ghost-confidence birth year", () => {
  it("still gives the stepper its own confirm action, distinct from nudging it (Sol r1 BLOCK)", () => {
    const onGhostConfirm = vi.fn();
    const onBirthYearNudge = vi.fn();
    const facts: OnboardingFacts = { birthYear: 1992, confidence: { birthYear: 0.65 } };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS}
      onGhostConfirm={onGhostConfirm} onBirthYearNudge={onBirthYearNudge} />);

    expect(screen.getByText(/34 → born 1992/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm birth year" }));
    expect(onGhostConfirm).toHaveBeenCalledWith("birthYear");
    expect(onBirthYearNudge).not.toHaveBeenCalled();
  });
});

describe("PlaybackSentence with a high-confidence birth year", () => {
  it("still gives it a real edit path beyond the stepper's +/- nudge (Sol r2 WARN)", () => {
    const onHoldEdit = vi.fn();
    const facts: OnboardingFacts = { birthYear: 1992, confidence: { birthYear: 0.95 } };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} onHoldEdit={onHoldEdit} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit birth year" }));
    expect(onHoldEdit).toHaveBeenCalledWith("birthYear");
  });
});

describe("PlaybackSentence against a malformed payload (Sol r2 WARN, generalized in the r3 re-plan)", () => {
  it.each([
    ["no value at all", { confidence: { goal: 0.95 } }],
    ["an explicit null", { goal: null as unknown as undefined, confidence: { goal: 0.95 } }],
    ["a non-finite score on a real value", { goal: "gain_muscle" as const, confidence: { goal: NaN } }],
  ])("treats a field with %s as empty, rendered through the plain-word gap prompt, not a value chip", (_label, partial) => {
    const facts: OnboardingFacts = { ...partial };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^goal:/ })).toBeNull();
  });

  it("never arms That's me on a confidence score with no backing value", () => {
    const facts: OnboardingFacts = { confidence: { goal: 0.95 } };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.queryByText("That’s me")).toBeNull();
  });

  it("treats a null birth year as empty, not a renderable stepper value", () => {
    const facts: OnboardingFacts = {
      birthYear: null as unknown as undefined, confidence: { birthYear: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText("how old?")).toBeTruthy();
    expect(screen.queryByText(/born/)).toBeNull();
  });

  it("treats an unrecognized enum string as empty, not a blank confirmed chip (Sol r4 BLOCK)", () => {
    // "gain_muscle" misspelled — a shape JSON.parse would happily hand back, with nothing in the
    // old "any non-blank string" rule to catch it.
    const facts: OnboardingFacts = {
      goal: "gainmuscle" as unknown as "gain_muscle", confidence: { goal: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^goal:/ })).toBeNull();
    expect(screen.queryByText("That’s me")).toBeNull();
  });

  it("treats a number on an enum field as empty, not just a mismatched string (Sol r5 BLOCK)", () => {
    const facts: OnboardingFacts = {
      goal: 123 as unknown as "gain_muscle", confidence: { goal: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
    expect(screen.queryByText("That’s me")).toBeNull();
  });

  it("treats a string on a numeric field as empty, not just a non-finite number (Sol r5 BLOCK)", () => {
    const facts: OnboardingFacts = {
      birthYear: "1992" as unknown as number, confidence: { birthYear: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText("how old?")).toBeTruthy();
    expect(screen.queryByText(/born/)).toBeNull();
  });

  it("never lets a hold that already fired also confirm on a later click (pointer leaves and returns, Sol r4 BLOCK)", () => {
    vi.useFakeTimers();
    const onHoldEdit = vi.fn();
    const onGhostConfirm = vi.fn();
    // A ghost chip (not "value"): it has both onActivate (confirm) and onHoldEdit (the hold
    // alternative) wired, so this is the one chip kind where the leave-and-return sequence could
    // let a completed hold's suppression slip and also fire the (wrong) primary action.
    const facts: OnboardingFacts = { heightCm: 178, confidence: { heightCm: 0.65 } };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS}
      onHoldEdit={onHoldEdit} onGhostConfirm={onGhostConfirm} />);
    const chip = screen.getByRole("button", { name: /height: 5'10" → 178 cm/i });

    fireEvent.pointerDown(chip);
    vi.advanceTimersByTime(600); // hold fires, opens the editor once, while still physically held
    fireEvent.pointerLeave(chip); // finger drifts off the chip's edge, still held
    fireEvent.pointerUp(chip); // finger lifts
    fireEvent.click(chip); // the browser's own click after the pointer lifts, one continuous press

    expect(onHoldEdit).toHaveBeenCalledTimes(1); // only the original hold
    expect(onGhostConfirm).not.toHaveBeenCalled(); // never also read as a confirm
    vi.useRealTimers();
  });
});

describe("SentenceChip activation (Sol r3 re-plan: one click-driven onActivate)", () => {
  it("never calls onActivate when the press is held past the hold threshold", () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    const onHoldEdit = vi.fn();
    render(<SentenceChip kind="ghost" label={`5'10" → 178 cm`} onActivate={onActivate}
      onHoldEdit={onHoldEdit} />);
    const chip = screen.getByRole("button", { name: /5'10/ });

    fireEvent.pointerDown(chip);
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(chip);
    // The browser still fires a click after the pointer lifts; the hold must swallow it.
    fireEvent.click(chip);

    expect(onHoldEdit).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("calls onActivate, not onHoldEdit, for a quick press released before the hold threshold", () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    const onHoldEdit = vi.fn();
    render(<SentenceChip kind="ghost" label={`5'10" → 178 cm`} onActivate={onActivate}
      onHoldEdit={onHoldEdit} />);
    const chip = screen.getByRole("button", { name: /5'10/ });

    fireEvent.pointerDown(chip);
    vi.advanceTimersByTime(100);
    fireEvent.pointerUp(chip);
    fireEvent.click(chip);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onHoldEdit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("commits neither action when the press is cancelled before the threshold (pointer leaves the chip, no click follows)", () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    const onHoldEdit = vi.fn();
    render(<SentenceChip kind="value" label="178 cm" onActivate={onActivate} onHoldEdit={onHoldEdit} />);
    const chip = screen.getByRole("button", { name: "178 cm" });

    fireEvent.pointerDown(chip);
    vi.advanceTimersByTime(100);
    fireEvent.pointerLeave(chip);
    vi.advanceTimersByTime(600);
    // No click: a real browser does not fire one when the pointer leaves before lifting.

    expect(onActivate).not.toHaveBeenCalled();
    expect(onHoldEdit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("activates on a plain click with no prior pointer sequence — the keyboard/assistive-tech path (Sol r1+r2+r3 BLOCKs)", () => {
    const onActivate = vi.fn();
    render(<SentenceChip kind="ghost" label="build muscle" onActivate={onActivate} />);
    // Enter, Space and an assistive-tech activation all dispatch a native `click` on a real
    // <button> with no pointer events at all — this is exactly that shape of event.
    fireEvent.click(screen.getByRole("button", { name: "build muscle" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens the editor on a plain click for a confirmed value chip with no onHoldEdit wired", () => {
    const onActivate = vi.fn();
    render(<SentenceChip kind="value" label="178 cm" onActivate={onActivate} />);
    fireEvent.click(screen.getByRole("button", { name: "178 cm" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("fully resets after a genuine pointer cancel, even once a hold already fired, so the next click still works (Sol r5 WARN)", () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    const onHoldEdit = vi.fn();
    render(<SentenceChip kind="ghost" label="build muscle" onActivate={onActivate}
      onHoldEdit={onHoldEdit} />);
    const chip = screen.getByRole("button", { name: "build muscle" });

    fireEvent.pointerDown(chip);
    vi.advanceTimersByTime(600); // hold fires
    fireEvent.pointerCancel(chip); // the browser voids the gesture outright — no click follows it
    vi.useRealTimers();

    // A later, unrelated activation (e.g. a keyboard press) must not be swallowed by a stale flag.
    fireEvent.click(chip);
    expect(onHoldEdit).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackSentence with activity (BRIEF §2 Optional, VISUAL-SPEC.md §5)", () => {
  it("never renders activity as a forced empty ask, and never gates pointingAt or That's me on it", () => {
    const facts: OnboardingFacts = { confidence: {} };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.queryByText("how active?")).toBeNull();
  });

  it("appends a trailing clause once activity has a real value, without affecting the required chips", () => {
    const facts: OnboardingFacts = {
      birthYear: 1992, sex: "male", heightCm: 178, weightKg: 75, goal: "gain_muscle",
      activity: "moderate",
      confidence: {
        birthYear: 0.95, sex: 0.95, heightCm: 0.9, weightKg: 0.9, goal: 0.95, activity: 0.9,
      },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByRole("button", { name: /activity level: moderately active/i })).toBeTruthy();
  });

  it("treats an unrecognized activity string as empty, same as any other enum field", () => {
    const facts: OnboardingFacts = {
      activity: "very-busy" as unknown as "moderate", confidence: { activity: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.queryByText("how active?")).toBeNull();
    expect(screen.queryByRole("button", { name: /^activity level:/i })).toBeNull();
  });
});

describe("PlaybackSentence punctuation (Sol r6 WARN)", () => {
  it("never double-punctuates an empty goal gap prompt with a stray period", () => {
    render(<PlaybackSentence facts={emptyFacts()} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.queryByText("what’s the goal?.")).toBeNull();
    expect(screen.getByText("what’s the goal?")).toBeTruthy();
  });

  it("puts the closing period after the goal, not mid-sentence, when activity follows it", () => {
    const facts: OnboardingFacts = {
      birthYear: 1992, sex: "male", heightCm: 178, weightKg: 75, goal: "gain_muscle",
      activity: "moderate",
      confidence: {
        birthYear: 0.95, sex: 0.95, heightCm: 0.9, weightKg: 0.9, goal: 0.95, activity: 0.9,
      },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    // The goal chip's own label never carries a period (it would read "build muscle." mid-sentence).
    expect(screen.getByRole("button", { name: "goal: build muscle" })).toBeTruthy();
    // The sentence does still end with one, after the activity clause.
    expect(screen.getByText(".")).toBeTruthy();
  });

  it("still ends with exactly one period when goal is resolved and no activity follows", () => {
    const facts: OnboardingFacts = {
      birthYear: 1992, sex: "male", heightCm: 178, weightKg: 75, goal: "gain_muscle",
      confidence: { birthYear: 0.95, sex: 0.95, heightCm: 0.9, weightKg: 0.9, goal: 0.95 },
    };
    render(<PlaybackSentence facts={facts} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getAllByText(".")).toHaveLength(1);
  });

  it("gives the empty weight gap prompt a weight cue, not a free-floating “and now?”", () => {
    render(<PlaybackSentence facts={emptyFacts()} today={TODAY} {...NOOP_PROPS} />);
    expect(screen.getByText(", weight")).toBeTruthy();
    expect(screen.getByText("and now?")).toBeTruthy();
  });
});
