import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HAS_BRANCH, adminClient, userClient, type TestUser } from "../helpers/supabase";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { previewRecipe, acceptPreview } from "@/lib/server/recipe-plan";

// Independent C5 verification (2026-10-04): the paths the preview-local-db suite does not
// reach. A guarded write must reach other devices as the guarded row, forged history markers
// must be refused on every write path, and another account must not see or move this history.
const testUrl = process.env.SUPABASE_TEST_URL ?? "";
const LOCAL = HAS_BRANCH && (() => {
  try { return ["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname); }
  catch { return false; }
})();
const authorityDate = "2099-09-01";

type Mark = { eaten_at: string | null; changed_at: string; history_epoch?: string;
  consumed?: unknown };
type FeedRow = { seq: number; entity: string; entity_key: string;
  current: { eaten_slots?: Record<string, Mark> } | null };

describe.skipIf(!LOCAL)("recipe consumed history guard on a local test stack", () => {
  let a: TestUser; let b: TestUser; let admin: SupabaseClient;
  let aClient: SupabaseClient; let bClient: SupabaseClient;
  let targetId = "";

  beforeAll(async () => {
    admin = adminClient();
    async function temporaryUser(): Promise<TestUser> {
      const email = `consumed-guard-${crypto.randomUUID()}@meal-companion.test`;
      const password = `Local-${crypto.randomUUID()}-1`;
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error || !result.data.user) throw result.error ?? new Error("Test user failed");
      return { id: result.data.user.id, email, password };
    }
    a = await temporaryUser(); b = await temporaryUser();
    aClient = await userClient(a); bClient = await userClient(b);
    const added = await admin.from("target_profiles").insert({ user_id: a.id,
      effective_from: authorityDate, rev: 1, kcal_train: 2000, kcal_rest: 2000,
      authored_by: "user", mode: "grams", protein_g: 120, fat_g: 70, carb_g: 200,
      protein_g_min: 120, training_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 },
      rest_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 } })
      .select("id").single();
    expect(added.error).toBeNull();
    targetId = added.data!.id;
    await seedPilotCatalog(admin);
  });

  afterAll(async () => {
    if (!admin || !a) return;
    await admin.from("recipe_plan_selections").delete().eq("user_id", a.id);
    if (targetId) await admin.from("target_profiles").delete().eq("id", targetId);
    if (a?.id) expect((await admin.auth.admin.deleteUser(a.id)).error).toBeNull();
    if (b?.id) expect((await admin.auth.admin.deleteUser(b.id)).error).toBeNull();
  });

  async function logRecipe(date: string, slotId: `meal-${1 | 2 | 3 | 4 | 5 | 6}` = "meal-3") {
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const preview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId, servingFraction: 0.5 });
    const accepted = await acceptPreview(aClient, a.id, preview.previewId,
      crypto.randomUUID(), true);
    const selection = accepted.selections[0];
    const logged = await aClient.rpc("recipe_log_consumed", {
      p_request_id: crypto.randomUUID(), p_local_date: date, p_slot_id: slotId,
      p_selection_id: selection.id, p_plan_revision: selection.planRevision,
      p_actual_servings: 0.5 });
    expect(logged.error).toBeNull();
    return logged.data.row as { rev: number; eaten_slots: Record<string, Mark> };
  }

  async function feedSince(client: SupabaseClient, since: number): Promise<FeedRow[]> {
    const rows = await client.rpc("sync_changes", { p_user_id: a.id, p_since: since,
      p_limit: 500 });
    expect(rows.error).toBeNull();
    return rows.data as FeedRow[];
  }

  async function cursor(): Promise<number> {
    return Math.max(0, ...(await feedSince(aClient, 0)).map((row) => row.seq));
  }

  function op(date: string, baseRev: number, payload: Record<string, unknown>) {
    return { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date, kind: "update",
      base_rev: baseRev, payload, client_ts: new Date().toISOString() };
  }

  it("sends other devices the guarded row, not the stale payload that was overridden", async () => {
    const date = "2099-09-02";
    const row = await logRecipe(date);
    const mark = row.eaten_slots["meal-3"];
    const since = await cursor();
    const stale = await aClient.rpc("apply_sync_op", { p_user_id: a.id, p_op: op(date, row.rev,
      { eaten_slots: { "meal-3": { eaten_at: null, changed_at: "2999-01-01T00:00:00Z" } } }) });
    expect(stale.error).toBeNull();
    expect(stale.data.status).toBe("applied");
    const feed = (await feedSince(aClient, since)).filter((r) => r.entity_key === date);
    expect(feed).toHaveLength(1);
    expect(feed[0].current?.eaten_slots?.["meal-3"]).toEqual(mark);
  });

  it("refuses a forged consumed snapshot or history epoch on a slot that was never logged", async () => {
    const date = "2099-09-03";
    const row = await logRecipe(date);
    const mark = row.eaten_slots["meal-3"];
    const forgedConsumed = { ...mark, history_epoch: crypto.randomUUID() };
    const forgedEpoch = { eaten_at: mark.eaten_at, changed_at: mark.changed_at,
      history_epoch: crypto.randomUUID() };
    for (const forged of [forgedConsumed, forgedEpoch, mark]) {
      const result = await aClient.rpc("apply_sync_op", { p_user_id: a.id,
        p_op: op(date, row.rev, { eaten_slots: { ...row.eaten_slots, "meal-2": forged } }) });
      expect(result.error?.code).toBe("22023");
    }
    const day = await aClient.from("plan_days").select("eaten_slots,rev")
      .eq("local_date", date).single();
    expect(day.data?.rev).toBe(row.rev);
    expect(day.data?.eaten_slots).toEqual(row.eaten_slots);
    const fresh = await aClient.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { ...op("2099-09-04", 0, { eaten_slots: { "meal-1": forgedEpoch } }),
        kind: "create" } });
    expect(fresh.error?.code).toBe("22023");
    const none = await admin.from("plan_days").select("local_date")
      .eq("user_id", a.id).eq("local_date", "2099-09-04");
    expect(none.data).toEqual([]);
  });

  it("restores the logged mark after a direct owner or service-role erase", async () => {
    const date = "2099-09-05";
    const row = await logRecipe(date);
    const mark = row.eaten_slots["meal-3"];
    const owner = await aClient.from("plan_days").update({ eaten_slots: {} })
      .eq("user_id", a.id).eq("local_date", date).select("eaten_slots").single();
    expect(owner.error).toBeNull();
    expect(owner.data?.eaten_slots?.["meal-3"]).toEqual(mark);
    const service = await admin.from("plan_days").update({ eaten_slots: {
      "meal-3": { eaten_at: null, changed_at: "2999-01-01T00:00:00Z",
        history_epoch: mark.history_epoch } } })
      .eq("user_id", a.id).eq("local_date", date).select("eaten_slots").single();
    expect(service.error).toBeNull();
    expect(service.data?.eaten_slots?.["meal-3"]).toEqual(mark);
  });

  it("keeps another account away from this history", async () => {
    const date = "2099-09-06";
    const row = await logRecipe(date);
    const mark = row.eaten_slots["meal-3"];
    const state = await bClient.from("recipe_consumed_slot_state").select("*");
    expect(state.data ?? []).toEqual([]);
    const ownState = await aClient.from("recipe_consumed_slot_state").select("*");
    expect(ownState.data ?? []).toEqual([]);
    const undo = await bClient.rpc("recipe_undo_consumed", { p_request_id: crypto.randomUUID(),
      p_local_date: date, p_slot_id: "meal-3", p_expected_changed_at: mark.changed_at });
    expect(undo.error?.code).toBe("40001");
    const foreign = await bClient.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: op(date, row.rev, { eaten_slots: {} }) });
    expect(foreign.error).not.toBeNull();
    const feed = await bClient.rpc("sync_changes", { p_user_id: a.id, p_since: 0, p_limit: 10 });
    expect(feed.data ?? []).toEqual([]);
    const day = await admin.from("plan_days").select("eaten_slots,rev")
      .eq("user_id", a.id).eq("local_date", date).single();
    expect(day.data?.rev).toBe(row.rev);
    expect(day.data?.eaten_slots?.["meal-3"]).toEqual(mark);
  });
});
