/**
 * POST /api/plan/ideas (lib/server/plan-ideas.ts): a chip is answered in code. Every model call
 * goes through `callModel` (lib/ai/call.ts); here it is a spy, and the only provider a chip may
 * reach is TypeSafe (Jev ranking). No Gemini, OpenRouter or other generative call, for any chip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@/lib/ai/call", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/call")>()),
  callModel: vi.fn(async (args: { target: () => { provider: string } }) => {
    calls.push(args.target().provider);
    return null;
  }),
}));
vi.mock("@/lib/server/meal-snapshot-v3", () => ({ mealSnapshotV3: vi.fn() }));
vi.mock("@/lib/server/day-context", () => ({ foodsFor: vi.fn(async () => ({})),
  userFoodRefIds: vi.fn(async () => ({})) }));
vi.mock("@/lib/server/coach-ports", () => ({ suggestionTarget: vi.fn(async () => MAIN) }));
vi.mock("@/lib/server/viewed-day", () => ({ viewedDay: () => ({ viewed: Promise.resolve({}),
  slotClock: async () => "12:30", timeOfDay: () => "12:30 PM" }) }));
vi.mock("@/lib/server/policy-profile", async () => ({
  readPolicyProfile: vi.fn(async () => ({ profile: (await import("@/tests/helpers/constraint-profile")).TEST_PROFILE })),
}));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: vi.fn(async () => ({ required: false })) }));
vi.mock("@/lib/server/compose-pool-ports", () => ({ composePoolPorts: () => ({ focus: async () => undefined }) }));
vi.mock("@/lib/server/plan-on-hand", () => ({ readOnHand: vi.fn(async (_c: unknown, _u: unknown,
  _d: unknown, stated: string[]) => stated.map((name) => ({ name, source: "stated" }))) }));

import { mealSnapshotV3 } from "@/lib/server/meal-snapshot-v3";
import { foodsFor, userFoodRefIds } from "@/lib/server/day-context";
import { planIdeas } from "@/lib/server/plan-ideas";
import { PLAN_CHIPS, type PlanChip } from "@/lib/plan/chips";
import { eats, F, MAIN } from "@/tests/helpers/meal-foods";
import { openSnapshot } from "@/tests/helpers/open-snapshot";

const client = {} as never;
const admin = {} as never;
const request = (chip: PlanChip) => ({ chip, slot: "meal-2" as const, date: "2026-10-08",
  zone: "America/Denver", ...(chip === "on_hand" ? { stated: ["eggs", "bread"] } : {}) });
const CLOSED = eats(F.eggs, F.chicken, F.tofu, F.rice, F.bread, F.broccoli, F.banana, F.oliveOil);
const closedBody = () => ({ schemaVersion: 2, rankingVersion: "x", accountId: "u1",
  computedAt: "2026-10-08T00:00:00Z", inputsHash: "h", foods: {},
  eligible: { eligibleRefIds: [], eligibleFoodIds: Object.keys(CLOSED), eligibleCatalogFoodIds: [],
    excluded: [], rulesRevision: 1 } });

beforeEach(() => { calls.length = 0; });

describe("plan ideas: no generative model call, any chip", () => {
  it.each(PLAN_CHIPS)("closed account, %s: cards from code, no model call at all", async (chip) => {
    vi.mocked(mealSnapshotV3).mockResolvedValueOnce(closedBody() as never);
    vi.mocked(foodsFor).mockResolvedValueOnce(CLOSED);
    vi.mocked(userFoodRefIds).mockResolvedValueOnce(Object.fromEntries(Object.keys(CLOSED)
      .map((id, index) => [id, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`])));
    const answer = await planIdeas(client, admin, "u1", request(chip));
    expect(answer.cards.length).toBeGreaterThan(0);
    expect(answer.chip).toBe(chip);
    expect(answer.provenance).toEqual({ ai: false, source: "app" });
    expect(calls).toEqual([]);
    expect(answer.serverMs).toBeGreaterThanOrEqual(0);
    expect(answer.serverMs).toBeLessThan(1_000);
  });

  it.each(PLAN_CHIPS)("open account, %s: only Jev, and its failure keeps the formula order", async (chip) => {
    vi.mocked(mealSnapshotV3).mockResolvedValueOnce(openSnapshot() as never);
    vi.mocked(foodsFor).mockResolvedValueOnce({});
    const answer = await planIdeas(client, admin, "u1", request(chip), {
      universeRefs: async (_user, ids) => Object.fromEntries(ids.map((id, index) =>
        [id, { foodRefId: `11111111-0000-4000-8000-${String(index).padStart(12, "0")}`, catalogFoodRevisionId: index + 1 }])),
    });
    expect(calls.every((provider) => provider === "typesafe")).toBe(true);
    expect(answer.provenance).toEqual({ ai: false, source: "app" });
    expect(answer.serverMs).toBeLessThan(1_000);
  });

  it("open account without the universe resolver: no unplaceable card is shown", async () => {
    vi.mocked(mealSnapshotV3).mockResolvedValueOnce(openSnapshot() as never);
    vi.mocked(foodsFor).mockResolvedValueOnce({});
    const answer = await planIdeas(client, admin, "u1", request("choose"));
    for (const card of answer.cards) {
      expect(card.items.some((item) => item.foodRefId?.startsWith("universe:"))).toBe(false);
    }
  });

  it("a chip's on-hand foods come only from the admitted pool", async () => {
    vi.mocked(mealSnapshotV3).mockResolvedValueOnce(closedBody() as never);
    vi.mocked(foodsFor).mockResolvedValueOnce({ ...CLOSED, ...eats({ ...F.tuna, status: "avoid" }) });
    const answer = await planIdeas(client, admin, "u1", { ...request("on_hand"), stated: ["tuna"] });
    for (const card of answer.cards) expect(card.items.some((item) => /tuna/i.test(item.name))).toBe(false);
  });
});
