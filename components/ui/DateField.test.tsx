// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DateField from "./DateField";
import { formatFieldDate, monthCells, shiftMonth, validIsoDay } from "./DatePickerSheet";

afterEach(cleanup);

const TODAY = "2026-10-01";

function open(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog", { name: /Scan date/ });
}

function heading(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: /choose month and year/ }).textContent;
}

describe("date helpers", () => {
  it("reads only real calendar days and formats them for the field", () => {
    expect(validIsoDay("2026-02-30")).toBeNull();
    expect(validIsoDay("")).toBeNull();
    expect(validIsoDay("2028-02-29")).toBe("2028-02-29");
    expect(formatFieldDate("2026-09-03")).toBe("3 Sep 2026");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("lays a month out in six Monday-first weeks", () => {
    const cells = monthCells("2026-09"); // 1 September 2026 is a Tuesday
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBe("2026-09-01");
    expect(cells[30]).toBe("2026-09-30");
    expect(cells[31]).toBeNull();
  });
});

describe("DateField", () => {
  it("shows the friendly date or a muted placeholder, never the ISO string", () => {
    const view = render(<DateField aria-label="Scan date" value="2026-09-03" onChange={() => {}} today={TODAY} />);
    const field = screen.getByRole("button", { name: "Scan date, 3 Sep 2026" }) as HTMLButtonElement;
    expect(field.textContent).toBe("3 Sep 2026");
    expect(field.value).toBe("2026-09-03");
    view.rerender(<DateField aria-label="Scan date" value={null} onChange={() => {}} today={TODAY} />);
    expect(screen.getByRole("button", { name: "Scan date, no date chosen" }).textContent).toBe("Choose a date");
  });

  it("opens the sheet on the chosen month; a tap moves the lens and Done commits", async () => {
    const change = vi.fn();
    render(<DateField aria-label="Scan date" value="2026-09-03" onChange={change} today={TODAY} />);
    const dialog = open(/Scan date/);
    expect(heading(dialog)).toContain("September 2026");
    expect(within(dialog).getByText("Thursday 3 September 2026")).toBeTruthy();
    const day = within(dialog).getByRole("button", { name: "Saturday 12 September 2026" });
    fireEvent.click(day);
    expect(change).not.toHaveBeenCalled();
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByText("Saturday 12 September 2026")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(change).toHaveBeenCalledWith("2026-09-12");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
  });

  it("marks today and disables days outside min and max", () => {
    render(<DateField aria-label="Scan date" value={null} onChange={() => {}} today={TODAY}
      min="2026-09-15" max={TODAY} />);
    const dialog = open(/Scan date/);
    expect(heading(dialog)).toContain("October 2026");
    const today = within(dialog).getByRole("button", { name: "Thursday 1 October 2026, today" }) as HTMLButtonElement;
    expect(today.getAttribute("aria-current")).toBe("date");
    expect(today.disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Friday 2 October 2026" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous month" }));
    expect(heading(dialog)).toContain("September 2026");
    expect((within(dialog).getByRole("button", { name: "Monday 14 September 2026" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Tuesday 15 September 2026" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears to null when Clear is offered", () => {
    const change = vi.fn();
    render(<DateField aria-label="Scan date" value="2026-09-03" onChange={change} today={TODAY} allowClear />);
    fireEvent.click(within(open(/Scan date/)).getByRole("button", { name: "Clear" }));
    expect(change).toHaveBeenCalledWith(null);
  });

  it("offers no Clear unless asked, or with nothing saved to clear", async () => {
    const view = render(<DateField aria-label="Scan date" value="2026-09-03" onChange={() => {}} today={TODAY} />);
    expect(within(open(/Scan date/)).queryByRole("button", { name: "Clear" })).toBeNull();
    view.unmount();
    render(<DateField aria-label="Scan date" value={null} onChange={() => {}} today={TODAY} allowClear />);
    expect(within(open(/Scan date/)).queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("steps months with the arrows and jumps through the month grid", () => {
    render(<DateField aria-label="Scan date" value="2026-01-20" onChange={() => {}} today={TODAY} />);
    const dialog = open(/Scan date/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous month" }));
    expect(heading(dialog)).toContain("December 2025");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next month" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next month" }));
    expect(heading(dialog)).toContain("February 2026");
    fireEvent.click(within(dialog).getByRole("button", { name: /choose month and year/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous year" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "June 2025" }));
    expect(heading(dialog)).toContain("June 2025");
  });

  it("moves by day with the arrows and by month with PageUp and PageDown", async () => {
    render(<DateField aria-label="Scan date" value="2026-01-31" onChange={() => {}} today={TODAY} />);
    const dialog = open(/Scan date/);
    const start = within(dialog).getByRole("button", { name: "Saturday 31 January 2026" });
    await waitFor(() => expect(document.activeElement).toBe(start));
    fireEvent.keyDown(start, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-01-30");
    fireEvent.keyDown(document.activeElement as Element, { key: "PageDown" });
    expect(heading(dialog)).toContain("February 2026");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-date")).toBe("2026-02-28"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(heading(dialog)).toContain("March 2026");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-date")).toBe("2026-03-07"));
  });

  it("closes without a change on Escape, the scrim and Close", async () => {
    const change = vi.fn();
    render(<DateField aria-label="Scan date" value="2026-09-03" onChange={change} today={TODAY} />);
    for (const dismiss of ["escape", "scrim", "close"] as const) {
      const dialog = open(/Scan date/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Saturday 12 September 2026" }));
      if (dismiss === "escape") fireEvent.keyDown(within(dialog).getByRole("grid"), { key: "Escape" });
      else {
        const [scrim, close] = within(dialog).getAllByRole("button", { name: "Close" });
        fireEvent.click(dismiss === "scrim" ? scrim : close);
      }
      await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    }
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps Escape from closing a sheet underneath", async () => {
    const outerClose = vi.fn();
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") outerClose(); };
    document.addEventListener("keydown", listener);
    try {
      render(<DateField aria-label="Scan date" value="2026-09-03" onChange={() => {}} today={TODAY} />);
      const dialog = open(/Scan date/);
      fireEvent.keyDown(within(dialog).getByRole("grid"), { key: "Escape" });
      await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
      expect(outerClose).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("does not open when disabled", () => {
    render(<DateField aria-label="Scan date" value={null} onChange={() => {}} today={TODAY} disabled />);
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Scan date/ })); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
