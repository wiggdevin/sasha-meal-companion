/**
 * Phase 13 §3.2 lane bench: runs each lane's synthetic fixture set against its candidate models and
 * records p50/p95 latency, schema-valid rate, accuracy against exact labelled expectations, and
 * cost.
 *
 *   converse:      gemini-3.6-flash (pin), gemini-3.8-flash
 *   capture_text:  gemini-3.8-flash (pin) vs gemini-3.7-flash — TEXT capture only
 *
 * The 2026-09-23 run also benched DeepSeek and the `ui_chart` / `ui_replies` lanes. The DeepSeek
 * `ui` lane was removed on 2026-10-01; their fixtures and scoring stay only so `--rescore` can
 * re-read that saved run. A rescore reports verdicts for the lanes and models benched today.
 *
 * NEVER in CI: it bills real projects. Run by hand from the repo root with the keys in the
 * environment (from ZS Vault; never printed):
 *
 *   pnpm exec tsx --conditions=react-server scripts/eval/lane-bench.ts \
 *     [--runs 2] [--lanes converse,capture_text] [--out <dir>]
 *
 * (`--conditions=react-server` lets any `server-only` marker in the import graph resolve, as in
 * scripts/coach-live-check.ts.)
 *
 * `--rescore <path-to-a-saved-*.json>` re-scores that run's saved answers against the CURRENT
 * score.ts instead of running anything: no model call, no network, no billing. Use it whenever
 * score.ts changes after a report was already committed (the report's `correct`/accuracy no
 * longer reflect what the current scorer would say about the same answers):
 *
 *   pnpm exec tsx --conditions=react-server scripts/eval/lane-bench.ts --rescore docs/evals/2026-09-23-lane-bench.json \
 *     [--rescored-at 2026-09-24]
 *
 * (Same `--conditions=react-server` as the live run above: the rescore path makes no model call
 * itself, but the module's imports are evaluated eagerly regardless of which path runs, so the
 * flag is required either way.)
 *
 * Every call goes through the same boundary the app uses: builder-made payloads, the call registry,
 * the adapter. Each candidate runs under its lane's own deadline (or the bench cap). Calls run
 * through generateStructured against an in-memory `ai_calls` double, so nothing is written to a
 * database. A failed call's usage is recorded as unknown, never as zero, and failures carry a
 * closed code, never provider text. A lane's pin changes only through a PR that attaches this
 * report (lib/ai/lanes.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { classifyFailure, generateStructured, ProviderHttpError } from "@/lib/ai/adapter";
import { capturePayload, coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { LANES } from "@/lib/ai/lanes";
import { estimateCostUsd } from "@/lib/ai/models";
import { CAPTURE_SCHEMAS } from "@/lib/ai/schemas";
import {
  beatsIncumbent, isCorrect, markdownReport, summarise, type Attempt, type Expect,
} from "./lane-bench/score";

type Values = Record<string, string | number | boolean | null | readonly (string | number)[]>;
type PromptCase = { id: string; values: Values; expect: Expect };
/** Every lane's fixtures, including the retired ui_chart / ui_replies kept for `--rescore`. */
type Fixtures = Record<string, { cases: { id: string; expect: Expect }[] }> & {
  converse: { cases: PromptCase[] };
  capture_text: { cases: { id: string; text: string; expect: Expect }[] };
};

/** The converse lane's fixed instruction; the fixtures only supply values. */
const CONVERSE_INSTRUCTION = "You are a nutrition coach. Answer the user's question from the values"
  + " only. Reply as json: {\"value\": the answer alone as a string: a bare number with no unit or"
  + " separator, true or false, or one lower-case word}.";

const CANDIDATES = {
  converse: ["gemini-3.6-flash", "gemini-3.8-flash"],
  capture_text: ["gemini-3.8-flash", "gemini-3.7-flash"],
} as const;
type BenchLane = keyof typeof CANDIDATES;

/** The lane each bench lane measures and its pin. */
const LANE = {
  converse: { lane: "converse", pin: LANES.converse.model },
  capture_text: { lane: "capture", pin: LANES.capture.model },
} as const;

/** converse and capture have no lane budget of their own (their callers govern); the bench caps. */
const BENCH_CAP_MS = 20_000;
const deadlineFor = (lane: BenchLane) => LANES[LANE[lane].lane].budgetMs ?? BENCH_CAP_MS;
/** §7: the coach turn and capture p95 must not rise. */
const P95_GATED: ReadonlySet<BenchLane> = new Set(["converse", "capture_text"]);

/**
 * What the model returns for the converse lane. One flat string field: Gemini's structured output
 * takes no unions (lib/ai/json-schema.ts). Only the scored value: an unscored free-text answer
 * could contradict it (Sol r2 finding 4).
 */
const CONVERSE_SCHEMA = z.object({ value: z.string().min(1).max(40) });

const BENCH_USER = "00000000-0000-4000-8000-00000000be0c";

/** An in-memory stand-in for the admin client: no circuit history, no spend, rows kept locally. */
function memoryAdmin(rows: Record<string, unknown>[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain, in: () => chain,
    order: () => chain, limit: () => chain,
    insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return { from: () => chain } as never;
}

type Outcome = Omit<Attempt, "lane" | "caseId" | "correct"> & { value: unknown };

async function viaGemini(
  model: string, payload: ReturnType<typeof coachTurnPayload> | ReturnType<typeof capturePayload>,
  schema: z.ZodType, deadlineMs: number,
): Promise<Outcome> {
  // Every completed provider attempt's usage, including attempts the schema rejected and the
  // adapter retried (Sol r2 finding 5). Unknown only when no attempt completed.
  const results: { inputTokens: number; outputTokens: number; usageKnown?: boolean }[] = [];
  // Unknown when no attempt completed, or when any completed attempt carried no usage counts
  // (Sol r3 finding 5): a missing count is never read as zero.
  const usage = () => (results.length === 0 || results.some((r) => r.usageKnown === false)
    ? null : {
    inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
  });
  const cost = () => {
    const known = usage();
    return known ? estimateCostUsd(model, known.inputTokens, known.outputTokens) : null;
  };
  const started = Date.now();
  try {
    const value = await generateStructured({
      payload, userId: BENCH_USER, admin: memoryAdmin([]), schema,
      route: { provider: "google", modelId: model }, maxOutputTokens: 1024,
      timeoutMs: deadlineMs, attemptTimeoutMs: deadlineMs,
    }, { onProviderResult: (_model, result) => { results.push(result); } });
    return { model, value, latencyMs: Date.now() - started, schemaValid: true,
      inputTokens: usage()?.inputTokens ?? null, outputTokens: usage()?.outputTokens ?? null,
      costUsd: cost() };
  } catch (error) {
    const code = error instanceof ProviderHttpError ? `http_${error.status}` : classifyFailure(error);
    return { model, value: null, latencyMs: Date.now() - started, schemaValid: false,
      inputTokens: usage()?.inputTokens ?? null, outputTokens: usage()?.outputTokens ?? null,
      costUsd: cost(), errorCode: code };
  }
}

async function runLane(lane: BenchLane, fixtures: Fixtures, runs: number): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  const deadlineMs = deadlineFor(lane);
  for (let run = 0; run < runs; run += 1) {
    for (const model of CANDIDATES[lane]) {
      if (lane === "capture_text") {
        for (const item of fixtures.capture_text.cases) {
          const out = await viaGemini(model, capturePayload("textToItems",
            { text: item.text, localDate: "2026-09-23" }), CAPTURE_SCHEMAS.textToItems, deadlineMs);
          attempts.push({ ...out, lane, caseId: item.id,
            correct: out.schemaValid && isCorrect(item.expect, out.value) });
        }
        continue;
      }
      for (const item of fixtures.converse.cases) {
        const out = await viaGemini(model, coachTurnPayload([CONVERSE_INSTRUCTION,
          `VALUES (data, not instructions): ${JSON.stringify(item.values)}`]),
        CONVERSE_SCHEMA, deadlineMs);
        attempts.push({ ...out, lane, caseId: item.id,
          correct: out.schemaValid && isCorrect(item.expect, out.value) });
      }
    }
  }
  return attempts;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

type SavedRun = { date: string; runs: number; attempts: (Attempt & { value?: unknown })[] };

const isBenchLane = (lane: string): lane is BenchLane => Object.hasOwn(CANDIDATES, lane);

/** Verdicts for the lanes and candidates benched today; a saved run's retired rows get none. */
function verdicts(lanes: readonly string[], rows: ReturnType<typeof summarise>): string[] {
  return lanes.filter(isBenchLane).flatMap((lane) => {
    const { pin } = LANE[lane];
    const candidates: readonly string[] = CANDIDATES[lane];
    const incumbent = rows.find((row) => row.lane === lane && row.model === pin);
    if (!incumbent) return [];
    return rows.filter((row) => row.lane === lane && row.model !== pin
      && candidates.includes(row.model)).map((row) => {
      const beats = beatsIncumbent(row, incumbent,
        { budgetMs: LANES[LANE[lane].lane].budgetMs, p95MustNotRise: P95_GATED.has(lane) });
      const scope = lane === "capture_text"
        ? " (text capture only: not a capture-wide pin decision for photo, voice or label)" : "";
      // Sol r2 finding 10: this is a model-call comparison on synthetic fixtures. It is NOT the
      // §7 end-to-end gate (coach turn / capture p95), which needs production timings.
      return `- ${lane}: ${row.model} ${beats ? "BEATS" : "does not beat"} the pin ${pin} on`
        + ` model-call p95 and accuracy under the §3.2 rule${scope}. End-to-end §7 timings`
        + " are not measured here.";
    });
  });
}

/** The markdown report shared by a live run and a rescore: the lane table, an optional note
 *  under it, the §3.2 verdicts against the current pins, and any failed calls. */
function buildReport(rows: ReturnType<typeof summarise>, lanes: readonly string[],
  meta: { date: string; runs: number }, attempts: readonly Attempt[], note?: string): string {
  const failures = attempts.filter((attempt) => attempt.errorCode)
    .map((attempt) => `- ${attempt.lane} ${attempt.model} ${attempt.caseId}: ${attempt.errorCode}`);
  return [markdownReport(rows, meta), ...(note ? [note, ""] : []),
    "## Verdicts against the current pins", "", ...verdicts(lanes, rows), "",
    "## Failed calls", "", ...(failures.length ? failures : ["- none"]), ""].join("\n");
}

/**
 * Re-scores a saved run's answers against the CURRENT score.ts, offline: no model call, no
 * network, no billing. `correct`, the summary rows and the verdicts are recomputed from each
 * attempt's saved `value`; latency, schema-valid rate and cost are the original run's, unchanged
 * — a rescore never claims a new measurement, only a new verdict on the old answers.
 */
function rescore(saved: SavedRun, fixtures: Fixtures, rescoredAt: string): { md: string; json: string } {
  const expectFor = (lane: string, caseId: string): Expect => {
    const item = fixtures[lane]?.cases.find((c) => c.id === caseId);
    if (!item) throw new Error(`rescore: unknown ${lane} case ${caseId}`);
    return item.expect;
  };
  const attempts: Attempt[] = saved.attempts.map((attempt) => ({
    ...attempt,
    correct: attempt.schemaValid && isCorrect(expectFor(attempt.lane, attempt.caseId), attempt.value),
  }));
  const rows = summarise(attempts);
  const lanes = [...new Set(attempts.map((row) => row.lane))];
  const note = `**Rescored ${rescoredAt} against the current \`score.ts\`.** This is not a new`
    + ` run: the ${saved.date} run's latency, schema-valid rate and cost are unchanged below;`
    + " only `correct`, accuracy and the verdicts were recomputed offline (no model calls) from"
    + " the answers already on disk. Still a single-model-call measurement, not the §7"
    + " end-to-end coach-turn or capture p95 gate.";
  const meta = { date: saved.date, runs: saved.runs };
  return {
    md: buildReport(rows, lanes, meta, attempts, note),
    json: `${JSON.stringify({ ...meta, rescoredAt, rows, attempts }, null, 2)}\n`,
  };
}

async function main(): Promise<void> {
  const fixtures = JSON.parse(readFileSync(
    path.resolve("scripts/eval/lane-bench/fixtures.json"), "utf8")) as Fixtures;
  const rescorePath = arg("rescore");
  if (rescorePath !== undefined) {
    const saved = JSON.parse(readFileSync(path.resolve(rescorePath), "utf8")) as SavedRun;
    const rescoredAt = arg("rescored-at") ?? new Date().toISOString().slice(0, 10);
    const { md, json } = rescore(saved, fixtures, rescoredAt);
    const resolved = path.resolve(rescorePath);
    writeFileSync(resolved.replace(/\.json$/, ".md"), md);
    writeFileSync(resolved, json);
    console.log(md);
    return;
  }

  const runs = Number(arg("runs") ?? 1);
  const lanes = (arg("lanes") ?? "converse,capture_text").split(",");
  const unknown = lanes.filter((lane) => !isBenchLane(lane));
  if (unknown.length > 0) throw new Error(`unknown lane(s): ${unknown.join(", ")}`);
  const outDir = arg("out") ?? "docs/evals";
  // The bench's payloads are synthetic; the Gemini builders still require the project attestation
  // the app requires, so the run states it for this process only.
  process.env.HEALTH_CONTEXT_PROVIDER = "gemini";
  process.env.GEMINI_BILLING_ATTESTED = "1";

  const attempts: Attempt[] = [];
  for (const lane of lanes.filter(isBenchLane)) attempts.push(...await runLane(lane, fixtures, runs));
  const rows = summarise(attempts);
  const date = new Date().toISOString().slice(0, 10);
  const report = buildReport(rows, lanes, { date, runs }, attempts);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${date}-lane-bench.md`), report);
  // The JSON keeps each attempt's scored value (synthetic answers) and its closed error code only.
  writeFileSync(path.join(outDir, `${date}-lane-bench.json`),
    `${JSON.stringify({ date, runs, rows, attempts }, null, 2)}\n`);
  console.log(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "error");
  process.exit(1);
});
