// @vitest-environment jsdom
/**
 * The ask box's "+" tab (components/plan/PlanComposer.tsx): "+" opens a tab of two small buttons
 * out of the pill's top edge, the buttons feed the same file inputs and handlers as before, and
 * "+", a chosen file, Escape and a tap outside put it away. The tab rises on the left, just right
 * of "+", so its buttons sit beside "×". The outline is one SVG path that morphs from flat to raised
 * (components/plan/composer/tab-shape.ts); the tab's tint is that outline clipped to its region.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PlanComposer from "@/components/plan/PlanComposer";
import {
  FLANK, RISE, TAB_GLYPH, plateauWidth, tabBox, tabLeftOffset, tabPath, tabRegionPath,
} from "@/components/plan/composer/tab-shape";
import { DOCUMENT_ACCEPT } from "@/lib/plan/document-files";

const PLUS = "Add a photo or file";
const WIDTH = 320;
const HEIGHT = 56;

// jsdom lays nothing out; give the form a phone-sized box so the SVG body is drawn.
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true, get() { return this.tagName === "FORM" ? WIDTH : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true, get() { return this.tagName === "FORM" ? HEIGHT : 0; } });
});
afterAll(() => {
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(props: Partial<Parameters<typeof PlanComposer>[0]> = {}) {
  const onPhoto = vi.fn();
  const onDocument = vi.fn();
  const view = render(<div>
    <button type="button">Elsewhere</button>
    <PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={onPhoto} onDocument={onDocument}
      busy={false} {...props} />
  </div>);
  const input = (name: string) => view.container.querySelector<HTMLInputElement>(`input[data-photo-input="${name}"]`);
  return { ...view, onPhoto, onDocument, input, plus: () => screen.getByRole("button", { name: PLUS }) };
}

const file = (name = "plate.jpg", type = "image/jpeg") => new File(["x"], name, { type });
const gone = (name: string) => waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());

describe("the ask box's + tab", () => {
  it("shows one + in the box, and toggles aria-expanded and the tab's camera and attach buttons", async () => {
    const { plus } = setup();
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload a meal plan or document" })).toBeNull();
    const tab = document.getElementById(plus().getAttribute("aria-controls")!)!;
    expect(tab.getAttribute("role")).toBe("group");

    fireEvent.click(plus());
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    const buttons = Array.from(tab.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    // Attach nearest "×", camera after it; both reachable by Tab (inside the group, not inert).
    expect(buttons).toEqual(["Upload a meal plan or document", "Take a photo"]);
    expect(tab.hasAttribute("inert")).toBe(false);

    fireEvent.click(plus());
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    await gone("Take a photo");
    expect(tab.hasAttribute("inert")).toBe(true);
  });

  it("raises the tab on the left, just right of + (where the left cap ends), not on the right", () => {
    const { plus } = setup();
    const tab = document.getElementById(plus().getAttribute("aria-controls")!)!;
    const box = tabBox(HEIGHT, 2);
    expect(tab.style.left).toBe(`${box.left}px`);
    expect(tab.style.right).toBe("");
    // The actions' box is exactly the raised region: from the tab's flat top down to the pill's edge.
    expect(tab.style.top).toBe(`${-RISE}px`);
    expect(tab.style.height).toBe(`${RISE}px`);
    expect(tab.style.width).toBe(`${box.width}px`);
  });

  it("splits the tab evenly: each bare glyph centred in its own half, inside the raised region (U3)", () => {
    const { plus } = setup();
    fireEvent.click(plus());
    const tab = document.getElementById(plus().getAttribute("aria-controls")!)!;
    const buttons = Array.from(tab.querySelectorAll("button"));
    // No backing: a bare 22 px glyph per action.
    for (const button of buttons) {
      expect(button.querySelector("svg")?.getAttribute("width")).toBe(String(TAB_GLYPH));
    }
    const box = tabBox(HEIGHT, 2);
    const centres = [box.left + box.width / 4, box.left + (box.width * 3) / 4];
    // Symmetric about the tab's own centre, and both on the tab's flat top.
    const middle = tabLeftOffset(HEIGHT) + plateauWidth(2) / 2;
    expect(centres[0] + centres[1]).toBeCloseTo(2 * middle);
    expect(centres[0] - TAB_GLYPH / 2).toBeGreaterThanOrEqual(tabLeftOffset(HEIGHT) - 1);
    expect(centres[1] + TAB_GLYPH / 2).toBeLessThanOrEqual(tabLeftOffset(HEIGHT) + plateauWidth(2) + 1);
    // Each half is at least the 44 px a finger needs, and the glyph fits the rise with room to spare.
    expect(box.width / 2).toBeGreaterThanOrEqual(44);
    expect(RISE - TAB_GLYPH).toBeGreaterThanOrEqual(8);
  });

  it("moves focus + → attach → camera → the words", () => {
    const { plus, container } = setup({ draft: "tacos" });
    fireEvent.click(plus());
    const form = container.querySelector("form")!;
    const order = Array.from(form.querySelectorAll<HTMLElement>("button, input"))
      .filter((node) => !node.hidden && node.tabIndex >= 0 && !node.closest("[inert]"))
      .map((node) => node.getAttribute("aria-label"));
    expect(order).toEqual([PLUS, "Upload a meal plan or document", "Take a photo", "Ask for a meal idea", "Send"]);
  });

  it("feeds the same inputs and handlers as before, and a chosen file puts the tab away", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { plus, input, onPhoto, onDocument } = setup();
    fireEvent.click(plus());
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    expect(click.mock.contexts.at(-1)).toBe(input("camera"));
    expect(input("camera")!.hasAttribute("capture")).toBe(false);
    expect(input("camera")!.accept).toBe("image/*");
    fireEvent.click(screen.getByRole("button", { name: "Upload a meal plan or document" }));
    expect(click.mock.contexts.at(-1)).toBe(input("document"));
    expect(input("document")!.accept).toBe(DOCUMENT_ACCEPT);
    expect(input("document")!.hasAttribute("capture")).toBe(false);

    const plate = file();
    fireEvent.change(input("camera")!, { target: { files: [plate] } });
    expect(onPhoto).toHaveBeenCalledWith(plate);
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(plus());
    await gone("Take a photo");

    const plan = file("plan.pdf", "application/pdf");
    fireEvent.change(input("document")!, { target: { files: [plan] } });
    expect(onDocument).toHaveBeenCalledWith(plan);
    expect(onPhoto).toHaveBeenCalledTimes(1);
  });

  it("opens the photo library for onPhoto when there is no document handler (the recipe widget)", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { plus, input, onPhoto } = setup({ onDocument: undefined, upload: true });
    fireEvent.click(plus());
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    expect(click.mock.contexts.at(-1)).toBe(input("upload"));
    expect(input("upload")!.hasAttribute("capture")).toBe(false);
    expect(input("document")).toBeNull();
    const photo = file();
    fireEvent.change(input("upload")!, { target: { files: [photo] } });
    expect(onPhoto).toHaveBeenCalledWith(photo);
  });

  it("closes on Escape without letting the sheet underneath see it, and focus returns to +", async () => {
    const sheet = vi.fn();
    document.addEventListener("keydown", sheet);
    try {
      const { plus } = setup();
      fireEvent.click(plus());
      fireEvent.keyDown(screen.getByRole("button", { name: "Take a photo" }), { key: "Escape" });
      expect(plus().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(plus());
      expect(sheet).not.toHaveBeenCalled();
      await gone("Take a photo");
      // Closed, Escape is the sheet's again.
      fireEvent.keyDown(plus(), { key: "Escape" });
      expect(sheet).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener("keydown", sheet); }
  });

  it("closes on a tap outside the box, not on a tap inside it", () => {
    const { plus } = setup();
    fireEvent.click(plus());
    fireEvent.pointerDown(screen.getByRole("textbox"));
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(plus().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps log mode's big camera button, and its tab holds attach alone", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { plus, input } = setup({ cameraFirst: "Snap what you ate" });
    fireEvent.click(screen.getByRole("button", { name: /Snap what you ate/ }));
    expect(click.mock.contexts.at(-1)).toBe(input("camera"));
    // The big button keeps its old picker (library or camera), so no capture here.
    expect(input("camera")!.hasAttribute("capture")).toBe(false);
    fireEvent.click(plus());
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload a meal plan or document" })).toBeTruthy();
  });

  it("draws the pill and tab as one path that rises from flat to the tab's height", async () => {
    const { container, plus } = setup();
    const svg = container.querySelector("svg[data-tab-motion]")!;
    expect(svg.getAttribute("data-tab-motion")).toBe("morph");
    const fill = () => svg.querySelector("path[data-shape-fill]")!.getAttribute("d")!;
    const flat = tabPath({ width: WIDTH, height: HEIGHT, rise: 0, spread: 0, plateau: plateauWidth(2) });
    expect(fill()).toBe(flat);
    fireEvent.click(plus());
    const raised = tabPath({ width: WIDTH, height: HEIGHT, rise: RISE, spread: 1, plateau: plateauWidth(2) });
    await waitFor(() => expect(fill()).toBe(raised), { timeout: 3000 });
    // The tab's tint: the same outline, clipped to the tab's own region.
    const tint = svg.querySelector("path[data-shape-tab]")!;
    expect(tint.getAttribute("d")).toBe(raised);
    const clip = svg.querySelector(`clipPath#${CSS.escape(tint.getAttribute("clip-path")!.slice(5, -1))} path`)!;
    expect(clip.getAttribute("d")).toBe(
      tabRegionPath({ width: WIDTH, height: HEIGHT, rise: RISE, spread: 1, plateau: plateauWidth(2) }));
    fireEvent.click(plus());
    await waitFor(() => expect(fill()).toBe(flat), { timeout: 3000 });
  });
});

describe("the tab's outline", () => {
  const plateau = plateauWidth(2);
  const ys = (d: string) => Array.from(d.matchAll(/-?\d+(?:\.\d+)?/g), (m) => Number(m[0]));

  it("is flat along the top edge with the tab down", () => {
    const d = tabPath({ width: WIDTH, height: HEIGHT, rise: 0, spread: 1, plateau });
    expect(Math.min(...ys(d))).toBeGreaterThanOrEqual(0);
    // A settling spring that dips under zero never dents the pill.
    expect(tabPath({ width: WIDTH, height: HEIGHT, rise: -3, spread: 1, plateau })).toBe(d);
  });

  it("rises to a flat top on the left, with S-curves FLANK wide leaving where the left cap ends", () => {
    const d = tabPath({ width: WIDTH, height: HEIGHT, rise: RISE, spread: 1, plateau });
    const r = HEIGHT / 2;
    const a = r + FLANK;
    const b = a + plateau;
    expect(d).toContain(`M${r} 0 L${r} 0 C`);
    expect(d).toContain(`${a} -${RISE} L${b} -${RISE}`);
    // Down again well before Send, then flat to the right cap.
    expect(d).toContain(`${b + FLANK} 0 L${WIDTH - r} 0`);
    expect(b + FLANK).toBeLessThan(WIDTH - r - 40);
    expect(Math.min(...ys(d))).toBe(-RISE);
  });

  it("cuts out the tab's own region: the same top edge closed along the pill's top line", () => {
    const geometry = { width: WIDTH, height: HEIGHT, rise: RISE, spread: 1, plateau };
    const region = tabRegionPath(geometry);
    const r = HEIGHT / 2;
    expect(region.startsWith(`M${r} 0 C`)).toBe(true);
    expect(region.endsWith(`${r + 2 * FLANK + plateau} 0 Z`)).toBe(true);
    expect(tabPath(geometry)).toContain(region.slice(region.indexOf("C"), -2));
    expect(Math.min(...ys(region))).toBe(-RISE);
    expect(Math.max(...ys(region).filter((_, index) => index % 2 === 1))).toBe(0);
  });

  it("is narrower while it is still growing", () => {
    const narrow = tabPath({ width: WIDTH, height: HEIGHT, rise: RISE, spread: 0, plateau });
    const top = narrow.match(new RegExp(` (-?[\\d.]+) -${RISE} L(-?[\\d.]+) -${RISE}`))!;
    expect(Number(top[2]) - Number(top[1])).toBeLessThan(plateau);
  });
});
