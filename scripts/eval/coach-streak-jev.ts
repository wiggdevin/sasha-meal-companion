import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction } from "@/lib/coach/actions";
import { applyLogEntry } from "@/lib/server/log";
import { FACET_THRESHOLDS } from "@/lib/foods/facet-thresholds";
import type { CoachCase, Assertion } from "./coach-streak-state";
import {
  ITEM_SANITY_WARNING_STATUS, type JevExpectation,
} from "./coach-streak-jev-contract";
import type { LiveHarness, SeedContext } from "./coach-streak-harness";

type JsonObject = Record<string, unknown>;
type Membership = { status: string | null; role: string | null } | null;

export type JevCaseContext = {
  expectation: JevExpectation;
  aiCallIdsBefore: string[];
  membershipBefore: Membership;
  roleFoodRefId: string | null;
};

export type JevPersistedEvidence = {
  assistantContent: string;
  toolCalls: JsonObject;
  actions: CoachAction[];
  blocks: unknown[];
  commit: JsonObject | null;
  logEntry: { id: string; grams: number[] } | null;
  rankingPurposes: string[];
  membershipBefore: Membership;
  membershipAfter: Membership;
};

export type JevWarmPlan = {
  userId: string;
  catalogAfter: number;
  limit: number;
  revisionIds: number[];
};

export type WarmingSnapshot = { calls: number; costUsd: number };

function recordOf(value: unknown): JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as JsonObject : {};
}

function arrayOf<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function assertion(name: string, passed: boolean, detail: unknown): Assertion {
  return { name, passed, detail: typeof detail === "string" ? detail : JSON.stringify(detail) };
}

function actionItems(action: CoachAction | undefined): JsonObject[] {
  return arrayOf<JsonObject>(recordOf(action).items);
}

function allText(evidence: JevPersistedEvidence): string {
  const calls = arrayOf<JsonObject>(evidence.toolCalls.calls);
  const callRefusals = calls.flatMap((call) =>
    arrayOf<string>(recordOf(call.result).refusals));
  return [
    evidence.assistantContent,
    ...arrayOf<string>(evidence.toolCalls.recipeRefusals),
    ...callRefusals,
  ].join(" ");
}

function foodIdeas(evidence: JevPersistedEvidence): JsonObject[] {
  return evidence.blocks.filter((block) => recordOf(block).kind === "food_ideas")
    .flatMap((block) => arrayOf<JsonObject>(recordOf(block).ideas));
}

export function jevAssertions(
  expectation: JevExpectation,
  evidence: JevPersistedEvidence,
): Assertion[] {
  const action = evidence.actions[0];
  const items = actionItems(action);
  const text = allText(evidence);
  if (expectation.kind === "logged_facet_mark") {
    const flagged = arrayOf<JsonObject>(evidence.commit?.flagged);
    return [
      assertion("Jev persisted soy verdict", action?.kind === "log_meal"
        && items.some((item) => item.verdict === "blocked"), action ?? null),
      assertion("Jev persisted soy reply mark", /(?:off[- ]plan|contains soy)/i.test(text), text),
      assertion("Jev soy log committed", evidence.commit?.status === "ok"
        && evidence.logEntry !== null, evidence.commit),
      assertion("Jev commit carries soy facet mark", flagged.some((item) =>
        String(item.message).includes("facet:contains_soy")), flagged),
    ];
  }
  if (expectation.kind === "recipe_exclusion") {
    return [
      assertion("Jev persisted recipe excludes soy", action?.kind === "save_recipe"
        && items.length > 0
        && items.every((item) => !/tofu/i.test(String(item.name))), action ?? null),
      assertion("Jev persisted recipe names facet and preference",
        /contains soy/i.test(text) && /no-soy preference/i.test(text), text),
    ];
  }
  if (expectation.kind === "unverified_recipe") {
    return [
      assertion("Jev persisted recipe excludes unverified food", action?.kind === "save_recipe"
        && items.length > 0
        && items.every((item) => !/mystery broth/i.test(String(item.name))), action ?? null),
      assertion("Jev persisted Not verified low-FODMAP copy",
        /cannot verify/i.test(text) && /low-FODMAP preference/i.test(text)
          && /Not verified/i.test(text), text),
    ];
  }
  if (expectation.kind === "tiny_log_commit") {
    const sanity = recordOf(items[0]?.sanity);
    const warnings = arrayOf<JsonObject>(sanity.warnings);
    return [
      assertion("Jev persisted tiny-portion warning", action?.kind === "log_meal"
        && items[0]?.grams === expectation.grams
        && sanity.status === ITEM_SANITY_WARNING_STATUS
        && warnings.some((warning) => warning.kind === "portion" && warning.level === "tiny"),
      items[0] ?? null),
      assertion("Jev tiny log committed", evidence.commit?.status === "ok"
        && evidence.logEntry?.grams.includes(expectation.grams) === true, evidence.commit),
    ];
  }
  if (expectation.kind === "ranked_suggestions") {
    const ideas = foodIdeas(evidence);
    const verdicts = ideas.flatMap((idea) => arrayOf<JsonObject>(idea.items)
      .map((item) => item.verdict));
    return [
      assertion("Jev exactly one persisted ranking call",
        evidence.rankingPurposes.filter((purpose) => purpose === expectation.purpose).length
          === expectation.calls, evidence.rankingPurposes),
      assertion("Jev persisted cards are policy-clean", ideas.length === 3
        && verdicts.length > 0 && verdicts.every((verdict) => verdict === "allowed"),
      { ideas: ideas.length, verdicts }),
    ];
  }
  const advice = recordOf(recordOf(action).roleAdvice);
  return [
    assertion("Jev persisted role advice requires confirmation",
      action?.kind === "add_to_eats" && advice.requiresConfirmation === true
        && typeof advice.suggestedRole === "string", action ?? null),
    assertion("Jev role unchanged before confirmation",
      evidence.membershipBefore?.role === null && evidence.membershipAfter?.role === null
        && evidence.membershipBefore?.status === evidence.membershipAfter?.status,
    { before: evidence.membershipBefore, after: evidence.membershipAfter }),
  ];
}

/** Sets the flags and keeps every other diet_prefs key (taste, water): every diet_prefs writer does
 *  (tests/profile/diet-prefs-taste.test.ts). Not safe against concurrent edits (read then write, no
 *  revision check): run it only against the dedicated eval account. */
async function updateFlags(harness: LiveHarness, flags: string[]): Promise<void> {
  const read = await harness.db.from("user_settings").select("diet_prefs")
    .eq("user_id", harness.userId).maybeSingle();
  if (read.error) throw read.error;
  const stored = read.data?.diet_prefs;
  const kept = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  const result = await harness.db.from("user_settings")
    .update({ diet_prefs: { ...kept, flags } }).eq("user_id", harness.userId);
  if (result.error) throw result.error;
}

async function membership(
  db: SupabaseClient,
  userId: string,
  foodRefId: string | null,
): Promise<Membership> {
  if (!foodRefId) return null;
  const row = await db.from("user_food_prefs").select("status,role")
    .eq("user_id", userId).eq("food_ref_id", foodRefId).maybeSingle();
  if (row.error) throw row.error;
  return row.data as Membership;
}

async function aiCallIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const rows = await db.from("ai_calls").select("id").eq("user_id", userId);
  if (rows.error) throw rows.error;
  return (rows.data ?? []).map((row) => String(row.id));
}

export async function seedJevCase(
  harness: LiveHarness,
  seed: SeedContext,
  item: CoachCase,
): Promise<JevCaseContext> {
  if (!item.expected_jev) throw new Error(`Jev case ${item.id} has no expected_jev contract.`);
  const expectation = item.expected_jev;
  let roleFoodRefId: string | null = null;
  if (expectation.kind === "logged_facet_mark" || expectation.kind === "recipe_exclusion"
      || expectation.kind === "ranked_suggestions") {
    await updateFlags(harness, ["no_soy"]);
  } else if (expectation.kind === "unverified_recipe") {
    await updateFlags(harness, ["low_fodmap"]);
    const { seedUserFood } = await import("@/tests/log/fixtures");
    const mystery = await seedUserFood(harness.db, harness.userId, {
      name: "Mystery broth",
      per100g: { energy_kcal: 12, protein: 1, carbohydrate: 2, fat_total: 0 },
    });
    const row = await harness.db.from("user_food_prefs").upsert({
      user_id: harness.userId,
      food_ref_id: mystery.foodRefId,
      status: "eats",
      role: "carb",
      rev: 1,
    });
    if (row.error) throw row.error;
  } else if (expectation.kind === "role_advice_unconfirmed") {
    const { seedUserFood } = await import("@/tests/log/fixtures");
    const roleless = await seedUserFood(harness.db, harness.userId, {
      name: "Blue pea crunch",
      per100g: { energy_kcal: 167, protein: 30, carbohydrate: 5, fat_total: 3 },
    });
    roleFoodRefId = roleless.foodRefId;
    const row = await harness.db.from("user_food_prefs").upsert({
      user_id: harness.userId,
      food_ref_id: roleFoodRefId,
      status: "avoid",
      role: null,
      rev: 1,
    });
    if (row.error) throw row.error;
  }
  if ((expectation.kind === "logged_facet_mark" || expectation.kind === "recipe_exclusion")
      && !seed.fixtures.has("streak-smoked-tofu")) {
    throw new Error("Jev soy fixture is missing.");
  }
  if (expectation.kind === "logged_facet_mark" || expectation.kind === "recipe_exclusion") {
    const revisionId = seed.fixtures.get("streak-smoked-tofu")?.revisionId;
    const cached = await harness.db.from("food_facets").select("p")
      .eq("food_key", `catalog_revision:${revisionId}`)
      .eq("facet", "contains_soy")
      .eq("rubric_version", 1)
      .order("judged_at", { ascending: false }).limit(1).maybeSingle();
    if (cached.error) throw cached.error;
    if (Number(cached.data?.p ?? 0) < FACET_THRESHOLDS.contains_soy.mark.present) {
      throw new Error("Jev soy fixture has no present contains_soy cache row; warm it first.");
    }
  }
  return {
    expectation,
    aiCallIdsBefore: await aiCallIds(harness.db, harness.userId),
    membershipBefore: await membership(harness.db, harness.userId, roleFoodRefId),
    roleFoodRefId,
  };
}

async function persistedAssistant(
  harness: LiveHarness,
  assistantId: string,
  waitForSanity: boolean,
): Promise<{ content: string; toolCalls: JsonObject }> {
  const deadline = Date.now() + (waitForSanity ? 4_000 : 0);
  for (;;) {
    const row = await harness.db.from("coach_messages").select("content,tool_calls")
      .eq("id", assistantId).eq("role", "assistant").single();
    if (row.error) throw row.error;
    const toolCalls = recordOf(row.data?.tool_calls);
    const pending = arrayOf<JsonObject>(toolCalls.actions).some((action) =>
      actionItems(action as unknown as CoachAction).some((item) =>
        recordOf(item.sanity).status === "pending"));
    if (!pending || Date.now() >= deadline) {
      return { content: String(row.data?.content ?? ""), toolCalls };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function commitLog(
  harness: LiveHarness,
  action: CoachAction | undefined,
): Promise<{ commit: JsonObject | null; logEntry: JevPersistedEvidence["logEntry"] }> {
  if (action?.kind !== "log_meal") return { commit: null, logEntry: null };
  const entryId = randomUUID();
  const eatenAt = new Date();
  const commit = await applyLogEntry(harness.client, harness.userId, {
    entry_id: entryId,
    eaten_at: eatenAt.toISOString(),
    tz: "America/Denver",
    local_date: action.date,
    slot: action.slot,
    method: "text",
    note: action.note,
    items: action.items.map((item, index) => ({
      id: randomUUID(),
      seq: index + 1,
      food_ref_id: item.foodRefId,
      food_revision_id: item.catalogFoodRevisionId,
      qty: item.grams,
      unit: "g",
      grams: item.grams,
      was_edited: false,
    })),
  });
  const items = await harness.db.from("log_items").select("grams").eq("entry_id", entryId)
    .order("seq", { ascending: true });
  if (items.error) throw items.error;
  return {
    commit: recordOf(commit),
    logEntry: (items.data?.length ?? 0) > 0
      ? { id: entryId, grams: (items.data ?? []).map((row) => Number(row.grams)) }
      : null,
  };
}

export async function collectJevEvidence(
  harness: LiveHarness,
  assistantId: string,
  context: JevCaseContext,
): Promise<JevPersistedEvidence> {
  const stored = await persistedAssistant(
    harness,
    assistantId,
    context.expectation.kind === "tiny_log_commit",
  );
  const actions = arrayOf<CoachAction>(stored.toolCalls.actions);
  const blocks = arrayOf(stored.toolCalls.blocks);
  const logged = context.expectation.kind === "logged_facet_mark"
      || context.expectation.kind === "tiny_log_commit"
    ? await commitLog(harness, actions[0]) : { commit: null, logEntry: null };
  const calls = await harness.db.from("ai_calls").select("id,purpose")
    .eq("user_id", harness.userId);
  if (calls.error) throw calls.error;
  const before = new Set(context.aiCallIdsBefore);
  return {
    assistantContent: stored.content,
    toolCalls: stored.toolCalls,
    actions,
    blocks,
    ...logged,
    rankingPurposes: (calls.data ?? []).filter((row) => !before.has(String(row.id)))
      .map((row) => String(row.purpose)),
    membershipBefore: context.membershipBefore,
    membershipAfter: await membership(harness.db, harness.userId, context.roleFoodRefId),
  };
}

export function jevWarmPlan(harness: LiveHarness, seed: SeedContext): JevWarmPlan {
  const revisionIds = [...seed.fixtures.values()].map((fixture) => fixture.revisionId)
    .sort((left, right) => left - right);
  const first = revisionIds[0];
  const last = revisionIds.at(-1);
  if (first === undefined || last === undefined) throw new Error("No fixture revisions to warm.");
  return {
    userId: harness.userId,
    catalogAfter: first - 1,
    limit: last - first + 1,
    revisionIds,
  };
}

export async function warmingSnapshot(
  db: SupabaseClient,
  userId: string,
): Promise<WarmingSnapshot> {
  const rows = await db.from("ai_calls").select("cost_estimate")
    .eq("user_id", userId).eq("purpose", "food_facets");
  if (rows.error) throw rows.error;
  return {
    calls: rows.data?.length ?? 0,
    costUsd: (rows.data ?? []).reduce((sum, row) => sum + Number(row.cost_estimate ?? 0), 0),
  };
}
