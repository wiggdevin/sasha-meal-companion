/**
 * One batch of the model's tool calls. The calls run TOGETHER — they are reads (spec: tools_ran is
 * read-only), so none depends on another; one after another, three search_foods cost ~16 s of a
 * 43 s turn on 2026-09-23. Their outcomes are then applied in the order the model asked for them,
 * so the transcript, the first block and the evidence map read exactly as they did when sequential.
 */

import { hydrateResolvedTool, isDirectBlockTool, runDirectBlockTool } from "@/lib/coach/blocks";
import type { ComposedMeal } from "@/lib/coach/compose";
import { validateToolCall, type ArgIssue, type ToolResult } from "@/lib/coach/dispatch";
import { renderToolResult, wrapUntrusted } from "@/lib/coach/envelope";
import type { DraftResult, FoodHit } from "@/lib/coach/executors";
import { lookupSourcesOf } from "@/lib/coach/lookup-sources";
import { allergenFacts } from "@/lib/coach/policy";
import { filterRecipeMeal, recipeToolResult } from "@/lib/coach/recipe-policy";
import { lookupTool, type ToolName } from "@/lib/coach/registry";
import { collectComposed } from "@/lib/coach/turn";

/** The explanation suggest_options attaches to an empty result (lib/coach/suggest.ts messageResult). */
function emptySuggestMessage(data: unknown): string | null {
  if (!Array.isArray(data) || data.length > 0) return null;
  const message = (data as unknown[] & { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}
import type { UiBlock } from "@/lib/coach/ui-blocks";
import { HttpError } from "@/lib/server/auth";
import { beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import type { ModelEnv, ModelState } from "@/lib/server/coach-turn/model-state";
import { validatedBlocks } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

const GENERIC_TOOL_FAILURE = "that lookup failed";

type ToolOutcome =
  | { kind: "invalid"; name: string; error: string; issues?: ArgIssue[] }
  | { kind: "failed"; name: string; message: string; errorName: string; status?: number }
  | { kind: "ok"; name: string; data: unknown; resolvedData: unknown; persistResult: boolean;
      block: UiBlock | null };

async function runTool(
  turn: OpenTurn, kit: TurnKit, env: ModelEnv, state: ModelState,
  call: { name: string; args: unknown },
): Promise<ToolOutcome> {
  const { userId, deps } = turn;
  const { profile, executors } = kit;
  const { blockContext } = env;
  const validated = validateToolCall(call.name, call.args);
  if (!validated.ok) return { kind: "invalid", name: call.name, error: validated.error, issues: validated.issues };
  const name = validated.tool.name;
  // A tool that throws must not escape the turn. Before this, a catalog 503 (or any
  // transient read failure) propagated out of runTurn, past every write below, so the
  // thread row created at the top of the turn was left with zero messages and the client
  // could not load it again — the "stale thread 404 on retry" of 2026-09-13. The model is
  // told the tool failed, in the same shape a validation failure uses, and gets to answer
  // from what it already has.
  try {
    if (isDirectBlockTool(name)) {
      const hydrateStarted = Date.now();
      const hydrated = await runDirectBlockTool(name, validated.args, blockContext);
      state.groundMs += Date.now() - hydrateStarted;
      return { kind: "ok", name, data: hydrated.data, resolvedData: undefined,
        persistResult: hydrated.block !== null, block: hydrated.block };
    }
    const executorArgs = name === "search_foods"
      ? { ...(validated.args as object), limit:
          Math.min(11, ((validated.args as { limit?: number }).limit ?? 5) + 1) }
      : validated.args;
    const raw = await executors[name as ToolName](userId, executorArgs);
    const hydrateStarted = Date.now();
    const recipe = name === "compose_meal"
      ? await filterRecipeMeal(userId, raw as ComposedMeal, profile,
          { acceptAllowedGrounding: deps.ports?.compose !== undefined })
      : null;
    const resolvedData = recipe ? recipe.meal : raw;
    const hydrated = recipe?.meal === null
      ? { block: null, data: { ok: true, block: "food_ideas", ideas: [] } }
      : hydrateResolvedTool(name, validated.args, resolvedData, blockContext);
    state.groundMs += Date.now() - hydrateStarted;
    return {
      kind: "ok", name, resolvedData,
      data: recipe ? recipeToolResult(hydrated.data, recipe.refusals) : hydrated.data,
      persistResult: hydrated.block !== null || (recipe?.refusals.length ?? 0) > 0,
      block: hydrated.block,
    };
  } catch (e) {
    // HttpError messages are already the user-facing text the API returns, so they are
    // safe to hand the model; anything else could carry internals and is generalised.
    console.error("coach tool failed", {
      tool: name,
      error: e instanceof Error
        ? { name: e.name, message: e.message.slice(0, 300) }
        : { name: "UnknownError", message: "non-Error rejection" },
    });
    return { kind: "failed", name, message: e instanceof HttpError ? e.message : GENERIC_TOOL_FAILURE,
      errorName: e instanceof Error ? e.name : "UnknownError",
      ...(e instanceof HttpError ? { status: e.status } : {}) };
  }
}

/** After this many calls with bad arguments, a tool is refused for the rest of the turn. */
const MAX_INVALID_CALLS = 2;

/**
 * The registry's per-turn cap, enforced (2026-10-01): it was declared on every tool and read by
 * nothing, so the model ran suggest_options twice into the 30 s wall and retried a failing one
 * seven times, and sent draft_log_entry with no items nine times. A call past the cap is not run;
 * the model is told why, in the shape a validation failure uses, and answers with what it has.
 */
function refusal(state: ModelState, call: { name: string; args: unknown }): ToolOutcome | null {
  const tool = lookupTool(call.name);
  if (!tool) return null;
  const runs = state.toolRuns[call.name] ??= { ran: 0, invalid: 0 };
  if (runs.ran >= tool.maxCallsPerTurn) {
    return { kind: "invalid", name: call.name, error: `already called ${call.name} ${runs.ran} `
      + `time${runs.ran === 1 ? "" : "s"} this turn; answer with what you have` };
  }
  if (runs.invalid >= MAX_INVALID_CALLS) {
    return { kind: "invalid", name: call.name, error: `already called ${call.name} with bad `
      + "arguments twice this turn; ask the person for what is missing instead" };
  }
  if (validateToolCall(call.name, call.args).ok) runs.ran += 1; else runs.invalid += 1;
  return null;
}

/** Runs one batch and applies it; "late" when the loop's budget ran out first. */
export async function runToolBatch(
  turn: OpenTurn, kit: TurnKit, env: ModelEnv, state: ModelState,
  calls: { name: string; args: unknown }[],
): Promise<"applied" | "late"> {
  const { realStartedAt } = turn;
  const { turnAbort, wallClockBudgetMs } = kit;
  state.used += calls.length;
  // The batch is bounded by the loop's budget like a model call is (review r1, BLOCK 1): a tool
  // still running then is left to finish unobserved — runTool never rejects — and the turn ends.
  const batch = calls.map((call) => ({ call, refused: refusal(state, call) }));
  const outcomes = await beforeDeadline(
    () => Promise.all(batch.map(({ call, refused }) => refused
      ? Promise.resolve(refused) : runTool(turn, kit, env, state, call))),
    realStartedAt + wallClockBudgetMs);
  if (outcomes === LATE) {
    turnAbort.abort();
    state.step = { kind: "abort", reason: "wall_clock" };
    return "late";
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "invalid") {
      state.toolCalls.push({ name: outcome.name, ok: false, error: outcome.error,
        failure: outcome.issues ? { kind: "invalid_args", args: outcome.issues }
          : lookupTool(outcome.name) ? { kind: "refused" } : { kind: "unknown_tool" } });
      state.transcript.push(renderToolResult(
        { name: outcome.name as ToolName, ok: false, error: outcome.error }));
      continue;
    }
    const name = outcome.name;
    if (!state.toolsUsed.includes(name)) state.toolsUsed.push(name);
    if (outcome.kind === "failed") {
      state.toolCalls.push({ name, ok: false, error: outcome.message,
        failure: { kind: "threw", errorName: outcome.errorName,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}) } });
      // A refusal written for the person (an HttpError, e.g. "Review your existing food rules
      // before getting recipe suggestions.") is the honest reply; the generic line is not.
      if (name === "suggest_options" && outcome.message !== GENERIC_TOOL_FAILURE) {
        state.suggestMessage = outcome.message;
      }
      state.transcript.push(renderToolResult({ name: name as ToolName, ok: false, error: outcome.message }));
      continue;
    }
    const { data, resolvedData, persistResult } = outcome;
    state.toolCalls.push(persistResult ? { name, ok: true, result: data } : { name, ok: true });
    if (state.blocks.length === 0 && outcome.block) state.blocks = validatedBlocks(outcome.block);
    const internalData = resolvedData ?? data;
    if (name === "draft_log_entry") state.draft = (internalData as DraftResult).draft;
    if (name === "lookup") {
      state.lookupSources = [...state.lookupSources, ...lookupSourcesOf(internalData)];
    }
    if (!(name === "compose_meal" && resolvedData === null)) {
      state.composed = collectComposed(state.composed, name, internalData);
    }
    if (name === "suggest_options") state.suggestMessage = emptySuggestMessage(internalData);
    if (name === "get_entries") {
      for (const entry of (internalData as { entryId?: string; name?: string; at?: string }[]) ?? []) {
        if (entry.entryId) state.seenEntries.set(entry.entryId, `${entry.name ?? "an entry"} at ${entry.at ?? "?"}`);
      }
    }
    if (name === "search_foods") {
      for (const hit of internalData as FoodHit[]) {
        state.evidence[hit.name] = {
          foodRefId: hit.foodRefId, allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit),
          category: hit.category ?? null, onEatsList: hit.prefStatus === "eats",
          onAvoidList: hit.prefStatus === "avoid",
        };
      }
    }
    const result: ToolResult = { name: name as ToolName, ok: true, data: wrapUntrusted(data) };
    state.transcript.push(renderToolResult(result));
  }
  return "applied";
}
