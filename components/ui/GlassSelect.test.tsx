// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GlassSelect from "./GlassSelect";

afterEach(cleanup);

const options = [
  { value: "any", label: "Any" },
  { value: "none", label: "No cooking" },
  { value: "minimal", label: "Minimal", disabled: true },
];

describe("GlassSelect", () => {
  it("opens a labelled list, selects by touch/click, and submits its exact value", () => {
    const change = vi.fn();
    const view = render(<form><GlassSelect aria-label="Cooking effort" name="effort" value="any"
      onChange={change} options={options} /></form>);
    const trigger = screen.getByRole("combobox", { name: "Cooking effort" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Cooking effort" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Minimal" }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "No cooking" }));
    expect(change).toHaveBeenCalledWith("none");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    view.rerender(<form><GlassSelect aria-label="Cooking effort" name="effort" value="none"
      onChange={change} options={options} /></form>);
    expect((document.querySelector('input[name="effort"]') as HTMLInputElement).value).toBe("none");
  });

  it("supports arrows, Enter, Escape, and disabled choices", () => {
    const change = vi.fn();
    render(<GlassSelect aria-label="Cooking effort" value="any" onChange={change} options={options} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("-1");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("-0");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("none");
    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not open when disabled", () => {
    render(<GlassSelect aria-label="Cooking effort" value="any" onChange={() => {}}
      options={options} disabled />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps a sheet popup inside its dialog for assistive technology", () => {
    render(<div role="dialog" aria-modal="true"><GlassSelect aria-label="Meal" value="any"
      onChange={() => {}} options={options} /></div>);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("dialog").contains(screen.getByRole("listbox"))).toBe(true);
  });

  it("shows Choose for an unknown value and keeps focus on the trigger when clicking an option", () => {
    render(<GlassSelect aria-label="Cooking effort" value="missing" name="effort"
      onChange={() => {}} options={options} />);
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Choose");
    expect((document.querySelector('input[name="effort"]') as HTMLInputElement).value).toBe("missing");
    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "No cooking" });
    expect(fireEvent.mouseDown(option)).toBe(false);
  });

  it("never scrolls the page to reach the active option; only the menu scrolls", () => {
    const intoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = intoView;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    try {
      const many = Array.from({ length: 30 }, (_, index) => ({ value: `v${index}`, label: `Choice ${index}` }));
      render(<GlassSelect aria-label="Long" value="v25" onChange={() => {}} options={many} />);
      const trigger = screen.getByRole("combobox");
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: "End" });
      fireEvent.keyDown(trigger, { key: "Home" });
      expect(intoView).not.toHaveBeenCalled();
      expect(scrollTo).not.toHaveBeenCalled();
      const listbox = screen.getByRole("listbox");
      expect(listbox.style.position === "" || listbox.style.position === "fixed").toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
      scrollTo.mockRestore();
    }
  });

  it("marks only the chosen row with a check and keeps Escape inside an open menu", () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><GlassSelect aria-label="Cooking effort" value="none"
      onChange={() => {}} options={options} /></div>);
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).not.toContain("\u2304");
    expect(trigger.querySelector("svg")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "No cooking" }).querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Any" }).querySelector("svg")).toBeNull();
    expect(trigger.getAttribute("aria-activedescendant")).toContain("-1");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
