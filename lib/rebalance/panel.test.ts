/** Phase 19 R2 / §7: `buildRebalancePanel` assembles §6's contract from R1's pure outputs. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearMeal } from "@/lib/today/meal-actions";
import type { StoredDay, Store } from "@/lib/types";
import {
  account, at, build, DATE, eatenAt, entry, item, saved,
} from "./__fixtures__/days";
import { dayBalance, type DayBalance } from "./balance";
import { classifyDay } from "./classify";
import { buildRebalancePanel, toneFor, type RebalancePanel } from "./panel";
import { copyFor } from "./copy";

function run(stored: Omit<StoredDay, "date">, now = at("12:00"), store: Store = account()): RebalancePanel {
  store.days[DATE] = { date: DATE, ...stored };
  const { day, slots } = build(store);
  const balance = dayBalance(day, slots, now);
  const state = classifyDay(DATE, now.date, balance);
  return buildRebalancePanel(state, balance, day);
}

function text(panel: RebalancePanel): string {
  if (!panel.show) return "";
  const copy = copyFor(panel.copyKey, panel.numbers, panel.cards);
  return [copy.headline, ...copy.sub].join(" ");
}

describe("toneFor", () => {
  it("nudges for under, over and spent only", () => {
    expect(toneFor("under")).toBe("nudge");
    expect(toneFor("over")).toBe("nudge");
    expect(toneFor("spent")).toBe("nudge");
    for (const quiet of ["no_target", "incomplete_intake", "on_track", "no_action"] as const) {
      expect(toneFor(quiet)).toBe("quiet");
    }
  });
});

describe("One predicate (source scan)", () => {
  it("finds no comparison of kcal with a target in panel.ts or copy.ts", () => {
    const dir = __dirname;
    const KCAL = String.raw`(kcal|Kcal|recorded|planned|left|consumed)`;
    const TARGET = String.raw`(target|Target|\bT\b|toleranceFor|tolerance)`;
    const compare = new RegExp(`${KCAL}[^;\\n]*[<>]=?[^;\\n]*${TARGET}|${TARGET}[^;\\n]*[<>]=?[^;\\n]*${KCAL}`);
    for (const file of ["panel.ts", "copy.ts", "panel-client.ts"]) {
      const code = readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const lines = code.split("\n").filter((line) => compare.test(line.replace(/=>/g, " arrow ")));
      expect({ file, lines }).toEqual({ file, lines: [] });
    }
  });

});

describe("buildRebalancePanel", () => {
  it("answers hidden with no numbers or cards", () => {
    expect(buildRebalancePanel({ state: "hidden", highlights: [] }, null, null)).toEqual({ show: false });
  });

  it("answers no_target with no balance at all", () => {
    const panel = buildRebalancePanel({ state: "no_target", highlights: [] }, null, null);
    expect(panel).toMatchObject({ show: true, state: "no_target", tone: "quiet", copyKey: "no_target" });
    if (panel.show) {
      expect(panel.numbers).toMatchObject({ targetKcal: null, recordedKcal: 0, leftKcal: null, plannedKcal: null,
        proteinTargetG: null, proteinConsumedG: null });
      expect(panel.cards).toEqual([]);
    }
  });

  it("builds missed then remaining cards, with highlights from the classifier only", () => {
    const panel = run({ eaten: eatenAt("meal-1"),
      itemOverrides: { "meal-1": saved(500, "Oats"), "meal-2": saved(600, "Lunch"), "meal-3": saved(700, "Dinner") } },
    at("14:00"));
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.state).toBe("under");
    expect(panel.cards.map((card) => [card.slot, card.status, card.highlight])).toEqual([
      ["meal-2", "missed", true],
      ["meal-3", "remaining", true],
    ]);
    expect(panel.cards.find((card) => card.slot === "meal-2")?.kcal).toBe(600);
  });

  it("gates leftKcal, plannedKcal and proteinConsumedG on a complete intake", () => {
    const complete = run({ itemOverrides: { "meal-3": saved(700, "Late", { time: "22:15" }) } }, at("09:00"));
    expect(complete.show).toBe(true);
    if (complete.show) {
      expect(complete.numbers.leftKcal).not.toBeNull();
      expect(complete.numbers.plannedKcal).not.toBeNull();
      expect(complete.numbers.proteinConsumedG).not.toBeNull();
    }

    const incomplete = run({ extras: [entry("shake", [item()])] });
    expect(incomplete.show).toBe(true);
    if (incomplete.show) {
      expect(incomplete.numbers.leftKcal).toBeNull();
      expect(incomplete.numbers.plannedKcal).toBeNull();
      expect(incomplete.numbers.proteinConsumedG).toBeNull();
    }
  });

  it("never reads day.consumed.kcal for recordedKcal (source scan)", () => {
    for (const file of ["panel.ts", "copy.ts"]) {
      const code = readFileSync(path.join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect({ file, found: code.match(/consumed\.kcal/g) }).toEqual({ file, found: null });
    }
  });
});

describe("incomplete_intake fixtures show no left or planned figure", () => {
  it("unknown energy: a logged item with no energy", () => {
    const panel = run({ extras: [entry("shake", [item()])] });
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.state).toBe("incomplete_intake");
    expect(panel.numbers.leftKcal).toBeNull();
    expect(panel.numbers.plannedKcal).toBeNull();
    const body = text(panel);
    expect(body).toContain("Intake is not fully known");
    expect(body).not.toContain("kcal left");
    expect(body).not.toContain("at least");
  });

  it("empty snapshot: the reconcile placeholder", () => {
    const placeholder = { ...item(), snapshot: {} };
    const panel = run({ extras: [entry("p", [placeholder])] });
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.state).toBe("incomplete_intake");
    expect(panel.numbers.leftKcal).toBeNull();
    expect(text(panel)).toContain("1 logged food has no calorie value");
  });

  it("partial recipe: a 200 kcal partly measured serving", () => {
    const panel = run({ extras: [entry("r", [item({ reported: 200 })], "meal-1", { nutritionPartial: true })] });
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.state).toBe("incomplete_intake");
    expect(panel.numbers.leftKcal).toBeNull();
    expect(panel.numbers.plannedKcal).toBeNull();
    const body = text(panel);
    expect(body).toContain("At least 200 kcal accounted for");
    expect(body).toContain("A recipe is only partly measured");
    expect(body).not.toContain("kcal left");
  });

  it("frozen estimate: a timestamp-only eaten mark", () => {
    const store = account(1800);
    const panel = run({ eaten: eatenAt("meal-3") }, at("20:00"), store);
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.numbers.leftKcal).toBeNull();
    expect(panel.numbers.plannedKcal).toBeNull();
    const body = text(panel);
    expect(body).not.toContain("600 kcal eaten");
    expect(body).not.toContain("at least 600");
    expect(body).toContain("1 eaten meal is an estimate");
  });

  it("legacy macro fallback: an item with macros.kcal but no itemKcal", () => {
    const panel = run({ extras: [entry("a", [{ ...item({ legacyKcal: 800 }, "legacy"), snapshot: {} },
      item({ reported: 200 }, "real")])] });
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.numbers.leftKcal).toBeNull();
    const body = text(panel);
    expect(body).toContain("At least 200 kcal accounted for");
    expect(body).not.toContain("800");
  });
});

describe("Clear is not empty, carried through the panel", () => {
  it("a cleared card never appears, and an unplanned empty slot is listed", () => {
    const panel = run({ eaten: eatenAt("meal-3"),
      itemOverrides: { "meal-3": saved(600), "meal-1": clearMeal(undefined, null) } }, at("23:00"));
    expect(panel.show).toBe(true);
    if (!panel.show) return;
    expect(panel.cards.some((card) => card.slot === "meal-1")).toBe(false);
    expect(panel.cards.some((card) => card.slot === "meal-2")).toBe(true);
  });
});

describe("panel reads the same balance the classifier used", () => {
  it("equals a hand-built dayBalance fed through classifyDay", () => {
    const balance: DayBalance = { targetKcal: 2000, missed: [], remaining: [], eatingEndMinutes: 1290,
      windowMinutes: 600, left: 2000, planned: 0,
      intake: { recordedKcal: 0, status: "complete", estimatedSlots: 0, unknownSlots: 0,
        unknownItems: 0, unknownEntries: 0, partial: false } };
    const state = classifyDay(DATE, DATE, balance);
    const panel = buildRebalancePanel(state, balance, null);
    expect(panel).toMatchObject({ show: true, state: "no_action" });
  });
});
