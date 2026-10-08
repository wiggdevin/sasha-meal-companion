// @vitest-environment jsdom
/** One plain question per missing fact, in US units, stored metric (live QA 2026-10-07). */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactQuestion } from "@/components/Onboarding/facts/FactQuestion";
import { emptyFacts } from "@/components/Onboarding/facts/types";

afterEach(cleanup);
const TODAY = new Date("2026-10-07T00:00:00.000Z");

describe("FactQuestion", () => {
  it("asks age in years and stores a birth year", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="birthYear" facts={emptyFacts()} today={TODAY} onAnswer={onAnswer} />);
    screen.getByText("How old are you?");
    fireEvent.change(screen.getByLabelText("Age"), { target: { value: "34" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "birthYear", value: 1992 });
  });

  it("asks height in feet and inches, never cm, and stores cm", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="heightCm" facts={emptyFacts()} onAnswer={onAnswer} />);
    expect(screen.queryByText(/cm/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Feet"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Inches"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "heightCm", value: 177.8 });
  });

  it("asks weight in pounds, never kg, and stores kg", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={emptyFacts()} onAnswer={onAnswer} />);
    expect(screen.queryByText(/kg/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Weight"), { target: { value: "165" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 74.8 });
  });

  it("refuses an out-of-range answer with a plain message", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="birthYear" facts={emptyFacts()} today={TODAY} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Age"), { target: { value: "4" } });
    screen.getByRole("alert");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pre-fills a guessed value so one tap confirms it", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={{ weightKg: 75, confidence: { weightKg: 0.6 } }} onAnswer={onAnswer} />);
    expect((screen.getByLabelText("Weight") as HTMLInputElement).value).toBe("165");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 74.8 });
  });
});
