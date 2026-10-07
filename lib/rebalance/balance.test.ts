/** Phase 19 §5.1, §5.2 / §7: the one predicate, the day's numbers and the intake evidence. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetProfile } from "@/lib/api-types";
import { targetRevisionFromProfile } from "@/lib/targets/revision";
import { clearMeal } from "@/lib/today/meal-actions";
import type { StoredDay, Store } from "@/lib/types";
import {
  account, at, build, DATE, eatenAt, entry, item, saved, slotOf,
} from "./__fixtures__/days";
import { balanceOf, dayBalance, panelNow, toleranceFor } from "./balance";

function balanceFor(stored: Omit<StoredDay, "date">, now = at("12:00"), store: Store = account()) {
  store.days[DATE] = { date: DATE, ...stored };
  const { day, slots } = build(store);
  return { day, slots, balance: dayBalance(day, slots, now) };
}

const names = (slots: readonly { slot: string }[]) => slots.map((slot) => slot.slot);

describe("Predicate: balanceOf", () => {
  it.each([[1200, 100], [2000, 100], [3000, 150]])("T %i has tolerance %i", (T, tol) => {
    expect(toleranceFor(T)).toBe(tol);
    expect(balanceOf(T, T)).toBe("within");
    expect(balanceOf(T + tol, T)).toBe("within");
    expect(balanceOf(T + tol + 1, T)).toBe("over");
    expect(balanceOf(T + tol - 1, T)).toBe("within");
    expect(balanceOf(T - tol, T)).toBe("within");
    expect(balanceOf(T - tol - 1, T)).toBe("under");
    expect(balanceOf(T - tol + 1, T)).toBe("within");
  });
});

describe("One predicate (source scan)", () => {
  const dir = __dirname;
  const sources = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, code: readFileSync(path.join(dir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "") }));
  const KCAL = String.raw`(kcal|Kcal|recorded|planned|left|consumed)`;
  const TARGET = String.raw`(target|Target|\bT\b|toleranceFor|tolerance)`;
  const compare = new RegExp(`${KCAL}[^;\\n]*[<>]=?[^;\\n]*${TARGET}|${TARGET}[^;\\n]*[<>]=?[^;\\n]*${KCAL}`);

  it("finds no comparison of kcal with a target outside balance.ts", () => {
    const files = sources.map((source) => source.file);
    for (const required of ["balance.ts", "classify.ts", "intake.ts", "missed.ts"]) {
      if (!files.includes(required)) throw new Error(`one-predicate scan: ${required} not found in ${dir}`);
    }
    for (const { file, code } of sources) {
      if (file === "balance.ts") continue;
      const lines = code.split("\n").filter((text) => compare.test(text.replace(/=>/g, " arrow ")));
      expect({ file, lines }).toEqual({ file, lines: [] });
      expect({ file, tolerance: /toleranceFor|BALANCE_TOLERANCE/.test(code) })
        .toEqual({ file, tolerance: false });
    }
  });

  it("has the classifier import balanceOf", () => {
    const scanned = ["classify.ts"];
    for (const file of scanned) {
      const source = sources.find((entry) => entry.file === file);
      if (!source) throw new Error(`one-predicate scan: ${file} not found in ${dir}`);
      expect({ file, imports: /import\s*{[^}]*\bbalanceOf\b[^}]*}\s*from\s*"\.\/balance"/.test(source.code) })
        .toEqual({ file, imports: true });
    }
  });

  // R2: panel.ts assembles a RebalancePanel from an already-decided PanelState; it never
  // classifies on its own, so it needs only the classifier's TYPE, never the value balanceOf.
  // panel-client.ts (the hook) is the one place that drives that classification for the UI, so it
  // must import the real functions. tests/rebalance/import-graph.test.ts widens the "no
  // comparison" half of this scan past lib/rebalance/ to the panel component, its face adapter,
  // the widget-sync hook and Today navigation, and repeats the hook's import check there too.
  it("has panel.ts read the classifier's type, and the hook import the classifier and balance functions", () => {
    const panel = sources.find((entry) => entry.file === "panel.ts");
    if (!panel) throw new Error(`one-predicate scan: panel.ts not found in ${dir}`);
    expect(/import\s+type\s*{[^}]*\b(PanelState|PanelStateName)\b[^}]*}\s*from\s*"\.\/classify"/.test(panel.code))
      .toBe(true);

    const client = sources.find((entry) => entry.file === "panel-client.ts");
    if (!client) throw new Error(`one-predicate scan: panel-client.ts not found in ${dir}`);
    expect(/import\s*{[^}]*\bclassifyDay\b[^}]*}\s*from\s*"\.\/classify"/.test(client.code)).toBe(true);
    expect(/import\s*{[^}]*\bdayBalance\b[^}]*}\s*from\s*"\.\/balance"/.test(client.code)).toBe(true);
  });
});

describe("Energy rule", () => {
  it("adds reported and calculated-only energy and calls the day complete", () => {
    const { day, balance } = balanceFor({ extras: [entry("a", [item({ reported: 320 }, "r"),
      item({ calculated: 180 }, "c")])] });
    expect(balance.intake.recordedKcal).toBe(500);
    expect(balance.intake.status).toBe("complete");
    expect(day.consumed.kcal).toBe(500);
  });

  it("prefers reported over calculated and keeps a known zero", () => {
    const { balance } = balanceFor({ extras: [entry("a", [item({ reported: 0, calculated: 90 })])] });
    expect(balance.intake).toMatchObject({ recordedKcal: 0, unknownItems: 0, status: "complete" });
  });

  it("decides recordedKcal and unknownItems only through itemKcal and eatenEnergyBasis (source scan)", () => {
    const intake = readFileSync(path.join(__dirname, "intake.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(intake).toMatch(/itemKcal\(/);
    expect(intake).toMatch(/eatenEnergyBasis/);
    // panel.ts (R2) is exempt from the consumed.protein half only: its proteinConsumedG is the
    // contract's own read of day.consumed.protein for display (spec §6), gated on a complete
    // intake and never used to decide recordedKcal or unknownItems — see its own source scan in
    // lib/rebalance/panel.test.ts ("never reads day.consumed.kcal for recordedKcal").
    for (const file of readdirSync(__dirname).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const code = readFileSync(path.join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const pattern = file === "panel.ts" ? /entryMacros|snapshotMacros|consumed\.kcal/g
        : /entryMacros|snapshotMacros|consumed\.kcal|consumed\.protein/g;
      expect({ file, found: code.match(pattern) }).toEqual({ file, found: null });
    }
    expect(intake.match(/macros\.kcal/g)).toBeNull();
  });

  it("treats an item with no snapshot at all as unknown", () => {
    const bare = { ...item({ reported: 100 }), snapshot: undefined } as unknown as ReturnType<typeof item>;
    const { balance } = balanceFor({ extras: [entry("a", [bare])] });
    expect(balance.intake).toMatchObject({ unknownItems: 1, status: "incomplete" });
  });
});

describe("Frozen estimate (round-6 BLOCK 1)", () => {
  it("never counts a frozen share as recorded energy", () => {
    const store = account(1800);
    const { slots, balance } = balanceFor({ eaten: eatenAt("meal-3") }, at("20:00"), store);
    expect(slotOf(slots, "meal-3").macros.kcal).toBeCloseTo(600, 5);
    expect(slotOf(slots, "meal-3").eatenEnergyBasis).toBe("estimate");
    expect(balance.intake).toMatchObject({ recordedKcal: 0, status: "estimated", estimatedSlots: 1 });
    expect(balance.left).toBeNull();
    expect(balance.planned).toBeNull();
  });

  it("counts a log filed under the slot once, as the record", () => {
    const store = account(1800);
    const { day, slots, balance } = balanceFor({ eaten: eatenAt("meal-3"),
      extras: [entry("dinner", [item({ reported: 700 })], "meal-3")] }, at("20:00"), store);
    expect(slotOf(slots, "meal-3").eatenEnergyBasis).toBe("log");
    expect(balance.intake).toMatchObject({ recordedKcal: 700, status: "complete" });
    expect(balance.intake.recordedKcal).toBe(day.consumed.kcal);
  });
});

describe("Timestamp-only ritual (round-1 BLOCK)", () => {
  it("records nothing for a date-rotated library meal and calls the day incomplete", () => {
    const { day, slots, balance } = balanceFor({ eaten: { coffee: `${DATE}T07:00:00Z` } });
    expect(slotOf(slots, "coffee").macros.kcal).toBeGreaterThan(0);
    expect(day.consumed.kcal).toBeGreaterThan(0); // Today's display total counts the library meal
    expect(balance.intake).toMatchObject({ recordedKcal: 0, unknownSlots: 1, status: "incomplete" });
    expect(balance.left).toBeNull();
    expect(balance.planned).toBeNull();
  });

  it("counts only the log filed under it, once, in the panel and in Today's total", () => {
    const { day, slots, balance } = balanceFor({ eaten: { coffee: `${DATE}T07:00:00Z` },
      extras: [entry("latte", [item({ reported: 125 })], "coffee")] });
    expect(slotOf(slots, "coffee").eatenEnergyBasis).toBe("log");
    expect(balance.intake).toMatchObject({ recordedKcal: 125, status: "complete" });
    expect(day.consumed.kcal).toBe(125);
  });

  it("keeps complete-day equality for a saved swap id with its own log (round-2 BLOCK)", () => {
    const { day, slots, balance } = balanceFor({ eaten: { coffee: `${DATE}T07:00:00Z` },
      swaps: { coffee: "coffee--latte" }, extras: [entry("latte", [item({ reported: 100 })], "coffee")] });
    expect(slotOf(slots, "coffee").macros.kcal).toBe(0);
    expect(slotOf(slots, "coffee").eatenEnergyBasis).toBe("log");
    expect(day.consumed.kcal).toBe(100);
    expect(balance.intake).toMatchObject({ recordedKcal: 100, status: "complete" });
    expect(balance.intake.recordedKcal).toBe(day.consumed.kcal);
  });
});

describe("Legacy macro fallback (round-6 BLOCK 2)", () => {
  it("never reads an item's legacy macros.kcal as energy", () => {
    const { day, balance } = balanceFor({ extras: [entry("a", [{ ...item({ legacyKcal: 800 }, "legacy"), snapshot: {} },
      item({ reported: 200 }, "real")])] });
    expect(day.consumed.kcal).toBeGreaterThan(200); // Today's display total still shows the fallback
    expect(balance.intake).toMatchObject({ recordedKcal: 200, unknownItems: 1, status: "incomplete" });
    expect(balance.left).toBeNull();
  });

  it("counts an entry with no items as an unknown entry, whatever its macros say", () => {
    for (const items of [undefined, []]) {
      const legacy = entry("a", items, undefined, { macros: { kcal: 800, protein: 40, carbs: 90, fat: 30 } });
      const { day, balance } = balanceFor({ extras: [legacy] });
      expect(day.consumed.kcal).toBe(800);
      expect(balance.intake).toMatchObject({ recordedKcal: 0, unknownEntries: 1, status: "incomplete" });
    }
  });

  it("counts the reconcile placeholder (snapshot {} with macros.kcal 0) as unknown", () => {
    const placeholder = { ...item(), snapshot: {} };
    const { balance } = balanceFor({ extras: [entry("a", [placeholder])] });
    expect(balance.intake).toMatchObject({ unknownItems: 1, status: "incomplete" });
  });

  it("calls a partly measured recipe serving incomplete", () => {
    const { balance } = balanceFor({ extras: [entry("r", [item({ reported: 200 })], "meal-1",
      { nutritionPartial: true })] });
    expect(balance.intake).toMatchObject({ recordedKcal: 200, partial: true, status: "incomplete" });
    expect(balance.planned).toBeNull();
  });
});

describe("Day numbers: dayBalance", () => {
  it("lists missed and remaining cards and keeps eaten, cleared and deleted ones out", () => {
    const store = account(2000, 4); // 08:00, 11:30, 15:00, 18:30
    const { day, balance } = balanceFor({
      eaten: eatenAt("meal-1"),
      itemOverrides: {
        "meal-1": saved(500, "Oats"),
        "meal-2": clearMeal(undefined, null),
        "meal-3": { ...saved(300, "Snack plate"), removed: true },
        "meal-4": saved(650, "Dinner"),
      },
    }, at("16:00"), store);
    expect(names(day.slots)).toEqual(["meal-1", "meal-2", "meal-4"]);
    expect(names(balance.missed)).toEqual([]);
    expect(names(balance.remaining)).toEqual(["meal-4"]);
    expect(balance.intake).toMatchObject({ recordedKcal: 500, status: "complete" });
    expect(balance.intake.recordedKcal).toBe(day.consumed.kcal);
    expect(balance.left).toBe(1500);
    expect(balance.planned).toBe(1150);
  });

  it("leaves missed cards out of planned", () => {
    const { day, balance } = balanceFor({ eaten: eatenAt("meal-1"),
      itemOverrides: { "meal-1": saved(500, "Oats"), "meal-2": saved(600, "Lunch"),
        "meal-3": saved(700, "Dinner") } }, at("14:00"));
    expect(names(balance.missed)).toEqual(["meal-2"]);
    expect(names(balance.remaining)).toEqual(["meal-3"]);
    expect(balance.planned).toBe(1200);
    expect(balance.intake.recordedKcal).toBe(day.consumed.kcal);
  });

  it("keeps a planned, uneaten meal with food logged under it remaining (round-7 BLOCK 1)", () => {
    const { day, balance } = balanceFor({ eaten: eatenAt("meal-1"),
      itemOverrides: { "meal-1": saved(500, "Oats"), "meal-2": saved(600, "Lunch") },
      extras: [entry("side", [item({ reported: 150 })], "meal-2")] }, at("15:30"));
    expect(names(balance.missed)).toEqual([]);
    expect(names(balance.remaining)).toEqual(["meal-2", "meal-3"]);
    expect(balance.planned).toBe(500 + 150 + 600);
    expect(balance.intake.recordedKcal).toBe(day.consumed.kcal);
  });

  it("drops a slot whose log is its record from both lists", () => {
    const { slots, balance } = balanceFor({ eaten: eatenAt("meal-1"),
      itemOverrides: { "meal-1": saved(500, "Oats") },
      extras: [entry("lunch", [item({ reported: 650 })], "meal-2")] }, at("15:30"));
    expect(slotOf(slots, "meal-2").meal).toBeNull();
    expect(names(balance.missed)).toEqual([]);
    expect(names(balance.remaining)).toEqual(["meal-3"]);
    expect(balance.planned).toBe(1150);
  });

  it("gives no left figure without a target, and sets the eating end and window", () => {
    const store = account(null);
    const { balance } = balanceFor({ itemOverrides: { "meal-3": saved(700, "Late", { time: "22:15" }) } },
      at("21:00"), store);
    expect(balance.targetKcal).toBeNull();
    expect(balance.intake.status).toBe("complete");
    expect(balance.left).toBeNull();
    expect(balance.planned).toBe(700);
    expect(balance.eatingEndMinutes).toBe(22 * 60 + 15);
    expect(balance.windowMinutes).toBe(75);
    const early = balanceFor({}, at("09:00")).balance;
    expect(early.eatingEndMinutes).toBe(21 * 60 + 30);
    expect(early.windowMinutes).toBe(750);
  });
});

describe("Target in force", () => {
  const row = (effective: string, rev: number, kcal: number): TargetProfile => ({
    id: `00000000-0000-4000-8000-00000000000${rev}`, user_id: "00000000-0000-4000-8000-000000000010",
    effective_from: effective, rev, kcal_train: kcal, kcal_rest: kcal, authored_by: "user", mode: "grams",
    protein_g: 120, fat_g: 70, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null,
    kcal_min: 1200, protein_g_min: 100, fat_g_min: 40, carb_g_min: 0,
    goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null, target_source: "derived",
    training_macros: { kcal, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal, protein: 120, carbs: 200, fat: 70 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
    input_weight_kg: 60, input_weight_source: "weigh-in", input_training_weekdays: [],
    input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
  });

  it("uses the revision in force on the day, never a future-dated one", () => {
    const old = targetRevisionFromProfile(row("2026-10-01", 1, 2000))!;
    const next = targetRevisionFromProfile(row("2026-10-08", 2, 2400))!;
    const store = account();
    store.settings = { ...store.settings, activeTargetProfile: old, targetHistory: [old, next],
      targetHistorySince: old.effectiveFrom };
    const on = (date: string) => {
      const { day, slots } = build(store, date);
      return dayBalance(day, slots, { date, minutes: 600 }).targetKcal;
    };
    expect(on("2026-10-07")).toBe(2000);
    expect(on("2026-10-08")).toBe(2400);
    expect(on("2026-10-09")).toBe(2400);
    expect(balanceFor({}, at("09:00"), account(null)).balance.targetKcal).toBeNull();
  });
});

describe("panelNow", () => {
  it("uses the device's local day and clock, not UTC", () => {
    const late = new Date(2026, 9, 6, 23, 45);
    expect(panelNow(late)).toEqual({ date: "2026-10-06", minutes: 23 * 60 + 45 });
    const early = new Date(2026, 9, 7, 0, 10);
    expect(panelNow(early)).toEqual({ date: "2026-10-07", minutes: 10 });
  });
});
