/**
 * The provider-side half of "they are slow" — Phase 13 §7's p95 gates. `pnpm timings` reads
 * `client_timings`, the tap-to-first-text a user feels; this reads `ai_calls.latency_ms`, the
 * model round trip alone, so a slow number can be placed: the call itself, or everything around
 * it. Same `summarize` (lib/timing.ts) as `pnpm timings`, so the two tables are comparable.
 *
 *   pnpm timings:ai [--purpose coach] [--days 7] [--by-model]
 *
 * One line per purpose and status (`ok`, `timeout`, `provider_error`, …), because a timed-out call
 * records the timeout as its latency and would otherwise pass for a slow success. `--by-model`
 * splits a purpose by provider and model id — the view to take before and after a pin change
 * (§3.2's bench report).
 *
 * Read-only, through the service-role admin client, the same way scripts/timings.ts reads
 * `client_timings`: `ai_calls` has no cross-user select policy, and this never reaches a browser.
 *
 * Env: SUPABASE_URL and the service-role key, from the shell or `.env.local` (scripts/load-env-local.ts).
 */

import { fileURLToPath } from "node:url";
import { summarize, type StepSummary } from "@/lib/timing";
import { adminClient } from "@/lib/server/admin";
import { loadEnvLocal } from "./load-env-local";

const PAGE = 1000;

export type AiCallRow = {
  purpose: string; provider: string; model_id: string; status: string; latency_ms: number | null;
};

export type Args = { purpose: string | null; days: number; byModel: boolean };

export function parseArgs(argv: string[]): Args {
  let purpose: string | null = null;
  let days = 7;
  let byModel = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--purpose") {
      // No list to check against: `purpose` has no check constraint, and rows outside
      // lib/ai/models.ts's table exist (the retired live-dictation mint). A typo prints an empty report.
      const value = argv[i + 1] ?? "";
      if (!/^[\w-]+$/.test(value)) throw new Error("--purpose needs a purpose name, e.g. coach or photoToItems");
      purpose = value;
      i += 1;
    } else if (argv[i] === "--days") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--days must be a whole number ≥ 1");
      days = value;
      i += 1;
    } else if (argv[i] === "--by-model") {
      byModel = true;
    }
  }
  return { purpose, days, byModel };
}

/** `summarize` buckets by (path, step); here path is the purpose and step is the call's status. */
export function toSamples(rows: AiCallRow[], byModel: boolean): { path: string; step: string; ms: number }[] {
  const out: { path: string; step: string; ms: number }[] = [];
  for (const r of rows) {
    if (r.latency_ms === null) continue;
    const path = byModel ? `${r.purpose} ${r.provider}/${r.model_id}` : r.purpose;
    out.push({ path, step: r.status, ms: r.latency_ms });
  }
  return out;
}

const HEAD = ["purpose", "status", "p50", "p95", "n"];

export function renderReport(rows: StepSummary[], days: number): string {
  if (rows.length === 0) return `No ai_calls rows with a latency in the last ${days} days.`;
  // `summarize` orders by lib/timing.ts's hop vocabulary, which these names are not in; sort by
  // name so the same data prints the same table.
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.step.localeCompare(b.step));
  const table = [HEAD, ...sorted.map((r) => [r.path, r.step, String(r.p50), String(r.p95), String(r.n)])];
  const widths = HEAD.map((_, col) => Math.max(...table.map((line) => line[col].length)));
  const lines = table.map((line) => line.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  return [`ai_calls.latency_ms — last ${days} days (ms, provider round trip only)`, "", ...lines].join("\n");
}

async function readRows(args: Args): Promise<AiCallRow[]> {
  const admin = adminClient();
  const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
  const out: AiCallRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from("ai_calls")
      .select("purpose, provider, model_id, status, latency_ms")
      .gte("created_at", since)
      .not("latency_ms", "is", null);
    if (args.purpose) query = query.eq("purpose", args.purpose);
    const { data, error } = await query
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`ai_calls read failed: ${error.message}`);
    const page = (data ?? []) as AiCallRow[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  console.log(renderReport(summarize(toSamples(await readRows(args), args.byModel)), args.days));
}

// Only when run as a script: importing this module (a test) must not open an admin client.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
