/** @vitest-environment jsdom */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Sheet from "@/components/Sheet";
import SlotCard from "@/components/SlotCard";
import type { ResolvedSlot } from "@/lib/types";

const ROOT = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".css"].includes(extname(path)) ? [path] : [];
  });
}

const SLOT: ResolvedSlot = {
  slot: "meal-1",
  time: "12:00",
  label: "Lunch",
  meal: { id: "meal", name: "Chicken and rice", slot: "meal-1", components: [],
    macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 }, prepMinutes: 10, tags: [] },
  components: [],
  macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 },
  eaten: false,
};

describe("horizontal containment", () => {
  it("clips the document root and constrains the app shell", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).toMatch(/html,\s*body\s*\{[\s\S]*?overflow-x:\s*clip;/);
    expect(css).toMatch(/html,\s*body\s*\{[\s\S]*?overscroll-behavior-x:\s*none;/);
    expect(css).toMatch(/body\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  });

  it("uses no viewport-width utility or declaration in app and components", () => {
    const failures = ["app", "components"].flatMap((directory) => sourceFiles(join(ROOT, directory)))
      .flatMap((path) => Array.from(readFileSync(path, "utf8").matchAll(/\bw-screen\b|\b100vw\b/g),
        (match) => `${relative(ROOT, path)}: ${match[0]}`));
    expect(failures).toEqual([]);
  });

  it("renders an open sheet and its meal cards inside bounded roots, never overflowing", () => {
    const sheet = render(<Sheet title="Edit meal" onClose={() => {}}><input aria-label="Meal" /></Sheet>);
    const dialog = sheet.getByRole("dialog");
    expect(Array.from(dialog.classList)).toEqual(expect.arrayContaining(["w-full", "max-w-full", "min-w-0"]));
    const panel = dialog.querySelector<HTMLElement>(".sheet-surface");
    expect(Array.from(panel?.classList ?? [])).toEqual(expect.arrayContaining(["max-w-full", "min-w-0"]));
    // The pop-up card is sized by lib/dom/popover-place.ts: never wider than the screen minus its
    // 16 px gutters, and capped so it fits the viewport.
    expect(Number.parseFloat(panel?.style.width ?? "")).toBeLessThanOrEqual(480);
    expect(panel?.style.maxHeight).toMatch(/px$/);
    sheet.unmount();

    const card = render(<SlotCard slot={SLOT} variant="standard" canSwap
      onToggleEaten={() => {}} onOpenSwap={() => {}} />);
    expect(Array.from(card.container.firstElementChild?.classList ?? []))
      .toEqual(expect.arrayContaining(["w-full", "max-w-full", "min-w-0"]));
  });
});
