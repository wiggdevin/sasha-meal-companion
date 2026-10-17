import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HAS_BRANCH, adminClient, userClient, type TestUser } from "../helpers/supabase";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { previewRecipe, acceptPreview } from "@/lib/server/recipe-plan";

// W085: the logged recipe version cannot change under a consumed meal, and two devices that log
// the same slot at once leave exactly one history entry.
const testUrl = process.env.SUPABASE_TEST_URL ?? "";
const LOCAL = HAS_BRANCH && (() => {
  try { return ["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname); }
  catch { return false; }
})();
const authorityDate = "2099-10-01";

type Mark = { eaten_at: string | null; changed_at: string; history_epoch?: string;
  consumed?: { baseMealId: string; title: string; components: unknown[] } };

describe.skipIf(!LOCAL)("recipe consumed history on a local test stack", () => {
  let a: TestUser; let admin: SupabaseClient;
  let tabOne: SupabaseClient; let tabTwo: SupabaseClient;
  let targetId = "";

  beforeAll(async () => {
    admin = adminClient();
    const email = `consumed-history-${crypto.randomUUID()}@meal-companion.test`;
    const password = `Local-${crypto.randomUUID()}-1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("Test user failed");
    a = { id: created.data.user.id, email, password };
    tabOne = await userClient(a); tabTwo = await userClient(a);
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
    expect((await admin.auth.admin.deleteUser(a.id)).error).toBeNull();
  });

  async function accept(date: string, slotId = "meal-3") {
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const preview = await previewRecipe(tabOne, a.id, root.data!.id,
      { date, slotId: slotId as "meal-3", servingFraction: 0.5 });
    const accepted = await acceptPreview(tabOne, a.id, preview.previewId,
      crypto.randomUUID(), true);
    return accepted.selections[0];
  }

  const logWith = (client: SupabaseClient, date: string, selection: { id: string;
    planRevision: number }, requestId = crypto.randomUUID()) =>
    client.rpc("recipe_log_consumed", { p_request_id: requestId, p_local_date: date,
      p_slot_id: "meal-3", p_selection_id: selection.id,
      p_plan_revision: selection.planRevision, p_actual_servings: 0.5 });

  async function requestCount(selectionId: string): Promise<number> {
    const rows = await admin.from("recipe_consumed_requests").select("request_id")
      .eq("user_id", a.id).eq("selection_id", selectionId);
    expect(rows.error).toBeNull();
    return rows.data!.length;
  }

  it("keeps the logged version when the catalog revision it came from is edited", async () => {
    const date = "2099-10-02";
    const selection = await accept(date);
    const logged = await logWith(tabOne, date, selection);
    expect(logged.error).toBeNull();
    const before = (logged.data.row.eaten_slots as Record<string, Mark>)["meal-3"];
    expect(before.consumed?.baseMealId).toMatch(/^recipe:/);

    const revisionId = before.consumed!.baseMealId.slice("recipe:".length);
    const edit = await admin.from("recipe_catalog_revisions")
      .update({ name: "Renamed after it was eaten" }).eq("id", revisionId);
    expect(edit.error?.code).toBe("23514");
    const removed = await admin.from("recipe_catalog_items").delete()
      .eq("recipe_revision_id", revisionId);
    expect(removed.error?.code).toBe("23514");

    const day = await admin.from("plan_days").select("eaten_slots,rev")
      .eq("user_id", a.id).eq("local_date", date).single();
    expect(day.data?.eaten_slots?.["meal-3"]).toEqual(before);
    expect(day.data?.rev).toBe(logged.data.row.rev);
  });

  it("makes one history entry when two tabs log the same slot with different requests", async () => {
    const date = "2099-10-03";
    const selection = await accept(date);
    const [first, second] = await Promise.all([
      logWith(tabOne, date, selection), logWith(tabTwo, date, selection)]);
    const outcomes = [first, second];
    expect(outcomes.filter((r) => !r.error)).toHaveLength(1);
    const loser = outcomes.find((r) => r.error)!;
    // nowait row lock while the other commits, or the eaten check once it has
    expect(["55P03", "40001"]).toContain(loser.error!.code);
    expect(await requestCount(selection.id)).toBe(1);
    const day = await admin.from("plan_days").select("eaten_slots")
      .eq("user_id", a.id).eq("local_date", date).single();
    const winner = outcomes.find((r) => !r.error)!;
    expect(day.data?.eaten_slots?.["meal-3"])
      .toEqual(winner.data.row.eaten_slots["meal-3"]);
  });

  it("settles one history entry when a tab and its retry race with the same request", async () => {
    const date = "2099-10-04";
    const selection = await accept(date);
    const requestId = crypto.randomUUID();
    const raced = await Promise.all([
      logWith(tabOne, date, selection, requestId), logWith(tabTwo, date, selection, requestId)]);
    expect(raced.some((r) => !r.error)).toBe(true);
    for (const r of raced.filter((x) => x.error)) {
      expect(["55P03", "40001"]).toContain(r.error!.code);
    }
    expect(await requestCount(selection.id)).toBe(1);
    const retry = await logWith(tabTwo, date, selection, requestId);
    expect(retry.error).toBeNull();
    expect(retry.data.replayed).toBe(true);
    const winner = raced.find((r) => !r.error)!;
    expect(retry.data.row.eaten_slots["meal-3"].history_epoch)
      .toBe(winner.data.row.eaten_slots["meal-3"].history_epoch);
  });
});
