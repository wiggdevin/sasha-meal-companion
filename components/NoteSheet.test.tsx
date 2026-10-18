// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import NoteSheet from "./NoteSheet";
import type { LoggedFood } from "@/lib/types";

const catalogEntry: LoggedFood = {
  id: "e1",
  foodId: "f1",
  name: "Bread",
  portionLabel: "1 slice",
  qty: 1,
  grams: 30,
  macros: { kcal: 80, protein: 3, carbs: 15, fat: 1 },
  flags: ["gluten"],
  items: [
    {
      id: "i1",
      seq: 0,
      food_ref_id: "f1",
      grams: 30,
      qty: 1,
      unit: "slice",
      snapshot: {},
      foodId: "f1",
      name: "Bread",
      portionLabel: "1 slice",
      macros: { kcal: 80, protein: 3, carbs: 15, fat: 1 },
    },
  ],
  at: "2026-09-13T12:00:00.000Z",
};

describe("NoteSheet off-plan line", () => {
  it("shows the off-plan flags for a catalog (items-carrying) entry", () => {
    const markup = renderToStaticMarkup(
      <NoteSheet
        title="Bread"
        note=""
        entry={catalogEntry}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("off-plan: gluten");
  });
});

describe("NoteSheet's own states", () => {
  it("opens empty: no note text, and nothing to remove", () => {
    const markup = renderToStaticMarkup(
      <NoteSheet title="Bread" note="" entry={catalogEntry} onSave={() => {}} onClose={() => {}} />,
    );
    expect(markup).toContain("How it went, how you felt after, what you&#x27;d change…");
    expect(markup).not.toContain("Toast with butter");
  });

  it("opens editing the note the entry already carries", () => {
    const markup = renderToStaticMarkup(
      <NoteSheet title="Bread" note="Toast with butter" entry={catalogEntry}
        onSave={() => {}} onClose={() => {}} />,
    );
    expect(markup).toContain("Toast with butter");
  });
});

describe("NoteSheet save feedback", () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  });
  afterEach(cleanup);

  it("confirms a saved note with the shared haptic, then closes", async () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NoteSheet title="Bread" note="" entry={catalogEntry} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "felt fine" } });
    const button = screen.getByRole("button", { name: "Save note" });
    // The sheet primary of the button system (52 px); every button presses alike (app/globals.css).
    expect(button.className).toContain("btn-lg");
    await act(async () => { fireEvent.click(button); });
    expect(onSave).toHaveBeenCalledExactlyOnceWith("felt fine");
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet and the typed note on failure, with the shared alert and no haptic", async () => {
    const onSave = vi.fn(async () => { throw new Error("offline"); });
    const onClose = vi.fn();
    render(<NoteSheet title="Bread" note="" entry={catalogEntry} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hurt later" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not save your note. Please try again.");
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hurt later");
    expect(onClose).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("never traps the user: a second close after a failed save leaves", async () => {
    const onSave = vi.fn(async () => { throw new Error("offline"); });
    const onClose = vi.fn();
    render(<NoteSheet title="Bread" note="" entry={catalogEntry} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hurt later" } });
    const close = () => screen.getAllByRole("button", { name: "Close" }).at(-1)!;
    await act(async () => { fireEvent.click(close()); });
    expect(screen.getByRole("alert").textContent).toContain("Could not save your note.");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(close()); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an unchanged note on blur", async () => {
    const onSave = vi.fn(async () => {});
    render(<NoteSheet title="Bread" note="same" entry={catalogEntry} onSave={onSave} onClose={() => {}} />);
    await act(async () => { fireEvent.blur(screen.getByRole("textbox")); });
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("NoteSheet reports what a closing save replaced", () => {
  afterEach(cleanup);

  it("reports the opening note and the saved one when a changed note closes, across blur saves", async () => {
    const onSaved = vi.fn();
    const onSave = vi.fn(async () => {});
    const { rerender } = render(<NoteSheet title="Bread" note="before" entry={catalogEntry}
      onSave={onSave} onSaved={onSaved} onClose={() => {}} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "middle" } });
    await act(async () => { fireEvent.blur(box); });
    // Today re-renders the open sheet with the note it now stores.
    rerender(<NoteSheet title="Bread" note="middle" entry={catalogEntry}
      onSave={onSave} onSaved={onSaved} onClose={() => {}} />);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "after" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("before", "after");
  });

  it("reports nothing for an unchanged note or a failed save", async () => {
    const onSaved = vi.fn();
    render(<NoteSheet title="Bread" note="same" entry={catalogEntry}
      onSave={async () => { throw new Error("offline"); }} onSaved={onSaved} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("NoteSheet compares the note it stores, not the typed whitespace", () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  });
  afterEach(cleanup);

  it("reports the trimmed note it saved, so Undo can recognise it", async () => {
    const onSaved = vi.fn();
    const onSave = vi.fn(async () => {});
    render(<NoteSheet title="Bread" note="before" entry={catalogEntry}
      onSave={onSave} onSaved={onSaved} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  after \n" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    expect(onSave).toHaveBeenCalledExactlyOnceWith("after");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("before", "after");
  });

  it("writes nothing, reports nothing and plays no haptic for a whitespace-only edit", async () => {
    const onSaved = vi.fn();
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NoteSheet title="Bread" note="same" entry={catalogEntry}
      onSave={onSave} onSaved={onSaved} onClose={onClose} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "same   " } });
    await act(async () => { fireEvent.blur(box); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    expect(onSave).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the typed text, whitespace and all, when the save fails", async () => {
    render(<NoteSheet title="Bread" note="" entry={catalogEntry}
      onSave={async () => { throw new Error("offline"); }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hurt later  " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hurt later  ");
  });
});

describe("NoteSheet Remove (UI audit 2026-10-18)", () => {
  afterEach(cleanup);

  it("asks once more before removing, and names the day it removes from", () => {
    const onRemove = vi.fn();
    render(<NoteSheet title="Bread" note="" entry={catalogEntry} onSave={() => {}} onClose={() => {}}
      onRemove={onRemove} removeLabel="Remove from this day" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from this day" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove from this day" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
