/**
 * The Jev fast path: an eligible intent (or the Plan sheet's structured request) answers without
 * Gemini — a chart, meal, snack or recipe suggestions, or one grounded action. Anything it cannot
 * finish becomes the model turn's hint, with the reason it fell through.
 */

import { actionsInScope } from "@/lib/coach/scope";
import { groundActions } from "@/lib/coach/actions";
import { hydrateRecipeResults, runDirectBlockTool } from "@/lib/coach/blocks";
import { hydrateFoodIdeas } from "@/lib/coach/blocks/hydrate-food-ideas";
import { validateToolCall } from "@/lib/coach/dispatch";
import type { RecipeSuggestionResult } from "@/lib/coach/executors";
import { isFastPathEligible, type ClassifiedIntentResult, type IntentFallbackReason }
  from "@/lib/coach/intent";
import type { SuggestionResult } from "@/lib/coach/suggest";
import { SUGGEST_RETRY_MESSAGE } from "@/lib/coach/suggest-messages";
import type { UiBlock } from "@/lib/coach/ui-blocks";
import { buildCoachContext } from "@/lib/server/coach-context";
import { applyGroundedActionPolicies } from "@/lib/server/coach-role-advice";
import { beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import { fastPathAction, fastPathReply, fastSuggestionReply }
  from "@/lib/server/coach-turn/fast-path-copy";
import type { IntentRead } from "@/lib/server/coach-turn/intent";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import { validatedBlocks, type TurnOutcome } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";
import { BY_APP, byJev, type Provenance } from "@/lib/provenance";

/** A Jev intent read chose the answer; the Plan sheet's structured request is the app's own. */
const JEV_INTENT: Provenance = byJev("coach-intent");
function suggestionProvenance(intent: IntentRead): Provenance {
  return intent.structuredPlan ? BY_APP : JEV_INTENT;
}

/** No fast path answered: the model turn runs, with this reason and the grounding already spent. */
export type FastPathMiss = { kind: "miss"; intentReason: IntentFallbackReason; preGroundMs: number };

type SuggestionArgs = NonNullable<IntentRead["structuredPlan"]>
  | ClassifiedIntentResult<"suggest_options">["args"];

/** Fast-path work, bounded by the reply deadline; late, it throws into the path's own catch. */
async function inTime<T>(turn: OpenTurn, kit: TurnKit, start: () => Promise<T>): Promise<T> {
  const result = await beforeDeadline(start, turn.replyDeadlineAt);
  if (result !== LATE) return result;
  kit.turnAbort.abort();
  throw new Error("the fast path ran out of time");
}

export async function runFastPath(
  turn: OpenTurn, kit: TurnKit, intent: IntentRead,
): Promise<TurnOutcome | FastPathMiss> {
  const { client, admin, userId, req, newId, today } = turn;
  const { profile, turnPorts } = kit;
  const { intentResult, intentMs, structuredPlan, recordIntent } = intent;
  let { intentReason } = intent;
  let preGroundMs = 0;

  // A Plan sheet photo or link carries its foods in `planSource`, and a refill its declined cards
  // in `planSkipped`; only the model turn reads them, so neither takes the fast path.
  if (!req.planSource && !req.planSkipped?.length && (structuredPlan || (intentResult && intentReason === "none"
    && isFastPathEligible(intentResult, req.text)))) {
    if (intentResult?.intent === "show_chart" && intentResult.args.chart) {
      return chartFastPath(turn, kit, intent, intentResult);
    }
    const mixedRecipeLog = /\b(?:log|logged|ate|eaten|had|track)\b/i.test(req.text)
      && /\b(?:find|search|show|suggest|ideas?|recommend|look for)\b/i.test(req.text);
    const suggestionArgs = mixedRecipeLog ? null : structuredPlan ?? (intentResult?.intent === "suggest_options"
      ? intentResult.args : null);
    if (suggestionArgs) {
      const validated = validateToolCall("suggest_options", {
        kind: suggestionArgs.kind,
        count: suggestionArgs.count ?? 3,
        fitRemaining: suggestionArgs.fitRemaining,
        ...(suggestionArgs.slot ? { slot: suggestionArgs.slot } : {}),
        ...(suggestionArgs.kind === "recipe" ? { wish: req.text.slice(0, 200) } : {}),
      });
      if (validated.ok) {
        return suggestionFastPath(turn, kit, intent, suggestionArgs, validated.args);
      } else {
        intentReason = "grounding";
      }
    }
    // The recipe widget never applies a coach action (it logs only through its own "Log it" tap),
    // so a mutating fast path there would only say "Logging…" over nothing.
    const candidate = intentResult && req.surface !== "recipes"
      ? fastPathAction(intentResult, today) : null;
    // Out of scope (lib/coach/scope.ts): no fast path; the model turn explains where it belongs.
    const input = candidate && actionsInScope([candidate], req.scope).length === 1 ? candidate : null;
    if (input && intentResult) {
      const groundStarted = Date.now();
      try {
        const { policy } = await inTime(turn, kit, async () => {
          const grounded = await groundActions(userId, [input], profile, {
            searchFoods: turnPorts.searchFoods,
            newActionId: newId,
            sameNameRefIds: async (uid, catalogName) => {
              const { sameNameRefIds } = await import("@/lib/server/catalog-names");
              return sameNameRefIds(client, admin, uid, catalogName);
            },
          });
          const policy = grounded.actions.length === 1 && grounded.clarifications.length === 0
            ? await applyGroundedActionPolicies(admin, userId, grounded.actions, profile)
            : null;
          return { grounded, policy };
        });
        if (policy) {
          preGroundMs = Date.now() - groundStarted;
          const actions = policy.actions;
          if (actions.length === 1 && policy.recipeRefusals.length === 0) {
            const content = [fastPathReply(actions[0]), ...policy.logNotices].join(" ");
            return {
              kind: "fast_path", content, messages: "plain", provenance: JEV_INTENT,
              toolCalls: {
                calls: [], actions, suggestions: [], composed: [],
                fastPath: true, intent: intentResult.intent,
              },
              telemetry: () => recordIntent(true, "none"),
              body: {
                suggestions: [], actions, draft: null, composed: [],
                fastPath: true,
                intent: intentResult.intent === "show_chart" ? undefined : intentResult.intent,
                deflected: false, toolsUsed: [],
                model: { provider: "gemini", modelId: "" },
                timings: { intent: intentMs, model: 0, ground: preGroundMs },
              },
            };
          }
        }
      } catch (error) {
        preGroundMs = Date.now() - groundStarted;
        console.error("coach action fast-path grounding failed", {
          error: error instanceof Error
            ? { name: error.name, message: error.message.slice(0, 300) }
            : { name: "UnknownError", message: "non-Error rejection" },
        });
      }
      intentReason = "grounding";
    }
  }
  return { kind: "miss", intentReason, preGroundMs };
}

async function chartFastPath(
  turn: OpenTurn, kit: TurnKit, intent: IntentRead,
  intentResult: ClassifiedIntentResult<"show_chart">,
): Promise<TurnOutcome> {
  const { client, admin, userId, req, deps, newId, clock, today } = turn;
  const { profile } = kit;
  const { intentMs, recordIntent } = intent;
  const groundStarted = Date.now();
  let block: UiBlock | null = null;
  let content = "I could not load that chart right now. Try again in a minute.";
  let ok = false;
  try {
    const chart = intentResult.args;
    const hydrated = await inTime(turn, kit, async () => {
      const chartContext = chart.chart === "macros_today"
        ? await buildCoachContext(admin, client, userId, clock, {
            intent: "question", message: req.text,
          })
        : null;
      return runDirectBlockTool("show_chart", chart, {
        admin, userId, date: today, tz: clock.tz, context: chartContext,
        profile, newId, ...deps.blocks,
      });
    });
    block = hydrated.block;
    ok = true;
    content = block?.kind === "chart"
      ? block.chart === "weight_trend" ? "Here is your weight trend."
        : block.chart === "kcal_week" ? "Here are your recent logged days."
          : "Here are today's macros."
      : ((hydrated.data as { message?: string }).message ?? content);
  } catch (error) {
    console.error("coach chart fast path failed", {
      error: error instanceof Error
        ? { name: error.name, message: error.message.slice(0, 300) }
        : { name: "UnknownError", message: "non-Error rejection" },
    });
  }
  const preGroundMs = Date.now() - groundStarted;
  const blocks = validatedBlocks(block);
  return {
    kind: "fast_path", content, messages: "full", provenance: JEV_INTENT,
    toolCalls: {
      calls: [{ name: "show_chart", ok }], actions: [], suggestions: [], composed: [], blocks,
      fastPath: true, intent: intentResult.intent,
    },
    telemetry: () => recordIntent(ok, ok ? "none" : "grounding"),
    body: {
      suggestions: [], actions: [], draft: null, composed: [],
      fastPath: true, deflected: false,
      toolsUsed: ["show_chart"],
      model: { provider: "gemini", modelId: "" },
      timings: { intent: intentMs, model: 0, ground: preGroundMs },
    },
  };
}

async function suggestionFastPath(
  turn: OpenTurn, kit: TurnKit, intent: IntentRead,
  suggestionArgs: SuggestionArgs, validatedArgs: unknown,
): Promise<TurnOutcome> {
  const { userId, newId } = turn;
  const { executors } = kit;
  const { intentMs, recordIntent } = intent;
  let preGroundMs = 0;
  const groundStarted = Date.now();
  try {
    const result = await inTime(turn, kit, () => executors.suggest_options(userId, validatedArgs));
    preGroundMs = Date.now() - groundStarted;
    if (suggestionArgs.kind === "recipe") {
      const found = result as RecipeSuggestionResult;
      const blocks = validatedBlocks(hydrateRecipeResults(newId(), found));
      const content = found.candidates.length
        ? `I found ${found.candidates.length} complete recipe${found.candidates.length === 1 ? "" : "s"} to review.`
        : found.noResultReasons[0] ?? "No complete recipe matched this request.";
      return {
        kind: "fast_path", content, messages: "full", provenance: suggestionProvenance(intent),
        toolCalls: { calls: [{ name: "suggest_options", ok: true }], actions: [],
          suggestions: [], composed: [], blocks, fastPath: true, intent: "suggest_options" },
        telemetry: () => recordIntent(true, "none"),
        body: { suggestions: [], actions: [], draft: null, composed: [],
          fastPath: true, intent: "suggest_options", deflected: false,
          toolsUsed: ["suggest_options"],
          model: { provider: "gemini", modelId: "" },
          timings: { intent: intentMs, model: 0, ground: preGroundMs } },
      };
    }
    const suggestionResult = Array.isArray(result) ? result as SuggestionResult : [];
    // Strip the executor's model-facing `toJSON` wrapper before persisting or returning the
    // cards; the phone contract keeps `composed` as an ordinary array.
    const composed = [...suggestionResult];
    const blocks = validatedBlocks(hydrateFoodIdeas(newId(), composed));
    const content = fastSuggestionReply(
      suggestionArgs.kind,
      suggestionArgs.fitRemaining,
      suggestionResult,
    );
    const calls = [{ name: "suggest_options", ok: true }];
    return {
      kind: "fast_path", content, messages: "full", provenance: suggestionProvenance(intent),
      toolCalls: {
        calls, actions: [], suggestions: [], composed, blocks,
        fastPath: true, intent: "suggest_options",
      },
      telemetry: () => recordIntent(true, "none"),
      body: {
        suggestions: [], actions: [], draft: null, composed,
        fastPath: true, intent: "suggest_options", deflected: false,
        toolsUsed: ["suggest_options"],
        model: { provider: "gemini", modelId: "" },
        timings: { intent: intentMs, model: 0, ground: preGroundMs },
      },
    };
  } catch (error) {
    preGroundMs = Date.now() - groundStarted;
    console.error("coach suggestion fast path failed", {
      error: error instanceof Error
        ? { name: error.name, message: error.message.slice(0, 300) }
        : { name: "UnknownError", message: "non-Error rejection" },
    });
    return {
      kind: "fast_path", content: SUGGEST_RETRY_MESSAGE, messages: "plain",
      provenance: suggestionProvenance(intent),
      toolCalls: {
        calls: [{ name: "suggest_options", ok: false }], actions: [], suggestions: [],
        composed: [], intent: "suggest_options",
      },
      telemetry: () => recordIntent(false, "grounding"),
      body: {
        suggestions: [], actions: [], draft: null, composed: [],
        intent: "suggest_options", deflected: false, toolsUsed: ["suggest_options"],
        model: { provider: "gemini", modelId: "" },
        timings: { intent: intentMs, model: 0, ground: preGroundMs },
      },
    };
  }
}
