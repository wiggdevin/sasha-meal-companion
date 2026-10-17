/**
 * W087 live coach pass: truncation share, off-plan leak/hang re-run, and the F10 prompt check, all
 * on the OpenRouter coach lane against a branch (never production).
 *
 * Bills real provider keys. Never run it in CI. Like coach-streak.ts it needs the branch-only
 * SUPABASE_TEST_* variables plus OPENROUTER_API_KEY / OPENROUTER_ATTESTED=1 / COACH_PROVIDER=openrouter
 * / GEMINI_API_KEY / TYPESAFE_API_KEY in the environment (nothing is read from argv), and it must run
 * under the react-server condition:
 *
 *   pnpm exec tsx --conditions=react-server scripts/eval/coach-live-pass.ts --mode <bulk|offplan|f10> --out <file.json>
 *
 * It uses the streak's dedicated branch test user, seeds it once (the streak's own reset), and never
 * creates, resets or destroys a branch. Every OpenRouter request is observed through a fetch wrapper:
 * the finish reason and token usage of each answer (truncation), and for `f10` the exact prompt text
 * that leaves the process (what a provider-side prompt log would hold). Prompt text is not stored; only
 * pattern findings are.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  openHarness, safeError, TIMEZONE,
} from "./coach-streak-harness";

type CallObs = {
  turn: number; status: number; elapsedMs: number; finishReason: string | null;
  completionTokens: number | null; promptTokens: number | null; costUsd: number | null;
  model: string | null; streamed: boolean; promptChars: number;
};
type TurnObs = {
  turn: number; label: string; sentence: string; elapsedMs: number; error: string | null;
  reply: string | null; actions: string[]; cards: number; model: string | null;
  timings: unknown; calls: CallObs[]; logs: string[];
};

const BULK_PROMPTS = [
  "What should I eat for dinner tonight? Give me three options with a short reason for each.",
  "Explain how my daily protein target works and what I could change over the next month.",
  "Plan a full day of meals for tomorrow with rough macros for each meal.",
  "I'm bored of chicken and rice. Give me five varied dinner ideas that fit my plan.",
  "How am I doing this week overall? Be specific about what went well and what to adjust.",
  "What are good high-protein snacks I can eat that are gluten free and dairy free?",
  "Give me a detailed grocery list for a week of lunches that fit my plan.",
  "Why might my weight go up and down from day to day? Keep it practical.",
  "Walk me through what I have left to eat today and suggest how to spend it.",
  "I have a long run on Saturday. How should I eat before, during and after it?",
  "What can I eat at a restaurant if the menu is mostly pasta and pizza?",
  "Suggest a no-cook breakfast I can prepare the night before.",
  "Can you explain what counts as ultra processed in my plan and why it is limited?",
  "Write me a short meal-prep plan for Sunday that covers Monday to Wednesday.",
  "I'm traveling for two days with only a hotel fridge. What can I pack?",
  "What does my plan say about fibre, and how do I get enough without upsetting my gut?",
  "Compare salmon and chicken for me: protein, fat and how often I could eat each.",
  "Give me a high-protein lunch under 500 calories with exact portions.",
  "What are some safe ways to add flavour without sauces that are off my plan?",
  "Help me decide between rice and sweet potato at dinner.",
  "How many meals per day does my plan use, and how should I space them on a late shift?",
  "Tell me everything I should know about eating enough protein on a recomp goal.",
  "What are three different snack ideas under 200 calories?",
  "I skipped lunch. How should I adjust the rest of my day?",
  "Can you list the foods I have marked as eats and suggest a meal from them?",
  "What should I do if I go over my calories one day?",
  "Give me a vegetarian dinner that still hits a decent amount of protein.",
  "How do I eat out at a burger place and stay on plan?",
  "Which of my foods are highest in protein per 100 grams?",
  "Make me a menu for a small birthday dinner that fits my plan.",
  "What can I drink besides water that still fits my plan?",
  "Suggest a post-workout meal and explain the timing.",
  "What is a sensible way to track my progress other than the scale?",
  "Give me a quick, simple breakfast idea using eggs.",
];

const OFFPLAN_PROMPTS = [
  "Can I have a bagel with cream cheese and a sliced apple for meal 1?",
  "I want a snack with cheddar cheese in it, what do you suggest?",
  "Search the food database for pizza and tell me if I'm allowed to have it.",
  "Can I eat a bowl of ice cream with honey tonight?",
  "Put a croissant with butter and jam in my breakfast.",
];
const OFFPLAN_REPEATS = 3;

/** Streak sentences that answered "I couldn't work that one out" in the 2026-10-17 run. */
const DIAG_PROMPTS = [
  "remove watermelon from avoid",
  "add tofu to my eats",
  "put eggs on my avoid list",
  "add Greek yogurt to my eats",
  "add salmon back to my eats list",
  "log a spaghetti bolognese as my snack",
];

/** Fragments that read as leaked internal field names, placeholders or JSON, not natural language. */
const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["baseline=", /\bbaseline\s*=/i],
  ["suggestions field", /\bsuggestions?\s*[:=]\s*[\[{]/i],
  ["empty array literal", /\[\s*\]/],
  ["json key", /"[A-Za-z_]{3,}"\s*:/],
  ["field name assignment", /\b(?:toolsUsed|composed|threadId|messageId|memoryOps|responseSchema)\b\s*[:=]/i],
  ["curly object", /\{\s*"?[A-Za-z_]+"?\s*:/],
  ["null/undefined token", /\b(?:undefined|NaN)\b|:\s*null\b/],
  ["prompt section marker", /<\/?(?:untrusted|context|system|instructions?|data)[^>]*>/i],
];

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const calls: CallObs[] = [];
const turnLogs = new Map<number, string[]>();
const capturedPrompts: string[] = [];
const rawResponses: Array<{ turn: number; text: string }> = [];
let currentTurn = 0;
let capturePrompts = false;

function sseSummary(text: string): {
  finishReason: string | null; completionTokens: number | null; promptTokens: number | null;
  costUsd: number | null; model: string | null;
} {
  let finishReason: string | null = null;
  let completionTokens: number | null = null;
  let promptTokens: number | null = null;
  let costUsd: number | null = null;
  let model: string | null = null;
  const bodies = text.trimStart().startsWith("{") ? [text] : text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  for (const body of bodies) {
    if (!body || body === "[DONE]") continue;
    try {
      const chunk = JSON.parse(body) as {
        model?: string;
        choices?: Array<{ finish_reason?: string | null }>;
        usage?: { completion_tokens?: number; prompt_tokens?: number; cost?: number };
      };
      model = chunk.model ?? model;
      for (const choice of chunk.choices ?? []) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        costUsd = typeof chunk.usage.cost === "number" ? chunk.usage.cost : costUsd;
      }
    } catch { /* ignore a malformed chunk */ }
  }
  return { finishReason, completionTokens, promptTokens, costUsd, model };
}

function installFetchObserver(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/^https:\/\/openrouter\.ai\//.test(url)) return realFetch(input, init);
    const started = Date.now();
    let promptChars = 0;
    let streamed = false;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as {
          stream?: boolean; messages?: Array<{ content?: unknown }>;
        };
        streamed = parsed.stream === true;
        const text = (parsed.messages ?? []).map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        promptChars = text.length;
        if (capturePrompts) capturedPrompts.push(text);
      } catch { /* not JSON */ }
    }
    const response = await realFetch(input, init);
    const turn = currentTurn;
    void response.clone().text().then((text) => {
      if (process.env.COACH_LIVE_PASS_RAW) rawResponses.push({ turn, text });
      calls.push({
        turn, status: response.status, elapsedMs: Date.now() - started, streamed, promptChars,
        ...sseSummary(text),
      });
    }).catch(() => {
      calls.push({
        turn, status: response.status, elapsedMs: Date.now() - started, streamed, promptChars,
        finishReason: null, completionTokens: null, promptTokens: null, costUsd: null, model: null,
      });
    });
    return response;
  }) as typeof fetch;
}

/** Keep the server's own error/warn lines per turn (the coach never logs prompts or bodies). */
function installConsoleObserver(): void {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const line = args.map((arg) => typeof arg === "string" ? arg : (() => {
        try { return JSON.stringify(arg); } catch { return String(arg); }
      })()).join(" ").slice(0, 400);
      const list = turnLogs.get(currentTurn) ?? [];
      list.push(`${level}: ${safeError(line)}`);
      turnLogs.set(currentTurn, list);
      original(...args);
    };
  }
}

function leakFindings(reply: string): string[] {
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(reply)).map(([name]) => name);
}

async function main(): Promise<void> {
  const mode = option("--mode");
  const out = option("--out");
  if (!mode || !["bulk", "offplan", "f10", "diag"].includes(mode)) throw new Error("--mode must be bulk, offplan, f10 or diag.");
  if (!out) throw new Error("--out is required.");
  installFetchObserver();
  installConsoleObserver();
  capturePrompts = mode === "f10";
  const harness = await openHarness("coach-eval", true);
  await harness.seed();
  const { runTurn } = await import("@/lib/server/coach-turn");
  const { COACH_MODEL_ID, COACH_PROVIDER } = await import("@/lib/ai/models");
  if (COACH_PROVIDER !== "openrouter") throw new Error("COACH_PROVIDER is not openrouter; refusing a run on the wrong lane.");

  const plan: Array<{ label: string; sentence: string }> = mode === "bulk"
    ? BULK_PROMPTS.map((sentence, index) => ({ label: `bulk-${index + 1}`, sentence }))
    : mode === "diag"
      ? DIAG_PROMPTS.map((sentence, index) => ({ label: `diag-${index + 1}`, sentence }))
    : mode === "offplan"
      ? Array.from({ length: OFFPLAN_REPEATS }, (_, rep) => OFFPLAN_PROMPTS.map((sentence, index) => ({
        label: `offplan-${index + 1}-r${rep + 1}`, sentence,
      }))).flat()
      : [
        { label: "f10-plain-question", sentence: "what should I eat next?" },
        { label: "f10-control-weight-question", sentence: "what is my current weight and target?" },
        { label: "f10-control-calorie-question", sentence: "how many calories should I eat on a rest day?" },
        { label: "f10-control-update-profile", sentence: "update my profile: my goal is maintain" },
        { label: "f10-control-log-weight", sentence: "log my weight 61 kg" },
        { label: "f10-control-weigh-in", sentence: "I weighed in at 61.2 this morning, please record it" },
      ];

  const turns: TurnObs[] = [];
  for (const [index, item] of plan.entries()) {
    currentTurn = index + 1;
    // 10 coach turns an hour per user is the limiter working, not the thing under test: clear only
    // this branch test user's counters before each turn.
    const cleared = await harness.db.from("rate_limits").delete()
      .like("key", `coach:turn:%:user:${harness.userId}`);
    if (cleared.error) throw new Error(`rate_limits reset: ${cleared.error.message}`);
    // Every probe turn opens a fresh chat (threadId null); eight chats is the per-user cap, so drop
    // this test user's chats between turns. Branch test user only.
    const chats = await harness.db.from("coach_threads").delete().eq("user_id", harness.userId);
    if (chats.error) throw new Error(`coach_threads reset: ${chats.error.message}`);
    const started = Date.now();
    let error: string | null = null;
    let response: Awaited<ReturnType<typeof runTurn>> | null = null;
    try {
      response = await runTurn(harness.client, harness.db, harness.userId, {
        threadId: null, messageId: randomUUID(), text: item.sentence,
        now: new Date().toISOString(), tz: TIMEZONE,
      });
    } catch (thrown) {
      error = safeError(thrown);
    }
    const elapsedMs = Date.now() - started;
    // Let the observer's cloned bodies finish before this turn's calls are counted.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reply = response?.messages.findLast((message) => message.role === "assistant")?.content ?? null;
    turns.push({
      turn: index + 1, label: item.label, sentence: item.sentence, elapsedMs, error, reply,
      actions: response?.actions.map((action) => action.kind) ?? [],
      cards: response?.composed?.length ?? 0,
      model: response ? `${response.model?.provider}/${response.model?.modelId}` : null,
      timings: response?.timings ?? null,
      calls: calls.filter((call) => call.turn === index + 1),
      logs: turnLogs.get(index + 1) ?? [],
    });
    console.log(`${item.label} ${elapsedMs} ms calls=${turns.at(-1)?.calls.length} `
      + `finish=${turns.at(-1)?.calls.map((call) => call.finishReason).join(",")}${error ? ` ERROR ${error.slice(0, 120)}` : ""}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const turn of turns) turn.calls = calls.filter((call) => call.turn === turn.turn);

  const aiCalls = await harness.db.from("ai_calls")
    .select("purpose,provider,model_id,status,input_tokens,output_tokens,latency_ms,cost_estimate,error")
    .eq("user_id", harness.userId).order("created_at", { ascending: true });
  const result: Record<string, unknown> = {
    generatedAt: new Date().toISOString(), mode, branch: "coach-eval",
    coachProvider: COACH_PROVIDER, coachModel: COACH_MODEL_ID, turns,
    aiCalls: aiCalls.error ? { error: aiCalls.error.message } : aiCalls.data,
  };
  if (mode === "offplan") {
    result.leaks = turns.map((turn) => ({
      label: turn.label, findings: turn.reply ? leakFindings(turn.reply) : ["no reply"],
    }));
  }
  let gateControl: Record<string, unknown> | null = null;
  if (mode === "f10") {
    // Positive control at the context builder itself (the real code the turn calls): the same
    // saved profile must reach the rendered context for a weight intent and stay out for a plain
    // question. This proves the scan below can see a profile when one is sent.
    const { buildCoachContext, renderCoachContext } = await import("@/lib/server/coach-context");
    const clock = { now: new Date().toISOString(), tz: TIMEZONE, date: new Date().toISOString().slice(0, 10) };
    const render = async (intent: "log_weight" | "question", message: string) =>
      renderCoachContext(await buildCoachContext(harness.db, harness.client, harness.userId, clock, { intent, message }));
    const weightIntent = await render("log_weight", "log my weight 61");
    const plainQuestion = await render("question", "what should I eat next?");
    gateControl = {
      logWeightHasProfileLine: /Profile: /.test(weightIntent) && /\b60 kg\b/.test(weightIntent),
      plainQuestionHasProfileLine: /Profile: /.test(plainQuestion) || /\b60 kg\b/.test(plainQuestion),
    };
  }
  if (mode === "f10") {
    // One prompt per OpenRouter request; the plain question is the first turn's requests.
    const firstTurnCalls = calls.filter((call) => call.turn === 1).length;
    const plainPrompts = capturedPrompts.slice(0, firstTurnCalls);
    const controlPrompts = capturedPrompts.slice(firstTurnCalls);
    const RAW_WEIGHT = [/\b60(?:\.0)?\s*kg\b/i, /weight_kg/i, /\b59\.[2-9]\b/, /\b60\.0\b/, /^Profile:/m, /Profile:/, /"profile"/i, /\bkg\b/];
    const scan = (prompts: string[]) => RAW_WEIGHT.map((pattern) => ({
      pattern: pattern.source, matches: prompts.filter((prompt) => pattern.test(prompt)).length,
    }));
    result.f10 = {
      plainQuestionRequests: plainPrompts.length,
      plainQuestionRawWeight: scan(plainPrompts),
      controlRequests: controlPrompts.length,
      controlRawWeight: scan(controlPrompts),
      plainFenced: plainPrompts.some((prompt) => /untrusted/i.test(prompt)),
      plainMentionsConditions: plainPrompts.some((prompt) => /colitis/i.test(prompt)),
      gateControl,
      profileSnippets: controlPrompts.map((prompt) => { const at = prompt.search(/Profile:|"profile"/i); return at < 0 ? null : prompt.slice(Math.max(0, at - 20), at + 120); }),
      promptChars: { plain: plainPrompts.map((prompt) => prompt.length), control: controlPrompts.map((prompt) => prompt.length) },
    };
  }
  if (process.env.COACH_LIVE_PASS_RAW) writeFileSync(process.env.COACH_LIVE_PASS_RAW, JSON.stringify(rawResponses));
  // Optional raw dump of the captured prompts (test-user data only) for manual inspection.
  if (process.env.COACH_LIVE_PASS_DUMP) writeFileSync(process.env.COACH_LIVE_PASS_DUMP, JSON.stringify(capturedPrompts));
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
