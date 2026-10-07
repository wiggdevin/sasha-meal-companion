/**
 * The Phase 4 exit gate (spec §9, contracts §8): 10 real items per method through the live model.
 *
 *   pnpm exec tsx scripts/ai-eval.ts [--method text] [--dry-run]
 *
 * It calls the live model and bills a real project, so it NEVER runs in CI. Env: SUPABASE_TEST_URL,
 * SUPABASE_TEST_ANON_KEY, SEARCH_EVAL_EMAIL, SEARCH_EVAL_PASSWORD, GEMINI_API_KEY, plus the admin
 * client's URL and secret key env, as read by lib/server/admin.ts.
 *
 * Media lines name a fixture under scripts/eval/fixtures/ that Devin supplies. A line whose expect
 * array is empty is unlabelled: it is run, printed, and left OUT of every score, because scoring
 * against an expectation nobody wrote would report our own guess back to us.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CaptureMethod } from "@/lib/capture/flags";
import { proposeDraft } from "@/lib/server/capture";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";

const SET_PATH = "scripts/eval/phase-4-capture.jsonl";

export type EvalLine = {
  method: CaptureMethod; slot: string; localDate: string;
  text?: string; media?: string; expect: { label: string; grams: number }[];
};
export type EvalResult = {
  expected: { label: string; grams: number };
  got: { label: string; grams: number } | null;
  autoResolved: boolean; inTop3: boolean;
};
export type MethodScore = {
  method: CaptureMethod; n: number; failed: number; itemAccuracy: number; gramMae: number;
  autoResolved: number; autoResolvePrecision: number | null; top3Containment: number;
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hit = (r: EvalResult): boolean =>
  r.got !== null && (norm(r.got.label).includes(norm(r.expected.label))
    || norm(r.expected.label).includes(norm(r.got.label)));

export function scoreMethod(method: CaptureMethod, results: EvalResult[]): MethodScore {
  const n = results.length;
  const correct = results.filter(hit).length;
  const gramErrors = results.filter((r) => r.got !== null)
    .map((r) => Math.abs((r.got as { grams: number }).grams - r.expected.grams));
  const auto = results.filter((r) => r.autoResolved);
  return {
    method, n, failed: results.filter((r) => r.got === null).length,
    itemAccuracy: n === 0 ? 0 : correct / n,
    gramMae: gramErrors.length === 0 ? 0
      : gramErrors.reduce((a, b) => a + b, 0) / gramErrors.length,
    autoResolved: auto.length,
    autoResolvePrecision: auto.length === 0 ? null : auto.filter(hit).length / auto.length,
    top3Containment: n === 0 ? 0 : results.filter((r) => r.inTop3).length / n,
  };
}

export function renderReport(scores: MethodScore[], at: string): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
  const lines = [
    `# Phase 4 capture eval — ${at}`, "",
    "Live model, run outside CI. Gate: item accuracy reported per method; grounding auto-resolve",
    "precision ≥ 90 % **over auto-resolved items**. Thresholds come from lib/search/thresholds.ts",
    "and are never lowered to make this table look better (contracts §8).", "",
    "| Method | n | failed calls | item accuracy | gram MAE | auto-resolve |",
    "|---|---|---|---|---|---|",
  ];
  for (const s of scores) {
    const auto = s.autoResolvePrecision === null
      ? `0 auto-resolved of ${s.n} — top-3 containment ${pct(s.top3Containment)}`
      : `${pct(s.autoResolvePrecision)} over ${s.autoResolved} auto-resolved`;
    lines.push(`| ${s.method} | ${s.n} | ${s.failed} | ${pct(s.itemAccuracy)} | ${s.gramMae.toFixed(1)} g | ${auto} |`);
  }
  return `${lines.join("\n")}\n`;
}

function readSet(): EvalLine[] {
  return readFileSync(SET_PATH, "utf8").trim().split("\n")
    .filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as EvalLine);
}

async function signIn(): Promise<SupabaseClient> {
  const client = createClient(process.env.SUPABASE_TEST_URL ?? "",
    process.env.SUPABASE_TEST_ANON_KEY ?? "");
  const { error } = await client.auth.signInWithPassword({
    email: process.env.SEARCH_EVAL_EMAIL ?? "", password: process.env.SEARCH_EVAL_PASSWORD ?? "" });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

/** One line, live: null means "nothing to score" (skipped fixture, or an unlabelled line — printed
 * either way). A failed provider call is never silently retried or dropped: it is printed and, for
 * a labelled line, turned into one miss per expectation so the gate still reports on it. */
async function runLine(
  client: SupabaseClient, admin: SupabaseClient, userId: string, line: EvalLine
): Promise<EvalResult[] | null> {
  if (line.media && !existsSync(line.media)) {
    console.log(`skipped (no fixture): ${line.media}`);
    return null;
  }
  const request = line.text
    ? { method: line.method, localDate: line.localDate, tz: "America/New_York", slot: line.slot,
        text: line.text }
    : { method: line.method, localDate: line.localDate, tz: "America/New_York", slot: line.slot,
        mediaPath: line.media as string };
  const label = line.text ?? line.media ?? "";
  let draft;
  try {
    draft = await proposeDraft(client, admin, userId, request as never);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : "?";
    const code = e instanceof HttpError ? e.code : "error";
    const message = e instanceof Error ? e.message : String(e);
    console.log(`failed: ${label} -> ${status} ${code} ${message}`);
    return line.expect.length === 0 ? null
      : line.expect.map((expected) => ({ expected, got: null, autoResolved: false, inTop3: false }));
  }
  if (line.expect.length === 0) {
    console.log(`unlabelled: ${label} -> ${draft.items.map((i) => i.label).join(", ")}`);
    return null;
  }
  return line.expect.map((expected, seq) => {
    const item = draft.items[seq] ?? null;
    return {
      expected,
      got: item ? { label: item.label, grams: item.grams } : null,
      autoResolved: item?.autoResolved ?? false,
      inTop3: item !== null && (item.autoResolved
        || item.alternatives.some((a) => norm(a.label).includes(norm(expected.label)))),
    };
  });
}

async function main(): Promise<void> {
  const only = process.argv.includes("--method")
    ? (process.argv[process.argv.indexOf("--method") + 1] as CaptureMethod) : null;
  const lines = readSet().filter((l) => (only ? l.method === only : true));
  const client = await signIn();
  const admin = adminClient();
  const { data } = await client.auth.getUser();
  const userId = data.user?.id ?? "";
  const byMethod = new Map<CaptureMethod, EvalResult[]>();

  for (const line of lines) {
    const results = await runLine(client, admin, userId, line);
    if (results === null) continue;
    byMethod.set(line.method, [...(byMethod.get(line.method) ?? []), ...results]);
  }

  const scores = [...byMethod.entries()].map(([method, results]) => scoreMethod(method, results));
  const at = new Date().toISOString().slice(0, 10);
  const report = renderReport(scores, at);
  console.log(report);
  if (!process.argv.includes("--dry-run")) {
    mkdirSync("docs/evals", { recursive: true });
    writeFileSync(`docs/evals/${at}-phase-4.md`, report);
    console.log(`wrote docs/evals/${at}-phase-4.md`);
  }
}

if (process.argv[1]?.endsWith("ai-eval.ts")) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
