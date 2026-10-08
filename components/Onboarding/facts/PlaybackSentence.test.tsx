// @vitest-environment jsdom
/**
 * The facts recap (live QA 2026-10-07, defect 4): answers only, one inline sentence, US units,
 * no placeholder words, every value a tap-to-change chip of at least 44 px.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  firstMissingField, firstUnconfirmedField, PlaybackSentence,
} from "@/components/Onboarding/facts/PlaybackSentence";
import { emptyFacts, type OnboardingFacts } from "@/components/Onboarding/facts/types";

afterEach(cleanup);

const TODAY = new Date("2026-10-07T00:00:00.000Z");
const FULL: OnboardingFacts = {
  birthYear: 1992, sex: "female", heightCm: 178, weightKg: 75, goal: "lose_fat",
  confidence: { birthYear: 1, sex: 1, heightCm: 1, weightKg: 1, goal: 1 },
};

describe("PlaybackSentence", () => {
  it("renders nothing before any answer", () => {
    const { container } = render(<PlaybackSentence facts={emptyFacts()} today={TODAY} onEdit={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("reads every answer back as one sentence in US units, punctuation attached", () => {
    render(<PlaybackSentence facts={FULL} today={TODAY} onEdit={vi.fn()} />);
    const recap = screen.getByTestId("facts-recap");
    expect(recap.tagName).toBe("P");
    expect(recap.textContent).toBe("You’re 34, female, 5′10″, 165 lb, and want to lose fat.");
    expect(recap.textContent).not.toMatch(/cm|kg| ,|add this|and now\?|how old\?/);
  });

  it("starts from the goal alone when it is the only answer", () => {
    render(<PlaybackSentence facts={{ goal: "gain_muscle", confidence: { goal: 1 } }} today={TODAY} onEdit={vi.fn()} />);
    expect(screen.getByTestId("facts-recap").textContent).toBe("You want to build muscle.");
  });

  it("marks a guessed value with a question mark and opens its question on tap", () => {
    const onEdit = vi.fn();
    render(<PlaybackSentence facts={{ weightKg: 75, confidence: { weightKg: 0.6 } }} today={TODAY} onEdit={onEdit} />);
    const chip = screen.getByRole("button", { name: /Your weight: 165 lb\? Tap to confirm/ });
    expect(chip.getAttribute("data-chip-kind")).toBe("ghost");
    expect(chip.className).toContain("min-h-11");
    fireEvent.click(chip);
    expect(onEdit).toHaveBeenCalledWith("weightKg");
  });

  it("a confirmed value opens its question again on tap", () => {
    const onEdit = vi.fn();
    render(<PlaybackSentence facts={FULL} today={TODAY} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /Your height: 5′10″\. Tap to change/ }));
    expect(onEdit).toHaveBeenCalledWith("heightCm");
  });
});

describe("question order helpers", () => {
  it("asks the first required field not yet confirmed, a ghost included", () => {
    expect(firstUnconfirmedField(emptyFacts())).toBe("birthYear");
    expect(firstUnconfirmedField({ birthYear: 1992, confidence: { birthYear: 0.6 } })).toBe("birthYear");
    expect(firstUnconfirmedField({ ...FULL, confidence: { ...FULL.confidence, weightKg: 0.6 } })).toBe("weightKg");
    expect(firstUnconfirmedField(FULL)).toBeNull();
  });

  it("firstMissingField ignores a ghost value", () => {
    expect(firstMissingField({ birthYear: 1992, confidence: { birthYear: 0.6 } })).toBe("sex");
  });
});
