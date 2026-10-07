import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ACTION_KINDS, type CoachAction } from "@/lib/coach/actions";
import { MEDICAL_DEFLECTION } from "@/lib/coach/deflect";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { jevExpectationSchema } from "./coach-streak-jev-contract";
import { renderReportMarkdown } from "./coach-streak-report";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS_PATH = resolve(ROOT, "scripts/eval/coach-corpus.json");
const caseCategorySchema = z.enum(["devin", "list_edit", "schedule_body", "suggestion", "no_action",
  "block", "jev", "meals", "activity"]);
const blockKindSchema = z.enum(["chart", "quick_replies", "food_search", "food_ideas"]);
const chartKindSchema = z.enum(["weight_trend", "macros_today", "kcal_week"]);
const blockIntentSchema = z.enum(["log", "eats", "avoid"]);
const rangeSchema = z.object({ min: z.number().int().min(0), max: z.number().int().min(0) });
export type CoachCaseCategory = z.infer<typeof caseCategorySchema>;
export type ExpectedBlockKind = z.infer<typeof blockKindSchema>;
export type StreakRunConfig = {
  category: CoachCaseCategory | null;
  branch: string;
  streakTarget: number;
  turnLimit: number;
  statePath: string;
  reportPath: string;
  turnDir: string;
  title: string;
};
export function runConfig(category: CoachCaseCategory | null, branch: string | null = null): StreakRunConfig {
  if (category === "meals") {
    return {
      category,
      branch: "meals-2-2026-09-20",
      streakTarget: 5,
      turnLimit: 25,
      statePath: resolve(ROOT, "docs/evals/2026-09-20-coach-streak-meals-state.json"),
      reportPath: resolve(ROOT, "docs/evals/2026-09-20-coach-streak-meals.md"),
      turnDir: resolve(ROOT, "docs/evals/2026-09-20-coach-streak-meals-turns"),
      title: "Coach meals quality streak — 2026-09-20",
    };
  }
  if (category === "block" || category === "jev") {
    const label = category === "block" ? "blocks" : "jev";
    const name = category === "block" ? "block" : "Jev";
    return {
      category,
      branch: "chat-first-2026-09-19",
      streakTarget: 6,
      turnLimit: 30,
      statePath: resolve(ROOT, `docs/evals/2026-09-20-coach-streak-${label}-state.json`),
      reportPath: resolve(ROOT, `docs/evals/2026-09-20-coach-streak-${label}.md`),
      turnDir: resolve(ROOT, `docs/evals/2026-09-20-coach-streak-${label}-turns`),
      title: `Coach ${name} quality streak — 2026-09-20`,
    };
  }
  const suffix = category ? `-${category.replaceAll("_", "-")}` : "";
  const date = category === "activity" ? "2026-09-20" : "2026-09-19";
  return {
    category,
    branch: category === "activity" ? "feat/health-3 (local Docker)" : branch ?? "",
    streakTarget: category === "activity" ? 1 : 10,
    turnLimit: category === "activity" ? 1 : 40,
    statePath: resolve(ROOT, `docs/evals/${date}-coach-streak${suffix}-state.json`),
    reportPath: resolve(ROOT, `docs/evals/${date}-coach-streak${suffix}.md`),
    turnDir: resolve(ROOT, `docs/evals/${date}-coach-streak${suffix}-turns`),
    title: category === "activity" ? "Coach activity quality streak — 2026-09-20"
      : "Coach quality streak — 2026-09-19",
  };
}
export function parseCategory(value: string | null): CoachCaseCategory | null {
  if (value === null) return null;
  return caseCategorySchema.parse(value);
}
const actionKindSchema = z.enum(ACTION_KINDS);
const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: caseCategorySchema,
  sentence: z.string().min(1),
  expected_path: z.enum(["fast", "llm", "either"]),
  note: z.string().min(1).optional(),
  expected_action_kinds: z.array(actionKindSchema),
  expected_card_count: rangeSchema,
  latency_bound_ms: z.object({ fast: z.number().int().positive(), llm: z.number().int().positive() }),
  no_unsupported_claim: z.literal(true),
  expected_marker: z.literal("medical_deflection").optional(),
  expected_block_kinds: z.array(blockKindSchema).optional(),
  expected_chart: chartKindSchema.optional(),
  expected_block_intent: blockIntentSchema.optional(),
  expected_quick_replies: rangeSchema.optional(),
  expected_jev: jevExpectationSchema.optional(),
}).refine((value) => value.expected_card_count.min <= value.expected_card_count.max, {
  message: "card count min must not exceed max",
}).refine((value) => value.expected_quick_replies === undefined
    || value.expected_quick_replies.min <= value.expected_quick_replies.max, {
  message: "quick reply min must not exceed max",
}).refine((value) => value.expected_block_kinds === undefined
    || new Set(value.expected_block_kinds).size === value.expected_block_kinds.length, {
  message: "expected block kinds must be unique",
}).superRefine((value, context) => {
  const requirements = [
    ["chart", "expected_chart"],
    ["food_search", "expected_block_intent"],
    ["quick_replies", "expected_quick_replies"],
  ] as const;
  for (const [kind, field] of requirements) {
    if (value.expected_block_kinds?.includes(kind) && value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${kind} cases require ${field}`,
      });
    }
  }
  if (value.category === "jev" && value.expected_jev === undefined) {
    context.addIssue({
      code: "custom",
      path: ["expected_jev"],
      message: "jev cases require expected_jev",
    });
  }
});
export type CoachCase = z.infer<typeof caseSchema>;
export type ActualPath = "fast" | "llm";
export type Diagnosis = "code defect" | "corpus expectation wrong" | "model behaviour"
  | "expectation corrected: argument-confidence rule" | "verifier_error";
export type TerminalState = "running" | "success" | "exhausted" | "blocked";
export type Assertion = { name: string; passed: boolean; detail: string };
export type TurnRecord = {
  turn: number;
  caseId: string;
  sentence: string;
  path: ActualPath | "error";
  elapsedMs: number;
  actions: string[];
  blocks: string[];
  cards: number;
  category: CoachCaseCategory;
  passed: boolean;
  assertions: Assertion[];
  proofPath: string;
  threadId?: string;
  error?: string;
  diagnosis?: "verifier_error";
};
export type FailureRecord = {
  id: string;
  turn: number;
  caseId: string;
  proofPath: string;
  status: "open" | "resolved";
  diagnosis: Diagnosis | null;
  resolution: string | null;
  regressionTest: string | null;
};
export type BlockerRecord = { reason: string; resolution: string | null };
export type StreakState = {
  version: 1;
  seed: string;
  branch: string;
  category?: CoachCaseCategory | null;
  startedAt: string;
  updatedAt: string;
  status: TerminalState;
  streak: number;
  totalTurns: number;
  turns: TurnRecord[];
  failures: FailureRecord[];
  blockers?: BlockerRecord[];
  blockedReason?: string;
  evaluation?: { mode: "live" | "offline"; storedTurns?: number };
  warming?: { foods: number; calls: number; costUsd: number; targetLine?: string };
  providerSpend?: import("./coach-streak-meals").ProviderSpend;
};
export function parseCoachCase(value: unknown): CoachCase {
  return caseSchema.parse(value);
}
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}
export function relativeToRoot(path: string): string {
  return relative(ROOT, path);
}

export function loadCorpus(): CoachCase[] {
  const parsed = z.array(caseSchema).parse(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
  if (parsed.length !== 38) throw new Error(`Expected 38 corpus cases, found ${parsed.length}.`);
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) {
    throw new Error("Corpus case ids must be unique.");
  }
  const expectedCounts = {
    devin: 4, list_edit: 5, schedule_body: 4, suggestion: 4, no_action: 3, block: 6, jev: 6,
    meals: 5, activity: 1,
  };
  for (const [category, expected] of Object.entries(expectedCounts)) {
    const actual = parsed.filter((item) => item.category === category).length;
    if (actual !== expected) throw new Error(`Expected ${expected} ${category} cases, found ${actual}.`);
  }
  return parsed;
}

export function newState(
  seed: string,
  config: StreakRunConfig,
  now = new Date().toISOString(),
): StreakState {
  return {
    version: 1, seed, branch: config.branch, category: config.category,
    startedAt: now, updatedAt: now,
    status: "running", streak: 0, totalTurns: 0, turns: [], failures: [], blockers: [],
  };
}

export function loadState(config: StreakRunConfig): StreakState | null {
  if (!existsSync(config.statePath)) return null;
  const value = JSON.parse(readFileSync(config.statePath, "utf8")) as Partial<StreakState>;
  if (value.version !== 1 || value.branch !== config.branch
      || (value.category ?? null) !== config.category || !Array.isArray(value.turns)
      || !Array.isArray(value.failures) || typeof value.seed !== "string") {
    throw new Error(`Invalid streak state at ${relativeToRoot(config.statePath)}.`);
  }
  return value as StreakState;
}

function hash(value: string): number {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function random(seed: number): () => number {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A seeded shuffle per filtered deck: random order, with every case reachable before repeats. */
export function drawCase(corpus: CoachCase[], seed: string, totalTurns: number): CoachCase {
  if (corpus.length > 0 && corpus.every((item) => item.category === "meals")) {
    return corpus[totalTurns % corpus.length];
  }
  const deckNumber = Math.floor(totalTurns / corpus.length);
  const deck = [...corpus];
  const next = random(hash(`${seed}:${deckNumber}`));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  return deck[totalTurns % deck.length];
}

/** A fresh or resumable --report request runs first; only a terminal state is report-only. */
export function reportRunsOffline(requested: boolean, state: StreakState | null): boolean {
  return requested && state !== null && state.status !== "running";
}

function sameSet(actual: string[], expected: string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

export function actualBlockKinds(blocks: readonly unknown[]): string[] {
  return blocks.flatMap((block) => {
    const kind = objectOf(block)?.kind;
    return typeof kind === "string" ? [kind] : [];
  });
}
function result(name: string, passed: boolean, detail: string): Assertion {
  return { name, passed, detail };
}
function blockValues(blocks: readonly unknown[], kind: string, field: string): unknown[] {
  return blocks.flatMap((block) => {
    const value = objectOf(block);
    return value?.kind === kind ? [value[field]] : [];
  });
}

export function actualPath(response: CoachTurnResponse): ActualPath {
  return response.model.modelId ? "llm" : "fast";
}
export function evaluateTurn(
  item: CoachCase,
  response: CoachTurnResponse,
  elapsedMs: number,
  unsupportedClaim: { flagged: boolean; p: number | null },
  persistedBlocks: readonly unknown[] = [], activityContextPresent = false,
): { path: ActualPath; assertions: Assertion[]; passed: boolean } {
  const path = actualPath(response);
  const actionKinds = response.actions.map((action) => action.kind);
  const cards = response.composed?.length ?? 0;
  const reply = response.messages.at(-1)?.content ?? "";
  const pathMatches = item.expected_path === "either" || item.expected_path === path;
  const markerMatches = item.expected_marker === "medical_deflection"
    ? response.deflected && reply === MEDICAL_DEFLECTION
    : !response.deflected;
  const assertions: Assertion[] = [
    result("expected path", pathMatches, `expected ${item.expected_path}; got ${path}`),
    result("expected action-kind set", sameSet(actionKinds, item.expected_action_kinds),
      `expected [${item.expected_action_kinds.join(", ")}]; got [${actionKinds.join(", ")}]`),
    result("expected card-count range",
      cards >= item.expected_card_count.min && cards <= item.expected_card_count.max,
      `expected ${item.expected_card_count.min}-${item.expected_card_count.max}; got ${cards}`),
    result("latency bound", elapsedMs < item.latency_bound_ms[path],
      `expected < ${item.latency_bound_ms[path]} ms; got ${elapsedMs} ms`),
    result("no unsupported action claim", !unsupportedClaim.flagged,
      `verifier flagged=${unsupportedClaim.flagged}; p=${unsupportedClaim.p ?? "fallback"}`),
    result(item.expected_marker ? "expected medical deflection" : "not medically deflected",
      markerMatches, `deflected=${response.deflected}; reply=${JSON.stringify(reply)}`),
  ];
  if (item.expected_block_kinds !== undefined) {
    const blockKinds = actualBlockKinds(persistedBlocks);
    assertions.push(
      result("expected block-kind set", sameSet(blockKinds, item.expected_block_kinds),
        `expected [${item.expected_block_kinds.join(", ")}]; got [${blockKinds.join(", ")}]`),
      result("expected block version", persistedBlocks.every((block) => objectOf(block)?.v === 1),
        `expected every persisted block at v1; got ${JSON.stringify(
          persistedBlocks.map((block) => objectOf(block)?.v ?? null),
        )}`),
    );
  }
  if (item.expected_chart !== undefined) {
    const charts = blockValues(persistedBlocks, "chart", "chart");
    assertions.push(result("expected chart subtype",
      charts.length === 1 && charts[0] === item.expected_chart,
      `expected ${item.expected_chart}; got ${JSON.stringify(charts)}`));
  }
  if (item.expected_block_intent !== undefined) {
    const intents = blockValues(persistedBlocks, "food_search", "intent");
    assertions.push(result("expected food-search intent",
      intents.length === 1 && intents[0] === item.expected_block_intent,
      `expected ${item.expected_block_intent}; got ${JSON.stringify(intents)}`));
  }
  if (item.expected_quick_replies !== undefined) {
    const counts = blockValues(persistedBlocks, "quick_replies", "options")
      .map((options) => Array.isArray(options) ? options.length : 0);
    const { min, max } = item.expected_quick_replies;
    assertions.push(result("expected quick-reply count",
      counts.length === 1 && counts[0] >= min && counts[0] <= max,
      `expected ${min}-${max}; got ${JSON.stringify(counts)}`));
  }
  if (item.category === "activity") {
    const forbidden = /\b(?:earned|eat back|extra calories)\b|\byou can (?:eat|have)\b.{0,24}\bmore\b/i;
    const deviceEstimate = /(?:device estimat(?:e|es).{0,48}\b520\b|\b520\b.{0,48}device estimat(?:e|es))/i;
    const noAllowance = /(?:^|[.!?]\s+)(?:(?:that|this|the reading|your device estimate)\b.{0,80}\b(?:does not|doesn't|did not|didn't)\b.{0,32}\b(?:create|give|provide)\b.{0,20}\bfood allowance\b|there is no food allowance\b)/i;
    const numericAllowance = /\byou can (?:eat|have|add)\b.{0,32}\b\d+(?:\.\d+)?\s*(?:kcal|calories)\b|\bfood allowance\b.{0,20}\b\d+(?:\.\d+)?\s*(?:kcal|calories)\b/i;
    const noMutation = /(?:^|[.!?]\s+)(?:(?:that|this|the reading|steps|device active kcal)\b.{0,40}\b(?:does not|doesn't|did not|didn't)\b.{0,40}\b(?:change|adjust|set)\b.{0,24}\b(?:your )?target\b|(?:your )?target\b.{0,20}\b(?:was not|is not)\b.{0,20}\b(?:changed|adjusted|set)\b.{0,30}\bby\b.{0,30}\b(?:that|this|the reading|steps|device)\b)/i;
    assertions.push(result("C13 activity context present", activityContextPresent,
      activityContextPresent ? "packed today.activity present" : "packed today.activity absent"),
      result("C13 device estimate wording", deviceEstimate.test(reply), JSON.stringify(reply)),
      result("C13 forbidden allowance wording", !forbidden.test(reply), JSON.stringify(reply)),
      result("C13 no numeric food allowance", noAllowance.test(reply) && !numericAllowance.test(reply), JSON.stringify(reply)),
      result("C13 no target mutation", noMutation.test(reply), JSON.stringify(reply)),
      result("C13 logs-and-weight weekly proposal", /\bone-tap\b/i.test(reply) && /\bweekly\b.{0,24}\bproposal\b/i.test(reply) && /\blogs\b/i.test(reply) && /\bweight\b/i.test(reply), JSON.stringify(reply)),
    );
  }
  return { path, assertions, passed: assertions.every((assertion) => assertion.passed) };
}

export function reportMarkdown(state: StreakState, config: StreakRunConfig): string {
  return renderReportMarkdown(state, config, loadCorpus());
}
export function saveState(state: StreakState, config: StreakRunConfig): void {
  state.updatedAt = new Date().toISOString();
  writeAtomic(config.statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(config.reportPath, reportMarkdown(state, config));
}

export function writeTurnProof(
  config: StreakRunConfig,
  turn: number,
  caseId: string,
  payload: unknown,
): string {
  const name = `turn-${String(turn).padStart(3, "0")}-${caseId}.json`;
  const path = resolve(config.turnDir, name);
  writeAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
  return relativeToRoot(path);
}

export function actionKinds(actions: CoachAction[]): string[] {
  return actions.map((action) => action.kind);
}
