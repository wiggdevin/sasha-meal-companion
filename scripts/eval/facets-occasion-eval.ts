/**
 * Phase 17 O3 calibration eval for the v2 occasion rubric (Acceptance 9).
 *
 * Runs Jev on the human-labelled, cuisine-diverse holdout (scripts/eval/facets-occasion.holdout.json:
 * foods, complete dishes and a plate pantry from South Asian, East Asian, Latin American,
 * Mediterranean, North American/European and West African food) with the production occasion
 * questions, picks the per-occasion threshold that maximises balanced accuracy, then, per cuisine
 * and leave-one-cuisine-out, GENERATES plates with lib/meals rankPlates over that cuisine's pantry
 * (facets on the ladder, ./facets-occasion/plates.ts) and judges each against the human labels.
 * Plate plausibility is what the gate reads; label accuracy is reported beside it. Scoring is pure
 * (./facets-occasion/metrics.ts, unit-tested).
 *
 * NEVER in CI: `--live` bills the TypeSafe key (about 70 cases x 4 questions, well under $0.05).
 * Run by hand from the repo root with the key in the environment or .env.local (ZS Vault).
 * The report carries every generated plate and the curated-only plausibility for comparison:
 *
 *   pnpm exec tsx scripts/eval/facets-occasion-eval.ts --live [--out <report.json>] [--freeze]
 *
 * Re-score a saved report's answers with no model call (after a metrics or label change):
 *
 *   pnpm exec tsx scripts/eval/facets-occasion-eval.ts --rescore <report.json> [--out <path>] [--freeze]
 *
 * `--freeze` writes lib/foods/occasion-calibration.data.ts from the report: the calibration when it
 * passes on a reviewed holdout, `null` (gate shut) otherwise. Commit that file with the report. The
 * seed holdout is unreviewed, so until the owner reviews its labels a freeze always writes `null`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import type { Answers, CalibrationReport, HoldoutItem } from "./facets-occasion/metrics";

const CHILD_ARG = "--facets-occasion-react-server-child";
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HOLDOUT_PATH = resolve(ROOT, "scripts/eval/facets-occasion.holdout.json");
const CALIBRATION_PATH = resolve(ROOT, "lib/foods/occasion-calibration.data.ts");
const BATCH_TOKEN_LIMIT = 16_000;
const INPUT_USD_PER_MILLION = 0.042;
const SPEND_LIMIT_USD = 1;
const DEADLINE_MS = 20_000;

type Args = { live: boolean; rescore: string | null; out: string; freeze: boolean };

export function parseArgs(argv: readonly string[], today = new Date().toISOString().slice(0, 10)): Args {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at < 0 ? null : argv[at + 1] ?? null;
  };
  const live = argv.includes("--live");
  const rescore = value("--rescore");
  if (live === Boolean(rescore)) throw new Error("Choose exactly one of --live (billed) or --rescore <report.json>");
  return { live, rescore, freeze: argv.includes("--freeze"),
    out: resolve(ROOT, value("--out") ?? `docs/evals/${today}-facets-occasion.json`) };
}

async function liveAnswers(items: readonly Pick<HoldoutItem, "id" | "food">[]): Promise<{ answers: Answers; model: string; usd: number }> {
  if (process.env.CI) throw new Error("The occasion eval bills a real key and never runs in CI");
  const envFile = resolve(ROOT, ".env.local");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const [{ systemOne }, { occasionEvalPayload }, { JEV_MODEL }, { OCCASION_FACET_OF, MEAL_OCCASIONS }] =
    await Promise.all([import("@/lib/ai/typesafe"), import("@/lib/ai/payloads"), import("@/lib/ai/models"),
      import("@/lib/foods/occasion-gate")]);
  type Case = { id: string; food: FacetFoodInput };
  const estimate = (cases: Case[]) => {
    const payload = occasionEvalPayload({ items: cases });
    return Math.ceil(Buffer.byteLength(JSON.stringify({ state: payload.state, questions: payload.questions }), "utf8") / 4);
  };
  const batches: Case[][] = [];
  let pending: Case[] = [];
  for (const item of items) {
    const next = [...pending, { id: item.id, food: item.food }];
    if (pending.length > 0 && estimate(next) > BATCH_TOKEN_LIMIT) {
      batches.push(pending);
      pending = [{ id: item.id, food: item.food }];
    } else pending = next;
  }
  if (pending.length > 0) batches.push(pending);
  const tokens = batches.reduce((sum, batch) => sum + estimate(batch), 0);
  const usd = (tokens / 1_000_000) * INPUT_USD_PER_MILLION;
  if (usd >= SPEND_LIMIT_USD) throw new Error(`Predicted Jev spend $${usd.toFixed(4)} exceeds $${SPEND_LIMIT_USD}`);

  const answers: Answers = {};
  for (const [index, batch] of batches.entries()) {
    const result = await systemOne(occasionEvalPayload({ items: batch }), { deadlineMs: DEADLINE_MS });
    if (!result) throw new Error(`Jev returned no answer for batch ${index + 1}/${batches.length}`);
    for (const item of batch) {
      const own: Partial<Record<(typeof MEAL_OCCASIONS)[number], number>> = {};
      for (const occasion of MEAL_OCCASIONS) {
        const answer = (result as Record<string, { type: string; noul?: number }>)[`${item.id}::${OCCASION_FACET_OF[occasion]}`];
        if (answer?.type === "noul" && typeof answer.noul === "number") own[occasion] = answer.noul;
      }
      answers[item.id] = own;
    }
    console.log(`judged batch ${index + 1}/${batches.length}: ${batch.length} cases`);
  }
  return { answers, model: JEV_MODEL, usd };
}

export async function run(argv: readonly string[]): Promise<CalibrationReport> {
  const args = parseArgs(argv);
  const [metrics, { rankPlatesGenerator }] = await Promise.all([import("./facets-occasion/metrics"),
    import("./facets-occasion/plates")]);
  const raw = readFileSync(HOLDOUT_PATH, "utf8");
  const holdout = metrics.parseHoldout(JSON.parse(raw));
  let answers: Answers;
  let model: string;
  if (args.live) {
    const live = await liveAnswers([...holdout.items, ...holdout.pantry]);
    answers = live.answers;
    model = live.model;
    console.log(`predicted spend: $${live.usd.toFixed(5)}`);
  } else {
    const saved = JSON.parse(readFileSync(resolve(ROOT, args.rescore as string), "utf8")) as CalibrationReport;
    if (saved.kind !== "facets-occasion-calibration" || !saved.answers) throw new Error("Not an occasion calibration report");
    answers = saved.answers;
    model = saved.model;
  }
  const report = metrics.evaluate(holdout, raw, answers, { model, measuredAt: new Date().toISOString() },
    rankPlatesGenerator);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  if (args.freeze) writeFileSync(CALIBRATION_PATH, metrics.calibrationSource(metrics.storedCalibration(report)));
  console.log(JSON.stringify({ thresholds: report.thresholds, perCuisine: report.perCuisine,
    verdict: report.verdict, out: args.out, froze: args.freeze }, null, 2));
  return report;
}

if (!process.argv.includes(CHILD_ARG)) {
  // `server-only` sits in the lib/ai import graph; the react-server condition lets it resolve.
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD_ARG, ...process.argv.slice(2)], { stdio: "inherit", env: process.env, cwd: ROOT });
  if (child.error) console.error(child.error);
  process.exitCode = child.status ?? 1;
} else {
  run(process.argv.slice(2).filter((arg) => arg !== CHILD_ARG))
    .then((report) => { process.exitCode = report.verdict.passes ? 0 : 1; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
