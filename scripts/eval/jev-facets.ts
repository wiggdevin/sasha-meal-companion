import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { EvalCase, Usage } from "./jev-facets/types";

const CHILD_ARG = "--jev-facets-react-server-child";
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function loadCases(path: string): EvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalCase[];
  if (!Array.isArray(parsed)) throw new Error(`${path} is not an array`);
  for (const item of parsed) {
    if (!item.id || !item.food?.name || !item.reason || item.reason.includes("\n")) {
      throw new Error(`Malformed labelled case in ${path}`);
    }
    const overlap = item.labels.confusableAbsent?.filter((facet) => item.labels.present.includes(facet));
    if (overlap?.length) throw new Error(`${item.id} labels ${overlap.join(", ")} present and confusable-absent`);
  }
  return parsed;
}

export async function run(args: string[]): Promise<{ markdown: string; passing: boolean }> {
  const isReport = args.includes("--report");
  const isFreeze = args.includes("--freeze") || args.includes("--generate");
  const isRefresh = args.includes("--refresh");
  if (!isReport && !isFreeze && !isRefresh) throw new Error("Choose --report, --freeze, or --refresh");
  if (isReport && (isFreeze || isRefresh)) throw new Error("--report is read-only and cannot be combined with a write mode");
  if (isRefresh && !process.env.TYPESAFE_API_KEY) loadEnvFile(".env.local");

  const [types, payload, cacheIo, scoring, reporting] = await Promise.all([
    import("./jev-facets/types"),
    import("./jev-facets/payload"),
    import("./jev-facets/cache"),
    import("./jev-facets/scoring"),
    import("./jev-facets/report"),
  ]);
  const { DEV_PATH, HOLDOUT_PATH, REPORT_PATH, THRESHOLDS_PATH, evaluatedCases } = types;
  const cases = { dev: loadCases(DEV_PATH), holdout: loadCases(HOLDOUT_PATH) };
  const all = [...cases.dev, ...cases.holdout];
  const [{ FACETS }, devBatches, holdoutBatches] = await Promise.all([
    import("@/lib/foods/facets"),
    payload.batchesFor(cases.dev, "dev"),
    payload.batchesFor(cases.holdout, "holdout"),
  ]);
  const batches = [...devBatches, ...holdoutBatches];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const cache = isRefresh
    ? await cacheIo.refreshCache(batches, all).then((result) => {
      usage = result.usage;
      return result.cache;
    })
    : cacheIo.readCache(all);
  const observed = scoring.observations(cases, cache, FACETS);
  const thresholds = isFreeze ? scoring.deriveThresholds(observed) : scoring.frozenThresholds();
  const report = reporting.reportSource(observed, thresholds, cache.model, usage, {
    dev: evaluatedCases(cases.dev).length,
    holdout: evaluatedCases(cases.holdout).length,
    operational: all.filter((item) => item.operationalCase).length,
    privacy: all.filter((item) => item.privacyCanary).length,
  });
  if (isFreeze) {
    writeFileSync(THRESHOLDS_PATH, scoring.tsSource(FACETS, thresholds, cache.model));
    mkdirSync(fileURLToPath(new URL("../../docs/evals", import.meta.url)), { recursive: true });
    writeFileSync(REPORT_PATH, report.markdown);
  }
  console.log(report.markdown);
  return report;
}

if (!process.argv.includes(CHILD_ARG)) {
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD_ARG, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    cwd: ROOT,
  });
  if (child.error) console.error(child.error);
  process.exitCode = child.status ?? 1;
} else {
  run(process.argv.slice(2)).then((report) => { process.exitCode = report.passing ? 0 : 1; })
    .catch((error: unknown) => {
      const safe = error instanceof Error ? error.message : String(error);
      const key = process.env.TYPESAFE_API_KEY;
      console.error(key ? safe.replaceAll(key, "[REDACTED]") : safe);
      process.exitCode = 1;
    });
}
