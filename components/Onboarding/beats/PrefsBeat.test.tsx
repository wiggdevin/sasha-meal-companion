// @vitest-environment jsdom
/** One typed-first preference question with the shared tile grid as the alternative. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrefsBeat from "./PrefsBeat";
import { CUISINE_TILE_LABELS, parseCuisinesText } from "@/lib/profile/onboarding-prefs-parse";
import { CUISINES } from "@/lib/profile/cuisines";

afterEach(cleanup);

const tiles = CUISINES.map((id) => ({ id, label: CUISINE_TILE_LABELS[id], ariaLabel: CUISINE_TILE_LABELS[id] }));
const label = (id: string) => CUISINE_TILE_LABELS[id as keyof typeof CUISINE_TILE_LABELS] ?? id;
const parse = (text: string) => { const r = parseCuisinesText(text); return { ids: r.cuisines, none: r.none }; };

function renderBeat(onDone = vi.fn()) {
  render(<PrefsBeat question="Which cuisines do you love?" helper="Pick up to 6." inputLabel="Cuisines"
    placeholder="e.g. Thai" tiles={tiles} labelFor={label} parse={parse} initial={null} max={6}
    unreadNote="Sprout didn’t catch a cuisine there." onDone={onDone} />);
  return onDone;
}

describe("PrefsBeat", () => {
  it("a typed answer and the tile grid write one selection", () => {
    const onDone = renderBeat();
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "thai and mexican" } });
    screen.getByText("Got it: Thai & SE Asian · Mexican & Latin");
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    // The typed reading is now tapped in the grid, and a tap takes one back.
    expect(screen.getByRole("button", { name: "Thai & SE Asian" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Thai & SE Asian" }));
    fireEvent.click(screen.getByRole("button", { name: "Italian" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onDone).toHaveBeenCalledWith(["latin_american", "italian"]);
  });

  it("never reads a health or allergy detail, and says what it did not catch", () => {
    const onDone = renderBeat();
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "I'm allergic to shrimp" } });
    screen.getByText(/health or allergy detail/);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "spicy stuff" } });
    screen.getByText("Sprout didn’t catch a cuisine there.");
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onDone).toHaveBeenCalledWith([]);
  });

  it("a typed \"none\" clears every earlier choice, typed or tapped (Sol r1 BLOCK)", () => {
    const onDone = vi.fn();
    render(<PrefsBeat question="Q" helper="H" inputLabel="Cuisines" placeholder="p" tiles={tiles} labelFor={label}
      parse={parse} initial={["korean", "italian"]} max={6} unreadNote="?" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onDone).toHaveBeenLastCalledWith([]);
  });

  it("a visible \"None of these\" clears the selection and moves on, from the box or the grid", () => {
    const onDone = vi.fn();
    render(<PrefsBeat question="Q" helper="H" inputLabel="Cuisines" placeholder="p" tiles={tiles} labelFor={label}
      parse={parse} initial={["korean"]} max={6} unreadNote="?" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("Cuisines"), { target: { value: "thai" } });
    fireEvent.click(screen.getByRole("button", { name: "None of these" }));
    expect(onDone).toHaveBeenLastCalledWith([]);
    cleanup();
    render(<PrefsBeat question="Q" helper="H" inputLabel="Cuisines" placeholder="p" tiles={tiles} labelFor={label}
      parse={parse} initial={["korean"]} max={6} unreadNote="?" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    fireEvent.click(screen.getByRole("button", { name: "None of these" }));
    expect(onDone).toHaveBeenLastCalledWith([]);
  });

  it("holds the cap in the grid", () => {
    renderBeat();
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    for (const id of CUISINES.slice(0, 7)) fireEvent.click(screen.getByRole("button", { name: CUISINE_TILE_LABELS[id] }));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(6);
    screen.getByText(/Up to 6/);
  });
});
