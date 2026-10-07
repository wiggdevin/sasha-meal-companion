import { createHash } from "node:crypto";
import type { Questions } from "@/lib/ai/typesafe";
import {
  facetEvalQuestions, facetEvalState, type FacetEvalCase,
} from "@/lib/foods/facet-eval-questions";
import {
  BATCH_TOKEN_LIMIT,
  MODEL_ALIAS,
  type Batch,
  type BatchKind,
  type EvalCase,
  type Split,
  evaluatedCases,
} from "./types";

export function productionState(item: EvalCase, kind: BatchKind): FacetEvalCase {
  return facetEvalState(item, kind);
}

export function makePayload(items: EvalCase[], kind: BatchKind): {
  state: Batch["state"];
  questions: Questions;
  input: string;
} {
  const state = { cases: Object.fromEntries(items.map((item) => [item.id, productionState(item, kind)])) };
  const questions = facetEvalQuestions(items, kind);
  return { state, questions, input: JSON.stringify({ state, model: MODEL_ALIAS, questions }) };
}

export async function batchesFor(cases: EvalCase[], split: Split): Promise<Batch[]> {
  const eligible = evaluatedCases(cases);
  return [
    ...await batchesOfKind(eligible, split, "facets"),
    ...await batchesOfKind(eligible.filter((item) => item.portion), split, "portion"),
  ];
}

export function caseHash(item: EvalCase, kind: BatchKind): string {
  return createHash("sha256").update(makePayload([item], kind).input).digest("hex");
}

async function batchesOfKind(cases: EvalCase[], split: Split, kind: BatchKind): Promise<Batch[]> {
  const result: Batch[] = [];
  let pending: EvalCase[] = [];
  for (const item of cases) {
    const trial = [...pending, item];
    const estimatedTokens = estimate(makePayload(trial, kind).input);
    if (estimatedTokens > BATCH_TOKEN_LIMIT && pending.length > 0) {
      result.push(finishBatch(pending, split, kind));
      pending = [item];
    } else if (estimatedTokens > BATCH_TOKEN_LIMIT) {
      throw new Error(`Case ${item.id} exceeds the 16k-token batch limit`);
    } else {
      pending = trial;
    }
  }
  if (pending.length > 0) result.push(finishBatch(pending, split, kind));
  return result;
}

function finishBatch(cases: EvalCase[], split: Split, kind: BatchKind): Batch {
  const payload = makePayload(cases, kind);
  for (const item of cases) for (const value of Object.values(item.privacyCanary ?? {})) {
    if (payload.input.includes(value)) throw new Error(`Privacy canary escaped into Jev state for ${item.id}`);
  }
  return { split, kind, cases, ...payload, estimatedTokens: estimate(payload.input) };
}

function estimate(input: string): number {
  return Math.ceil(Buffer.byteLength(input, "utf8") / 4);
}
