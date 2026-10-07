/**
 * Phase 19 §6.1 UI hand-off: SlotCard's unused `isMissed` prop and app/page.tsx's inline missed
 * calculation are gone. The panel's own `isMissedSlot` (lib/rebalance/missed.ts) is the only missed
 * rule left; Today's card never claims to render one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("the isMissed hand-off", () => {
  it("SlotCard declares no isMissed prop", () => {
    const source = strip(readFileSync(path.join(ROOT, "components/SlotCard.tsx"), "utf8"));
    expect(source).not.toMatch(/\bisMissed\b/);
  });

  it("app/page.tsx has no inline missed calculation or isMissed prop", () => {
    const source = strip(readFileSync(path.join(ROOT, "app/page.tsx"), "utf8"));
    expect(source).not.toMatch(/\bisMissed\b/);
    expect(source).not.toMatch(/\bisPastDay\b/);
    expect(source).not.toMatch(/\bdayHasActivity\b/);
  });

  it("no test caller still passes isMissed to SlotCard", () => {
    const callers = [
      "components/SlotCard.test.tsx",
      "components/SlotCard.actions.test.tsx",
      "components/SlotCard.rule-marks.test.tsx",
      "components/SlotCard.empty-focus.test.tsx",
      "components/SlotCard.notes.test.tsx",
      "tests/cards/today.test.tsx",
      "tests/design/overflow.test.tsx",
    ];
    for (const file of callers) {
      const source = strip(readFileSync(path.join(ROOT, file), "utf8"));
      expect({ file, found: /\bisMissed\b/.test(source) }).toEqual({ file, found: false });
    }
  });
});
