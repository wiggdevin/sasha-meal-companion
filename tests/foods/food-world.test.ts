/**
 * Phase 18 W2b: `POST /api/foods/world`, `GET /api/foods/rules-version` and the condition gate on
 * every generating surface, over the in-memory PostgREST double. The database half (the trigger
 * that closes an open account in the same write as a new condition) is proved on the migrated
 * schema by tests/migrations/food-world-clocks-db.test.ts; here the rows are set the way it leaves them.
 *
 * Acceptance 5: an unconfirmed condition gets 409 condition_review; a held account gets 423.
 * Acceptance 10 (the app half): after a condition is added to an open account, no surface
 * generates (bread included, though bread is Favored) until the user confirms; after the celiac
 * pack's gluten rule is confirmed, bread is blocked and never admitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";
import { A, eatsEvidence, worldTables, type WorldOptions } from "@/tests/helpers/world-fixtures";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => state.client }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: async () => ({ userId: A, client: state.client }),
}));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: async () => eatsEvidence(),
}));

const { POST } = await import("@/app/api/foods/world/route");
const { GET: rulesVersion } = await import("@/app/api/foods/rules-version/route");
const { candidateFoods } = await import("@/lib/server/candidate-foods");
const { eligibleFoods } = await import("@/lib/server/eligible-foods");
const { getRuleReviewStatus } = await import("@/lib/server/constraints");

const RELEASED = { OPEN_WORLD_ENABLED: "1", OPEN_WORLD_USER_IDS: "*", CONDITION_PACKS_ENABLED: "1" };
let tables: Record<string, Row[]>;

function loadWorld(options: WorldOptions = {}) {
  const fake = fakeDb(worldTables(options));
  tables = fake.tables;
  state.client = fake.client;
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(new Request("https://app.test/api/foods/world", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "generated"; } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code}` : String(error);
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(RELEASED)) vi.stubEnv(key, value);
  vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", "");
  loadWorld();
});

describe("POST /api/foods/world (W2b acceptance 5)", () => {
  it("opens an account with no stated condition once the open world is released", async () => {
    expect(await post({ world: "open" })).toEqual({ status: 200, body: { world: "open" } });
    expect(tables.user_settings[0].food_world).toBe("open");
  });

  it("answers 409 condition_review for an unconfirmed condition, and stays closed", async () => {
    loadWorld({ conditions: ["Celiac"] });
    expect(await post({ world: "open" })).toEqual({ status: 409,
      body: { error: "condition_review", conditions: ["Celiac"] } });
    expect(tables.user_settings[0].food_world).toBe("closed");
  });

  it("answers 423 held for a held account, before reading anything", async () => {
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", `someone-else, ${A}`);
    expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "held" } });
    expect(tables.user_settings[0].food_world).toBe("closed");
  });

  it("answers 423 while the open world is unreleased (the default)", async () => {
    vi.stubEnv("OPEN_WORLD_ENABLED", "");
    expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "open_world_not_released" } });
  });

  it("accepts no confirmation until the reviewed wording is live (owner decision Q4)", async () => {
    loadWorld({ conditions: ["Celiac"] });
    vi.stubEnv("CONDITION_PACKS_ENABLED", "");
    const answer = await post({ world: "open", confirmations: [{ condition: "Celiac", choice: "no_limit" }] });
    expect(answer).toEqual({ status: 409, body: { error: "condition_review", conditions: ["Celiac"],
      reason: "packs_disabled" } });
    expect(tables.food_world_condition_confirmations).toEqual([]);
  });

  it("refuses a confirmation for a condition the account does not state, or a pack that does not exist", async () => {
    loadWorld({ conditions: ["Gout"] });
    expect((await post({ world: "open", confirmations: [{ condition: "Celiac", choice: "pack" }] })).body)
      .toMatchObject({ error: "condition_review", reason: "unknown_condition" });
    expect((await post({ world: "open", confirmations: [{ condition: "gout", choice: "pack" }] })).body)
      .toMatchObject({ error: "condition_review", reason: "no_pack" });
  });

  it("always allows closing: the stop switch", async () => {
    loadWorld({ world: "open" });
    vi.stubEnv("OPEN_WORLD_ENABLED", "");
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", A);
    expect(await post({ world: "closed" })).toEqual({ status: 200, body: { world: "closed" } });
    expect(tables.user_settings[0].food_world).toBe("closed");
  });

  it("rejects an unknown field or world", async () => {
    expect((await post({ world: "wide" })).status).toBe(400);
    expect((await post({ world: "open", userId: "someone-else" })).status).toBe(400);
  });

  it("opting in keeps the account's Eats marks as Favored marks, byte-for-byte (W13 acceptance 6)", async () => {
    const before = JSON.stringify(tables.user_food_prefs);
    expect(await post({ world: "open" })).toEqual({ status: 200, body: { world: "open" } });
    // `eats` is the unchanged wire status (D13) — "Favored" is only ever how it is read back to
    // the user. Opting in writes nothing to user_food_prefs at all.
    expect(JSON.stringify(tables.user_food_prefs)).toBe(before);
    expect(tables.user_food_prefs.map((row: Row) => row.status)).toEqual(["eats", "eats", "avoid"]);
  });
});

describe("POST /api/foods/world intent: onboarding_default (W13 Sol round 2 BLOCK fix)", () => {
  it("applies and stamps food_world_set_at on a never-touched account", async () => {
    expect(tables.user_settings[0].food_world_set_at).toBeNull();
    expect(await post({ world: "open", intent: "onboarding_default" }))
      .toEqual({ status: 200, body: { world: "open" } });
    expect(tables.user_settings[0].food_world).toBe("open");
    expect(typeof tables.user_settings[0].food_world_set_at).toBe("string");
  });

  it("settles as a no-op against the account's own current world once a choice was already made, "
    + "so a pending retry can never reopen a deliberately-closed account", async () => {
    // Simulates: the onboarding default already landed once (or the person used Settings), then
    // closed it again on purpose -- all backend-side, no clearWorldOpenPending call required.
    loadWorld({ world: "closed", foodWorldSetAt: "2026-10-01T00:00:00Z" });
    expect(await post({ world: "open", intent: "onboarding_default" }))
      .toEqual({ status: 200, body: { world: "closed" } });
    expect(tables.user_settings[0].food_world).toBe("closed");
    expect(tables.user_settings[0].food_world_set_at).toBe("2026-10-01T00:00:00Z");
  });

  it("an explicit Settings POST (no intent) always applies and stamps, even over a prior choice", async () => {
    loadWorld({ world: "open", foodWorldSetAt: "2026-10-01T00:00:00Z" });
    expect(await post({ world: "closed" })).toEqual({ status: 200, body: { world: "closed" } });
    expect(tables.user_settings[0].food_world).toBe("closed");
    expect(tables.user_settings[0].food_world_set_at).not.toBe("2026-10-01T00:00:00Z");
  });

  it("an explicit close that lands between the default's check and its write still wins "
    + "(Sol round 3 BLOCK: one atomic conditional write)", async () => {
    // Another device closes the world while this default POST is in flight: the close commits
    // right before the default's UPDATE runs. The old read-then-write saw null and reopened it.
    const base = state.client as { from: (table: string) => Record<string, unknown> };
    let raced = false;
    state.client = { ...base, from: (table: string) => {
      const builder = base.from(table);
      if (table !== "user_settings") return builder;
      const update = builder.update as (values: Row) => unknown;
      builder.update = (values: Row) => {
        if (!raced) {
          raced = true;
          Object.assign(tables.user_settings[0], { food_world: "closed", food_world_set_at: "2026-10-07T09:00:00Z" });
        }
        return update(values);
      };
      return builder;
    } };
    expect(await post({ world: "open", intent: "onboarding_default" }))
      .toEqual({ status: 200, body: { world: "closed" } });
    expect(raced).toBe(true);
    expect(tables.user_settings[0].food_world).toBe("closed");
    expect(tables.user_settings[0].food_world_set_at).toBe("2026-10-07T09:00:00Z");
  });

  it("answers 409 profile_required to the default when the account has no settings row yet", async () => {
    tables.user_settings.length = 0;
    expect(await post({ world: "open", intent: "onboarding_default" }))
      .toMatchObject({ status: 409, body: { error: "profile_required" } });
  });

  it("rejects an intent other than the one literal", async () => {
    expect((await post({ world: "open", intent: "user_choice" })).status).toBe(400);
  });
});

describe("GET /api/foods/world (W13)", () => {
  const ONBOARDED = "2026-10-07T09:00:00.000Z";
  async function get(): Promise<Record<string, unknown>> {
    const { GET } = await import("@/app/api/foods/world/route");
    const res = await GET(new Request("https://app.test/api/foods/world"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    return await res.json() as Record<string, unknown>;
  }

  it("answers the account's own current world", async () => {
    expect((await get()).world).toBe("closed");
    loadWorld({ world: "open", onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED, foodWorldSetAt: ONBOARDED });
    expect(await get()).toEqual({ world: "open", openDefaultPending: false, starterSeed: false });
  });

  // Sol round 4 BLOCK: the starter-seed decision is the server's, so device B (no local pending
  // flag) agrees with device A, whose open POST answered 503.
  it("a W13-onboarded, undecided, closed account is pending and never seeds, on any device", async () => {
    loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED });
    expect(await get()).toEqual({ world: "closed", openDefaultPending: true, starterSeed: false });
  });

  it("once the default lands the account is open and still never seeds", async () => {
    loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED });
    expect(await post({ world: "open", intent: "onboarding_default" })).toEqual({ status: 200, body: { world: "open" } });
    expect(await get()).toEqual({ world: "open", openDefaultPending: false, starterSeed: false });
  });

  it("a legacy closed account (onboarded before W13, no due stamp) still seeds", async () => {
    loadWorld({ onboardedAt: "2026-09-20T09:00:00.000Z" });
    expect(await get()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: true });
  });

  it("an explicit closed choice still seeds, as the closed world always did", async () => {
    loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED, foodWorldSetAt: ONBOARDED });
    expect(await get()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: true });
  });

  it.each([
    ["the open world is unreleased", () => vi.stubEnv("OPEN_WORLD_ENABLED", ""), {}],
    ["the account is held", () => vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", A), {}],
    ["a stated condition is unconfirmed", () => undefined, { conditions: ["Celiac"] }],
  ])("a W13 default that cannot open the account (%s) is not pending, so the closed seed runs",
    async (_label, setup, options) => {
      setup();
      loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED, ...options });
      expect(await get()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: true });
    });

  it("an account the server has not onboarded yet never seeds", async () => {
    expect(await get()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: false });
    tables.user_settings = [];
    expect(await get()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: false });
  });

  it("a failed read answers 503 with no state at all", async () => {
    const { readFoodWorldState } = await import("@/lib/server/food-world");
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
      ({ data: null, error: { message: "down" } }) }) }) }) };
    expect(await code(readFoodWorldState(broken as never, A))).toBe("503 food_world_unavailable");
  });
});

describe("GET /api/foods/world/invitation (W13 acceptance 4)", () => {
  it("is eligible only once released, not held and still closed", async () => {
    const { GET } = await import("@/app/api/foods/world/invitation/route");
    const req = () => new Request("https://app.test/api/foods/world/invitation");
    expect(await (await GET(req())).json()).toEqual({ eligible: true });

    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", A);
    expect(await (await GET(req())).json()).toEqual({ eligible: false });
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", "");

    vi.stubEnv("OPEN_WORLD_ENABLED", "");
    expect(await (await GET(req())).json()).toEqual({ eligible: false });
    vi.stubEnv("OPEN_WORLD_ENABLED", "1");

    loadWorld({ world: "open" });
    expect(await (await GET(req())).json()).toEqual({ eligible: false });
  });
});

describe("staged release: OPEN_WORLD_USER_IDS", () => {
  const ONBOARDED = "2026-10-07T09:00:00.000Z";
  const invitation = async () => {
    const { GET } = await import("@/app/api/foods/world/invitation/route");
    return (await GET(new Request("https://app.test/api/foods/world/invitation"))).json();
  };
  const worldState = async () => {
    const { GET } = await import("@/app/api/foods/world/route");
    return (await GET(new Request("https://app.test/api/foods/world"))).json();
  };

  it.each([["unset", undefined], ["empty", ""], ["comma-only", " , "]])(
    "%s releases NOBODY, even with the flag on (Sol r1 BLOCK 2)", async (_label, value) => {
      vi.stubEnv("OPEN_WORLD_USER_IDS", value);
      expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "open_world_not_released" } });
      expect(await invitation()).toEqual({ eligible: false });
    });

  it("a stored-open account off the release list reads closed everywhere, and nothing is written (Sol r1 WARN 3)", async () => {
    loadWorld({ world: "open" });
    vi.stubEnv("OPEN_WORLD_USER_IDS", "someone-else");
    const before = JSON.stringify(tables.user_settings);
    expect(await worldState()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: false });
    const { readFoodWorld } = await import("@/lib/server/food-world");
    expect(await readFoodWorld(state.client as never, A)).toBe("closed");
    expect((await candidateFoods(state.client as never as never, A)).world).toBe("closed");
    expect(JSON.stringify(tables.user_settings)).toBe(before);
    vi.stubEnv("OPEN_WORLD_USER_IDS", A);
    expect((await worldState()).world).toBe("open");
  });

  it("an account off a non-empty list is not released: 423, no invitation, no open default", async () => {
    vi.stubEnv("OPEN_WORLD_USER_IDS", "someone-else");
    expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "open_world_not_released" } });
    expect(tables.user_settings[0].food_world).toBe("closed");
    expect(await invitation()).toEqual({ eligible: false });
    loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED });
    expect(await post({ world: "open", intent: "onboarding_default" }))
      .toEqual({ status: 423, body: { error: "open_world_not_released" } });
    expect(await worldState()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: true });
  });

  it("a listed account opens, is invited and gets the open default", async () => {
    vi.stubEnv("OPEN_WORLD_USER_IDS", `someone-else, ${A}`);
    expect(await invitation()).toEqual({ eligible: true });
    loadWorld({ onboardedAt: ONBOARDED, defaultDueAt: ONBOARDED });
    expect(await worldState()).toEqual({ world: "closed", openDefaultPending: true, starterSeed: false });
    expect(await post({ world: "open" })).toEqual({ status: 200, body: { world: "open" } });
  });

  it("`*` lists every account; the hold list still wins; the flag off still closes everything", async () => {
    vi.stubEnv("OPEN_WORLD_USER_IDS", "*");
    expect(await invitation()).toEqual({ eligible: true });
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", A);
    expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "held" } });
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", "");
    vi.stubEnv("OPEN_WORLD_USER_IDS", A);
    vi.stubEnv("OPEN_WORLD_ENABLED", "");
    expect(await post({ world: "open" })).toEqual({ status: 423, body: { error: "open_world_not_released" } });
  });

  it("closing is always allowed, listed or not", async () => {
    vi.stubEnv("OPEN_WORLD_USER_IDS", "someone-else");
    loadWorld({ world: "open" });
    expect(await post({ world: "closed" })).toEqual({ status: 200, body: { world: "closed" } });
  });
});

describe("GET /api/foods/rules-version", () => {
  it("returns the two counters, no-store", async () => {
    const res = await rulesVersion(new Request("https://app.test/api/foods/rules-version"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ rulesVersion: 5, evidenceVersion: 2 });
  });

  it("reads an account with no rule write yet as rulesVersion 0", async () => {
    tables.account_rules_clock = [];
    const res = await rulesVersion(new Request("https://app.test/api/foods/rules-version"));
    expect(await res.json()).toEqual({ rulesVersion: 0, evidenceVersion: 2 });
  });
});

describe("a condition added after opening (W2b acceptance 10, app half)", () => {
  /** What the database leaves after a second client saves "Celiac" on an open account. */
  function conditionAddedOnOpenAccount() {
    loadWorld({ world: "open" });
    Object.assign(tables.constraint_profiles[0], { conditions: ["Celiac"], condition_review_required: true, rev: 3 });
    Object.assign(tables.user_settings[0], { food_world: "closed" });
  }

  it("pauses every generating surface, Favored bread included, until the user confirms", async () => {
    conditionAddedOnOpenAccount();
    const client = state.client as never;
    expect(await getRuleReviewStatus(client, A)).toMatchObject({ required: true, conditionReview: true });
    expect(await code(eligibleFoods(client, A))).toBe("409 rule_review_required");
    expect(await code(candidateFoods(client, A))).toBe("409 rule_review_required");
    expect(await post({ world: "open" })).toEqual({ status: 409, body: { error: "condition_review", conditions: ["Celiac"] } });
  });

  it("after the celiac pack's gluten rule is confirmed, bread is blocked and never admitted", async () => {
    conditionAddedOnOpenAccount();
    expect(await post({ world: "open", confirmations: [{ condition: "Celiac", choice: "pack" }] }))
      .toEqual({ status: 200, body: { world: "open" } });
    expect(tables.constraint_profiles[0]).toMatchObject({ avoid_allergens: ["gluten"], condition_review_required: false });
    expect(tables.food_world_condition_confirmations).toMatchObject([{ user_id: A, condition_key: "celiac", choice: "pack" }]);
    const client = state.client as never;
    const eligible = await eligibleFoods(client, A);
    expect(eligible.eligibleRefIds).toEqual(["ref-chicken"]);
    expect(eligible.excluded).toMatchObject([{ refId: "ref-bread", verdict: "blocked" }]);
    const admitted = await candidateFoods(client, A);
    expect(admitted.admittedRefIds).toEqual(["ref-chicken"]);
    expect(admitted.admittedUniverseIds.filter((id) => /bread|wheat|pita|rye/.test(id))).toEqual([]);
  });

  it("a no_limit confirmation lifts the pause without adding a rule", async () => {
    conditionAddedOnOpenAccount();
    expect((await post({ world: "closed", confirmations: [{ condition: "celiac ", choice: "no_limit" }] })).status).toBe(200);
    expect(tables.constraint_profiles[0]).toMatchObject({ avoid_allergens: [], condition_review_required: false });
    expect(await getRuleReviewStatus(state.client as never, A)).toMatchObject({ required: false });
  });
});
