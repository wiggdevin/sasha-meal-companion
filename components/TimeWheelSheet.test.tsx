// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import TimeWheelSheet, { nearestQuarter, stepQuarter } from "./TimeWheelSheet";
import EditSlotSheet from "./EditSlotSheet";
import { quarterHours } from "@/lib/today/presentation";

afterEach(cleanup);

function renderWheel(value = "12:30") {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<TimeWheelSheet value={value} onChange={onChange} onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "Meal time" });
  const wheel = within(dialog).getByRole("listbox", { name: "Quarter hours" });
  const selected = () => within(wheel).getAllByRole("option")
    .filter((option) => option.getAttribute("aria-selected") === "true").map((option) => option.textContent);
  const done = () => fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  return { onChange, onClose, dialog, wheel, selected, done };
}

describe("TimeWheelSheet", () => {
  it("selects only 15-minute values and snaps a stored time to the nearest quarter", () => {
    expect(nearestQuarter("12:07")).toBe("12:00");
    expect(nearestQuarter("12:08")).toBe("12:15");
    expect(nearestQuarter("23:59")).toBe("23:45");
    expect(nearestQuarter("7:30")).toBe("07:30");
    expect(nearestQuarter("24:00")).toBeNull();
    expect(nearestQuarter("noon")).toBeNull();

    const { wheel, selected } = renderWheel("12:07");
    const options = within(wheel).getAllByRole("option");
    expect(options).toHaveLength(96);
    expect(options.map((option) => option.getAttribute("data-value"))).toEqual([...quarterHours()]);
    expect(selected()).toEqual(["12:00 pm"]);
  });

  it("wraps safely at day bounds", () => {
    expect(stepQuarter("23:45", 1)).toBe("00:00");
    expect(stepQuarter("00:00", -1)).toBe("23:45");
    expect(stepQuarter("12:07", 1)).toBe("12:15");

    const late = renderWheel("23:45");
    fireEvent.click(within(late.dialog).getByRole("button", { name: "15 minutes later" }));
    expect(late.selected()).toEqual(["12:00 am"]);
    fireEvent.click(within(late.dialog).getByRole("button", { name: "15 minutes earlier" }));
    fireEvent.click(within(late.dialog).getByRole("button", { name: "15 minutes earlier" }));
    expect(late.selected()).toEqual(["11:30 pm"]);
    fireEvent.keyDown(late.wheel, { key: "ArrowDown" });
    fireEvent.keyDown(late.wheel, { key: "ArrowDown" });
    fireEvent.keyDown(late.wheel, { key: "ArrowDown" });
    expect(late.selected()).toEqual(["12:15 am"]);
    late.done();
    expect(late.onChange).toHaveBeenCalledWith("00:15");
  });

  it("supports direct keyboard entry", () => {
    const { dialog, selected, done, onChange } = renderWheel("12:30");
    const field = within(dialog).getByRole("textbox", { name: "Type a time" });
    fireEvent.change(field, { target: { value: "7:30" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(selected()).toEqual(["7:30 am"]);
    fireEvent.change(field, { target: { value: "19:05" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(selected()).toEqual(["7:00 pm"]);
    fireEvent.change(field, { target: { value: "25:00" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Type a time");
    expect(selected()).toEqual(["7:00 pm"]);
    done();
    expect(onChange).toHaveBeenCalledWith("19:00");
  });

  it("picks the centred row after a finger scroll", () => {
    const { wheel, done, onChange } = renderWheel("12:30");
    wheel.scrollTop = 44 * 30;
    fireEvent.scroll(wheel);
    done();
    expect(onChange).toHaveBeenCalledWith("07:30");
  });

  it("is an opaque modal sheet", () => {
    const { dialog } = renderWheel();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector(".time-sheet-surface")).not.toBeNull();
  });

  it("closes without saving on Escape", () => {
    const { dialog, wheel, onChange, onClose } = renderWheel("12:30");
    fireEvent.click(within(wheel).getByRole("option", { name: "1:15 pm" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EditSlotSheet meal time", () => {
  function renderSheet() {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<EditSlotSheet open label="Lunch" planned={[]} override={undefined} target={undefined}
      foods={{}} time="12:30" onSave={onSave} onClose={onClose} />);
    return { onSave, onClose, field: () => screen.getByRole("textbox", { name: "Meal time" }) as HTMLInputElement };
  }

  it("replaces the native time picker with the wheel and keeps direct entry and steps", () => {
    const { field } = renderSheet();
    expect(document.querySelector('input[type="time"]')).toBeNull();
    expect(field().value).toBe("12:30");
    fireEvent.click(screen.getByRole("button", { name: "Later meal time" }));
    expect(field().value).toBe("12:45");
    fireEvent.click(screen.getByRole("button", { name: "Earlier meal time" }));
    fireEvent.click(screen.getByRole("button", { name: "Earlier meal time" }));
    expect(field().value).toBe("12:15");
    fireEvent.change(field(), { target: { value: "7:05" } });
    fireEvent.blur(field());
    expect(field().value).toBe("07:05");
  });

  it("saves a time chosen on the wheel through the existing save callback", async () => {
    const { onSave, onClose, field } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Choose meal time" }));
    const wheel = screen.getByRole("dialog", { name: "Meal time" });
    fireEvent.click(within(wheel).getByRole("option", { name: "1:15 pm" }));
    fireEvent.click(within(wheel).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Meal time" })).toBeNull();
    expect(field().value).toBe("13:15");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith([], "", "13:15"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes the wheel on Escape without closing the meal sheet or saving", () => {
    const { onSave, onClose, field } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Choose meal time" }));
    const wheel = screen.getByRole("dialog", { name: "Meal time" });
    fireEvent.click(within(wheel).getByRole("option", { name: "1:15 pm" }));
    fireEvent.keyDown(within(wheel).getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Meal time" })).toBeNull();
    expect(field().value).toBe("12:30");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
