/**
 * L3 live coach quality streak.
 *
 * The caller supplies branch-only SUPABASE_TEST_* variables (export them with
 * `scripts/db-branch.sh env <branch>`). This runner never creates, resets, or destroys a branch;
 * it resets only its dedicated test user's rows before each fresh-thread case.
 *
 * The default (no --category) run needs a persistent branch name: pass --branch <name> or export
 * COACH_STREAK_BRANCH=<name> — there is no hardcoded fallback, so a stale branch can't be used by
 * accident. The maintained branch as of 2026-10-03 is `coach-eval` (see AGENTS.md). The --category
 * meals/block/jev/activity runs still use their own fixed branch names in coach-streak-state.ts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { CoachTurnResponse } from "@/lib/coach/types";
import {
  actionKinds,
  actualBlockKinds,
  actualPath,
  drawCase,
  evaluateTurn,
  loadCorpus,
  loadState,
  newState,
  parseCategory,
  relativeToRoot,
  reportMarkdown,
  reportRunsOffline,
  runConfig,
  saveState,
  writeTurnProof,
  type Assertion,
  type CoachCase,
  type Diagnosis,
  type FailureRecord,
  type StreakState,
  type StreakRunConfig,
  type TurnRecord,
} from "./coach-streak-state";
import { defaultBranch, needsActivityContext } from "./coach-streak-branch";
import { withRunDate } from "./coach-streak-run-date";
import {
  evaluateRunnerTurn,
  type VerificationRecord,
} from "./coach-streak-evaluate";
import { persistedBlockEvidence } from "./coach-streak-proof";
import {
  collectJevEvidence,
  jevAssertions,
  jevWarmPlan,
  seedJevCase,
  warmingSnapshot,
  type JevPersistedEvidence,
} from "./coach-streak-jev";
import {
  liveCheckAssertions,
  loadProviderKeys,
  openHarness,
  safeError,
  TIMEZONE,
} from "./coach-streak-harness";
import {
  materializedMealTitle,
  materializePhoneMeal,
  mealCaseAssertions,
  providerSpend,
  userStateSnapshot,
} from "./coach-streak-meals";

const SERVER_CHILD_ARG = "--coach-streak-react-server-child";
const DEFAULT_SEED = "20260919";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function configFromCli(): StreakRunConfig {
  const categoryFlag = option("--category");
  if (has("--category") && categoryFlag === null) throw new Error("--category requires a name.");
  const branchFlag = option("--branch");
  if (has("--branch") && branchFlag === null) throw new Error("--branch requires a name.");
  const category = parseCategory(categoryFlag);
  return withRunDate(runConfig(category, category === null ? defaultBranch(branchFlag) : branchFlag));
}

function printSummary(state: StreakState, config: StreakRunConfig): void {
  const open = state.failures.filter((failure) => failure.status === "open").length;
  console.log(`state=${state.status} streak=${state.streak}/${config.streakTarget} `
    + `turns=${state.totalTurns}/${config.turnLimit} failures=${state.failures.length} open=${open}`);
  console.log(`report: ${relativeToRoot(config.reportPath)}`);
}

function diagnosisFromCli(value: string | null): Diagnosis {
  const diagnoses: Record<string, Diagnosis> = {
    "code-defect": "code defect",
    "corpus-expectation-wrong": "corpus expectation wrong",
    "model-behaviour": "model behaviour",
  };
  const diagnosis = value ? diagnoses[value] : undefined;
  if (!diagnosis) {
    throw new Error("--diagnosis must be code-defect, corpus-expectation-wrong, or model-behaviour.");
  }
  return diagnosis;
}

function resolveFailure(): void {
  const config = configFromCli();
  const state = loadState(config);
  if (!state) throw new Error(`No streak state at ${relativeToRoot(config.statePath)}.`);
  const requestedId = option("--resolve");
  const failure = requestedId
    ? state.failures.find((item) => item.id === requestedId)
    : state.failures.findLast((item) => item.status === "open");
  if (!failure || failure.status !== "open") throw new Error("No matching open failure.");
  const diagnosis = diagnosisFromCli(option("--diagnosis"));
  const resolution = option("--resolution")?.trim();
  if (!resolution) throw new Error("--resolution is required.");
  const regression = option("--regression")?.trim() ?? null;
  if (diagnosis === "code defect") {
    if (!regression || !/^tests\/coach\/streak-[a-z0-9-]+\.test\.ts$/.test(regression)) {
      throw new Error("A code defect requires --regression tests/coach/streak-<case>.test.ts.");
    }
    if (!existsSync(resolve(process.cwd(), regression))) {
      throw new Error(`Regression test does not exist: ${regression}`);
    }
  }
  Object.assign(failure, {
    status: "resolved" as const,
    diagnosis,
    resolution,
    regressionTest: regression,
  });
  state.status = state.totalTurns >= config.turnLimit ? "exhausted" : "running";
  delete state.blockedReason;
  saveState(state, config);
  console.log(`resolved ${failure.id}: ${diagnosis}`);
  printSummary(state, config);
}

function resumeBlocked(): void {
  const config = configFromCli();
  const state = loadState(config);
  if (!state || state.status !== "blocked" || !state.blockedReason) {
    throw new Error("No blocked streak is available to resume.");
  }
  const resolution = option("--resolution")?.trim();
  if (!resolution) throw new Error("--resolution is required.");
  const blockers = state.blockers ?? [];
  blockers.push({ reason: state.blockedReason, resolution });
  state.blockers = blockers;
  state.status = "running";
  delete state.blockedReason;
  saveState(state, config);
  console.log("resumed blocked streak");
  printSummary(state, config);
}

function report(): void {
  const config = configFromCli();
  const state = loadState(config);
  if (!state) {
    console.error(`No streak state at ${relativeToRoot(config.statePath)}.`);
    process.exitCode = 1;
    return;
  }
  saveState(state, config);
  console.log(reportMarkdown(state, config));
  const everyFailureResolved = state.failures.every((failure) => failure.status === "resolved");
  process.exitCode = state.status === "success" && state.streak >= config.streakTarget
    && everyFailureResolved ? 0 : 1;
}

function failureRecord(state: StreakState, turn: TurnRecord): FailureRecord {
  return {
    id: `F${String(state.failures.length + 1).padStart(3, "0")}`,
    turn: turn.turn,
    caseId: turn.caseId,
    proofPath: turn.proofPath,
    status: "open",
    diagnosis: turn.diagnosis ?? null,
    resolution: null,
    regressionTest: null,
  };
}

function isBranchOrKeyProblem(detail: string): boolean {
  return /SUPABASE_TEST_|production Supabase|API_KEY|JWT|auth|permission denied|schema cache|test_reset_user|Could not (?:create|sign in)/i
    .test(detail);
}

function block(state: StreakState, reason: string): void {
  state.status = "blocked";
  state.blockedReason = reason;
}

function recordErroredTurn(
  config: StreakRunConfig,
  state: StreakState,
  category: CoachCase["category"],
  caseId: string,
  sentence: string,
  elapsedMs: number,
  detail: string,
): TurnRecord {
  const turnNumber = state.totalTurns + 1;
  const proofPath = writeTurnProof(config, turnNumber, caseId, {
    generatedAt: new Date().toISOString(), branch: config.branch, seed: state.seed,
    turn: turnNumber, caseId, sentence, passed: false, error: detail,
  });
  return {
    turn: turnNumber, caseId, sentence, path: "error", elapsedMs,
    actions: [], blocks: [], cards: 0, category, passed: false,
    assertions: [{ name: "runTurn returned", passed: false, detail }],
    proofPath, error: detail,
  };
}

async function persistedAssistantBlocks(
  harness: Awaited<ReturnType<typeof openHarness>>,
  response: CoachTurnResponse,
): Promise<unknown[]> {
  const assistantId = response.messages.findLast((message) => message.role === "assistant")?.id;
  if (!assistantId) throw new Error("Coach turn returned no assistant message id.");
  const row = await harness.db.from("coach_messages").select("tool_calls")
    .eq("id", assistantId).eq("role", "assistant").single();
  if (row.error) throw row.error;
  const toolCalls = row.data?.tool_calls;
  if (toolCalls === null || Array.isArray(toolCalls) || typeof toolCalls !== "object") return [];
  const blocks = (toolCalls as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? blocks : [];
}

async function runCase(
  config: StreakRunConfig,
  state: StreakState,
  harness: Awaited<ReturnType<typeof openHarness>>,
  seededContext?: Awaited<ReturnType<Awaited<ReturnType<typeof openHarness>>["seed"]>>,
): Promise<TurnRecord> {
  const corpus = loadCorpus().filter((item) => config.category === null
    || item.category === config.category);
  if (corpus.length === 0) throw new Error(`No corpus cases for category ${config.category}.`);
  const item = drawCase(corpus, state.seed, state.totalTurns);
  const context = seededContext ?? await harness.seed();
  // The coach allows 10 turns an hour per user; a 40-turn streak on one test user trips it at turn
  // 10 (W087, 2026-10-17: 429s from turn 10). Clear only this branch test user's counters.
  const limits = await harness.db.from("rate_limits").delete().like("key", `coach:turn:%:user:${harness.userId}`);
  if (limits.error) throw new Error(`rate_limits reset: ${limits.error.message}`);
  const jevContext = item.category === "jev"
    ? await seedJevCase(harness, context, item) : null;
  const started = Date.now();
  const beforeUserState = item.category === "meals"
    ? await userStateSnapshot(harness.db, harness.userId) : null;
  let response: CoachTurnResponse;
  try {
    const { runTurn } = await import("@/lib/server/coach-turn");
    response = await runTurn(harness.client, harness.db, harness.userId, {
      threadId: item.id === "meals-p2-future-breakfast"
        ? state.turns.findLast((turn) => turn.caseId === "meals-p1-month-breakfast")?.threadId ?? null
        : null,
      messageId: randomUUID(),
      text: item.sentence,
      now: new Date().toISOString(),
      tz: TIMEZONE,
    });
  } catch (error) {
    return recordErroredTurn(
      config, state, item.category, item.id, item.sentence, Date.now() - started, safeError(error),
    );
  }
  const elapsedMs = Date.now() - started;
  const afterUserState = item.category === "meals"
    ? await userStateSnapshot(harness.db, harness.userId) : null;
  let persistedBlocks: unknown[];
  let jevEvidence: JevPersistedEvidence | null = null;
  try {
    if (jevContext) {
      const assistantId = response.messages.findLast((message) => message.role === "assistant")?.id;
      if (!assistantId) throw new Error("Coach turn returned no assistant message id.");
      jevEvidence = await collectJevEvidence(harness, assistantId, jevContext);
      persistedBlocks = jevEvidence.blocks;
      response = {
        ...response,
        actions: jevEvidence.actions,
        composed: Array.isArray(jevEvidence.toolCalls.composed)
          ? jevEvidence.toolCalls.composed as CoachTurnResponse["composed"] : [],
        messages: response.messages.map((message) => message.role === "assistant"
          ? { ...message, content: jevEvidence?.assistantContent ?? message.content }
          : message),
      };
    } else {
      persistedBlocks = await persistedAssistantBlocks(harness, response);
    }
  } catch (error) {
    return recordErroredTurn(
      config, state, item.category, item.id, item.sentence, elapsedMs, safeError(error),
    );
  }
  const result = await evaluateRunnerTurn(item, response, elapsedMs, async (input) => {
    const { verifyReply } = await import("@/lib/coach/verify");
    const verified = await verifyReply(input, { userId: harness.userId });
    return verified.p === null ? null : { flagged: verified.flagged, p: verified.p };
  }, persistedBlocks, context.activityContextPresent);
  const materializedTitle = item.id === "meals-p2-future-breakfast"
    ? await materializedMealTitle(harness.db, harness.userId, "2026-10-05", "meal-1") : null;
  const assertions = [
    ...result.evaluated.assertions,
    ...liveCheckAssertions(item.id, response, context),
    ...(item.category === "meals" ? [
      { name: "C9 server turn kept user state read-only", passed: beforeUserState === afterUserState,
        detail: beforeUserState === afterUserState ? "unchanged" : "plan/log state changed during runTurn" },
      ...mealCaseAssertions(item.id, response, harness.date, materializedTitle),
    ] : []),
    ...(item.expected_jev && jevEvidence ? jevAssertions(item.expected_jev, jevEvidence) : []),
  ];
  if (item.category === "meals" && assertions.every((candidate) => candidate.passed)) {
    const meal = response.actions.find((action) => action.kind === "set_slot_meal");
    if (meal?.kind === "set_slot_meal") {
      assertions.push(await materializePhoneMeal(harness, meal));
    }
  }
  const passed = assertions.every((assertion) => assertion.passed);
  const turnNumber = state.totalTurns + 1;
  const proofPath = writeTurnProof(config, turnNumber, item.id, {
    generatedAt: new Date().toISOString(),
    branch: config.branch,
    seed: state.seed,
    turn: turnNumber,
    case: item,
    actual: {
      path: actualPath(response), elapsedMs, actions: actionKinds(response.actions),
      blocks: actualBlockKinds(persistedBlocks),
      persistedBlocks,
      cards: response.composed?.length ?? 0, unsupportedClaim: result.verification,
      activityContextPresent: context.activityContextPresent,
      ...(jevEvidence ? { jev: jevEvidence } : {}),
    },
    assertions,
    passed,
    ...(result.diagnosis ? { diagnosis: result.diagnosis, error: result.error } : {}),
    response,
  });
  return {
    turn: turnNumber,
    caseId: item.id,
    sentence: item.sentence,
    path: result.evaluated.path,
    elapsedMs,
    actions: actionKinds(response.actions),
    blocks: actualBlockKinds(persistedBlocks),
    cards: response.composed?.length ?? 0,
    category: item.category,
    passed,
    assertions,
    proofPath,
    threadId: response.threadId,
    ...(result.diagnosis ? { diagnosis: result.diagnosis, error: result.error } : {}),
  };
}

async function prepareJev(): Promise<void> {
  const config = configFromCli();
  if (config.category !== "jev") throw new Error("--prepare-jev requires --category jev.");
  const harness = await openHarness(config.branch);
  const seed = await harness.seed();
  console.log(JSON.stringify(jevWarmPlan(harness, seed)));
}

async function printWarmingSnapshot(): Promise<void> {
  const config = configFromCli();
  if (config.category !== "jev") throw new Error("--warming-snapshot requires --category jev.");
  const harness = await openHarness(config.branch);
  console.log(JSON.stringify(await warmingSnapshot(harness.db, harness.userId)));
}

function recordWarming(): void {
  const config = configFromCli();
  if (config.category !== "jev") throw new Error("--record-warming requires --category jev.");
  const numeric = (name: string) => {
    const value = Number(option(name));
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number.`);
    return value;
  };
  const state = loadState(config) ?? newState(DEFAULT_SEED, config);
  const targetLine = option("--warm-target")?.trim();
  if (!targetLine) throw new Error("--warm-target is required.");
  state.warming = {
    foods: numeric("--warm-foods"),
    calls: numeric("--warm-calls"),
    costUsd: numeric("--warm-cost-usd"),
    targetLine,
  };
  saveState(state, config);
  printSummary(state, config);
}

async function runStreak(): Promise<void> {
  const config = configFromCli();
  const requestedSeed = option("--seed") ?? DEFAULT_SEED;
  const state = loadState(config) ?? newState(requestedSeed, config);
  if (state.seed !== requestedSeed && option("--seed")) {
    throw new Error(`State already uses seed ${state.seed}; refusing seed ${requestedSeed}.`);
  }
  if (state.status !== "running") {
    printSummary(state, config);
    process.exitCode = state.status === "success" ? 0 : 1;
    return;
  }
  if (state.failures.some((failure) => failure.status === "open")) {
    throw new Error("Resolve the open failure before restarting the streak.");
  }
  let harness: Awaited<ReturnType<typeof openHarness>>;
  try {
    harness = await openHarness(config.branch, needsActivityContext(config.category));
  } catch (error) {
    block(state, safeError(error));
    saveState(state, config);
    printSummary(state, config);
    process.exitCode = 1;
    return;
  }
  const seededContext = config.category === "meals"
    ? state.totalTurns === 0
      ? await harness.seed()
      : { remaining: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
          expectedWatermelonRefs: new Set<string>(), fixtures: new Map(),
          activityContextPresent: false }
    : undefined;
  while (state.totalTurns < config.turnLimit && state.streak < config.streakTarget) {
    let turn: TurnRecord;
    try {
      turn = await runCase(config, state, harness, seededContext);
    } catch (error) {
      block(state, safeError(error));
      saveState(state, config);
      printSummary(state, config);
      process.exitCode = 1;
      return;
    }
    state.turns.push(turn);
    state.totalTurns += 1;
    if (turn.passed) {
      state.streak += 1;
      console.log(`PASS ${turn.turn}/${config.turnLimit} ${turn.caseId} ${turn.path} `
        + `${turn.elapsedMs} ms streak=${state.streak}/${config.streakTarget}`);
      saveState(state, config);
      continue;
    }
    state.streak = 0;
    if (turn.error && isBranchOrKeyProblem(turn.error)) {
      block(state, turn.error);
    } else {
      state.failures.push(failureRecord(state, turn));
    }
    saveState(state, config);
    console.error(`FAIL ${turn.turn}/${config.turnLimit} ${turn.caseId}; proof=${turn.proofPath}`);
    for (const assertion of turn.assertions.filter((item) => !item.passed)) {
      console.error(`  ${assertion.name}: ${assertion.detail}`);
    }
    printSummary(state, config);
    process.exitCode = 1;
    return;
  }
  state.status = state.streak >= config.streakTarget
    && state.failures.every((failure) => failure.status === "resolved")
    ? "success" : "exhausted";
  if (config.category === "meals") state.providerSpend = await providerSpend(harness.db, harness.userId);
  saveState(state, config);
  if (has("--report")) console.log(reportMarkdown(state, config));
  else printSummary(state, config);
  process.exitCode = state.status === "success" ? 0 : 1;
}

type StoredTurnProof = {
  generatedAt: string;
  branch: string;
  seed: string;
  turn: number;
  case: CoachCase;
  actual: {
    path: "fast" | "llm";
    elapsedMs: number;
    actions: string[];
    blocks?: string[];
    persistedBlocks?: unknown[];
    cards: number;
    activityContextPresent?: boolean;
    unsupportedClaim: (Omit<VerificationRecord, "verifier"> & {
      verifier?: VerificationRecord["verifier"];
    }) | null;
  };
  assertions: Assertion[];
  passed: boolean;
  response: CoachTurnResponse;
  diagnosis?: "verifier_error";
  error?: string;
  reevaluatedAt?: string;
  evaluationMode?: "offline_stored_turn";
};

const GENERIC_ASSERTIONS = new Set([
  "C13 activity context present",
  "C13 device estimate wording",
  "C13 forbidden allowance wording",
  "C13 no numeric food allowance",
  "C13 no target mutation",
  "C13 logs-and-weight weekly proposal",
  "expected path",
  "expected action-kind set",
  "expected card-count range",
  "latency bound",
  "no unsupported action claim",
  "expected medical deflection",
  "not medically deflected",
  "reply verifier",
  "expected block-kind set",
  "expected block version",
  "expected chart subtype",
  "expected food-search intent",
  "expected quick-reply count",
  "persisted block proof",
]);

function loadStoredProofs(config: StreakRunConfig): StoredTurnProof[] {
  const names = readdirSync(config.turnDir)
    .filter((name) => /^turn-\d{3}-[a-z0-9-]+\.json$/.test(name))
    .sort();
  if (names.length === 0) throw new Error(`No stored turns in ${relativeToRoot(config.turnDir)}.`);
  return names.map((name, index) => {
    const proof = JSON.parse(readFileSync(resolve(config.turnDir, name), "utf8")) as StoredTurnProof;
    if (proof.turn !== index + 1 || !proof.case?.id || !proof.response || !proof.actual) {
      throw new Error(`Invalid stored turn proof: ${name}`);
    }
    return proof;
  });
}

function storedVerification(proof: StoredTurnProof): VerificationRecord | null {
  if (proof.diagnosis === "verifier_error") return null;
  const stored = proof.actual.unsupportedClaim;
  if (!stored || typeof stored.flagged !== "boolean") {
    throw new Error(`Turn ${proof.turn} has no stored reply-verifier result.`);
  }
  return {
    flagged: stored.flagged,
    p: stored.p,
    verifier: stored.verifier ?? (stored.p === null ? "heuristic" : "jev"),
  };
}

function correctedFailures(
  prior: StreakState,
  corpusById: Map<string, CoachCase>,
  turns: TurnRecord[],
): FailureRecord[] {
  const failures = prior.failures.map((failure): FailureRecord => {
    const item = corpusById.get(failure.caseId);
    if (!item?.note?.startsWith("argument-confidence rule:")) return { ...failure };
    return {
      ...failure,
      status: "resolved",
      diagnosis: "expectation corrected: argument-confidence rule",
      resolution: `${item.note}. Offline re-evaluation accepts the stored ${
        turns.find((turn) => turn.turn === failure.turn)?.path ?? "recorded"
      } path under its own latency bound.`,
      regressionTest: null,
    };
  });
  for (const turn of turns.filter((candidate) => !candidate.passed)) {
    const existing = failures.find((failure) => failure.turn === turn.turn);
    if (!existing) {
      failures.push(failureRecord({ ...prior, failures } as StreakState, turn));
    }
  }
  return failures;
}

function reevaluateStoredTurns(config: StreakRunConfig): StreakState {
  const prior = loadState(config);
  if (!prior) throw new Error(`No streak state at ${relativeToRoot(config.statePath)}.`);
  const corpus = loadCorpus();
  const corpusById = new Map(corpus.map((item) => [item.id, item]));
  const proofs = loadStoredProofs(config);
  const reevaluatedAt = new Date().toISOString();
  const turns = proofs.map((proof): TurnRecord => {
    const item = corpusById.get(proof.case.id);
    if (!item) throw new Error(`Stored turn ${proof.turn} has unknown case ${proof.case.id}.`);
    const verification = storedVerification(proof);
    const extras = proof.assertions.filter((assertion) => !GENERIC_ASSERTIONS.has(assertion.name));
    const blockEvidence = persistedBlockEvidence(proof.actual);
    const persistedBlocks = blockEvidence.persistedBlocks;
    const evaluated = verification
      ? evaluateTurn(item, proof.response, proof.actual.elapsedMs, verification, persistedBlocks,
          proof.actual.activityContextPresent === true)
      : {
          path: actualPath(proof.response),
          assertions: [{
            name: "reply verifier", passed: false,
            detail: proof.error ?? "stored verifier error",
          }],
          passed: false,
        };
    const assertions = [
      ...evaluated.assertions,
      blockEvidence.assertion,
      ...extras,
    ];
    const passed = assertions.every((assertion) => assertion.passed);
    const proofPath = writeTurnProof(config, proof.turn, item.id, {
      ...proof,
      case: item,
      actual: {
        path: actualPath(proof.response),
        elapsedMs: proof.actual.elapsedMs,
        actions: actionKinds(proof.response.actions),
        blocks: actualBlockKinds(persistedBlocks),
        ...(blockEvidence.assertion.passed ? { persistedBlocks } : {}),
        cards: proof.response.composed?.length ?? 0,
        activityContextPresent: proof.actual.activityContextPresent === true,
        unsupportedClaim: verification,
      },
      assertions,
      passed,
      reevaluatedAt,
      evaluationMode: "offline_stored_turn",
    });
    return {
      turn: proof.turn,
      caseId: item.id,
      sentence: item.sentence,
      path: evaluated.path,
      elapsedMs: proof.actual.elapsedMs,
      actions: actionKinds(proof.response.actions),
      blocks: actualBlockKinds(persistedBlocks),
      cards: proof.response.composed?.length ?? 0,
      category: item.category,
      passed,
      assertions,
      proofPath,
      ...(proof.diagnosis ? { diagnosis: proof.diagnosis, error: proof.error } : {}),
    };
  });
  let streak = 0;
  for (const turn of turns) streak = turn.passed ? streak + 1 : 0;
  const failures = correctedFailures(prior, corpusById, turns);
  const state: StreakState = {
    version: 1,
    seed: prior.seed,
    branch: config.branch,
    category: config.category,
    startedAt: prior.startedAt,
    updatedAt: reevaluatedAt,
    status: streak >= config.streakTarget && failures.every((failure) => failure.status === "resolved")
      ? "success" : turns.length >= config.turnLimit ? "exhausted" : "running",
    streak,
    totalTurns: turns.length,
    turns,
    failures,
    blockers: prior.blockers ?? [],
    ...(prior.warming ? { warming: prior.warming } : {}),
    evaluation: { mode: "offline", storedTurns: turns.length },
  };
  saveState(state, config);
  return state;
}

function offlineCommand(): boolean {
  const config = configFromCli();
  if (has("--reevaluate")) {
    const state = reevaluateStoredTurns(config);
    if (has("--report")) console.log(reportMarkdown(state, config));
    else printSummary(state, config);
    const everyFailureResolved = state.failures.every((failure) => failure.status === "resolved");
    process.exitCode = state.status === "success" && everyFailureResolved ? 0 : 1;
    return true;
  }
  if (reportRunsOffline(has("--report"), loadState(config))) {
    report();
    return true;
  }
  if (has("--resolve")) {
    resolveFailure();
    return true;
  }
  if (has("--resume-blocked")) {
    resumeBlocked();
    return true;
  }
  if (has("--record-warming")) {
    recordWarming();
    return true;
  }
  return false;
}

if (offlineCommand()) {
  // Offline commands intentionally need no branch credentials or provider calls.
} else if (!has(SERVER_CHILD_ARG)) {
  loadProviderKeys();
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    "--conditions=react-server",
    fileURLToPath(import.meta.url),
    SERVER_CHILD_ARG,
    ...process.argv.slice(2),
  ], { stdio: "inherit", env: process.env });
  if (child.error) console.error(safeError(child.error));
  process.exitCode = child.status ?? 1;
} else {
  const command = has("--prepare-jev") ? prepareJev()
    : has("--warming-snapshot") ? printWarmingSnapshot()
      : runStreak();
  void command.catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
