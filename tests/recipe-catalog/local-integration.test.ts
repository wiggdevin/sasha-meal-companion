import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { searchCatalog } from "@/lib/recipe-catalog/repository";
import type { RecipeSearch } from "@/lib/recipe-catalog/types";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { aggregateShopping } from "@/lib/shopping/aggregate";
import { createLine, createPeriod, getPeriod, listPantry, patchLine, patchPeriod,
  patchPurchaseWindow, putPantry } from "@/lib/shopping/repository";
import { HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient,
  type TestUser } from "../helpers/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

describe.skipIf(!HAS_BRANCH || !HAS_DB)("recipe catalog and shopping local DB", () => {
  let a: TestUser; let b: TestUser;
  let aClient: SupabaseClient; let bClient: SupabaseClient;
  let periodId: string; let lineId: string;
  const pantryIds: string[] = [];

  beforeAll(async () => {
    a = await ensureUser("a"); b = await ensureUser("b");
    aClient = await userClient(a); bClient = await userClient(b);
  });
  afterAll(async () => {
    if (!periodId) return;
    const admin = adminClient();
    if (pantryIds.length) await admin.from("shopping_pantry").delete().in("id", pantryIds);
    await admin.from("shopping_lines").delete().eq("period_id", periodId);
    await admin.from("shopping_periods").delete().eq("id", periodId);
  });

  it("seeds once; published content is readable but authenticated users cannot edit it", async () => {
    const first = await seedPilotCatalog(adminClient());
    const manifestSize = pilotRecipes().length;
    expect(first.created + first.skipped).toBe(manifestSize);
    const second = await seedPilotCatalog(adminClient());
    expect(second).toEqual({ created: 0, skipped: manifestSize });
    const read = await aClient.from("recipe_catalog")
      .select("id,slug").eq("slug", "lentil-carrot-tomato-stew").single();
    expect(read.error).toBeNull();
    const blocked = await aClient.from("recipe_catalog").update({ author: "tampered" })
      .eq("id", read.data!.id).select("id");
    expect(blocked.error).toBeNull();
    expect(blocked.data).toEqual([]); // RLS intentionally makes unauthorized UPDATE affect zero rows.
    const unchanged = await aClient.from("recipe_catalog").select("author")
      .eq("id", read.data!.id).single();
    expect(unchanged.data?.author).toBe("Meal Companion");
    const revisions = await aClient.from("recipe_catalog_revisions")
      .select("id,nutrition_per_serving").eq("recipe_id", read.data!.id);
    expect(revisions.data).toHaveLength(1);
    expect(revisions.data![0].nutrition_per_serving.kcal.status).toBe("estimated");
  });

  it("seals a published revision and permanently withdraws it", () => {
    const slug = `test-seal-${crypto.randomUUID().slice(0, 12)}`;
    const sql = `begin;
      do $do$ begin
        begin
          insert into recipe_catalog (slug,author,rights_kind,rights_record,source_revision,
            publication_state) values ('${slug}-direct','Meal Companion','original',
              'Original test content; app use permitted; not kitchen-tested','test-v1','published');
          raise exception 'direct published insert was accepted';
        exception when check_violation then null; end;
      end $do$;
      insert into recipe_catalog (slug,author,rights_kind,rights_record,source_revision)
        values ('${slug}','Meal Companion','original',
          'Original test content; app use permitted; not kitchen-tested','test-v1');
      insert into recipe_catalog_revisions (recipe_id,rev,name,effort,servings,yield_status)
        select id,1,'Test sealed stew','minimal',2,'unknown' from recipe_catalog where slug='${slug}';
      insert into recipe_catalog_items (recipe_revision_id,seq,name,food_db_id,quantity,unit,grams,
        state,purchase_grams,purchase_conversion_status)
        select r.id,1,'water','water',100,'g',100,'as_purchased',100,'known'
          from recipe_catalog_revisions r join recipe_catalog c on c.id=r.recipe_id where c.slug='${slug}';
      insert into recipe_catalog_steps (recipe_revision_id,seq,instruction)
        select r.id,1,'Measure the water and serve it.'
          from recipe_catalog_revisions r join recipe_catalog c on c.id=r.recipe_id where c.slug='${slug}';
      update recipe_catalog c set current_revision_id=r.id,publication_state='published'
        from recipe_catalog_revisions r where r.recipe_id=c.id and c.slug='${slug}';
      do $do$ begin
        begin
          insert into recipe_catalog_steps (recipe_revision_id,seq,instruction)
            select current_revision_id,2,'Late alteration is forbidden.' from recipe_catalog
            where slug='${slug}';
          raise exception 'late append was accepted';
        exception when check_violation then null; end;
        begin
          update recipe_catalog set author='tampered' where slug='${slug}';
          raise exception 'provenance rewrite was accepted';
        exception when check_violation then null; end;
        begin
          update recipe_catalog set publication_state='draft' where slug='${slug}';
          raise exception 'return to draft was accepted';
        exception when check_violation then null; end;
      end $do$;
      update recipe_catalog set publication_state='withdrawn', withdrawal_reason='rights correction'
        where slug='${slug}';
      do $do$ begin
        begin
          update recipe_catalog set publication_state='published' where slug='${slug}';
          raise exception 'withdrawn content republished';
        exception when check_violation then null; end;
      end $do$;
      rollback;`;
    expect(() => runSql(sql)).not.toThrow();
  });

  it("owner RLS, revision CAS and retry keep manual/bought lines", async () => {
    const draft = { startDate: "2026-10-01", endDate: "2026-10-07", timezone: "America/Denver",
      people: 1, mealCoverage: ["dinner"], mode: "simple" as const,
      effort: "minimal" as const, maxActiveMinutes: 25, variety: "repeat_friendly" as const,
      budgetAmount: null, currency: null, locale: null, lockMode: "none" as const };
    const requestId = crypto.randomUUID();
    const created = await createPeriod(aClient, a.id, draft, requestId);
    periodId = created.id;
    expect((await createPeriod(aClient, a.id, draft, requestId)).id).toBe(periodId);
    const hidden = await bClient.from("shopping_periods").select("id").eq("id", periodId);
    expect(hidden.data).toEqual([]);
    const entry = await createLine(aClient, a.id, periodId, { origin: "manual", name: "Soap",
      identity: null, category: "manual", needGrams: null, confirmedStockGrams: null,
      buyGrams: null, packageGrams: null, purchaseConversionStatus: "unknown",
      sources: [], pinned: false, checked: true, note: "Keep checked" }, crypto.randomUUID());
    lineId = entry.id;
    const p2 = await patchPeriod(aClient, a.id, periodId, created.revision, crypto.randomUUID(),
      { mode: "balanced" });
    expect(p2.revision).toBe(created.revision + 1);
    await expect(patchPeriod(aClient, a.id, periodId, created.revision, crypto.randomUUID(),
      { mode: "simple" })).rejects.toMatchObject({ status: 409 });
    const editRequest = crypto.randomUUID();
    const line2 = await patchLine(aClient, a.id, periodId, lineId, entry.revision, editRequest,
      { note: "Still checked" });
    const retry = await patchLine(aClient, a.id, periodId, lineId, entry.revision, editRequest,
      { note: "Still checked" });
    expect(retry.revision).toBe(line2.revision);
    const fetched = await getPeriod(aClient, a.id, periodId);
    expect(fetched.lines.find((row) => row.id === lineId)).toMatchObject({
      checked: true, origin: "manual", note: "Still checked" });
    const stolen = await bClient.from("shopping_lines").update({ checked: false })
      .eq("id", lineId).select("id");
    expect(stolen.data).toEqual([]);
  });

  it("reads the bounded catalog under SQL filters; words rank in memory and never empty it", async () => {
    // O4a: SQL no longer narrows by text; query words rank in memory and never remove a recipe.
    const match = (recipes: Awaited<ReturnType<typeof searchCatalog>>, search: RecipeSearch) =>
      findRecipeCandidates(recipes, { ...search, limit: 64 }, { profile: EMPTY_PROFILE })
        .candidates.map((recipe) => recipe.name);
    const natural = await searchCatalog(aClient, { query: "find me a stew recipe", limit: 25 });
    expect(natural).toHaveLength(pilotRecipes().length);
    expect(match(natural, { query: "find me a stew recipe" }).slice(0, 3)
      .every((name) => /stew/i.test(name))).toBe(true);
    const filtered = await searchCatalog(aClient, { query: "show me a stew recipe",
      cuisine: "Mediterranean", maxMinutes: 30, limit: 25 });
    expect(match(filtered, { query: "show me a stew recipe", cuisine: "Mediterranean", maxMinutes: 30 })[0])
      .toBe("Chickpea and spinach stew");
    expect(match(natural, { query: "zxqnotfood recipe" })).toEqual(match(natural, { query: "" }));
  });

  it("replays simultaneous line creates and rejects a reused key with a different body", async () => {
    const draft = { origin: "manual" as const, name: "Soap", identity: null,
      category: "manual" as const, needGrams: null, confirmedStockGrams: null,
      buyGrams: null, packageGrams: null, purchaseConversionStatus: "unknown" as const,
      sources: [], pinned: false, checked: false, note: null };
    const requestId = crypto.randomUUID();
    const [first, second] = await Promise.all([
      createLine(aClient, a.id, periodId, draft, requestId),
      createLine(aClient, a.id, periodId, draft, requestId),
    ]);
    expect(first.id).toBe(second.id);
    await expect(createLine(aClient, a.id, periodId, { ...draft, name: "Different" }, requestId))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    const edited = await patchLine(aClient, a.id, periodId, first.id, first.revision,
      crypto.randomUUID(), { note: "Edited after create" });
    const postEditReplay = await createLine(aClient, a.id, periodId, draft, requestId);
    expect(postEditReplay).toMatchObject({ id: first.id, revision: edited.revision,
      note: "Edited after create" });
    const receiptRewrite = await aClient.from("shopping_lines")
      .update({ create_fingerprint: "0".repeat(64) }).eq("id", first.id);
    expect(receiptRewrite.error?.code).toBe("23514");
    await expect(createLine(aClient, a.id, periodId, { ...draft, name: "Different" }, requestId))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("keeps one active stock row per identity and never underbuys on a concurrent confirmation", async () => {
    const identity = { foodRefId: null, foodDbId: "whole-wheat-bread",
      catalogFoodRevisionId: null, purchaseState: "as_purchased" as const,
      variantKey: `audit-${crypto.randomUUID()}` };
    const draft = { name: "Whole wheat bread", identity, confirmedGrams: 500 };
    const key = crypto.randomUUID();
    const [first, replay] = await Promise.all([
      putPantry(aClient, a.id, draft, null, key),
      putPantry(aClient, a.id, draft, null, key),
    ]);
    expect(first.id).toBe(replay.id);
    pantryIds.push(first.id);
    await expect(putPantry(aClient, a.id, { ...draft, confirmedGrams: 400 }, null, key))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    const concurrentIdentity = { ...identity, variantKey: `audit-${crypto.randomUUID()}` };
    const [otherA, otherB] = await Promise.allSettled([
      putPantry(aClient, a.id, { ...draft, identity: concurrentIdentity }, null, crypto.randomUUID()),
      putPantry(aClient, a.id, { ...draft, identity: concurrentIdentity }, null, crypto.randomUUID()),
    ]);
    expect([otherA.status, otherB.status].sort()).toEqual(["fulfilled", "rejected"]);
    for (const outcome of [otherA, otherB]) {
      if (outcome.status === "fulfilled") pantryIds.push(outcome.value.id);
      else expect(outcome.reason).toMatchObject({ status: 409, code: "pantry_identity_exists" });
    }
    const stock = (await listPantry(aClient, a.id)).filter((row) =>
      row.identity.variantKey === identity.variantKey);
    expect(stock).toHaveLength(1);
    expect((await listPantry(aClient, a.id)).filter((row) =>
      row.identity.variantKey === concurrentIdentity.variantKey)).toHaveLength(1);
    const recipe = pilotRecipes().find((row) => row.ingredients.some((item) =>
      item.foodDbId === "whole-wheat-bread"))!;
    const ingredient = recipe.ingredients.find((item) => item.foodDbId === "whole-wheat-bread")!;
    const oneItem = { ...recipe, ingredients: [{ ...ingredient, purchaseGrams: 900 }] };
    const period = (await getPeriod(aClient, a.id, periodId)).period;
    const basket = aggregateShopping(period, [{ recipe: oneItem, localDate: period.startDate,
      slotId: "dinner", servingsConsumed: recipe.servings, batchId: null }], {
      pantry: stock, packages: [{ identity, grams: 100 }],
      identityFor: () => identity,
    });
    expect(basket.lines[0].confirmedStockGrams).toBe(500);
    expect(basket.lines[0].buyGrams).toBe(400);
    const edited = await putPantry(aClient, a.id, { ...draft, id: first.id,
      confirmedGrams: 300 }, first.revision, crypto.randomUUID());
    const postEditReplay = await putPantry(aClient, a.id, draft, null, key);
    expect(postEditReplay).toMatchObject({ id: first.id, revision: edited.revision,
      confirmedGrams: 300 });
    const receiptRewrite = await aClient.from("shopping_pantry")
      .update({ create_fingerprint: "0".repeat(64) }).eq("id", first.id);
    expect(receiptRewrite.error?.code).toBe("23514");
    await expect(putPantry(aClient, a.id, { ...draft, confirmedGrams: 400 }, null, key))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("scopes dated purchases and replays checked/note edits without exposing derived amounts", async () => {
    const identity = { foodRefId: null, foodDbId: "whole-wheat-bread",
      catalogFoodRevisionId: null, purchaseState: "as_purchased" as const,
      variantKey: `window-${crypto.randomUUID()}` };
    const planLine = await createLine(aClient, a.id, periodId, {
      origin: "plan", name: "Whole wheat bread", identity, category: "core",
      needGrams: 900, confirmedStockGrams: 500, buyGrams: 400, packageGrams: 100,
      purchaseConversionStatus: "known", sources: [], pinned: false, checked: false,
      note: null,
    }, crypto.randomUUID());
    const inserted = await adminClient().from("shopping_purchase_windows").insert({
      user_id: a.id, period_id: periodId, line_id: planLine.id,
      window_start_date: "2026-10-01", window_end_date: "2026-10-07",
      need_grams: 900, confirmed_stock_grams: 500, buy_grams: 400,
    }).select("id").single();
    expect(inserted.error).toBeNull();
    const windowId = inserted.data!.id;
    const own = await getPeriod(aClient, a.id, periodId);
    expect(own.purchaseWindows).toContainEqual(expect.objectContaining({
      id: windowId, lineId: planLine.id, needGrams: 900, buyGrams: 400, checked: false,
    }));
    const hidden = await bClient.from("shopping_purchase_windows").select("id")
      .eq("id", windowId);
    expect(hidden.data).toEqual([]);
    await expect(patchPurchaseWindow(bClient, b.id, periodId, windowId, 1,
      crypto.randomUUID(), { checked: true })).rejects.toMatchObject({ status: 404 });
    const firstRequest = crypto.randomUUID();
    const checked = await patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      firstRequest, { checked: true });
    expect(checked).toMatchObject({ checked: true, revision: 2, buyGrams: 400 });
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      crypto.randomUUID(), { note: "late" })).rejects.toMatchObject({ status: 409 });
    const noted = await patchPurchaseWindow(aClient, a.id, periodId, windowId, 2,
      crypto.randomUUID(), { note: "Bought on Monday" });
    const replay = await patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      firstRequest, { checked: true });
    expect(replay).toMatchObject({ revision: noted.revision, checked: true,
      note: "Bought on Monday" });
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      firstRequest, { checked: false })).rejects.toMatchObject({ status: 409,
      code: "idempotency_conflict" });
    const forged = await aClient.from("shopping_purchase_windows")
      .update({ buy_grams: 0 }).eq("id", windowId);
    expect(forged.error).not.toBeNull();
    const still = await getPeriod(aClient, a.id, periodId);
    expect(still.purchaseWindows.find((row) => row.id === windowId)?.buyGrams).toBe(400);
    const admin = adminClient();
    const manual = await admin.from("shopping_lines").update({ origin: "manual",
      category: "manual" }).eq("id", planLine.id);
    expect(manual.error).toBeNull();
    expect((await getPeriod(aClient, a.id, periodId)).purchaseWindows).not.toContainEqual(
      expect.objectContaining({ id: windowId }));
    expect((await aClient.from("shopping_purchase_windows").select("id").eq("id", windowId)).data)
      .toEqual([]);
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      firstRequest, { checked: true })).rejects.toMatchObject({ status: 404 });
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, noted.revision,
      crypto.randomUUID(), { checked: false })).rejects.toMatchObject({ status: 404 });
    const restored = await admin.from("shopping_lines").update({ origin: "plan",
      category: "core" }).eq("id", planLine.id);
    expect(restored.error).toBeNull();
    const softLine = await admin.from("shopping_lines").update({
      deleted_at: new Date().toISOString() }).eq("id", planLine.id);
    expect(softLine.error).toBeNull();
    expect((await aClient.from("shopping_purchase_windows").select("id").eq("id", windowId)).data)
      .toEqual([]);
    const liveLine = await admin.from("shopping_lines").update({ deleted_at: null })
      .eq("id", planLine.id);
    expect(liveLine.error).toBeNull();
    const softPeriod = await admin.from("shopping_periods").update({
      deleted_at: new Date().toISOString() }).eq("id", periodId);
    expect(softPeriod.error).toBeNull();
    expect((await aClient.from("shopping_purchase_windows").select("id").eq("id", windowId)).data)
      .toEqual([]);
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, 1,
      firstRequest, { checked: true })).rejects.toMatchObject({ status: 404 });
    await expect(patchPurchaseWindow(aClient, a.id, periodId, windowId, noted.revision,
      crypto.randomUUID(), { note: "after retirement" })).rejects.toMatchObject({ status: 404 });
    await expect(getPeriod(aClient, a.id, periodId)).rejects.toMatchObject({ status: 404 });
  });
});
