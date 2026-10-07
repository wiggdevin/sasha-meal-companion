// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WeighInField, { SUGGESTIONS_ASK, TREND_ASK } from "@/components/coach/attachments/WeighInField";
import { WEIGH_IN_UNDO_MS, parseWeight, type WeightToken, type WeightWriter } from "@/components/coach/attachments/weigh-in";
import { CONFIRM_MS } from "@/components/ui/useButtonStatus";

/** The weight path stands in for lib/coach/apply-body (applyLogWeight / undoLogWeight). */
const token = { kind: "log_weight", date: "2026-10-04", previousLb: null, tz: "UTC" } as WeightToken;

function writer(overrides: Partial<WeightWriter> = {}) {
  return {
    log: vi.fn(async () => ({ token, note: null })),
    undo: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A dock-like owner: it keeps the typed value, the way AssistantField does. */
function Field({ w, onAsk = () => {}, initial = "", unit = "lb" as const }: {
  w: WeightWriter; onAsk?: (text: string) => void; initial?: string; unit?: "lb" | "kg";
}) {
  return <Holder initial={initial}>{(value, set) =>
    <WeighInField unit={unit} value={value} onValueChange={set} onAsk={onAsk} onClose={() => {}} writer={w} />}
  </Holder>;
}
import { useState, type ReactNode } from "react";
function Holder({ initial, children }: { initial: string; children: (v: string, s: (v: string) => void) => ReactNode }) {
  const [value, setValue] = useState(initial);
  return <>{children(value, setValue)}</>;
}

async function settle(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("parseWeight", () => {
  it("converts the account's unit to kilograms and keeps the coach's range", () => {
    expect(parseWeight("180", "lb")).toEqual({ kg: 180 / 2.2046226218 });
    expect(parseWeight("81,5", "kg")).toEqual({ kg: 81.5 });
    expect(parseWeight("abc", "lb")).toEqual({ hint: "Enter your weight in lb." });
    expect(parseWeight("900", "lb")).toEqual({ hint: "Enter a weight between 45 and 881 lb." });
    expect(parseWeight("10", "kg")).toEqual({ hint: "Enter a weight between 20 and 400 kg." });
  });
});

describe("the weigh-in card", () => {
  it("logs directly, confirms in the button, then turns into the follow-ups with an exact undo", async () => {
    const w = writer();
    render(<Field w={w} initial="180.4" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(0);
    expect(w.log).toHaveBeenCalledWith(180.4 / 2.2046226218);
    expect(screen.getByRole("button", { name: "Log" }).getAttribute("data-status")).toBe("success");

    await settle(CONFIRM_MS);
    expect(screen.getByText(/Logged 180\.4 lb/)).toBeTruthy();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(document.activeElement).toBe(undo);

    fireEvent.click(undo);
    await settle(0);
    expect(w.undo).toHaveBeenCalledWith(token);
    await settle(CONFIRM_MS);
    // Back to the entry, with the number that was taken back, ready to correct.
    expect((screen.getByRole("textbox", { name: "Weight in lb" }) as HTMLInputElement).value).toBe("180.4");
  });

  it("offers Undo for eight seconds only, and moves focus off it when it goes", async () => {
    render(<Field w={writer()} initial="80" unit="kg" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(CONFIRM_MS);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.focus(screen.getByRole("button", { name: "Undo" }));
    screen.getByRole("button", { name: "Undo" }).focus();
    await settle(WEIGH_IN_UNDO_MS + 100);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Your trend" }));
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
  });

  it("asks the chat for the trend or suggestions, and never for the log itself", async () => {
    const onAsk = vi.fn();
    render(<Field w={writer()} initial="80" unit="kg" onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(CONFIRM_MS);
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Your trend" }));
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    expect(onAsk.mock.calls).toEqual([[TREND_ASK], [SUGGESTIONS_ASK]]);
  });

  it("keeps the number and says why when the weight did not save", async () => {
    const w = writer({ log: vi.fn(async () => { throw new Error("No connection. Try again."); }) });
    render(<Field w={w} initial="80" unit="kg" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(0);
    expect(screen.getByRole("alert").textContent).toContain("No connection. Try again.");
    expect((screen.getByRole("textbox", { name: "Weight in kg" }) as HTMLInputElement).value).toBe("80");
  });

  it("says when the undo did not hold, and keeps Undo to try again inside its window", async () => {
    const undo = vi.fn<WeightWriter["undo"]>()
      .mockRejectedValueOnce(new Error("No connection. Try again."))
      .mockResolvedValueOnce(undefined);
    const w = writer({ undo });
    render(<Field w={w} initial="80" unit="kg" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(CONFIRM_MS);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await settle(0);
    expect(screen.getByRole("alert").textContent).toContain("No connection. Try again.");
    // Still there, saying it can be tried again.
    const again = screen.getByRole("button", { name: "Undo" });
    expect(again.getAttribute("data-status")).toBe("error");
    expect(again.textContent).toContain("Try again");
    fireEvent.click(again);
    await settle(0);
    expect(undo).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(CONFIRM_MS);
    expect((screen.getByRole("textbox", { name: "Weight in kg" }) as HTMLInputElement).value).toBe("80");
  });

  it("lets a failed undo go once its window has passed", async () => {
    const w = writer({ undo: vi.fn(async () => { throw new Error("Weight kept — edit it in Settings"); }) });
    render(<Field w={w} initial="80" unit="kg" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(CONFIRM_MS);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await settle(0);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    await settle(WEIGH_IN_UNDO_MS + 100);
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("Weight kept — edit it in Settings");
  });

  it("draws Undo as a ghost action with no underline", async () => {
    render(<Field w={writer()} initial="80" unit="kg" />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await settle(CONFIRM_MS);
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.className).toMatch(/\bbtn-ghost\b/);
    expect(undo.className).not.toMatch(/underline/);
    for (const name of ["Your trend", "Suggestions"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/\bbtn-secondary\b.*\bbtn-sm\b/);
    }
  });
});
