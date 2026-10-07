/**
 * The W1c Jev pair-label batch (Phase 18 D9 item 2): asks Jev, under the registered D0 purpose
 * `pair_plausibility`, whether each fixed pair or plate pattern is a normal combination at its
 * stated occasion, and stores the raw probability in the label store (./labels.ts).
 *
 * BILLS the TypeSafe key. Never in CI, never on a request path. Run by hand from the repo root with
 * TYPESAFE_API_KEY in the environment or .env.local (ZS Vault `typesafe_api_key`):
 *
 *   pnpm exec tsx scripts/pairing/jev-labels.ts --items sample            refresh: ask only unstored items
 *   pnpm exec tsx scripts/pairing/jev-labels.ts --items sample --verify   re-ask stored items, report drift,
 *                                                                          write nothing to the store
 *   pnpm exec tsx scripts/pairing/jev-labels.ts --items holdout|all --max-usd <n>
 *
 * `sample` is the ≤ 60-item reproducibility sample (pairs.ts); `holdout` the 432 human-holdout
 * pairs; `all` every fixed pair and plate pattern. Anything past the sample needs --max-usd.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import type { PairItem } from "@/lib/foods/pairing/questions";
import { labelKey, labelsFor, mergeLabels, missingItems, readStore, storeText, writeStore } from "@/scripts/pairing/labels";
import { fixedPairs, holdoutCandidates, platePatterns, reproducibilitySample, toItem } from "@/scripts/pairing/pairs";
import { sha256 } from "@/scripts/priors/artifact-io";

const CHILD_ARG = "--pair-labels-react-server-child";
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BATCH_TOKEN_LIMIT = 12_000;
const INPUT_USD_PER_MILLION = 0.042;
const SAMPLE_LIMIT = 60;
const DEADLINE_MS = 20_000;
export const REPRO_REPORT = "docs/pairing/w1c-jev-reproducibility.md";

type Args = { items: "sample" | "holdout" | "all"; verify: boolean; maxUsd: number };

export function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string) => { const at = argv.indexOf(flag); return at < 0 ? null : argv[at + 1] ?? null; };
  const items = (value("--items") ?? "sample") as Args["items"];
  if (!["sample", "holdout", "all"].includes(items)) throw new Error("--items is sample, holdout or all");
  const maxUsd = Number(value("--max-usd") ?? (items === "sample" ? "0.05" : "NaN"));
  if (!(maxUsd > 0)) throw new Error(`--items ${items} needs --max-usd <dollars>`);
  return { items, verify: argv.includes("--verify"), maxUsd };
}

export function itemsFor(kind: Args["items"]): PairItem[] {
  const pairs = fixedPairs();
  if (kind === "sample") return reproducibilitySample(pairs).slice(0, SAMPLE_LIMIT);
  if (kind === "holdout") return holdoutCandidates(pairs).map(toItem);
  return [...pairs.map(toItem), ...platePatterns(pairs).map(({ id, anchor, sides, occasion }) => ({ id, anchor, sides, occasion }))];
}

async function ask(items: readonly PairItem[], maxUsd: number): Promise<{ answers: { item: PairItem; p: number }[]; model: string; usd: number; calls: number }> {
  if (process.env.CI) throw new Error("The Jev pair-label batch bills a real key and never runs in CI");
  const [{ systemOne }, { pairPlausibilityPayload }, { JEV_MODEL }] = await Promise.all([
    import("@/lib/ai/typesafe"), import("@/lib/ai/payloads"), import("@/lib/ai/models")]);
  const estimate = (batch: readonly PairItem[]) => {
    const payload = pairPlausibilityPayload({ items: batch });
    return Math.ceil(Buffer.byteLength(JSON.stringify({ state: payload.state, questions: payload.questions }), "utf8") / 4);
  };
  const batches: PairItem[][] = [];
  let pending: PairItem[] = [];
  for (const item of items) {
    if (pending.length && estimate([...pending, item]) > BATCH_TOKEN_LIMIT) { batches.push(pending); pending = []; }
    pending.push(item);
  }
  if (pending.length) batches.push(pending);
  const usd = batches.reduce((sum, batch) => sum + estimate(batch), 0) / 1e6 * INPUT_USD_PER_MILLION;
  if (usd > maxUsd) throw new Error(`Predicted Jev spend $${usd.toFixed(5)} exceeds --max-usd ${maxUsd}`);
  const answers: { item: PairItem; p: number }[] = [];
  for (const [index, batch] of batches.entries()) {
    const result = await systemOne(pairPlausibilityPayload({ items: batch }), { deadlineMs: DEADLINE_MS });
    if (!result) throw new Error(`Jev returned no answer for batch ${index + 1}/${batches.length}`);
    for (const item of batch) {
      const answer = (result as Record<string, { type: string; noul?: number }>)[item.id];
      if (answer?.type !== "noul" || typeof answer.noul !== "number") throw new Error(`no answer for ${item.id}`);
      answers.push({ item, p: answer.noul });
    }
    console.log(`asked batch ${index + 1}/${batches.length}: ${batch.length} items`);
  }
  return { answers, model: JEV_MODEL, usd, calls: batches.length };
}

function reproReport(model: string, rows: { id: string; stored: number; again: number }[], storeHash: string, calls: number, usd: number): string {
  const diffs = rows.map((row) => Math.abs(row.stored - row.again));
  const mean = diffs.reduce((sum, value) => sum + value, 0) / (diffs.length || 1);
  const max = Math.max(0, ...diffs);
  return [`# W1c Jev pair labels: reproducibility (acceptance 2)`, "",
    `Model \`${model}\`, purpose \`pair_plausibility\`, sample of ${rows.length} items (pairs and plate patterns).`,
    `Generated by \`scripts/pairing/jev-labels.ts --items sample --verify\`. Live calls: ${calls} batch request(s), predicted input spend $${usd.toFixed(5)}.`,
    "", "## Stored probabilities", "",
    `A refresh with the same model id, prompt and rubric asks Jev for no stored item and writes no stored value: the label store`,
    `(\`scripts/pairing/data/jev-pair-labels.json\`) hashed \`${storeHash}\` before and after this run.`,
    "", "## Jev's own repeatability (informative)", "",
    `Re-asking the stored items live (not written): mean |Δp| ${mean.toFixed(4)}, max |Δp| ${max.toFixed(4)},`,
    `${diffs.filter((value) => value === 0).length} of ${rows.length} identical. The store never takes the re-asked value.`,
    "", "| item | stored p | re-asked p |", "|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${row.stored.toFixed(4)} | ${row.again.toFixed(4)} |`), ""].join("\n");
}

export async function run(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const envFile = resolve(ROOT, ".env.local");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const { JEV_MODEL } = await import("@/lib/ai/models");
  const items = itemsFor(args.items);
  const store = readStore();
  const before = sha256(storeText(store));
  if (args.verify) {
    const stored = labelsFor(store, items, JEV_MODEL);
    const asked = items.filter((item) => stored.has(item.id));
    const live = await ask(asked, args.maxUsd);
    const after = sha256(storeText(readStore()));
    if (after !== before) throw new Error("the label store changed during --verify");
    const rows = live.answers.map(({ item, p }) => ({ id: item.id, stored: stored.get(item.id)!, again: p }));
    mkdirSync(dirname(resolve(ROOT, REPRO_REPORT)), { recursive: true });
    writeFileSync(resolve(ROOT, REPRO_REPORT), reproReport(live.model, rows, before, live.calls, live.usd));
    console.log(`verified ${rows.length} stored items; store unchanged (${before})`);
    return;
  }
  const missing = missingItems(store, items, JEV_MODEL);
  console.log(`${items.length - missing.length} stored, ${missing.length} to ask (model ${JEV_MODEL})`);
  if (!missing.length) { console.log(`store unchanged (${before})`); return; }
  const live = await ask(missing, args.maxUsd);
  const next = mergeLabels(store, live.answers, live.model);
  writeStore(next);
  const unchanged = store.labels.every((label) => next.labels.find((other) => other.key === label.key)?.p === label.p);
  console.log(`stored ${next.labels.length - store.labels.length} new labels; existing unchanged: ${unchanged}; `
    + `${live.calls} call(s), predicted $${live.usd.toFixed(5)}; keys e.g. ${labelKey(live.model, missing[0]).slice(0, 12)}`);
}

if (!process.argv.includes(CHILD_ARG)) {
  // `server-only` sits in the lib/ai import graph; the react-server condition lets it resolve.
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD_ARG, ...process.argv.slice(2)], { stdio: "inherit", env: process.env, cwd: ROOT });
  if (child.error) console.error(child.error);
  process.exitCode = child.status ?? 1;
} else {
  run(process.argv.slice(2).filter((arg) => arg !== CHILD_ARG)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
