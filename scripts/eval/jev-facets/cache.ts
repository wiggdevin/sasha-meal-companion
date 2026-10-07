import { readFileSync, writeFileSync } from "node:fs";
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "@/lib/ai/typesafe";
import { caseHash } from "./payload";
import {
  CACHE_PATH,
  PORTION_LEVELS,
  RUBRIC_VERSION,
  SPEND_LIMIT_USD,
  costUsd,
  evaluatedCases,
  type Batch,
  type CachedCase,
  type EvalCase,
  type JudgmentsCache,
  type Usage,
} from "./types";

type Envelope = {
  model: string;
  answers: Record<string, NoulAnswer | ScoreAnswer | ChoiceAnswer<Record<string, string>>>;
  usage: { input_tokens: number; output_tokens: number };
};

export function readCache(cases: readonly EvalCase[]): JudgmentsCache {
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as JudgmentsCache;
  if (cache.version !== 1 || cache.rubricVersion !== RUBRIC_VERSION || !cache.model || !cache.cases) {
    throw new Error("Malformed committed Jev judgments cache");
  }
  validateCaseHashes(cache, cases);
  return cache;
}

export async function refreshCache(batches: Batch[], cases: readonly EvalCase[]): Promise<{
  cache: JudgmentsCache;
  usage: Usage;
}> {
  const predicted = batches.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
  if (costUsd({ inputTokens: predicted, outputTokens: 0 }) >= SPEND_LIMIT_USD) {
    throw new Error(`Predicted Jev spend exceeds $${SPEND_LIMIT_USD}`);
  }
  const usage: Usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const casesById: Record<string, CachedCase> = {};
  const models = new Set<string>();
  for (const [index, batch] of batches.entries()) {
    const result = await callBatch(batch);
    models.add(result.model);
    usage.inputTokens += result.usage.input_tokens;
    usage.outputTokens += result.usage.output_tokens;
    usage.requests += 1;
    mergeScores(casesById, batch, result.answers);
    console.log(`judged batch ${index + 1}/${batches.length}: ${batch.split} ${batch.kind}, ${batch.cases.length} cases`);
  }
  if (models.size !== 1) throw new Error(`Refresh returned multiple models: ${[...models].join(", ")}`);
  if (costUsd(usage) >= SPEND_LIMIT_USD) throw new Error(`Actual Jev spend exceeded $${SPEND_LIMIT_USD}`);
  const cache: JudgmentsCache = {
    version: 1,
    rubricVersion: RUBRIC_VERSION,
    model: [...models][0],
    cases: casesById,
  };
  validateCaseHashes(cache, cases);
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  return { cache, usage };
}

function validateCaseHashes(cache: JudgmentsCache, cases: readonly EvalCase[]): void {
  for (const item of evaluatedCases(cases)) {
    const cached = cache.cases[item.id];
    if (!cached) throw new Error(`Missing committed score for ${item.id}`);
    const kinds = item.portion ? ["facets", "portion"] as const : ["facets"] as const;
    for (const kind of kinds) {
      if (cached.hashes[kind] !== caseHash(item, kind)) throw new Error(`Stale committed score for ${item.id} ${kind}`);
    }
  }
}

async function callBatch(batch: Batch): Promise<Envelope> {
  const { systemOne } = await import("@/lib/ai/typesafe");
  const { facetEvalPayload } = await import("@/lib/ai/payloads");
  const originalFetch = globalThis.fetch;
  let raw: unknown;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.ok && String(args[0]).includes("api.typesafe.ai/v1/systemone")) {
      raw = await response.clone().json();
    }
    return response;
  };
  try {
    const answers = await systemOne(facetEvalPayload({ kind: batch.kind, items: batch.cases }), {
      deadlineMs: 10_000,
    });
    if (!answers || !raw || typeof raw !== "object") throw new Error("Jev returned null");
    const envelope = raw as Envelope;
    const rawKeys = Object.keys(envelope.answers ?? {}).sort();
    const validatedKeys = Object.keys(answers).sort();
    if (rawKeys.length !== validatedKeys.length
      || rawKeys.some((key, index) => key !== validatedKeys[index])) {
      throw new Error("Captured provider answer keys differ from validated wrapper answer keys");
    }
    return { ...envelope, answers };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function mergeScores(target: Record<string, CachedCase>, batch: Batch,
  answers: Envelope["answers"]): void {
  for (const item of batch.cases) {
    const entry = target[item.id] ?? { hashes: {}, scores: {} };
    entry.hashes[batch.kind] = caseHash(item, batch.kind);
    const prefix = `${item.id}::`;
    for (const [key, answer] of Object.entries(answers)) {
      if (!key.startsWith(prefix)) continue;
      if (answer.type === "choice") throw new Error(`Unexpected choice answer for ${key}`);
      entry.scores[key.slice(prefix.length)] = answer.type === "noul" ? answer.noul
        : PORTION_LEVELS.map((_, index) => requiredProbability(answer, index, item.id));
    }
    target[item.id] = entry;
  }
}

function requiredProbability(answer: ScoreAnswer, level: number, caseId: string): number {
  const value = answer.probabilities[String(level)];
  if (!Number.isFinite(value)) throw new Error(`Missing score level ${level} for ${caseId}`);
  return value;
}

export function score(cache: JudgmentsCache, caseId: string, key: string, level?: number): number {
  const value: number | number[] | undefined = cache.cases[caseId]?.scores[key];
  if (level === undefined) {
    if (!Number.isFinite(value)) throw new Error(`Missing score ${caseId}::${key}`);
    return value as number;
  }
  if (!Array.isArray(value) || !Number.isFinite(value[level])) {
    throw new Error(`Missing score level ${level} for ${caseId}::${key}`);
  }
  return value[level];
}
