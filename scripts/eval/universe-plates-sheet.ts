/**
 * The owner's plate-plausibility sheet for the open food world (Phase 18 W8 acceptance 7, the
 * release gate in docs/specs/phase-18-open-world-foods.md §W8 "As built"). It generates the plates
 * an open account with NO Favored foods would get, per stated cuisine and meal, exactly the way the
 * phone builds them (the D4 admission over the universe, snapshot v3 foods, `openWorldInputs`,
 * `planMealsForDay`), and writes them as a CSV for a person to label. No model call, no database,
 * no billing.
 *
 *   pnpm exec tsx scripts/eval/universe-plates-sheet.ts [--per 12] [--out <csv>]
 *       writes the sheet (default: docs/eval/universe-plates/sheet-<universe version>.csv): each
 *       distinct (meal, plate) once, with the cuisines whose plan produced it
 *   pnpm exec tsx scripts/eval/universe-plates-sheet.ts --score <labelled csv>
 *       prints plausibility per cuisine and the verdict against ACCEPTANCE (85 % per cuisine, no
 *       cuisine more than 10 points below the best: the Phase 17 Acceptance 9 numbers)
 *
 * Label column `plausible`: `y` (a typical plate at that meal for people who eat that cuisine),
 * `n` (implausible: say why in `note`), or blank to skip. A skipped row is not scored.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { planMealsForDay, type LayoutSlot } from "@/lib/foods/layout-plan";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE, UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import { CUISINES, type CuisineKey } from "@/lib/foods/universe/vocabulary";
import { admitUniverse } from "@/lib/foods/world/admission";
import { snapshotFoodsV3 } from "@/lib/foods/world/snapshot-foods";
import { openWorldInputs } from "@/lib/meals/open-world";
import type { Part } from "@/lib/meals/parts";
import { PREFERENCE_VERSION } from "@/lib/meals/preference";
import { RANKING_VERSION } from "@/lib/meals/snapshot";
import { SNAPSHOT_V3, type MealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

/** The Phase 17 Acceptance 9 numbers, applied to open-world plates. */
export const ACCEPTANCE = { minPerCuisine: 0.85, maxGapBelowBest: 0.10, minLabelledPerCuisine: 10 } as const;

/** One ordinary 2,000 kcal, 4-meal day: each clock falls in one occasion band (lib/meals/occasion.ts). */
const SLOTS: readonly (LayoutSlot & { occasion: string })[] = [
  { id: "meal-1", clock: "08:00", occasion: "breakfast", target: { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 } },
  { id: "meal-2", clock: "12:30", occasion: "lunch", target: { kcal: 550, protein: 38, carbs: 58, fat: 18 } },
  { id: "meal-3", clock: "15:30", occasion: "snack", target: { kcal: 250, protein: 15, carbs: 26, fat: 9 } },
  { id: "meal-4", clock: "19:00", occasion: "dinner", target: { kcal: 700, protein: 52, carbs: 72, fat: 23 } },
] as const;

const ITEMS: readonly UniverseItem[] = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
const UNIVERSE_PARTS: Readonly<Record<string, readonly Part[]>> =
  Object.fromEntries(ITEMS.map((item) => [item.entry.id, item.parts]));

/** The v3 body the server would send an open account with no rules, no Favored foods and this cuisine. */
function snapshotFor(cuisine: CuisineKey): MealSnapshotV3 {
  const admitted = admitUniverse(ITEMS, { profile: EMPTY_PROFILE, preferenceFlags: [], avoidFamilies: new Set() });
  const foods = snapshotFoodsV3({ own: [], admittedRefIds: [], admittedUniverseIds: admitted.admitted, plateRules: [],
    context: { profile: { m: 0, identities: [] }, identities: new Map(), dislikes: [], cuisines: [cuisine],
      prior: { prior: { status: "neutral", reason: "country_unset" }, cohort: "national" },
      universeParts: UNIVERSE_PARTS, graph: null } });
  return {
    schemaVersion: SNAPSHOT_V3, rankingVersion: RANKING_VERSION, universeVersion: UNIVERSE_VERSION,
    universeHash: UNIVERSE_HASH, prefVersion: PREFERENCE_VERSION, priorVersion: "neutral", graphVersion: "none",
    accountId: "00000000-0000-4000-8000-000000000000", rulesVersion: 1, evidenceVersion: 1,
    computedAt: "2026-10-08T00:00:00.000Z", inputsHash: "sheet", world: "open", focusUntil: null, plateRules: [],
    admittedUniverseIds: admitted.admitted, admittedRefIds: [], foods,
    excluded: admitted.excluded.map((row) => ({ id: row.id, verdict: row.verdict, reason: row.reason })),
    eligible: { eligibleRefIds: [], eligibleFoodIds: [], eligibleCatalogFoodIds: [], excluded: [],
      rulesRevision: 1, preferenceFlags: [] },
  };
}

type SheetRow = { id: string; cuisine: CuisineKey; occasion: string; plate: string };
/** One distinct (meal, plate), with every stated cuisine whose plan produced it. */
type LabelRow = { id: string; occasion: string; plate: string; cuisines: CuisineKey[] };

/**
 * The plates to label, each distinct (meal, plate) once. A plate that every cuisine produces is one
 * row, labelled once: at day 0 (no history) the stated cuisine moves `z` by about 0.1, too little
 * to change a plate, so today the 12 cuisines share one sheet.
 */
export function labelRows(per: number): LabelRow[] {
  const byPlate = new Map<string, LabelRow>();
  for (const row of sheetRows(per)) {
    const key = `${row.occasion}\u0000${row.plate}`;
    const hit = byPlate.get(key);
    if (hit) hit.cuisines.push(row.cuisine);
    else byPlate.set(key, { id: `${row.occasion}-${[...byPlate.values()].filter((r) => r.occasion === row.occasion).length + 1}`,
      occasion: row.occasion, plate: row.plate, cuisines: [row.cuisine] });
  }
  return [...byPlate.values()];
}

/** Up to `per` distinct plates per (cuisine, occasion), from consecutive dates (the date rotation). */
export function sheetRows(per: number, maxDates = 90): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const cuisine of CUISINES) {
    const open = openWorldInputs(snapshotFor(cuisine), {}, {});
    const seen = new Map<string, Set<string>>(SLOTS.map((slot) => [slot.occasion, new Set<string>()]));
    for (let i = 0; i < maxDates; i += 1) {
      if ([...seen.values()].every((set) => set.size >= per)) break;
      const date = new Date(Date.UTC(2026, 9, 8) + i * 86_400_000).toISOString().slice(0, 10);
      const plan = planMealsForDay(date, SLOTS, open.foods, undefined, open.evidence, open);
      for (const { slot, meal } of plan.meals) {
        const occasion = SLOTS.find((row) => row.id === slot)?.occasion ?? "other";
        const plate = meal.components.map((part) => part.name).sort().join(" + ");
        const set = seen.get(occasion);
        if (!set || set.size >= per || set.has(plate)) continue;
        set.add(plate);
        rows.push({ id: `${cuisine}-${occasion}-${set.size}`, cuisine, occasion, plate });
      }
    }
  }
  return rows;
}

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function writeSheet(per: number, out: string): void {
  const rows = labelRows(per);
  const lines = ["id,occasion,plate,cuisines,plausible,note",
    ...rows.map((row) => [row.id, row.occasion, row.plate,
      row.cuisines.length === CUISINES.length ? "all" : row.cuisines.join(" "), "", ""].map(csvCell).join(","))];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`wrote ${rows.length} distinct plates (${CUISINES.length} cuisines, up to ${per} per meal each) to ${out}`);
}

/** A minimal CSV reader for the sheet this script writes (quoted cells, doubled quotes). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  return out;
}

export function scoreSheet(text: string): { passes: boolean; lines: string[] } {
  const [header, ...body] = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const tally = new Map<string, { yes: number; total: number }>();
  for (const row of body) {
    const label = (row[col("plausible")] ?? "").trim().toLowerCase();
    if (label !== "y" && label !== "n") continue;
    const listed = (row[col("cuisines")] ?? "").trim();
    // A plate counts for every cuisine whose plan produced it.
    for (const cuisine of listed === "all" ? CUISINES : listed.split(/\s+/)) {
      const entry = tally.get(cuisine) ?? { yes: 0, total: 0 };
      entry.total += 1; if (label === "y") entry.yes += 1;
      tally.set(cuisine, entry);
    }
  }
  const shares = CUISINES.map((cuisine) => {
    const entry = tally.get(cuisine) ?? { yes: 0, total: 0 };
    return { cuisine, ...entry, share: entry.total ? entry.yes / entry.total : 0 };
  });
  const best = Math.max(...shares.map((row) => row.share));
  const lines: string[] = []; let passes = true;
  for (const row of shares) {
    const reasons: string[] = [];
    if (row.total < ACCEPTANCE.minLabelledPerCuisine) reasons.push(`only ${row.total} labelled`);
    if (row.share < ACCEPTANCE.minPerCuisine) reasons.push("below 85 %");
    if (best - row.share > ACCEPTANCE.maxGapBelowBest) reasons.push("more than 10 points below the best");
    if (reasons.length) passes = false;
    lines.push(`${row.cuisine.padEnd(16)} ${(row.share * 100).toFixed(1).padStart(5)} % (${row.yes}/${row.total})${reasons.length ? `  FAIL: ${reasons.join("; ")}` : ""}`);
  }
  return { passes, lines };
}

function main(argv: readonly string[]): void {
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const score = at("--score");
  if (score) {
    const { passes, lines } = scoreSheet(readFileSync(score, "utf8"));
    console.log(lines.join("\n"));
    console.log(passes ? "PASS: acceptance 7 holds on this sheet" : "FAIL: acceptance 7 does not hold");
    process.exitCode = passes ? 0 : 1;
    return;
  }
  const per = Number(at("--per") ?? 12);
  if (!Number.isInteger(per) || per < 1 || per > 20) throw new Error("--per must be an integer from 1 to 20");
  writeSheet(per, at("--out") ?? `docs/eval/universe-plates/sheet-${UNIVERSE_VERSION}.csv`);
}

if (process.argv[1]?.endsWith("universe-plates-sheet.ts")) main(process.argv.slice(2));
