/**
 * Phase 13 slice 4 (§4, §9 R5): the live wiring in lib/server/coach-turn.ts — a stated need in
 * the user's own message proposes a dietary_profile_proposal block, never applies anything, and
 * never re-proposes a profile the account already has a stored row for. Same fixture shape as
 * The local fake Supabase double covers user_dietary_profiles and user_settings the same way
 * lib/server/dietary-profiles.ts reads them. The logged-day default is in
 * tests/coach/fixtures/run-turn.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000020", text: "" };

function db(tables: Record<string, unknown[]>) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain,
      is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      insert: () => chain, update: () => chain,
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

function deps(generate: () => Promise<unknown>) {
  return { generate: generate as never, ports, logEntryExists: async () => true,
    now: () => 0, newId: () => "profile-blk-1" };
}

describe("runTurn — dietary profile proposal", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("proposes a confirm card when the message names a catalog synonym", async () => {
    const client = db({});
    const generate = () => Promise.resolve({ kind: "final", text: "Got it." });
    const req = { ...REQ, text: "just so you know, I'm vegan now" };
    const result = await runTurn(client, client, "u1", req, deps(generate));
    const assistant = result.messages.at(-1)!;
    expect(assistant.blocks?.[0]).toMatchObject({
      kind: "dietary_profile_proposal", profileId: "vegan",
    });
    expect(assistant.blocks?.[1]).toMatchObject({
      kind: "next_action_chip", action: "confirm_rule", label: "Confirm this rule",
    });
  });

  it("proposes nothing when the message names no catalog profile", async () => {
    const client = db({});
    const generate = () => Promise.resolve({ kind: "final", text: "Sounds good." });
    const req = { ...REQ, text: "what should I eat for lunch" };
    const result = await runTurn(client, client, "u1", req, deps(generate));
    expect(result.messages.at(-1)!.blocks ?? []).toEqual([]);
  });

  it("keeps rule confirmation ahead of the log chip on an unlogged day", async () => {
    const client = db({});
    const generate = () => Promise.resolve({ kind: "final", text: "Got it." });
    const result = await runTurn(client, client, "u1",
      { ...REQ, text: "just so you know, I'm vegan now" },
      { ...deps(generate), logEntryExists: async () => false });
    expect(result.messages.at(-1)?.blocks?.[1]).toMatchObject({
      kind: "next_action_chip", action: "confirm_rule",
    });
  });

  it("never re-proposes a profile the account already has a stored row for", async () => {
    const client = db({
      user_dietary_profiles: [{
        profile_id: "vegan", source: "user_stated", confirmed_at: "2026-09-24T00:00:00Z",
        rules: [], options: {}, notes: null,
      }],
    });
    const generate = () => Promise.resolve({ kind: "final", text: "Got it." });
    const req = { ...REQ, text: "just a reminder, I'm vegan" };
    const result = await runTurn(client, client, "u1", req, deps(generate));
    expect(result.messages.at(-1)!.blocks ?? []).toEqual([]);
  });

  it("proposes a like or dislike as a soft food preference card (slice 7)", async () => {
    const client = db({});
    const generate = () => Promise.resolve({ kind: "final", text: "Noted." });
    const req = { ...REQ, text: "honestly I hate cilantro" };
    const result = await runTurn(client, client, "u1", req, deps(generate));
    expect(result.messages.at(-1)!.blocks?.[0]).toMatchObject({
      kind: "dietary_profile_proposal", profileId: "food_preferences",
      items: [{ facet: "food_named:cilantro", strength: "avoid", hardBasis: null }],
    });
    expect(result.messages.at(-1)!.blocks?.[1]).toMatchObject({
      kind: "next_action_chip", action: "confirm_rule",
    });
  });

  it("reads the profile rows once per turn, shared by the policy, the reply check and the proposal", async () => {
    const client = db({});
    const from = (client as { from: (t: string) => unknown }).from;
    const tables: string[] = [];
    const counting = { ...(client as object),
      from: (t: string) => { tables.push(t); return from(t); } } as never;
    const generate = () => Promise.resolve({ kind: "final", text: "Got it." });
    const req = { ...REQ, text: "just so you know, I'm vegan now" };
    const result = await runTurn(counting, counting, "u1", req, deps(generate));
    expect(result.messages.at(-1)!.blocks?.[0]).toMatchObject({ profileId: "vegan" });
    expect(tables.filter((t) => t === "user_dietary_profiles")).toHaveLength(1);
  });

  it("never re-proposes a like or dislike the account already stated", async () => {
    const client = db({
      user_dietary_profiles: [{
        profile_id: "food_preferences", source: "user_stated", confirmed_at: "2026-09-24T00:00:00Z",
        rules: [{ id: "food_preferences::food_named:salmon", profileId: "food_preferences",
          facet: "food_named:salmon", strength: "prefer", hardBasis: null,
          evidenceStrength: "user_rule", confirmation: "confirmed", expiresAt: null }],
        options: {}, notes: null,
      }],
    });
    const generate = () => Promise.resolve({ kind: "final", text: "Noted." });
    const req = { ...REQ, text: "I love salmon" };
    const result = await runTurn(client, client, "u1", req, deps(generate));
    expect(result.messages.at(-1)!.blocks ?? []).toEqual([]);
  });
});
