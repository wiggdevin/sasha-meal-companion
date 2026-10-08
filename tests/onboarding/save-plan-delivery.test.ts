/**
 * GPT-6 Sol BLOCK (onb2-p0) and the owner's "things didn't save": the onboarding save's delivery
 * gate answered for the settings op only (`flushOutboxNow`), so a food membership op the server
 * failed let "Use this plan" open Today without the chosen foods. Driven against a fake IndexedDB
 * and a fake server: the real outbox, the real drain and the real gate; only the save's own
 * profile and starter writes are stand-ins that queue the same ops the real ones queue.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushOnboardingWritesNow } from "@/lib/sync/client";
import { allOps } from "@/lib/sync/idb";
import { enqueue, mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { createOnboardingState } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import { FOODS_NOT_DELIVERED_ERROR, saveOnboardingPlan } from "@/lib/onboarding/save-plan";
import type { OpsResponse, SyncOp } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;
const ONBOARDED_AT = "2026-10-08T12:00:00.000Z";
const FOOD_OP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const sixFoods = { "chicken-breast-roasted": "eats", "turkey-breast-roasted": "eats",
  "white-rice-cooked": "eats", "brown-rice-cooked": "eats",
  "olive-oil": "eats", "avocado-oil": "eats" } as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** A server that holds no rows, applies the settings op and fails every food op while `failFoods`. */
function server() {
  const state = { failFoods: true, posted: [] as SyncOp[][] };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/sync/changes")) return json({ changes: [], next_cursor: 0, has_more: false });
    const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    state.posted.push(body.ops);
    return json({
      results: body.ops.map((op) => op.entity === "food_membership" && state.failFoods
        ? { op_id: op.op_id, status: "error", message: "boom" }
        : { op_id: op.op_id, status: "applied", rev: 1, seq: 1 }),
      server_time: ONBOARDED_AT,
    } satisfies OpsResponse);
  });
  return { state, fetchFn: fetchFn as unknown as typeof fetch };
}

async function queueSettings(): Promise<void> {
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    return {
      row: { ...row, onboarded_at: ONBOARDED_AT },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const, entity_id: USER_SETTINGS_KEY,
        kind: rev === null ? "create" as const : "update" as const, base_rev: rev,
        payload: { onboarded_at: ONBOARDED_AT }, client_ts: ONBOARDED_AT },
      result: undefined,
    };
  });
}

async function queueFood(): Promise<void> {
  await enqueue(h, { op_id: FOOD_OP_ID, entity: "food_membership",
    entity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "update", base_rev: null,
    payload: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name_norm: "chicken breast", status: "eats", note: null, rev: 1 },
    client_ts: ONBOARDED_AT });
}

function deps() {
  return {
    persistPlan: vi.fn(async () => { await queueSettings(); return { settings: defaultSettings(), constraintsSaved: true }; }),
    retryConstraints: vi.fn(async () => true),
    readRules: vi.fn(async () => ({ profile: rules, instances: [] })),
    writeStarter: vi.fn(async () => { if ((await allOps(h)).every((op) => op.op_id !== FOOD_OP_ID)) await queueFood(); return 1; }),
  };
}

const input = () => ({
  settings: defaultSettings(), onboardingState: createOnboardingState(defaultSettings()),
  starter: { status: "pilot" as const, marks: sixFoods, plannedCount: 0 },
});

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the onboarding save's delivery gate", () => {
  it("never reports the plan saved while a food op the save queued failed on the server", async () => {
    const { state, fetchFn } = server();
    vi.stubGlobal("fetch", fetchFn);

    const result = await saveOnboardingPlan(input(), deps());

    expect(result).toEqual({ ok: false, error: FOODS_NOT_DELIVERED_ERROR });
    expect(state.posted.flat().some((op) => op.entity === "food_membership")).toBe(true);
    await expect(allOps(h)).resolves.toMatchObject([{ op_id: FOOD_OP_ID }]);
  });

  it("a retry sends the backed-off food op again at once and then reports the plan saved", async () => {
    const { state, fetchFn } = server();
    vi.stubGlobal("fetch", fetchFn);
    const d = deps();
    expect((await saveOnboardingPlan(input(), d)).ok).toBe(false);

    state.failFoods = false;
    const retried = await saveOnboardingPlan(input(), d);

    expect(retried).toEqual({ ok: true });
    await expect(allOps(h)).resolves.toEqual([]);
  });

  it("reports each entity still queued", async () => {
    const { fetchFn } = server();
    await queueSettings();
    await queueFood();
    const delivery = await flushOnboardingWritesNow(h, { fetchFn });
    expect(delivery).toEqual({ delivered: false, pending: { userSettings: 0, foodMembership: 1 } });
  });
});
