import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HAS_BRANCH, HAS_DB, adminClient, pgEnvFromUrl, runSql, userClient, type TestUser }
  from "../helpers/supabase";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { adaptRecipeServing } from "@/lib/recipes/adapt";
import { previewRecipe, previewShopping, acceptPreview } from "@/lib/server/recipe-plan";
import { createLine, getPeriod, patchLine } from "@/lib/shopping/repository";
import { identityKey } from "@/lib/shopping/aggregate";

const testUrl = process.env.SUPABASE_TEST_URL ?? "";
const LOCAL = HAS_BRANCH && (() => {
  try { return ["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname); }
  catch { return false; }
})();
const LOCAL_DB = HAS_DB && (() => {
  try { return ["127.0.0.1", "localhost"].includes(
    new URL(process.env.SUPABASE_TEST_DB_URL ?? "").hostname); }
  catch { return false; }
})();
const authorityDate = "2099-04-01";
const expiresAt = () => new Date(Date.now() + 20 * 60_000).toISOString();

describe.skipIf(!LOCAL)("recipe proof RPCs on an approved local test stack", () => {
  let a: TestUser; let b: TestUser; let aClient: SupabaseClient;
  let bClient: SupabaseClient; let admin: SupabaseClient;
  let targetId = ""; let targetRev = 0;
  const previewIds: string[] = [];

  beforeAll(async () => {
    admin = adminClient();
    async function temporaryUser(): Promise<TestUser> {
      const email = `recipe-proof-${crypto.randomUUID()}@meal-companion.test`;
      const password = `Local-${crypto.randomUUID()}-1`;
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error || !result.data.user) throw result.error ?? new Error("Test user failed");
      return { id: result.data.user.id, email, password };
    }
    a = await temporaryUser(); b = await temporaryUser();
    aClient = await userClient(a); bClient = await userClient(b);
    const prior = await admin.from("target_profiles").select("rev")
      .eq("user_id", a.id).order("rev", { ascending: false }).limit(1);
    expect(prior.error).toBeNull();
    targetRev = Number(prior.data?.[0]?.rev ?? 0) + 1;
    const added = await admin.from("target_profiles").insert({ user_id: a.id,
      effective_from: authorityDate, rev: targetRev, kcal_train: 2000, kcal_rest: 2000,
      authored_by: "user", mode: "grams", protein_g: 120, fat_g: 70, carb_g: 200,
      protein_g_min: 120, training_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 },
      rest_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 } })
      .select("id").single();
    expect(added.error).toBeNull();
    targetId = added.data!.id;
  });

  afterAll(async () => {
    if (!admin || !a) return;
    for (const id of previewIds) {
      await admin.from("recipe_plan_previews").delete().eq("id", id).eq("user_id", a.id);
    }
    await admin.from("recipe_plan_selections").delete().eq("user_id", a.id);
    if (targetId) await admin.from("target_profiles").delete().eq("id", targetId);
    if (a?.id) expect((await admin.auth.admin.deleteUser(a.id)).error).toBeNull();
    if (b?.id) expect((await admin.auth.admin.deleteUser(b.id)).error).toBeNull();
  });

  async function issue(choices: unknown[] = []): Promise<string> {
    const state = await aClient.from("recipe_plan_state").select("rev")
      .eq("user_id", a.id).maybeSingle();
    expect(state.error).toBeNull();
    // W072: a preview's state rev is the account's rev plus the global catalog rev.
    const catalog = await aClient.from("recipe_catalog_clock").select("rev").eq("id", 1).single();
    expect(catalog.error).toBeNull();
    const withBaselines = await Promise.all(choices.map(async (choice) => {
      const row = choice as { localDate: string; slotId: string };
      const day = await aClient.from("plan_days").select("rev,swaps,item_overrides,eaten_slots")
        .eq("user_id", a.id).eq("local_date", row.localDate).maybeSingle();
      expect(day.error).toBeNull();
      return { ...row, slotBaseline: { dayRevision: day.data?.rev ?? 0,
        swap: day.data?.swaps?.[row.slotId] ?? null,
        override: day.data?.item_overrides?.[row.slotId] ?? null,
        eaten: day.data?.eaten_slots?.[row.slotId] ?? null } };
    }));
    const saved = await admin.rpc("recipe_store_preview", { p_user_id: a.id,
      p_kind: "recipe", p_state_rev: Number(state.data?.rev ?? 0) + Number(catalog.data!.rev),
      p_expires_at: expiresAt(), p_proof: { authorityDate,
        authority: { targetRevisionId: targetId, targetRevision: targetRev },
        choices: withBaselines, blockingIssues: [] } });
    expect(saved.error).toBeNull();
    previewIds.push(saved.data as string);
    return saved.data as string;
  }

  it("denies direct authenticated issuance of a forged nutrition proof", async () => {
    const forged = await aClient.rpc("recipe_store_preview", { p_user_id: a.id,
      p_kind: "recipe", p_state_rev: 0, p_expires_at: expiresAt(),
      p_proof: { authorityDate, authority: {}, choices: [{ nutritionSnapshot: {
        kcal: { value: 1_000_000 } } }], blockingIssues: [] } });
    expect(forged.error).not.toBeNull();
    expect(forged.data).toBeNull();
  });

  it("scopes proof and accept to owner, then replays only the same key", async () => {
    const id = await issue();
    const hidden = await bClient.from("recipe_plan_previews").select("id").eq("id", id);
    expect(hidden.data).toEqual([]);
    const other = await bClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(other.error?.code).toBe("P0002");
    const key = crypto.randomUUID();
    const first = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: key, p_accept_approximate: true });
    expect(first.error).toBeNull();
    const retry = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: key, p_accept_approximate: true });
    expect(retry.error).toBeNull();
    expect(retry.data).toEqual(first.data);
    const different = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(different.error?.code).toBe("40001");
  });

  it("rejects a stale proof after account rules or shared catalog change", async () => {
    const userProof = await issue();
    const profileId = `recipe-clock-${crypto.randomUUID()}`;
    try {
      const changed = await admin.from("user_dietary_profiles").insert({ user_id: a.id,
        profile_id: profileId, source: "user_stated", confirmed_at: new Date().toISOString(),
        rules: [] });
      expect(changed.error).toBeNull();
      const stale = await aClient.rpc("recipe_accept_preview", { p_preview_id: userProof,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true });
      expect(stale.error?.code).toBe("40001");
    } finally {
      await admin.from("user_dietary_profiles").delete().eq("user_id", a.id)
        .eq("profile_id", profileId);
    }
    const globalProof = await issue();
    const created = await admin.from("recipe_catalog").insert({
      slug: `recipe-clock-${crypto.randomUUID()}`,
      author: "Test", rights_kind: "original", rights_record: "Local clock test only",
      source_revision: "test", publication_state: "draft" }).select("id").single();
    expect(created.error).toBeNull();
    try {
      const stale = await aClient.rpc("recipe_accept_preview", { p_preview_id: globalProof,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true });
      expect(stale.error?.code).toBe("40001");
    } finally {
      await admin.from("recipe_catalog").delete().eq("id", created.data!.id);
    }
  });

  it.skipIf(!LOCAL_DB)("scopes private food ref clocks while concurrent owners edit foods", async () => {
    const aFood = crypto.randomUUID();
    const bFood = crypto.randomUUID();
    for (const [id, owner] of [[aFood, a.id], [bFood, b.id]]) {
      const added = await admin.from("user_foods").insert({ id, user_id: owner,
        name: `Clock food ${id}`, kind: "custom" });
      expect(added.error).toBeNull();
    }

    const unaffectedProof = await issue();
    const bRef = await admin.from("food_refs").insert({ kind: "user", user_food_id: bFood });
    expect(bRef.error).toBeNull();
    const unaffected = await aClient.rpc("recipe_accept_preview", {
      p_preview_id: unaffectedProof, p_request_id: crypto.randomUUID(),
      p_accept_approximate: true });
    expect(unaffected.error).toBeNull();

    const nextAFood = crypto.randomUUID();
    const nextBFood = crypto.randomUUID();
    for (const [id, owner] of [[nextAFood, a.id], [nextBFood, b.id]]) {
      const added = await admin.from("user_foods").insert({ id, user_id: owner,
        name: `Concurrent food ${id}`, kind: "custom" });
      expect(added.error).toBeNull();
    }
    const ownProof = await issue();
    // Both transactions first hold their own account clock, then create their
    // private refs. The former global food_refs trigger deadlocked here.
    async function editAndAddRef(foodId: string): Promise<void> {
      const sql = `begin; set local lock_timeout = '5s';
        update public.user_foods set name = name || ' edited' where id = '${foodId}';
        select pg_sleep(0.6);
        insert into public.food_refs(kind, user_food_id) values ('user', '${foodId}');
        commit;`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
          env: { ...process.env, ...pgEnvFromUrl(process.env.SUPABASE_TEST_DB_URL!) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let errors = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
      });
    }
    await Promise.all([editAndAddRef(nextAFood), editAndAddRef(nextBFood)]);
    const staleOwn = await aClient.rpc("recipe_accept_preview", { p_preview_id: ownProof,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(staleOwn.error?.code).toBe("40001");

    const catalogProof = await issue();
    const catalog = await admin.from("catalog_foods").insert({
      source: "fdc_branded", source_id: `clock-${crypto.randomUUID()}` }).select("id").single();
    expect(catalog.error).toBeNull();
    const catalogRef = await admin.from("food_refs").insert({
      kind: "catalog", catalog_food_id: catalog.data!.id }).select("id").single();
    expect(catalogRef.error).toBeNull();
    const staleShared = await aClient.rpc("recipe_accept_preview", { p_preview_id: catalogProof,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(staleShared.error?.code).toBe("40001");
    expect((await admin.from("food_refs").delete().eq("id", catalogRef.data!.id)).error).toBeNull();
    expect((await admin.from("catalog_foods").delete().eq("id", catalog.data!.id)).error).toBeNull();
  });

  it("rejects a choice after an already scheduled target transition", async () => {
    const later = await admin.from("target_profiles").insert({ user_id: a.id,
      effective_from: "2099-04-02", rev: targetRev + 1,
      kcal_train: 2200, kcal_rest: 2200, authored_by: "user", mode: "grams",
      protein_g: 120, fat_g: 70, carb_g: 250, protein_g_min: 120,
      training_macros: { kcal: 2200, protein: 120, fat: 70, carbs: 250 },
      rest_macros: { kcal: 2200, protein: 120, fat: 70, carbs: 250 } })
      .select("id").single();
    expect(later.error).toBeNull();
    try {
      const id = await issue([{ localDate: "2099-04-02", slotId: "meal-1" }]);
      const result = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true });
      expect(result.error?.code).toBe("40001");
      expect(result.error?.message).toMatch(/target changed for meal date/);
    } finally {
      await admin.from("target_profiles").delete().eq("id", later.data!.id);
    }
  });

  it("rejects a stale slot version against a real published recipe", async () => {
    await seedPilotCatalog(admin);
    const root = await admin.from("recipe_catalog")
      .select("id,current_revision_id").eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const id = await issue([{ localDate: authorityDate, slotId: "meal-1",
      recipeId: root.data!.id, recipeRevisionId: root.data!.current_revision_id,
      servingFraction: 1, expectedPlanRevision: 9, evidenceIssues: [] }]);
    const result = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(result.error?.code).toBe("40001");
    expect(result.error?.message).toMatch(/plan selection changed/);
  });

  it("commits a real portion with the same ingredient ratios and line nutrition", async () => {
    await seedPilotCatalog(admin);
    const root = await admin.from("recipe_catalog")
      .select("id,current_revision_id").eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const id = await issue([{ localDate: authorityDate, slotId: "meal-2",
      recipeId: root.data!.id, recipeRevisionId: root.data!.current_revision_id,
      servingFraction: 0.5, expectedPlanRevision: 0, evidenceIssues: [] }]);
    const accepted = await aClient.rpc("recipe_accept_preview", { p_preview_id: id,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(accepted.error).toBeNull();
    const row = accepted.data.selections[0];
    const pilot = pilotRecipes().find((recipe) => recipe.recipeId === "beef-tomato-vegetable-stew")!;
    const expected = adaptRecipeServing(pilot, 0.5, { retainedFractionBySeq: {} });
    expect(row.ingredient_snapshot.map((line: { quantity: number }) => Number(line.quantity)))
      .toEqual(expected.lines.map((line) => line.quantity));
    expect(row.ingredient_snapshot[0].nutritionEvidence.kcal.sourceKey)
      .toBe(expected.lines[0].nutritionEvidence?.kcal.sourceKey);
    expect(Number(row.nutrition_snapshot.kcal.value)).toBeCloseTo(expected.nutrition.kcal.value!, 4);
    const hidden = await bClient.from("recipe_plan_selections").select("id").eq("id", row.id);
    expect(hidden.data).toEqual([]);
    const cleared = await admin.from("plan_days").insert({ user_id: a.id,
      local_date: authorityDate, item_overrides: { "meal-2": {
        baseMealId: `recipe:${root.data!.current_revision_id}`, components: [], cleared: true } } });
    expect(cleared.error).toBeNull();
    const superseded = await aClient.from("recipe_plan_selections")
      .select("superseded_at").eq("id", row.id).single();
    expect(superseded.error).toBeNull();
    expect(superseded.data?.superseded_at).not.toBeNull();
  });

  it("supersedes a captured clear, ignores its delayed replay, and retires a later edit", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-04-03";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const clear = { baseMealId: "old-meal", components: [], cleared: true };
    const added = await admin.from("plan_days").insert({ user_id: a.id, local_date: date,
      item_overrides: { "meal-1": clear }, slot_notes: { "meal-2": "Keep this" } });
    expect(added.error).toBeNull();
    const preview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-1", servingFraction: 0.5 });
    const accepted = await acceptPreview(aClient, a.id, preview.previewId, crypto.randomUUID(), true);
    expect(accepted.selections[0].baselineOverride).toEqual(clear);
    const replay = await admin.from("plan_days").update({ item_overrides: { "meal-1": clear },
      slot_notes: { "meal-2": "Keep this", "meal-3": "Offline note" }, rev: 2 })
      .eq("user_id", a.id).eq("local_date", date);
    expect(replay.error).toBeNull();
    const afterReplay = await aClient.from("recipe_plan_selections").select("superseded_at")
      .eq("id", accepted.selections[0].id).single();
    expect(afterReplay.data?.superseded_at).toBeNull();
    const edited = await admin.from("plan_days").update({ item_overrides: {
      "meal-1": { baseMealId: "new-meal", components: [], cleared: true } }, rev: 3 })
      .eq("user_id", a.id).eq("local_date", date);
    expect(edited.error).toBeNull();
    const afterEdit = await aClient.from("recipe_plan_selections").select("superseded_at")
      .eq("id", accepted.selections[0].id).single();
    expect(afterEdit.data?.superseded_at).not.toBeNull();
  });

  it("keeps a delayed captured clear but retires a new byte-identical clear intent", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-04-05";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const old = { baseMealId: "old-meal", components: [], cleared: true,
      mutationId: crypto.randomUUID() };
    const inserted = await admin.from("plan_days").insert({ user_id: a.id, local_date: date,
      item_overrides: { "meal-1": old } });
    expect(inserted.error).toBeNull();
    const preview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-1", servingFraction: 0.5 });
    const accepted = await acceptPreview(aClient, a.id, preview.previewId, crypto.randomUUID(), true);
    expect(accepted.selections[0].baselineOverride).toEqual(old);
    const replay = await admin.from("plan_days").update({
      item_overrides: { "meal-1": old }, slot_notes: { "meal-2": "Later note" }, rev: 2,
    }).eq("user_id", a.id).eq("local_date", date);
    expect(replay.error).toBeNull();
    const afterReplay = await aClient.from("recipe_plan_selections").select("superseded_at")
      .eq("id", accepted.selections[0].id).single();
    expect(afterReplay.data?.superseded_at).toBeNull();
    const timeOnly = await admin.from("plan_days").update({
      item_overrides: { "meal-1": { ...old, time: "13:15" } }, rev: 3,
    }).eq("user_id", a.id).eq("local_date", date);
    expect(timeOnly.error).toBeNull();
    const afterTime = await aClient.from("recipe_plan_selections").select("superseded_at")
      .eq("id", accepted.selections[0].id).single();
    expect(afterTime.data?.superseded_at).toBeNull();
    const next = { ...old, mutationId: crypto.randomUUID() };
    const newClear = await admin.from("plan_days").update({
      item_overrides: { "meal-1": next }, rev: 4,
    }).eq("user_id", a.id).eq("local_date", date);
    expect(newClear.error).toBeNull();
    const afterNewClear = await aClient.from("recipe_plan_selections").select("superseded_at")
      .eq("id", accepted.selections[0].id).single();
    expect(afterNewClear.data?.superseded_at).not.toBeNull();
  });

  it("rejects tab A's stale consumed write after tab B accepts a newer selection", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-04-06";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const firstPreview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-3", servingFraction: 0.5 });
    const first = await acceptPreview(aClient, a.id, firstPreview.previewId,
      crypto.randomUUID(), true);
    const opened = first.selections[0];
    const secondTab = await userClient(a);
    const replacementPreview = await previewRecipe(secondTab, a.id, root.data!.id,
      { date, slotId: "meal-3", servingFraction: 1 });
    const second = await acceptPreview(secondTab, a.id, replacementPreview.previewId,
      crypto.randomUUID(), true);
    const current = second.selections[0];
    expect(current.planRevision).toBe(opened.planRevision + 1);
    const requestId = crypto.randomUUID();
    const stale = await aClient.rpc("recipe_log_consumed", { p_request_id: requestId,
      p_local_date: date, p_slot_id: "meal-3", p_selection_id: opened.id,
      p_plan_revision: opened.planRevision, p_actual_servings: 0.25 });
    expect(stale.error?.code).toBe("40001");
    const before = await admin.from("plan_days").select("eaten_slots")
      .eq("user_id", a.id).eq("local_date", date).maybeSingle();
    expect(before.error).toBeNull();
    expect(before.data?.eaten_slots?.["meal-3"]).toBeUndefined();
    const cursorRows = await secondTab.rpc("sync_changes", { p_user_id: a.id,
      p_since: 0, p_limit: 500 });
    expect(cursorRows.error).toBeNull();
    const cursor = Math.max(0, ...cursorRows.data.map((row: { seq: number }) => row.seq));
    const saved = await aClient.rpc("recipe_log_consumed", { p_request_id: requestId,
      p_local_date: date, p_slot_id: "meal-3", p_selection_id: current.id,
      p_plan_revision: current.planRevision, p_actual_servings: 0.25 });
    expect(saved.error).toBeNull();
    expect(saved.data.row.eaten_slots["meal-3"].consumed.components[0].qty).toBe(0.25);
    expect(saved.data.row.eaten_slots["meal-3"].history_epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.data.row.item_overrides).toEqual({});
    const pulled = await secondTab.rpc("sync_changes", { p_user_id: a.id,
      p_since: cursor, p_limit: 500 });
    expect(pulled.error).toBeNull();
    expect(pulled.data).toEqual(expect.arrayContaining([expect.objectContaining({
      entity: "plan_days", entity_key: date,
      current: expect.objectContaining({ eaten_slots: expect.objectContaining({
        "meal-3": expect.objectContaining({ consumed: expect.any(Object) }),
      }) }),
    })]));
    const replay = await secondTab.rpc("recipe_log_consumed", { p_request_id: requestId,
      p_local_date: date, p_slot_id: "meal-3", p_selection_id: current.id,
      p_plan_revision: current.planRevision, p_actual_servings: 0.25 });
    expect(replay.error).toBeNull();
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.row.rev).toBe(saved.data.row.rev);
    const duplicate = await secondTab.rpc("recipe_log_consumed", { p_request_id: crypto.randomUUID(),
      p_local_date: date, p_slot_id: "meal-3", p_selection_id: current.id,
      p_plan_revision: current.planRevision, p_actual_servings: 0.25 });
    expect(duplicate.error?.code).toBe("40001");
    const mark = saved.data.row.eaten_slots["meal-3"];
    const staleMark = { eaten_at: null, changed_at: "2999-01-01T00:00:00Z" };
    const staleConflict = await secondTab.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: "update", base_rev: saved.data.row.rev - 1,
        payload: { eaten_slots: { "meal-3": staleMark } }, client_ts: new Date().toISOString() } });
    expect(staleConflict.error).toBeNull();
    expect(staleConflict.data.status).toBe("conflict");
    const staleApplied = await secondTab.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: "update", base_rev: saved.data.row.rev,
        payload: { eaten_slots: { "meal-3": staleMark }, slot_notes: { "meal-1": "Later" } },
        client_ts: new Date().toISOString() } });
    expect(staleApplied.error).toBeNull();
    expect(staleApplied.data.status).toBe("applied");
    const protectedDay = await secondTab.from("plan_days").select("eaten_slots,slot_notes,rev")
      .eq("local_date", date).single();
    expect(protectedDay.error).toBeNull();
    expect(protectedDay.data?.eaten_slots?.["meal-3"]).toEqual(mark);
    expect(protectedDay.data?.slot_notes?.["meal-1"]).toBe("Later");
    const undoId = crypto.randomUUID();
    const undone = await aClient.rpc("recipe_undo_consumed", { p_request_id: undoId,
      p_local_date: date, p_slot_id: "meal-3", p_expected_changed_at: mark.changed_at });
    expect(undone.error).toBeNull();
    expect(undone.data.row.eaten_slots["meal-3"]).toMatchObject({ eaten_at: null,
      history_epoch: expect.any(String) });
    const undoReplay = await secondTab.rpc("recipe_undo_consumed", { p_request_id: undoId,
      p_local_date: date, p_slot_id: "meal-3", p_expected_changed_at: mark.changed_at });
    expect(undoReplay.error).toBeNull();
    expect(undoReplay.data.replayed).toBe(true);
    expect(undoReplay.data.row.rev).toBe(undone.data.row.rev);
    const undoFeed = await secondTab.rpc("sync_changes", { p_user_id: a.id,
      p_since: Math.max(...pulled.data.map((row: { seq: number }) => row.seq)), p_limit: 500 });
    expect(undoFeed.error).toBeNull();
    expect(undoFeed.data.at(-1)?.current?.eaten_slots?.["meal-3"]?.eaten_at).toBeNull();
    const resurrect = await secondTab.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: "update", base_rev: undone.data.row.rev,
        payload: { eaten_slots: { "meal-3": mark } }, client_ts: new Date().toISOString() } });
    expect(resurrect.error).toBeNull();
    expect(resurrect.data.status).toBe("applied");
    const afterResurrect = await secondTab.from("plan_days").select("eaten_slots,rev")
      .eq("local_date", date).single();
    expect(afterResurrect.data?.eaten_slots?.["meal-3"]).toEqual(undone.data.row.eaten_slots["meal-3"]);
    const ordinary = { eaten_at: new Date(Date.now() + 60_000).toISOString(),
      changed_at: new Date(Date.now() + 60_000).toISOString(),
      history_epoch: undone.data.row.eaten_slots["meal-3"].history_epoch };
    const ordinaryTick = await secondTab.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: "update", base_rev: afterResurrect.data!.rev,
        payload: { eaten_slots: { "meal-3": ordinary } }, client_ts: new Date().toISOString() } });
    expect(ordinaryTick.error).toBeNull();
    expect(ordinaryTick.data.status).toBe("applied");
    const afterOrdinary = await secondTab.from("plan_days").select("eaten_slots,rev")
      .eq("local_date", date).single();
    expect(afterOrdinary.data?.eaten_slots?.["meal-3"]).toEqual(ordinary);
    const lateConsumed = await secondTab.rpc("apply_sync_op", { p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: "update", base_rev: afterOrdinary.data!.rev,
        payload: { eaten_slots: { "meal-3": mark } }, client_ts: new Date().toISOString() } });
    expect(lateConsumed.error).toBeNull();
    expect(lateConsumed.data.status).toBe("applied");
    const finalDay = await secondTab.from("plan_days").select("eaten_slots")
      .eq("local_date", date).single();
    expect(finalDay.data?.eaten_slots?.["meal-3"]).toEqual(ordinary);
    const oldRetry = await aClient.rpc("recipe_log_consumed", { p_request_id: requestId,
      p_local_date: date, p_slot_id: "meal-3", p_selection_id: current.id,
      p_plan_revision: current.planRevision, p_actual_servings: 0.25 });
    expect(oldRetry.error?.code).toBe("40001");
  });

  it("does not replay an undone request as a later identical serving", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-04-07";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const preview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-3", servingFraction: 0.5 });
    const accepted = await acceptPreview(aClient, a.id, preview.previewId,
      crypto.randomUUID(), true);
    const selection = accepted.selections[0];
    const log = (requestId: string) => aClient.rpc("recipe_log_consumed", {
      p_request_id: requestId, p_local_date: date, p_slot_id: "meal-3",
      p_selection_id: selection.id, p_plan_revision: selection.planRevision,
      p_actual_servings: 0.25,
    });
    const firstId = crypto.randomUUID();
    const first = await log(firstId);
    expect(first.error).toBeNull();
    const undo = await aClient.rpc("recipe_undo_consumed", {
      p_request_id: crypto.randomUUID(), p_local_date: date, p_slot_id: "meal-3",
      p_expected_changed_at: first.data.row.eaten_slots["meal-3"].changed_at,
    });
    expect(undo.error).toBeNull();
    const secondId = crypto.randomUUID();
    const second = await log(secondId);
    expect(second.error).toBeNull();
    expect(second.data.row.eaten_slots["meal-3"].consumed)
      .toEqual(first.data.row.eaten_slots["meal-3"].consumed);
    expect(second.data.row.eaten_slots["meal-3"].history_epoch)
      .not.toBe(first.data.row.eaten_slots["meal-3"].history_epoch);
    const oldRetry = await log(firstId);
    expect(oldRetry.error?.code).toBe("40001");
    const currentRetry = await log(secondId);
    expect(currentRetry.error).toBeNull();
    expect(currentRetry.data.replayed).toBe(true);
    expect(currentRetry.data.row.rev).toBe(second.data.row.rev);
  });

  it("rejects a changed slot after a fresh preview of its clear", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-04-04";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const inserted = await admin.from("plan_days").insert({ user_id: a.id, local_date: date,
      item_overrides: { "meal-1": { baseMealId: "old-meal", components: [], cleared: true } } });
    expect(inserted.error).toBeNull();
    const preview = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-1", servingFraction: 0.5 });
    const changed = await admin.from("plan_days").update({ item_overrides: {
      "meal-1": { baseMealId: "new-meal", components: [], cleared: true } }, rev: 2 })
      .eq("user_id", a.id).eq("local_date", date);
    expect(changed.error).toBeNull();
    const accept = await aClient.rpc("recipe_accept_preview", { p_preview_id: preview.previewId,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(accept.error?.code).toBe("40001");
  });

  it("accepts seven real pilot dinners with fractional servings and unknown cooked conversion", async () => {
    await seedPilotCatalog(admin);
    const draft = { startDate: "2099-06-01", endDate: "2099-06-07",
      timezone: "America/Denver", people: 1, mealCoverage: ["meal-3"],
      mode: "balanced" as const, effort: "standard" as const,
      maxActiveMinutes: null, variety: "balanced" as const,
      budgetAmount: null, currency: "USD", locale: "US-CO",
      lockMode: "none" as const };
    const preview = await previewShopping(aClient, a.id, { draft, basket: [] });
    expect(preview.blockingIssues).toEqual([]);
    expect(preview.choices).toHaveLength(7);
    expect(preview.replenishment[0].lines.some((row) => row.needGrams === null
      && row.confirmedStockGrams === null && row.buyGrams === null)).toBe(true);
    const accepted = await acceptPreview(aClient, a.id, preview.previewId, crypto.randomUUID(), true);
    expect(accepted.selections).toHaveLength(7);
    expect(accepted.purchaseWindows.length).toBeGreaterThan(0);
  });

  it.skipIf(!LOCAL_DB)("avoids lock cycles with period, line, pantry, target and day writers", async () => {
    await seedPilotCatalog(admin);
    const draft = { startDate: "2099-08-01", endDate: "2099-08-07",
      timezone: "America/Denver", people: 1, mealCoverage: ["meal-1"],
      mode: "balanced" as const, effort: "standard" as const,
      maxActiveMinutes: null, variety: "balanced" as const,
      budgetAmount: null, currency: "USD", locale: "US-CO", lockMode: "none" as const };
    const day = await admin.from("plan_days").insert({ user_id: a.id,
      local_date: draft.startDate });
    expect(day.error).toBeNull();
    const first = await previewShopping(aClient, a.id, { draft, basket: [] });
    const accepted = await acceptPreview(aClient, a.id, first.previewId, crypto.randomUUID(), true);
    const periodId = accepted.period!.id;
    const lineId = accepted.lines[0].id;
    const pantry = await admin.from("shopping_pantry").insert({ user_id: a.id,
      name: "race stock", identity: { foodRefId: null, foodDbId: `race-${crypto.randomUUID()}`,
        catalogFoodRevisionId: null, purchaseState: "raw", variantKey: "raw" },
      confirmed_grams: 1 }).select("id").single();
    expect(pantry.error).toBeNull();

    async function competingWrite(lockSql: string, writeSql: string, previewId: string) {
      const child = spawn("psql", ["-At", "-v", "ON_ERROR_STOP=1"], {
        env: { ...process.env, ...pgEnvFromUrl(process.env.SUPABASE_TEST_DB_URL!) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = ""; let errors = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
      const locked = new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("LOCKED")) resolve();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (!output.includes("LOCKED")) reject(new Error(`Lock writer exited ${code}: ${errors}`));
        });
      });
      const finished = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.stdin.end(`begin; ${lockSql} select 'LOCKED'; select pg_sleep(0.5); ${writeSql} commit;\n`);
      await locked;
      const result = await aClient.rpc("recipe_accept_preview", { p_preview_id: previewId,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true });
      expect(result.error?.code).not.toBe("40P01");
      expect([undefined, "40001", "55P03"]).toContain(result.error?.code);
      expect(await finished).toBe(0);
      expect(errors).toBe("");
    }

    const blockers = [
      [`select id from public.shopping_periods where id='${periodId}' for update;`,
        `update public.shopping_periods set updated_at=clock_timestamp() where id='${periodId}';`],
      [`select id from public.shopping_lines where id='${lineId}' for update;`,
        `update public.shopping_lines set note='race writer' where id='${lineId}';`],
      [`select id from public.shopping_pantry where id='${pantry.data!.id}' for update;`,
        `update public.shopping_pantry set name='race writer' where id='${pantry.data!.id}';`],
      [`select id from public.target_profiles where id='${targetId}' for update;`,
        `update public.target_profiles set kcal_train=kcal_train where id='${targetId}';`],
      [`select local_date from public.plan_days where user_id='${a.id}' and local_date='${draft.startDate}' for update;`,
        `update public.plan_days set slot_notes='{"meal-2":"race writer"}'::jsonb
          where user_id='${a.id}' and local_date='${draft.startDate}';`],
    ];
    for (const [lockSql, writeSql] of blockers) {
      const current = await getPeriod(aClient, a.id, periodId);
      const preview = await previewShopping(aClient, a.id, { periodId,
        expectedRevision: current.period.revision, draft, basket: [] });
      await competingWrite(lockSql, writeSql, preview.previewId);
    }
  }, 20_000);

  it("accepts dated purchases and preserves a checked first week on equal replan", async () => {
    await seedPilotCatalog(admin);
    const draft = { startDate: "2099-05-01", endDate: "2099-05-08",
      timezone: "America/Denver", people: 1, mealCoverage: ["meal-1"],
      mode: "balanced" as const, effort: "standard" as const,
      maxActiveMinutes: null, variety: "repeat_friendly" as const,
      budgetAmount: null, currency: "USD", locale: "US-CO",
      lockMode: "none" as const };
    const initial = await previewShopping(aClient, a.id, { draft, basket: [] });
    expect(initial.blockingIssues).toEqual([]);
    expect(initial.replenishment).toHaveLength(2);
    const common = initial.replenishment[0].lines.find((row) => row.needGrams !== null
      && row.needGrams > 0 && initial.replenishment[1].lines.some((next) =>
        next.lineId === row.lineId && next.needGrams !== null && next.needGrams > 0));
    expect(common).toBeDefined();
    const identity = initial.lines.find((line) => line.id === common!.lineId)!.identity!;
    const pantry = await admin.from("shopping_pantry").insert({ user_id: a.id,
      name: "dated stock", identity, confirmed_grams: common!.needGrams }).select("id").single();
    expect(pantry.error).toBeNull();
    const first = await previewShopping(aClient, a.id, { draft, basket: [] });
    const firstLine = first.lines.find((line) => line.identity
      && identityKey(line.identity) === identityKey(identity))!;
    const dates = first.replenishment.map((row) => row.lines.find((line) =>
      line.lineId === firstLine.id)!);
    expect(dates[0].confirmedStockGrams).toBe(dates[0].needGrams);
    expect(dates[0].buyGrams).toBe(0);
    expect(dates[1].confirmedStockGrams).toBe(0);
    expect(dates[1].buyGrams).toBeNull();
    const stale = await aClient.rpc("recipe_accept_preview", { p_preview_id: initial.previewId,
      p_request_id: crypto.randomUUID(), p_accept_approximate: true });
    expect(stale.error?.code).toBe("40001");
    const proof = await admin.from("recipe_plan_previews").select("proof,state_rev")
      .eq("id", first.previewId).single();
    expect(proof.error).toBeNull();
    const forged = structuredClone(proof.data!.proof) as {
      replenishment: { lines: { needGrams: number | null }[] }[] };
    const firstDated = forged.replenishment.find((row) => row.lines.length > 0)!;
    firstDated.lines[0].needGrams = (firstDated.lines[0].needGrams ?? 0) + 1;
    const forgedProof = await admin.rpc("recipe_store_preview", { p_user_id: a.id,
      p_kind: "shopping", p_proof: forged, p_state_rev: proof.data!.state_rev,
      p_expires_at: expiresAt() });
    expect(forgedProof.error).toBeNull();
    const forgedAccept = await aClient.rpc("recipe_accept_preview", {
      p_preview_id: forgedProof.data, p_request_id: crypto.randomUUID(),
      p_accept_approximate: true });
    expect(forgedAccept.error?.code).toBe("22023");
    const overlap = structuredClone(proof.data!.proof) as {
      replenishment: { window: { startDate: string } }[] };
    overlap.replenishment[1].window.startDate = overlap.replenishment[0].window.startDate;
    const overlapProof = await admin.rpc("recipe_store_preview", { p_user_id: a.id,
      p_kind: "shopping", p_proof: overlap, p_state_rev: proof.data!.state_rev,
      p_expires_at: expiresAt() });
    expect(overlapProof.error).toBeNull();
    const overlapAccept = await aClient.rpc("recipe_accept_preview", {
      p_preview_id: overlapProof.data, p_request_id: crypto.randomUUID(),
      p_accept_approximate: true });
    expect(overlapAccept.error?.code).toBe("22023");
    const accepted = await acceptPreview(aClient, a.id, first.previewId, crypto.randomUUID(), true);
    expect(accepted.purchaseWindows.length).toBeGreaterThan(0);
    const root = accepted.period!;
    const ingredient = accepted.lines.find((line) => line.identity
      && identityKey(line.identity) === identityKey(identity))!;
    const pinned = await patchLine(aClient, a.id, root.id, ingredient.id,
      ingredient.revision, crypto.randomUUID(), { pinned: true });
    expect(pinned.pinned).toBe(true);
    const manual = await createLine(aClient, a.id, root.id, { origin: "manual",
      name: "Dish soap", identity: null, category: "manual", needGrams: null,
      confirmedStockGrams: null, buyGrams: null, packageGrams: null,
      purchaseConversionStatus: "unknown", sources: [], pinned: false,
      checked: true, note: "Unscented" }, crypto.randomUUID());
    const week1 = accepted.purchaseWindows.find((row) => row.lineId ===
      accepted.lines.find((line) => line.identity
        && identityKey(line.identity) === identityKey(identity))?.id
      && row.windowStartDate === draft.startDate)!;
    const week2 = accepted.purchaseWindows.find((row) => row.lineId === week1.lineId
      && row.windowStartDate === "2099-05-08")!;
    expect(week2.buyGrams).toBeNull();
    const marked = await aClient.rpc("shopping_patch_purchase_window", { p_period_id: root.id,
      p_window_id: week1.id, p_expected_revision: week1.revision,
      p_request_id: crypto.randomUUID(), p_patch: { checked: true, note: "already bought" } });
    expect(marked.error).toBeNull();
    expect(marked.data.status).toBe("ok");
    const markedUnknown = await aClient.rpc("shopping_patch_purchase_window", { p_period_id: root.id,
      p_window_id: week2.id, p_expected_revision: week2.revision,
      p_request_id: crypto.randomUUID(), p_patch: { checked: true, note: "size at store" } });
    expect(markedUnknown.error).toBeNull();
    expect(markedUnknown.data.status).toBe("ok");
    const editedRev = Number(marked.data.purchaseWindow.rev);
    const again = await previewShopping(aClient, a.id, { periodId: root.id,
      expectedRevision: root.revision, draft, basket: [] });
    expect(again.blockingIssues).toEqual([]);
    const second = await acceptPreview(aClient, a.id, again.previewId, crypto.randomUUID(), true);
    expect(second.purchaseWindows.length).toBeGreaterThan(0);
    expect(second.lines.find((line) => line.id === ingredient.id)?.pinned).toBe(true);
    expect(second.lines.find((line) => line.id === manual.id))
      .toMatchObject({ origin: "manual", checked: true, note: "Unscented" });
    const kept = second.purchaseWindows.find((row) => row.id === week1.id)!;
    expect(kept).toMatchObject({ checked: true, note: "already bought", revision: editedRev });
    expect(second.purchaseWindows.find((row) => row.id === week2.id))
      .toMatchObject({ checked: true, note: "size at store", buyGrams: null,
        revision: Number(markedUnknown.data.purchaseWindow.rev) });
    const racing = await previewShopping(aClient, a.id, { periodId: root.id,
      expectedRevision: second.period!.revision, draft, basket: [] });
    const [editRace, acceptRace] = await Promise.all([
      aClient.rpc("shopping_patch_purchase_window", { p_period_id: root.id,
        p_window_id: week1.id, p_expected_revision: kept.revision,
        p_request_id: crypto.randomUUID(), p_patch: { note: "race edit" } }),
      aClient.rpc("recipe_accept_preview", { p_preview_id: racing.previewId,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true }),
    ]);
    expect(editRace.error?.code).not.toBe("40P01");
    expect(acceptRace.error?.code).not.toBe("40P01");
    expect(editRace.error).toBeNull();
    expect([undefined, "40001"]).toContain(acceptRace.error?.code);
    const afterRace = await getPeriod(aClient, a.id, root.id);
    const raised = await previewShopping(aClient, a.id, { periodId: root.id,
      expectedRevision: afterRace.period.revision, draft: { ...draft, people: 2 }, basket: [] });
    const increased = await acceptPreview(aClient, a.id, raised.previewId, crypto.randomUUID(), true);
    const reset = increased.purchaseWindows.find((row) => row.id === week1.id)!;
    expect(reset.needGrams).toBeGreaterThan(kept.needGrams!);
    expect(reset).toMatchObject({ checked: false, note: null });
    expect(reset.revision).toBeGreaterThan(kept.revision);
    const lateEdit = await aClient.rpc("shopping_patch_purchase_window", { p_period_id: root.id,
      p_window_id: week1.id, p_expected_revision: editedRev,
      p_request_id: crypto.randomUUID(), p_patch: { checked: true } });
    expect(lateEdit.data.status).toBe("stale_revision");
    const oldPlanLine = await admin.from("shopping_lines").insert({ user_id: a.id,
      period_id: root.id, origin: "plan", name: "old checked plan item",
      identity: { foodRefId: null, foodDbId: `retired-${crypto.randomUUID()}`,
        catalogFoodRevisionId: null, purchaseState: "raw", variantKey: "raw" },
      category: "core", need_grams: 10, confirmed_stock_grams: 0,
      buy_grams: null, purchase_conversion_status: "known", checked: true,
      note: "keep this purchase", sources: [] }).select("id").single();
    expect(oldPlanLine.error).toBeNull();
    const oldWindow = await admin.from("shopping_purchase_windows").insert({
      user_id: a.id, period_id: root.id, line_id: oldPlanLine.data!.id,
      window_start_date: draft.startDate, window_end_date: "2099-05-07",
      need_grams: 10, confirmed_stock_grams: 0, buy_grams: null,
      checked: true, note: "old dated note" }).select("id").single();
    expect(oldWindow.error).toBeNull();
    const shorter = await previewShopping(aClient, a.id, { periodId: root.id,
      expectedRevision: increased.period!.revision,
      draft: { ...draft, people: 2, endDate: "2099-05-07" }, basket: [] });
    const shortened = await acceptPreview(aClient, a.id, shorter.previewId, crypto.randomUUID(), true);
    expect(shortened.purchaseWindows.every((row) => row.windowStartDate === draft.startDate)).toBe(true);
    expect(shortened.lines.find((line) => line.id === oldPlanLine.data!.id))
      .toMatchObject({ origin: "manual", checked: true, note: "keep this purchase" });
    const retired = await admin.from("shopping_purchase_windows").select("deleted_at")
      .eq("id", oldWindow.data!.id).single();
    expect(retired.error).toBeNull();
    expect(retired.data?.deleted_at).not.toBeNull();
    const stored = await getPeriod(aClient, a.id, root.id);
    expect(stored?.purchaseWindows.length).toBe(shortened.purchaseWindows.length);
    expect(stored.lines.find((line) => line.id === ingredient.id)?.pinned).toBe(true);
    expect(stored.lines.find((line) => line.id === manual.id))
      .toMatchObject({ origin: "manual", checked: true, note: "Unscented" });
    const hidden = await bClient.from("shopping_purchase_windows").select("id")
      .eq("period_id", root.id);
    expect(hidden.data).toEqual([]);
    const hiddenLines = await bClient.from("shopping_lines").select("id")
      .eq("period_id", root.id);
    expect(hiddenLines.data).toEqual([]);
    // Account deletion must also cascade through the user-specific evidence
    // trigger without trying to recreate a state row for a departed user.
    const evidence = await admin.from("food_allergen_evidence").insert({
      food_key: `user_food:${crypto.randomUUID()}:1`, allergen: "soy",
      level: "no_evidence", label_complete: false, source: "legacy", user_id: a.id });
    expect(evidence.error).toBeNull();
  });

  it.skipIf(!LOCAL_DB)("blocks a withdrawn recipe inside the accept transaction", async () => {
    await seedPilotCatalog(admin);
    const root = await admin.from("recipe_catalog")
      .select("id,current_revision_id").eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const id = await issue([{ localDate: authorityDate, slotId: "meal-1",
      recipeId: root.data!.id, recipeRevisionId: root.data!.current_revision_id,
      servingFraction: 1, expectedPlanRevision: 0, evidenceIssues: [] }]);
    // Roll back the withdrawal and all test writes. The authenticated accept
    // runs after withdrawal in the same transaction, so no published row leaks.
    const output = runSql(`begin;
      create temporary table recipe_outcome(code text);
      grant insert, select on recipe_outcome to authenticated;
      update public.recipe_catalog set publication_state='withdrawn',
        withdrawal_reason='local transactional test' where id='${root.data!.id}';
      set role authenticated;
      select set_config('request.jwt.claims',
        '{"sub":"${a.id}","role":"authenticated"}', true);
      do $test$ begin
        perform public.recipe_accept_preview('${id}'::uuid,
          '${crypto.randomUUID()}'::uuid, true);
        insert into recipe_outcome values ('accepted');
        exception when others then insert into recipe_outcome values (sqlstate);
      end $test$;
      select code from recipe_outcome;
      reset role;
      rollback;`);
    expect(output.split("\n")).toContain("40001");
  });

  it("keeps an accepted recipe when a shopping period covers its slot (audit S1)", async () => {
    await seedPilotCatalog(admin);
    const date = "2099-09-02";
    const root = await admin.from("recipe_catalog").select("id")
      .eq("slug", "beef-tomato-vegetable-stew").single();
    expect(root.error).toBeNull();
    const single = await previewRecipe(aClient, a.id, root.data!.id,
      { date, slotId: "meal-3", servingFraction: 0.5 });
    const mine = (await acceptPreview(aClient, a.id, single.previewId,
      crypto.randomUUID(), true)).selections[0];
    const draft = { startDate: "2099-09-01", endDate: "2099-09-03",
      timezone: "America/Denver", people: 1, mealCoverage: ["meal-3"],
      mode: "balanced" as const, effort: "standard" as const,
      maxActiveMinutes: null, variety: "high" as const,
      budgetAmount: null, currency: "USD", locale: "US-CO", lockMode: "none" as const };
    const preview = await previewShopping(aClient, a.id, { draft, basket: [] });
    expect(preview.blockingIssues).toEqual([]);
    expect(preview.informationalIssues)
      .toContain(`Keeps your chosen ${mine.recipeName} on ${date} Meal 3.`);
    expect(preview.choices.find((row) => row.localDate === date)).toMatchObject({
      id: mine.id, keptSelectionId: mine.id, recipeRevisionId: mine.recipeRevisionId,
      servingFraction: 0.5, planRevision: mine.planRevision });
    expect(preview.lines.some((line) => line.sources.some((source) =>
      source.localDate === date))).toBe(true);

    // Defence in depth needs 20261209090300 in this database; it is checked, never applied here.
    const guarded = LOCAL_DB && runSql(`select position('kept selection changed' in
      pg_get_functiondef('public.recipe_accept_preview(uuid,uuid,boolean)'::regprocedure)) > 0;`)
      .trim().split("\n").includes("t");
    if (guarded) {
      const stored = await admin.from("recipe_plan_previews").select("proof,state_rev")
        .eq("id", preview.previewId).single();
      expect(stored.error).toBeNull();
      const forged = structuredClone(stored.data!.proof) as { choices: Record<string, unknown>[] };
      for (const row of forged.choices) {
        if (row.localDate === date) { delete row.keptSelectionId; row.expectedSelectionId = null; }
      }
      const forgedId = await admin.rpc("recipe_store_preview", { p_user_id: a.id,
        p_kind: "shopping", p_proof: forged, p_state_rev: stored.data!.state_rev,
        p_expires_at: expiresAt() });
      expect(forgedId.error).toBeNull();
      previewIds.push(forgedId.data as string);
      const overwrite = await aClient.rpc("recipe_accept_preview", { p_preview_id: forgedId.data,
        p_request_id: crypto.randomUUID(), p_accept_approximate: true });
      expect(overwrite.error?.code).toBe("40001");
    }

    await acceptPreview(aClient, a.id, preview.previewId, crypto.randomUUID(), true);
    const after = await admin.from("recipe_plan_selections")
      .select("id,recipe_revision_id,serving_fraction,plan_revision,superseded_at")
      .eq("user_id", a.id).eq("local_date", date).eq("slot_id", "meal-3").single();
    expect(after.error).toBeNull();
    expect(after.data).toMatchObject({ id: mine.id, recipe_revision_id: mine.recipeRevisionId,
      superseded_at: null });
    expect(Number(after.data!.serving_fraction)).toBe(0.5);
    if (guarded) expect(after.data!.plan_revision).toBe(mine.planRevision);
  }, 20_000);
});
