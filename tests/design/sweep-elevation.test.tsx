import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoggedExtraCard } from "@/components/LoggedExtras";
import CardFrame from "@/components/ui/CardFrame";
import type { LoggedFood } from "@/lib/types";

/**
 * Elevation in the stream F2 sweep (DESIGN.md §Elevation & Depth, PRD U11, 2026-10-04): a card on the
 * oat ground is E1, and everything inside a card is E0 — never a shadow inside a shadow. A logged
 * extra stands on the ground, so its face is E1. CardFrame (UI makeover §3) carries the same rule:
 * raised on the ground in a `.shell`, nested at E0 with the 12 % hairline and no shadow. The Day
 * card's board tiles live in tests/design/sweep-elevation-dayboard.test.tsx.
 */
const ROOT = new URL("../../", import.meta.url).pathname;

describe("a logged extra", () => {
  const entry: LoggedFood = {
    id: "e", foodId: "f", name: "Chicken and rice", portionLabel: "plate", qty: 1, grams: 300,
    macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 }, at: "2026-09-20T18:00:00.000Z",
  };

  it("stands on the ground at E1; the snack ticket keeps its own drop", () => {
    const face = (markup: string) => /class="(logged-card-in[^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(face(renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}} />)))
      .toContain("elev-1");
    expect(face(renderToStaticMarkup(<LoggedExtraCard entry={{ ...entry, slot: "snack" }} pending={false}
      onOpen={() => {}} />))).not.toContain("elev-1");
  });

  it("offers its actions as small secondary buttons, not chip tracks", () => {
    const markup = renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}} />);
    expect(markup).toMatch(/<button[^>]*class="btn btn-secondary btn-sm"[^>]*>.*Add note/);
    expect(markup).not.toContain("pill-in");
  });
});

describe("CardFrame elevation", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  const classesOf = (markup: string, cls: string) =>
    Array.from(markup.matchAll(/class="([^"]*)"/g), (m) => m[1].split(/\s+/)).filter((set) => set.includes(cls));
  const rule = (selector: string) => {
    const match = new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`${selector} not found`);
    return match[1];
  };

  it("stands on the ground at E1: a .shell around an ivory .surface", () => {
    const markup = renderToStaticMarkup(<CardFrame title="Card">x</CardFrame>);
    expect(classesOf(markup, "shell")).toHaveLength(1);
    expect(classesOf(markup, "surface")[0]).toEqual(expect.arrayContaining(["card-md", "card-ivory"]));
  });

  it("nests at E0: the inset face, no shell, so no shadow inside a shadow", () => {
    const markup = renderToStaticMarkup(<CardFrame title="Outer"><CardFrame title="Inner">x</CardFrame></CardFrame>);
    expect(classesOf(markup, "shell")).toHaveLength(1);
    const [, inner] = classesOf(markup, "surface");
    expect(inner).toEqual(expect.arrayContaining(["card-recess", "card-e0"]));
    expect(inner).not.toContain("shell");
  });

  it("the nested faces drop no shadow and draw the 12 % hairline", () => {
    for (const selector of [".card-recess", ".card-e0:not(.card-olive)"]) {
      expect(rule(selector)).toMatch(/border-color: var\(--hairline-card\);/);
      expect(rule(selector)).toMatch(/box-shadow: none;/);
    }
    expect(css).toMatch(/--hairline-card: rgb\(var\(--ink-rgb\) \/ 0\.12\);/);
  });
});
