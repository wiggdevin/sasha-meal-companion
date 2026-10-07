/**
 * The p50 / p95 / n table behind "they are slow" — T0 §1. The percentiles are lib/timing.ts's
 * `summarize`, which interpolates between ranks rather than picking a run, so a p95 here is
 * usually not one of the measured numbers.
 *
 *   pnpm timings [--path barcode] [--days 7]
 *
 * Reads `client_timings` with the service-role admin client, the same way
 * scripts/annotate-policy-categories.ts reads the catalog: the table has no select policy, so
 * this script is the only way its rows are ever read, and it is never reachable from a browser.
 *
 * Env: SUPABASE_URL and the service-role key (read only inside adminClient()), from the shell or
 * `.env.local` — a bare `tsx` script reads no env file on its own (scripts/load-env-local.ts).
 */

import { fileURLToPath } from "node:url";
import { summarize, TIMING_PATHS, type StepSummary, type TimingPath } from "@/lib/timing";
import { adminClient } from "@/lib/server/admin";
import { loadEnvLocal } from "./load-env-local";

const PAGE = 1000;

export type TimingSample = { path: string; step: string; ms: number };

export type Args = { path: TimingPath | null; days: number };

export function parseArgs(argv: string[]): Args {
  let path: TimingPath | null = null;
  let days = 7;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--path") {
      const value = argv[i + 1] ?? "";
      if (!(TIMING_PATHS as readonly string[]).includes(value)) {
        throw new Error(`--path must be one of ${TIMING_PATHS.join(", ")}`);
      }
      path = value as TimingPath;
      i += 1;
    } else if (argv[i] === "--days") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--days must be a whole number ≥ 1");
      days = value;
      i += 1;
    }
  }
  return { path, days };
}

const HEAD = ["path", "step", "p50", "p95", "n"];

export function renderReport(rows: StepSummary[], days: number): string {
  if (rows.length === 0) return `No client timings in the last ${days} days.`;
  const table = [HEAD, ...rows.map((r) => [r.path, r.step, String(r.p50), String(r.p95), String(r.n)])];
  const widths = HEAD.map((_, col) => Math.max(...table.map((line) => line[col].length)));
  const lines = table.map((line) => line.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  return [`client_timings — last ${days} days (ms)`, "", ...lines].join("\n");
}

async function readSamples(args: Args): Promise<TimingSample[]> {
  const admin = adminClient();
  const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
  const out: TimingSample[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from("client_timings").select("path, step, ms").gte("at", since);
    if (args.path) query = query.eq("path", args.path);
    const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`client_timings read failed: ${error.message}`);
    const page = (data ?? []) as TimingSample[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  // The percentiles are lib/timing.ts's (`summarize`); this script reads rows and lays out a
  // table. One place owns the vocabulary and the statistics behind it.
  console.log(renderReport(summarize(await readSamples(args)), args.days));
}

// Only when run as a script: importing this module (a test) must not open an admin client.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
