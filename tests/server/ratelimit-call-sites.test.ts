/**
 * Scale S2: an inventory of every `enforceRateLimit` call site (a static read of app/ and lib/).
 *
 * - Every route whose imports can reach a model call (lib/ai/call.ts, the one governed model path)
 *   and every named expensive or write-amplifying route is fail closed: no `"fail_open"` anywhere in
 *   the file. Fail closed is the typed default, so a new call site is closed until someone opts it
 *   open.
 * - `"fail_open"` appears only inside a GET handler (cheap reads of the caller's own data).
 * - No call site uses a static key (one row shared by every caller) except the cron jobs'
 *   deliberately global `jobs:*` keys.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MODEL_PATH = path.join(ROOT, "lib/ai/call.ts");
const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Expensive, model-calling or write-amplifying routes the policy names; fail closed always. */
const EXPENSIVE = [
  "app/api/coach/route.ts", "app/api/coach/transcribe/route.ts", "app/api/log/propose/route.ts",
  "app/api/plan/inspire/route.ts", "app/api/plan/document/route.ts", "app/api/media/sign/route.ts",
  "app/api/export/route.ts", "app/api/foods/barcode/route.ts", "app/api/foods/facets/warm/route.ts",
  "app/api/health/ingest/route.ts", "app/api/sync/ops/route.ts", "app/api/log/commit/route.ts",
];

/**
 * The only handlers allowed to fail open: GETs that make one cheap indexed read of the caller's
 * own data (or none) and never reach a model. Anything that fans out into several reads, pages,
 * searches or computes stays fail closed.
 */
const SINGLE_READ_GETS: Record<string, string> = {
  "app/api/constraints/route.ts GET": "constraint_profiles by its user_id primary key",
  "app/api/constraints/review/route.ts GET": "the same constraint_profiles primary-key row",
  "app/api/foods/diet/route.ts GET": "user_settings by its user_id primary key",
  "app/api/proposals/route.ts GET": "target_proposals by user_id (index user_id, week_start)",
  "app/api/sync/changes/route.ts GET": "sync_changes: change_log by its (user_id, seq) primary key, <= 500 rows",
  "app/api/warm/route.ts GET": "no database read",
};

function sourceFiles(dir: string): string[] {
  return (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file whose imports reach MODEL_PATH: one parse per file, then a reverse walk. */
const reachingModel: Set<string> = (() => {
  const importers = new Map<string, Set<string>>();
  const queue = ["app", "lib"].flatMap(sourceFiles).map((f) => path.join(ROOT, f));
  const parsed = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (parsed.has(file)) continue;
    parsed.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const next = resolve(file, m[1] ?? m[2]);
      if (!next) continue;
      if (!importers.has(next)) importers.set(next, new Set());
      importers.get(next)?.add(file);
      if (!parsed.has(next)) queue.push(next);
    }
  }
  const reached = new Set<string>([MODEL_PATH]);
  const todo = [MODEL_PATH];
  while (todo.length > 0) {
    for (const importer of importers.get(todo.pop() as string) ?? []) {
      if (!reached.has(importer)) { reached.add(importer); todo.push(importer); }
    }
  }
  return reached;
})();

const reachesModel = (file: string): boolean => reachingModel.has(file);

type Site = { file: string; line: number; key: string; handler: string; call: string };

/** Each call with its first argument's source text and the exported handler it sits in. */
function callSites(): Site[] {
  return ["app", "lib"].flatMap(sourceFiles).filter((f) => f !== "lib/server/ratelimit.ts")
    .flatMap((file) => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      const sites: Site[] = [];
      for (const m of src.matchAll(/enforceRateLimit\(([\s\S]*?)\);/g)) {
        const before = src.slice(0, m.index);
        const handler = [...before.matchAll(/export (?:async )?function (\w+)\(|^(?:async )?function (\w+)\(/gm)]
          .map((h) => h[1] ?? h[2]).pop() ?? "";
        const args = m[1];
        const key = args.startsWith("`") ? args.slice(0, args.indexOf("`", 1) + 1)
          : args.startsWith("\"") ? args.slice(0, args.indexOf("\"", 1) + 1) : args.split(",")[0];
        sites.push({ file, line: before.split("\n").length, key, handler, call: m[0] });
      }
      return sites;
    });
}

/** Splits an argument list at its top-level commas (a nested call's own commas stay put). */
function topLevelArgs(list: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

const sites = callSites();
const files = [...new Set(sites.map((s) => s.file))];

describe("rate-limit call-site inventory (scale S2)", () => {
  it("finds the call sites", () => {
    expect(sites.length).toBeGreaterThan(80);
  });

  it("every route that can reach a model is fail closed", () => {
    const aiRoutes = files.filter((f) => reachesModel(path.join(ROOT, f)));
    // The import graph must see the obvious model routes, or the walk itself is broken.
    for (const f of ["app/api/coach/route.ts", "app/api/log/propose/route.ts", "app/api/plan/inspire/route.ts",
      "app/api/plan/document/route.ts", "app/api/coach/transcribe/route.ts"]) {
      expect(aiRoutes).toContain(f);
    }
    const open = aiRoutes.filter((f) => readFileSync(path.join(ROOT, f), "utf8").includes("\"fail_open\""));
    expect(open).toEqual([]);
  });

  it("every handler of every route that can reach a model calls the limiter", () => {
    const routes = (readdirSync(path.join(ROOT, "app"), { recursive: true }) as string[])
      .filter((f) => /(^|\/)route\.ts$/.test(f)).map((f) => path.join("app", f))
      .filter((f) => reachesModel(path.join(ROOT, f)));
    expect(routes.length).toBeGreaterThan(15);
    const missing = routes.flatMap((file) => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      const handlers = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\(/g)];
      return handlers.filter((h, i) => {
        const body = src.slice(h.index, handlers[i + 1]?.index ?? src.length);
        // A handler may delegate its limits to a local helper (targets' `limits`, avoid-impact's
        // `authorized`) or to a guard that calls the limiter itself.
        return !/enforceRateLimit\(|await (limits|authorized|guarded|handle)\(/.test(body);
      }).map((h) => `${file} ${h[1]}`);
    });
    expect(missing).toEqual([]);
  });

  it("every named expensive or write-amplifying route is fail closed", () => {
    for (const f of EXPENSIVE) {
      expect(files, f).toContain(f);
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toContain("\"fail_open\"");
    }
  });

  it("fails open only in the reviewed single-read GET handlers", () => {
    const found = ["app", "lib"].flatMap(sourceFiles).flatMap((file) => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      return [...src.matchAll(/"fail_open"/g)].map((m) => {
        const before = src.slice(0, m.index);
        const handler = [...before.matchAll(/export (?:async )?function (\w+)\(/g)].map((h) => h[1]).pop();
        return `${file} ${handler}`;
      });
    }).filter((site) => !site.startsWith("lib/server/ratelimit.ts"));
    expect([...new Set(found)].sort()).toEqual(Object.keys(SINGLE_READ_GETS).sort());
  });

  it("passes the policy only as a literal or a typed parameter", () => {
    const odd = sites.filter((s) => {
      const args = topLevelArgs(s.call.slice("enforceRateLimit(".length, -2));
      return args.length > 3 && !/^("fail_open"|"fail_closed"|failure)$/.test(args[3]);
    }).map((s) => `${s.file}:${s.line}`);
    expect(odd).toEqual([]);
  });

  it("uses no static key except the cron jobs' deliberately global ones", () => {
    const isStatic = (key: string) => (key.startsWith("\"") || key.startsWith("`")) && !key.includes("${");
    const statics = sites.filter((s) => isStatic(s.key)).map((s) => `${s.file}:${s.line} ${s.key}`);
    expect(statics.filter((s) => !/ ["`]jobs:[a-z-]+["`]$/.test(s))).toEqual([]);
    expect(statics.every((s) => s.startsWith("app/api/jobs/"))).toBe(true);
  });
});
