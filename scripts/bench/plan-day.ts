/**
 * W107: the `planDay` phone benchmark. Times one whole day's plate search (lib/meals/day.ts
 * `planDay`, the open food-world search the phone runs) for 4 and 6 meal slots across Favored list
 * sizes, and reports p50 / p95 / max against the 20 ms phone target (D11, spec §W8 acceptance 5).
 *
 *   pnpm exec tsx scripts/bench/plan-day.ts                      # Chromium, 4x CPU throttle
 *   pnpm exec tsx scripts/bench/plan-day.ts --throttle 6 --dates 100
 *   pnpm exec tsx scripts/bench/plan-day.ts --mode node          # this host's CPU, no browser
 *   pnpm exec tsx scripts/bench/plan-day.ts --favored 0,20,100,300 --slots 4,6 --json out.json
 *   pnpm exec tsx scripts/bench/plan-day.ts --bundle plan-day.js  # write the browser bundle, run nothing
 *
 * Browser mode bundles scripts/bench/plan-day-workload.ts with esbuild (already installed with
 * tsx), starts headless Chromium (`--chrome <path>`, else `CHROME_PATH`, else the Playwright
 * Chromium under /opt/pw-browsers), sets `Emulation.setCPUThrottlingRate` over the DevTools
 * protocol and runs the bundle in a blank page. No network, no database, no account data. A real
 * phone run is the owner's step (docs/operations/plan-day-benchmark.md).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBench, type BenchOptions, type CaseResult, type SlotCount } from "./plan-day-workload";

const TARGET_MS = 20;
const ROOT = path.resolve(__dirname, "../..");

type Args = BenchOptions & { mode: "browser" | "node"; throttle: number; chrome: string | null; json: string | null };

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const list = (flag: string, fallback: number[]) => (value(flag)?.split(",").map(Number) ?? fallback);
  const slots = list("--slots", [4, 6]);
  if (!slots.every((n) => n === 4 || n === 6)) throw new Error("--slots takes 4 and/or 6");
  const mode = value("--mode") ?? "browser";
  if (mode !== "browser" && mode !== "node") throw new Error("--mode is browser or node");
  const args: Args = { mode, throttle: Number(value("--throttle") ?? 4), dates: Number(value("--dates") ?? 60),
    warmup: Number(value("--warmup") ?? 5), favored: list("--favored", [0, 20, 100, 300]),
    slots: slots as SlotCount[], chrome: value("--chrome") ?? process.env.CHROME_PATH ?? null, json: value("--json") ?? null };
  const counts = [args.throttle, args.dates, args.warmup ?? 0, ...args.favored];
  if (!counts.every((n) => Number.isFinite(n) && n >= 0) || args.throttle < 1 || args.dates < 1) {
    throw new Error("--throttle ≥ 1, --dates ≥ 1, --warmup and --favored ≥ 0");
  }
  return args;
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function chromePath(given: string | null): string {
  const candidates = [given, "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("no Chromium found: pass --chrome <path> or set CHROME_PATH");
  return found;
}

/** The one esbuild call this script makes; esbuild is tsx's dependency, not the app's, so it has no types here. */
type EsbuildLike = { build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

/** The workload as one browser script that defines `globalThis.__planDayBench`. */
async function bundleWorkload(): Promise<string> {
  // esbuild ships with tsx; resolve it from there rather than adding a dependency.
  const esbuild = createRequire(require.resolve("tsx/package.json"))("esbuild") as EsbuildLike;
  const result = await esbuild.build({
    stdin: { contents: `import { runBench } from "./scripts/bench/plan-day-workload";\nglobalThis.__planDayBench = runBench;`,
      resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
    tsconfig: path.join(ROOT, "tsconfig.json"), logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}

/** A minimal DevTools-protocol client over Node's own WebSocket. */
class Cdp {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!waiter) return;
      this.pending.delete(message.id as number);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    // Chromium crashed or the socket dropped: fail every waiting call rather than hang.
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("DevTools socket closed"));
      this.pending.clear();
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`DevTools socket failed: ${url}`)), { once: true });
    });
  }
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  close() { this.socket.close(); }
}

async function launch(binary: string): Promise<{ chrome: ChildProcess; port: number; profile: string }> {
  const profile = mkdtempSync(path.join(tmpdir(), "plan-day-bench-"));
  const chrome = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--no-sandbox", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`Chromium did not start:\n${log}`)), 20_000);
    chrome.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    chrome.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chromium exited (${code}):\n${log}`)); });
  });
  return { chrome, port, profile };
}

async function runInBrowser(args: Args): Promise<{ results: CaseResult[]; browser: string }> {
  const script = await bundleWorkload();
  const { chrome, port, profile } = await launch(chromePath(args.chrome));
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
      { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("no page target");
    const cdp = await Cdp.open(page.webSocketDebuggerUrl);
    const version = await cdp.send<{ product: string }>("Browser.getVersion");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.throttle });
    const evaluate = async (expression: string) => {
      const out = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>(
        "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? "page error");
      return out.result.value;
    };
    await evaluate(script);
    const options: BenchOptions = { favored: args.favored, slots: args.slots, dates: args.dates, warmup: args.warmup };
    const results = await evaluate(`globalThis.__planDayBench(${JSON.stringify(options)})`) as CaseResult[];
    cdp.close();
    return { results, browser: version.product };
  } finally {
    // Wait for Chromium to exit before removing its profile, which it writes until then.
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export type Summary = Omit<CaseResult, "times"> & { p50Ms: number; p95Ms: number; maxMs: number; meetsTarget: boolean };

export function summarize(results: readonly CaseResult[]): Summary[] {
  return results.map(({ times, ...rest }) => {
    const p95Ms = percentile(times, 95);
    return { ...rest, p50Ms: percentile(times, 50), p95Ms, maxMs: Math.max(...times), meetsTarget: p95Ms <= TARGET_MS };
  });
}

function table(rows: readonly Summary[]): string {
  const head = "| Favored | Slots | Pool | Body KB | Prepare ms | p50 ms | p95 ms | max ms | max sizePlate | p95 ≤ 20 ms |";
  const line = (row: Summary) => `| ${row.favored} | ${row.slots} | ${row.pool} | ${(row.bodyBytes / 1024).toFixed(1)} | `
    + `${row.prepareMs.toFixed(1)} | ${row.p50Ms.toFixed(1)} | ${row.p95Ms.toFixed(1)} | ${row.maxMs.toFixed(1)} | `
    + `${row.maxSizePlate} | ${row.meetsTarget ? "yes" : "no"} |`;
  return [head, "|---|---|---|---|---|---|---|---|---|---|", ...rows.map(line)].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const bundleAt = argv.indexOf("--bundle");
  if (bundleAt >= 0) {
    // For a real phone: load this file in its browser, then call `__planDayBench({ favored: [20],
    // slots: [4, 6], dates: 60 })` from the console (docs/operations/plan-day-benchmark.md).
    const out = argv[bundleAt + 1];
    if (!out) throw new Error("--bundle takes an output path");
    writeFileSync(out, await bundleWorkload());
    console.log(`wrote ${out}`);
    return;
  }
  const args = parseArgs(argv);
  const run = args.mode === "browser" ? await runInBrowser(args)
    : { results: runBench(args), browser: `node ${process.version} (no throttle)` };
  const rows = summarize(run.results);
  const where = args.mode === "browser" ? `${run.browser}, ${args.throttle}x CPU throttle` : run.browser;
  console.log(`planDay benchmark: ${where}; ${args.dates} dates per case after ${args.warmup} warm-up days\n`);
  console.log(table(rows));
  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify({ at: new Date().toISOString(), mode: args.mode, throttle: args.throttle,
      browser: run.browser, dates: args.dates, targetMs: TARGET_MS, rows }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
