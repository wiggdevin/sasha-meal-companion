/**
 * Phase 18 W7 acceptance 1: with no taste (`z`) values, `rankPlates` and `planDay` are byte-identical
 * to `main` before `pref-2`. The golden file holds, per date over 365 dates, the sha256 of the full
 * serialized day plan and of the small-snack ranking (the anchorless path) as `main` produced them;
 * odd dates also carry snapshot evidence so the history path is pinned too.
 *
 * Regenerate only on a reviewed, intended ranking change: `UPDATE_PREF2_GOLDEN=1 pnpm vitest run
 * tests/meals/pref2-baseline.test.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planDay, type DaySlot } from "@/lib/meals/day";
import { rankPlates } from "@/lib/meals/plate";
import type { MealEvidence } from "@/lib/meals/snapshot";
import { BREAKFAST, eats, F, MAIN } from "@/tests/helpers/meal-foods";

const GOLDEN = new URL("./__golden__/pref2-baseline.golden.json", import.meta.url);
const FOODS = eats(...Object.values(F));
const SNACK = { kcal: 300, protein: 20, carbs: 30, fat: 10 };
const SLOTS: DaySlot[] = [
  { id: "meal-1", clock: "07:30", target: BREAKFAST },
  { id: "meal-2", clock: "12:30", target: MAIN },
  { id: "meal-3", clock: "15:30", target: SNACK },
  { id: "meal-4", clock: "19:00", target: MAIN },
];
const EVIDENCE: MealEvidence = {
  accountId: "acct-golden", computedAt: "2026-01-01T00:00:00.000Z",
  history: { "tofu, firm": { breakfast: 0.9 }, "paneer": { lunch: 0.8, dinner: 0.7 } },
};

function datesFrom(start: string, count: number): string[] {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function snapshotOf(date: string, index: number): string {
  const evidence = index % 2 ? EVIDENCE : undefined;
  // Every third date passes an empty taste map: no taste values at all, so the same bytes.
  const taste = index % 3 === 0 ? {} : undefined;
  const plan = planDay(date, SLOTS, FOODS, undefined, evidence, taste);
  const snack = rankPlates({ date, slot: "meal-3", occasion: "snack", target: SNACK, foods: FOODS,
    ...(evidence ? { evidence } : {}), ...(taste ? { taste } : {}) });
  return sha({ plan, snack });
}

describe("W7 acceptance 1: no taste values, byte-identical to main", () => {
  it("matches the 365-date golden file", () => {
    const dates = datesFrom("2026-01-01", 365);
    const actual = Object.fromEntries(dates.map((date, i) => [date, snapshotOf(date, i)]));
    if (process.env.UPDATE_PREF2_GOLDEN === "1") {
      writeFileSync(GOLDEN, `${JSON.stringify({ source: "main before pref-2", dates: actual }, null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { dates: Record<string, string> };
    expect(Object.keys(golden.dates)).toHaveLength(365);
    expect(actual).toEqual(golden.dates);
  }, 120_000);
});
