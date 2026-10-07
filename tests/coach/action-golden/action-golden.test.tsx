/**
 * Golden outputs for every per-kind coach-action surface, recorded BEFORE the ActionSpec registry
 * (lib/coach/actions/*) replaced the hand-kept switches and field lists. The provider schema, the
 * prompt and the card copy must stay byte-identical; a parse, grounding or history change shows up
 * as a diff against `__golden__/`. Update a golden file only for a deliberate behaviour change.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));
vi.mock("@/lib/ai/typesafe", () => ({
  choice: (instructions: string, criteria: Record<string, string>) => ({
    type: "choice", instructions, criteria,
  }),
  noul: (instructions: string, criteria?: Record<string, string>) => ({
    type: "noul", instructions, ...(criteria ? { criteria } : {}),
  }),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

import CoachActionCard, { actionMacroStrip, actionTitle, type CoachActionStatus }
  from "@/components/CoachActionCard";
import { toGeminiSchema } from "@/lib/ai/json-schema";
import {
  ACTION_KINDS, coachActionSchema, coachActionWireSchemaFor, flatCoachActionSchema,
  groundedCoachActionSchema, providerActionSchema,
} from "@/lib/coach/actions";
import { groundActions, groundAndExpandActions } from "@/lib/coach/ground";
import { actionLine } from "@/lib/coach/history";
import { classifyIntent, type ClassifiedIntentResult } from "@/lib/coach/intent";
import { buildSystemPrompt } from "@/lib/coach/prompt";
import { turnStepProviderSchema } from "@/lib/coach/wire";
import { fastPathAction, fastPathReply } from "@/lib/server/coach-turn/fast-path-copy";
import {
  REPLAY_SAMPLES, SAMPLE_ACTIONS, STRICT_SAMPLES, TODAY, UNKNOWN_ACTION, WIRE_SAMPLES,
} from "@/tests/coach/action-golden/corpus";
import { GROUND_SAMPLES, groundPorts } from "@/tests/coach/action-golden/ground-corpus";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const GOLDEN = "./__golden__";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** `birthYear` is bounded by the current year, which must not age the golden file. */
const yearless = (text: string) => text.replaceAll(String(new Date().getFullYear()), "<YEAR>");
/**
 * The lenient parse schema is never sent anywhere: it only reads a reply, and the strict schema
 * re-orders the result. Its JSON is compared with sorted keys, which is the same schema.
 */
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, key === "required" && Array.isArray(item)
        ? [...item].sort() : sorted(item)]))
    : value;
const parsed = (schema: z.ZodType, samples: unknown[]) => samples.map((input) => {
  const result = schema.safeParse(input);
  return result.success ? { ok: true, data: result.data } : { ok: false };
});

describe("action registry golden: the wire", () => {
  it("keeps the provider action schema byte-identical", async () => {
    await expect(JSON.stringify(toGeminiSchema(providerActionSchema), null, 2))
      .toMatchFileSnapshot(`${GOLDEN}/provider-action.json`);
    await expect(JSON.stringify(toGeminiSchema(turnStepProviderSchema), null, 2))
      .toMatchFileSnapshot(`${GOLDEN}/provider-turn-step.json`);
    await expect(yearless(JSON.stringify(z.toJSONSchema(providerActionSchema), null, 2)))
      .toMatchFileSnapshot(`${GOLDEN}/provider-action.zod.json`);
  });

  it("keeps the lenient parse schema and the kind list", async () => {
    await expect(yearless(JSON.stringify(sorted(z.toJSONSchema(flatCoachActionSchema)), null, 2)))
      .toMatchFileSnapshot(`${GOLDEN}/flat-action.json`);
    await expect(json(ACTION_KINDS)).toMatchFileSnapshot(`${GOLDEN}/kinds.json`);
  });

  it("parses every wire sample the same way", async () => {
    await expect(json(parsed(coachActionWireSchemaFor(TODAY), WIRE_SAMPLES)))
      .toMatchFileSnapshot(`${GOLDEN}/wire-parse.json`);
  });

  it("parses every strict and replayed sample the same way", async () => {
    await expect(json(parsed(coachActionSchema, [...STRICT_SAMPLES, ...WIRE_SAMPLES])))
      .toMatchFileSnapshot(`${GOLDEN}/strict-parse.json`);
    await expect(json(parsed(groundedCoachActionSchema, REPLAY_SAMPLES)))
      .toMatchFileSnapshot(`${GOLDEN}/replay-parse.json`);
  });
});

describe("action registry golden: the server", () => {
  it("keeps the system prompt byte-identical", async () => {
    const ctx = {
      constraints: { ...TEST_PROFILE, conditions: ["ulcerative colitis"], notes: "no spice" },
      today: TODAY,
    };
    await expect(buildSystemPrompt(ctx)).toMatchFileSnapshot(`${GOLDEN}/prompt.txt`);
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    try {
      await expect(buildSystemPrompt({ ...ctx, today: "2027-02-27" }))
        .toMatchFileSnapshot(`${GOLDEN}/prompt-activity.txt`);
    } finally { vi.unstubAllEnvs(); }
  });

  it("grounds every sample the same way", async () => {
    const one = await Promise.all(GROUND_SAMPLES.map(async (input) =>
      groundAndExpandActions("u1", [input], TEST_PROFILE, groundPorts())));
    const batch = await groundActions("u1", GROUND_SAMPLES, TEST_PROFILE, groundPorts());
    const noEntries = await groundActions("u1", GROUND_SAMPLES.filter((input) =>
      input.kind === "delete_entry" || input.kind === "move_entry"), TEST_PROFILE,
    groundPorts({ knownEntries: undefined }));
    const noWiden = await groundActions("u1", [{ kind: "add_to_avoid", name: "watermelon" }],
      TEST_PROFILE, groundPorts({ sameNameRefIds: undefined }));
    await expect(json({ one, batch, noEntries, noWiden }))
      .toMatchFileSnapshot(`${GOLDEN}/ground.json`);
  });

  it("renders the same history line for every kind", async () => {
    await expect(json(SAMPLE_ACTIONS.map(actionLine))).toMatchFileSnapshot(`${GOLDEN}/history.json`);
  });

  it("keeps the fast-path mapping and copy", async () => {
    const result = (intent: string, args: Record<string, unknown>) =>
      ({ intent, confidence: 0.99, args, argConfidence: {}, raw: {} }) as ClassifiedIntentResult;
    const intents = [
      result("shift_schedule", { minutes: 30, direction: "later", scope: "remaining" }),
      result("shift_schedule", { minutes: 45, direction: "earlier", scope: "all" }),
      result("shift_schedule", { minutes: 30, direction: "later", scope: "one_slot" }),
      result("shift_schedule", { direction: "later", scope: "all" }),
      result("shift_schedule", { minutes: 0, direction: "later", scope: "all" }),
      result("add_to_eats", { name: "salmon" }), result("add_to_avoid", { name: "cake" }),
      result("remove_from_eats", { name: "salmon" }), result("remove_from_avoid", { name: "x" }),
      result("add_to_avoid", { missing: ["name"] }),
      result("log_water", { ml: 480.4 }), result("log_water", {}), result("log_water", { ml: 9000 }),
      result("log_weight", { kg: 58.06 }), result("log_weight", {}),
      result("log_food", { foodsMentioned: ["eggs"] }), result("update_profile", {}),
      result("suggest_options", { kind: "meal", count: 3, fitRemaining: false }),
    ];
    await expect(json({
      actions: intents.map((value) => fastPathAction(value, TODAY)),
      replies: [...SAMPLE_ACTIONS, UNKNOWN_ACTION].map(fastPathReply),
    })).toMatchFileSnapshot(`${GOLDEN}/fast-path.json`);
  });
});

describe("action registry golden: the intent pre-pass", () => {
  beforeEach(() => { vi.stubEnv("TYPESAFE_API_KEY", "test-key"); systemOneMock.mockReset(); });
  afterEach(() => vi.unstubAllEnvs());

  const choice = (value: string, confidence = 0.97) =>
    ({ type: "choice", choice: value, probabilities: { [value]: confidence }, confidence });
  const answers = (intent: string, over: Record<string, unknown> = {}) => ({
    intent: choice(intent, 0.96), direction: choice("later", 0.98), scope: choice("remaining", 0.94),
    suggest_kind: choice("meal", 0.9), suggest_count: choice("3", 0.9),
    suggest_slot: choice("none", 0.99), fit_remaining: { type: "noul", noul: 0.1 },
    mentions_specific_foods: { type: "noul", noul: 0.1 }, mentions_size: { type: "noul", noul: 0.1 },
    ...over,
  });
  const cases: [string, string, Record<string, unknown>?, string[]?][] = [
    ["shift_schedule", "move my meals 30 minutes"],
    ["shift_schedule", "move my meals an hour earlier", { direction: choice("earlier") }],
    ["shift_schedule", "move lunch by 20 min", { scope: choice("one_slot") }],
    ["shift_schedule", "move everything later"],
    ["shift_schedule", "move 2 meals by 30 min", { which_number: choice("30 min", 0.8) }],
    ["log_water", "I drank 2 cups of water"], ["log_water", "drank 500 ml"],
    ["log_water", "16 oz water"], ["log_water", "drank some water"],
    ["log_water", "2 cups then 500 ml", { which_number: choice("500 ml", 0.95) }],
    ["log_water", "drank 3 glasses"],
    ["log_weight", "I weigh 128 lb"], ["log_weight", "58 kg today"], ["log_weight", "weighed in"],
    ["add_to_eats", "add salmon to my eats", {}, ["salmon"]],
    ["add_to_avoid", "avoid cake", {}, ["", " cake "]], ["remove_from_eats", "drop it", {}, []],
    ["remove_from_avoid", "unavoid watermelon", {}, ["watermelon"]],
    ["update_profile", "I am 34"], ["set_targets", "set kcal to 2300"],
  ];

  it("extracts the same arguments for every action intent", async () => {
    const results = [];
    for (const [intent, message, over, foodsMentioned] of cases) {
      systemOneMock.mockResolvedValueOnce(answers(intent, over));
      results.push(await classifyIntent(message, {
        now: "2026-09-19T10:00:00-06:00", userId: "u1",
        ...(foodsMentioned ? { foodsMentioned } : {}),
      }));
    }
    await expect(json(results)).toMatchFileSnapshot(`${GOLDEN}/intent.json`);
  });
});

describe("action registry golden: the card", () => {
  it("renders the same copy for every kind and status", async () => {
    const statuses: CoachActionStatus[] = ["pending", "applied", "failed", "undoing", "undone"];
    const rows = [...SAMPLE_ACTIONS, UNKNOWN_ACTION].map((action) => ({
      kind: action.kind, title: actionTitle(action), strip: actionMacroStrip(action),
      html: statuses.map((status) => renderToStaticMarkup(createElement(CoachActionCard, {
        action, status, canUndo: status === "failed" || status === "applied", reason: status === "failed" ? "No." : undefined,
        onRetry: () => {}, onUndo: () => {},
      }))),
    }));
    await expect(json(rows)).toMatchFileSnapshot(`${GOLDEN}/card.json`);
  });
});
