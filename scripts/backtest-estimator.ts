/**
 * Replays every synthetic scenario through the exp-3.0.0 engine and writes the exit record.
 * Run: `pnpm exec tsx scripts/backtest-estimator.ts`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  BASE_TDEE, replayScenario, SCENARIOS, steadyState, toScenarioDay, waterSwingControl,
} from "@/lib/expenditure.fixtures";
import { ENGINE_VERSION } from "@/lib/expenditure";

/**
 * exp-3.0.0's acceptance claims (docs/specs/phase-16-adaptive-handoff.md §Acceptance,
 * docs/decisions/2026-10-04-adaptive-handoff-rulings.md R9), re-declared here from the spec text —
 * deliberately NOT imported from `tests/expenditure/backtest.test.ts`. That test asserts these
 * same numbers agree with its own, so a bound can never drift in one place only.
 */
export const ARTEFACT_MAX_KCAL = 60;
export const STEP_MIN_MOVE_KCAL = 200;
export const STEP_WITHIN_DAYS = 28;
export const RAMP_MAX_KCAL = 120;

type Runs = ReturnType<typeof replayScenario>;

const control = replayScenario(steadyState());

const tdeeOn = (runs: Runs, date: string) => runs.find((r) => r.date === date)?.result ?? null;

function maxAbsDeviation(runs: Runs, against: Runs = control): number {
  let worst = 0;
  for (const run of runs) {
    const base = tdeeOn(against, run.date);
    if (base?.tdeeKcal == null || run.result.tdeeKcal == null) continue;
    worst = Math.max(worst, Math.abs(run.result.tdeeKcal - base.tdeeKcal));
  }
  return worst;
}

function row(label: string, runs: Runs) {
  const statuses = new Set<string>();
  for (const run of runs) statuses.add(run.result.status);
  const last = runs.at(-1)?.result;
  return `| ${label} | ${last?.status ?? "n/a"} | ${last?.tdeeKcal ?? "n/a"} | ${last?.phase ?? "n/a"} | ${last?.dataWeight?.toFixed(2) ?? "n/a"} | ${[...statuses].sort().join(", ")} |`;
}

function scenario(label: string): Runs {
  const match = SCENARIOS.find((s) => s.label === label);
  if (!match) throw new Error(`unknown scenario: ${label}`);
  return replayScenario(match);
}

const claims: string[] = [];
function claim(name: string, bound: string, measured: string, pass: boolean) {
  claims.push(`| ${name} | ${bound} | ${measured} | ${pass ? "pass" : "**MISS**"} |`);
}

function verdict() {
  claims.length = 0;
  const water = scenario("1.5 kg water swing over 3 days");
  const cycle = scenario("±0.8 kg on a 28-day cycle");
  const under = scenario("under-logging: 3 qualified days a week");
  const step = scenario("+250 kcal/day step");
  const ramp = scenario("+15 kcal/day/week ramp");

  const waterControl = replayScenario(waterSwingControl());
  const waterDev = maxAbsDeviation(water, waterControl);
  const badNights = water.filter((r, i) =>
    r.result.proposalEligible && !waterControl[i].result.proposalEligible);
  claim("1a water swing", `< ${ARTEFACT_MAX_KCAL} kcal vs a matched artefact-free control`,
    `${Math.round(waterDev)} kcal; bad nights: ${badNights.length}`,
    waterDev < ARTEFACT_MAX_KCAL && badNights.length === 0);

  const day42 = cycle.find((r) => toScenarioDay(r.date) === 42)?.result;
  const rangeContainsTruth = day42?.tdeeLowKcal != null && day42?.tdeeHighKcal != null
    && day42.tdeeLowKcal <= BASE_TDEE && day42.tdeeHighKcal >= BASE_TDEE;
  claim("1b/6 28-day cycle — day 42 range contains the truth", `[low, high] ⊇ {${BASE_TDEE}}`,
    `[${day42?.tdeeLowKcal ?? "n/a"}, ${day42?.tdeeHighKcal ?? "n/a"}]`, !!rangeContainsTruth);

  const after = under.filter((r) => toScenarioDay(r.date) >= 90);
  const day119 = under.find((r) => toScenarioDay(r.date) === 119)?.result;
  const heldNights = after.filter((r) => r.result.status === "held");
  const heldValue = heldNights[0]?.result.tdeeKcal ?? null;
  const consistentHeld = heldNights.every((r) => r.result.tdeeKcal === heldValue);
  claim("2 under-logging", "ends held; every held night pinned to one value; no run after day 90 is burn_in",
    `day 119 status ${day119?.status ?? "n/a"}; held value ${heldValue} kcal; held nights consistent: ${consistentHeld}`,
    day119?.status === "held" && consistentHeld && !after.some((r) => r.result.status === "burn_in"));

  const at60 = step.find((r) => toScenarioDay(r.date) === 60)?.result.tdeeKcal ?? null;
  const at88 = step.find((r) => toScenarioDay(r.date) === 60 + STEP_WITHIN_DAYS)?.result.tdeeKcal ?? null;
  const stepMove = at60 !== null && at88 !== null ? at88 - at60 : null;
  claim(`3a +250 kcal step by day ${60 + STEP_WITHIN_DAYS}`, `≥ +${STEP_MIN_MOVE_KCAL} kcal vs day 60`,
    `day 60: ${at60} kcal, day ${60 + STEP_WITHIN_DAYS}: ${at88} kcal, move ${stepMove ?? "n/a"} kcal`,
    stepMove !== null && stepMove >= STEP_MIN_MOVE_KCAL);

  let rampWorst = 0;
  for (const run of ramp) {
    if (!run.result.proposalEligible || run.result.tdeeKcal === null) continue;
    const day = toScenarioDay(run.date);
    const truth = BASE_TDEE + (day >= 60 ? ((day - 60) * 15) / 7 : 0);
    rampWorst = Math.max(rampWorst, Math.abs(run.result.tdeeKcal - truth));
  }
  claim("3b/12 +15 kcal/day/week ramp", `every proposalEligible night within ${RAMP_MAX_KCAL} kcal of truth`,
    `worst error ${Math.round(rampWorst)} kcal`, rampWorst < RAMP_MAX_KCAL);
}

/** The full Markdown record, deterministic for a given day. */
export function renderRecord(today: string): string {
  verdict();
  const lines = [
    `# Estimator backtest: ${today}`,
    "",
    `Engine \`${ENGINE_VERSION}\`. Each scenario below is replayed with the test seed/BMR from`,
    "`lib/expenditure.fixtures.ts` (prior 2,130 kcal / BMR 1,372 kcal, targets.md §1 — test",
    "scenarios only; the real engine seeds from each account's own profile).",
    "Every series is generated by the seeded LCG in `lib/expenditure.fixtures.ts`; re-running this",
    "script on any machine reproduces the table byte for byte.",
    "",
    "| Scenario | Final status | Final TDEE | Final phase | Final data weight | Statuses seen |",
    "|---|---|---|---|---|---|",
    ...SCENARIOS.map((s) => row(s.label, replayScenario(s))),
    "",
    "## Acceptance claims (docs/specs/phase-16-adaptive-handoff.md, rulings R9)",
    "",
    "1a. Artefact bounded: a 1.5 kg water swing over 3 days moves TDEE by less than",
    `    ${ARTEFACT_MAX_KCAL} kcal against a matched, artefact-free control (same seed, artefact`,
    "    only), and is never proposalEligible on a night the control is not.",
    "1b/6. Cycle artefact: a ±0.8 kg 28-day cycle keeps the day-42 range around the flat truth, and",
    "    no two proposalEligible nights within 28 days disagree about the truth's side by more",
    "    than 75 kcal.",
    "2. Under-logging holds: the account ends `held`, every held night after the thin stretch is",
    "   pinned to one value (R8 — a held night never lowers), and no run after day 90 is `burn_in`.",
    `3a. Real change detected: the +250 kcal step moves the estimate by at least ${STEP_MIN_MOVE_KCAL}`,
    "    kcal within 28 days of the step.",
    `3b/12. Ramp: every proposalEligible night stays within ${RAMP_MAX_KCAL} kcal of the moving truth —`,
    "    never an opposite-sign proposal.",
    "",
    "## Verdict (measured)",
    "",
    "Recomputed by this script from the same replays as `tests/expenditure/backtest.test.ts`, at the",
    "bounds the spec states them. No engine constant is tuned to move a row.",
    "",
    "| Claim | Bound | Measured | Result |",
    "|---|---|---|---|",
    ...claims,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const doc = renderRecord(today);
  mkdirSync("docs/evals", { recursive: true });
  const output = `docs/evals/${today}-exp-3.0.0-backtest.md`;
  writeFileSync(output, doc, "utf8");
  console.log(`wrote ${output}`);
  console.log(doc.split("\n").slice(-12).join("\n"));
}

if (process.argv[1]?.includes("backtest-estimator")) main();
