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

  it("asks height in one typed box, read the way people say it, never cm, and stores cm", () => {
    for (const typed of ["5 10", "5'10\"", "5ft 10in", "70 in"]) {
      const onAnswer = vi.fn();
      render(<FactQuestion field="heightCm" facts={emptyFacts()} onAnswer={onAnswer} />);
      expect(screen.queryByText(/cm/)).toBeNull();
      const box = screen.getByLabelText("Height") as HTMLInputElement;
      expect(box.type).toBe("text");
      fireEvent.change(box, { target: { value: typed } });
      screen.getByText("5 ft 10 in");
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(onAnswer).toHaveBeenCalledWith({ key: "heightCm", value: 177.8 });
      cleanup();
    }
  });

  it("refuses a height it cannot read, with a plain message", () => {
    render(<FactQuestion field="heightCm" facts={emptyFacts()} onAnswer={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "10 foot" } });
    screen.getByRole("alert");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("age is a plain typed box with a numeric keypad, no stepper, empty to start", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="birthYear" facts={emptyFacts()} today={TODAY} onAnswer={onAnswer} />);
    const box = screen.getByLabelText("Age") as HTMLInputElement;
    expect(box.type).toBe("text");
    expect(box.inputMode).toBe("numeric");
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "birthYear", value: 1956 });
  });

  it("accepts an under-18 age so the shell can show its adult-only stop", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="birthYear" facts={emptyFacts()} today={TODAY} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Age"), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "birthYear", value: 2010 });
  });

  it("asks weight in pounds, never kg, and stores kg", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={emptyFacts()} onAnswer={onAnswer} />);
    expect(screen.queryByText(/kg/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Weight"), { target: { value: "165 lbs" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 74.8 });
  });

  it("refuses an out-of-range answer with a plain message", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="birthYear" facts={emptyFacts()} today={TODAY} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Age"), { target: { value: "111" } });
    screen.getByRole("alert");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pre-fills a guessed value so one tap confirms it", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={{ weightKg: 75, confidence: { weightKg: 0.6 } }} onAnswer={onAnswer} />);
    expect((screen.getByLabelText("Weight") as HTMLInputElement).value).toBe("165.3");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 75 });
  });

  it("reopening a precise stored weight shows its pounds and re-saves the same kg (Sol p0 WARN)", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={{ weightKg: 72.35, confidence: { weightKg: 1 } }} onAnswer={onAnswer} />);
    expect((screen.getByLabelText("Weight") as HTMLInputElement).value).toBe("159.5");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 72.35 });
  });

  it("an edited weight is a new measurement, converted from the pounds typed", () => {
    const onAnswer = vi.fn();
    render(<FactQuestion field="weightKg" facts={{ weightKg: 72.35, confidence: { weightKg: 1 } }} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Weight"), { target: { value: "160.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAnswer).toHaveBeenCalledWith({ key: "weightKg", value: 72.8 });
  });

  it("reopening a stored height or age re-saves the stored value unchanged", () => {
    const onHeight = vi.fn();
    render(<FactQuestion field="heightCm" facts={{ heightCm: 177.3, confidence: { heightCm: 1 } }} onAnswer={onHeight} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onHeight).toHaveBeenCalledWith({ key: "heightCm", value: 177.3 });
    cleanup();
    const onAge = vi.fn();
    render(<FactQuestion field="birthYear" facts={{ birthYear: 1990, confidence: { birthYear: 1 } }} today={TODAY} onAnswer={onAge} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onAge).toHaveBeenCalledWith({ key: "birthYear", value: 1990 });
  });
});
