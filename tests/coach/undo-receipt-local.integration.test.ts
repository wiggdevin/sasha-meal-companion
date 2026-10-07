/**
 * Coach Undo receipts, PR A (docs/specs/coach-undo-receipt.md §4, §6, §8) on the local Supabase
 * stack: the real tables, RLS, grants, sync RPC and the receipt-aware `perform_coach_undo`, driven
 * through lib/server/coach-undo.ts on each user's own session client.
 *
 * No writer exists yet (apply_coach_op is PR B), so every receipt and receipt record here is seeded
 * directly as the database owner, as apply_coach_op will write them: the receipt from the rows the
 * op changed, the record with `inverse = '{}'`. Local-only: refuses any non-loopback target.
 */
// Refuses any non-local database before anything else runs.
import "../tenancy/local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listUndos, LIST_LIMIT, performUndo, recordUndo } from "@/lib/server/coach-undo";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, resetUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";
import { localTargets } from "../tenancy/target-guard";

const DATE = "2041-03-04";
const q = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
type Refusal = { status: number; code: string };
/** The value of an `insert … returning`; psql prints the command tag after it. */
const returning = (sql: string) => runSql(sql).split("\n")[0];

/** One sync op as the phone sends it, applied as the database owner on `user`'s behalf. */
function sync(user: string, entity: string, key: string, kind: string, baseRev: number | null,
  payload: object, opId: string = crypto.randomUUID()): Record<string, unknown> {
  const op = { op_id: opId, entity, entity_id: key, kind, base_rev: baseRev, payload,
    client_ts: new Date().toISOString() };
  const out = JSON.parse(runSql(`select apply_sync_op('${user}', ${q(op)})::text`)) as Record<string, unknown>;
  if (out.status !== "applied") throw new Error(`${entity} ${kind}: ${JSON.stringify(out)}`);
  return out;
}

/** An account food and its ref. */
function food(user: string, name: string): string {
  const id = crypto.randomUUID();
  sync(user, "user_foods", id, "create", null, { name, kind: "custom" });
  return runSql(`select get_or_create_food_ref('${user}', 'user', null, '${id}')`);
}

function receipt(user: string, actionId: string, kind: string, entity: string, entityId: string,
  applied: object, sourceCheck = "match", source: object | null = null): void {
  runSql(`insert into coach_action_receipts (user_id, action_id, kind, op_id, entity, entity_id, source,
    source_check, applied) values ('${user}', '${actionId}', '${kind}', gen_random_uuid(), '${entity}',
    '${entityId}', ${source ? q(source) : "null"}, '${sourceCheck}', ${q(applied)})`);
}

function receiptRecord(user: string, actionId: string, kind: string, sourceCheck = "match"): string {
  return returning(`insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode,
    source_check) values ('${user}', '${actionId}', '${kind}', '{}', 'receipt_v1', '${sourceCheck}')
    returning id`);
}

describe.skipIf(!HAS_BRANCH || !HAS_DB || !localTargets())("coach Undo receipts on the local stack", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;

  /** The server Undo as A; answers "undone" or the refusal's status and code. */
  async function undo(id: string, opts: { local?: boolean } = {}): Promise<"undone" | Refusal> {
    try {
      const view = await performUndo(asA, a.id, id, opts);
      return view.undoneAt ? "undone" : { status: 0, code: "open" };
    } catch (error) {
      const e = error as { status?: number; code?: string };
      return { status: e.status ?? 0, code: e.code ?? String(error) };
    }
  }
  const open = (id: string) => runSql(`select undone_at is null from coach_action_undos where id = '${id}'`);

  /** A logged snack of `grams` g of eggs through the sync RPC, and the receipt body it would get. */
  function logEggs(grams = 100) {
    const egg = food(a.id, "Eggs");
    const entryId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const eatenAt = "2041-03-04T08:00:00.000Z";
    sync(a.id, "log_entries", entryId, "create", null, { note: null, media_ref: null, eaten_at: eatenAt,
      tz: "UTC", local_date: DATE, slot: "snack", method: "search", items: [{ id: itemId, seq: 0,
        food_ref_id: egg, qty: grams, unit: "g", grams, snapshot: null }] });
    const applied = { entryId, date: DATE, slot: "snack", eatenAt, rev: 1, title: null,
      items: [{ itemId, foodRefId: egg, name: "Eggs", grams }] };
    return { entryId, itemId, applied };
  }

  /** A recipe through the sync RPC (its user_foods twin too), and the receipt body it would get. */
  function saveRecipe(name: string, grams: number) {
    const egg = food(a.id, `Egg ${grams}`);
    const recipeId = crypto.randomUUID();
    sync(a.id, "recipes", recipeId, "create", null, { name, servings: 1,
      items: [{ seq: 0, qty: grams, unit: "g", food_ref_id: egg, grams }] });
    const revisionId = runSql(`select id from recipe_revisions where recipe_id = '${recipeId}' and rev = 1`);
    const applied = { recipeId, rev: 1, name, revisionId, items: [{ seq: 0, foodRefId: egg, name: "Egg", grams }] };
    return { recipeId, applied };
  }

  const component = (name: string, qty: number) => ({ name, qty, unit: "g", role: "protein",
    macros: { protein: 20, carbs: 0, fat: 10 } });
  const meal2 = { baseMealId: null, components: [component("tofu", 120)], mutationId: crypto.randomUUID() };

  /** A one-date slot write: meal-3 now holds `after`; meal-2 holds another meal. */
  function slotDay(after: object) {
    sync(a.id, "plan_days", DATE, "create", null, { local_date: DATE,
      item_overrides: { "meal-2": meal2, "meal-3": after } });
    return { date: DATE, slot: "meal-3", rev: 1, before: null, after };
  }
  const slots = () => JSON.parse(runSql(`select json_build_object('rev', rev, 'o', item_overrides)::text
    from plan_days where user_id = '${a.id}' and local_date = '${DATE}'`)) as
    { rev: number; o: Record<string, { mutationId?: string; components: { name: string }[] }> };

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
  });
  beforeEach(async () => { await resetUser(a.id); await resetUser(b.id); });
  afterAll(async () => {
    if (a) await resetUser(a.id);
    if (b) await resetUser(b.id);
  });

  it("undoes a matched logged meal from its receipt", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const id = receiptRecord(a.id, "act-log", "log_meal");
    expect(await undo(id)).toBe("undone");
    expect(runSql(`select rev || '|' || (deleted_at is not null) from log_entries where id = '${meal.entryId}'`))
      .toBe("2|true");
    expect(await undo(id)).toEqual({ status: 409, code: "undo_already_undone" });
  });

  it("r1 BLOCK 1: an op pre-submitted under the old predictable Undo id cannot close the record", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const id = receiptRecord(a.id, "act-log", "log_meal");
    // The first draft derived the inverse op id from the record; the owner could send it first.
    const predictable = runSql(`select md5('coach-undo:' || '${id}')::uuid`);
    sync(a.id, "water_log", DATE, "create", null, { local_date: DATE, cups: 1 }, predictable);
    expect(await undo(id)).toBe("undone");
    expect(runSql(`select deleted_at is not null from log_entries where id = '${meal.entryId}'`)).toBe("t");
  });

  it("legacy path: an op pre-submitted under the old predictable Undo id cannot close the record", async () => {
    const meal = logEggs();
    const id = returning(`insert into coach_action_undos (user_id, action_id, kind, inverse, expected_rev,
      bind) values ('${a.id}', 'act-legacy-meal', 'log_meal', ${q({ kind: "log_meal", date: DATE,
      entryId: meal.entryId, baseRev: 1 })}, 1, ${q({ date: DATE, slot: "snack",
      items: [[meal.applied.items[0].foodRefId, 100]], eatenAt: meal.applied.eatenAt })}) returning id`);
    const predictable = runSql(`select md5('coach-undo:' || '${id}')::uuid`);
    sync(a.id, "water_log", DATE, "create", null, { local_date: DATE, cups: 1 }, predictable);
    expect(await undo(id)).toBe("undone");
    expect(runSql(`select rev || '|' || (deleted_at is not null) from log_entries where id = '${meal.entryId}'`))
      .toBe("2|true");
  });

  it("legacy path: a water Undo closes only after the cups are written back", async () => {
    sync(a.id, "water_log", DATE, "create", null, { local_date: DATE, cups: 4 });
    sync(a.id, "water_log", DATE, "update", 1, { local_date: DATE, cups: 6 });
    const id = returning(`insert into coach_action_undos (user_id, action_id, kind, inverse, expected_rev)
      values ('${a.id}', 'act-water', 'log_water', ${q({ kind: "log_water", date: DATE, cups: 2, after: 6,
      afterRev: 2 })}, 2) returning id`);
    runSql(`insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id)
      values ('${a.id}', next_change_seq('${a.id}'), 'water_log', '${DATE}', 0, 'update',
      md5('coach-undo:' || '${id}')::uuid)`);
    expect(await undo(id)).toBe("undone");
    expect(runSql(`select cups || '|' || rev from water_log where user_id = '${a.id}' and local_date = '${DATE}'`))
      .toBe("4|3");
  });

  it("refuses a logged meal whose items changed at the same revision (409 undo_receipt_mismatch)", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const id = receiptRecord(a.id, "act-log", "log_meal");
    runSql(`update log_items set grams = 250 where id = '${meal.itemId}'`);
    expect(await undo(id)).toEqual({ status: 409, code: "undo_receipt_mismatch" });
    expect(runSql(`select deleted_at is null from log_entries where id = '${meal.entryId}'`)).toBe("t");
    expect(open(id)).toBe("t");
  });

  it("E1: an Eggs idea that wrote beef is refused (422 undo_source_mismatch); the card shows beef", async () => {
    const beef = { baseMealId: null, title: "Beef", components: [component("beef mince", 150)],
      mutationId: crypto.randomUUID() };
    receipt(a.id, "act-idea", "set_slot_meal", "plan_days", DATE, slotDay(beef), "mismatch",
      { messageId: crypto.randomUUID(), blockId: "ideas-1", ideaIndex: 0 });
    const id = receiptRecord(a.id, "act-idea", "set_slot_meal", "mismatch");
    const [view] = (await listUndos(asA, a.id, {})).undos;
    expect(view.card).toMatchObject({ type: "receipt", sourceCheck: "mismatch", messageId: null,
      lines: [{ name: "beef mince", grams: 150 }], complete: true });
    expect(view.serverUndoable).toBe(false);
    expect(await undo(id)).toEqual({ status: 422, code: "undo_source_mismatch" });
    expect(slots().o["meal-3"].components[0].name).toBe("beef mince");
  });

  it("puts the slot back and leaves every other slot as it stands", async () => {
    const after = { baseMealId: null, components: [component("eggs", 100)], mutationId: crypto.randomUUID() };
    receipt(a.id, "act-slot", "set_slot_meal", "plan_days", DATE, slotDay(after));
    const id = receiptRecord(a.id, "act-slot", "set_slot_meal");
    expect(await undo(id)).toBe("undone");
    const now = slots();
    expect(now.rev).toBe(2);
    expect(now.o["meal-3"]).toBeUndefined();
    expect(now.o["meal-2"]).toEqual(meal2);
  });

  it("R3-2: a later write to another slot of the date refuses the slot Undo (409 undo_conflict)", async () => {
    const after = { baseMealId: null, components: [component("eggs", 100)], mutationId: crypto.randomUUID() };
    receipt(a.id, "act-slot", "set_slot_meal", "plan_days", DATE, slotDay(after));
    const id = receiptRecord(a.id, "act-slot", "set_slot_meal");
    const edited = { ...meal2, components: [component("tofu", 200)], mutationId: crypto.randomUUID() };
    sync(a.id, "plan_days", DATE, "update", 1, { local_date: DATE,
      item_overrides: { "meal-2": edited, "meal-3": after } });
    expect(await undo(id)).toEqual({ status: 409, code: "undo_conflict" });
    expect(slots().o).toEqual({ "meal-2": edited, "meal-3": after });
  });

  it("E4: a later mutationId in the slot at the same revision is refused (409 undo_receipt_mismatch)", async () => {
    const after = { baseMealId: null, components: [component("eggs", 100)], mutationId: crypto.randomUUID() };
    receipt(a.id, "act-slot", "set_slot_meal", "plan_days", DATE, slotDay(after));
    const id = receiptRecord(a.id, "act-slot", "set_slot_meal");
    const later = { ...after, mutationId: crypto.randomUUID() };
    runSql(`update plan_days set item_overrides = jsonb_set(item_overrides, '{meal-3}', ${q(later)})
      where user_id = '${a.id}' and local_date = '${DATE}'`);
    expect(await undo(id)).toEqual({ status: 409, code: "undo_receipt_mismatch" });
    expect(slots().o).toEqual({ "meal-2": meal2, "meal-3": later });
  });

  it("E2: same-name recipes — a mismatched receipt and a legacy name record are both refused", async () => {
    const recipeA = saveRecipe("Eggs", 100);
    const recipeB = saveRecipe("Eggs", 200);
    receipt(a.id, "act-b", "save_recipe", "recipes", recipeB.recipeId, recipeB.applied, "mismatch",
      { messageId: crypto.randomUUID(), cardIndex: 0 });
    const viaReceipt = receiptRecord(a.id, "act-b", "save_recipe", "mismatch");
    expect(await undo(viaReceipt)).toEqual({ status: 422, code: "undo_source_mismatch" });
    const legacy = returning(`insert into coach_action_undos (user_id, action_id, kind, inverse, expected_rev,
      bind) values ('${a.id}', 'act-legacy', 'save_recipe', ${q({ kind: "save_recipe",
      recipeId: recipeA.recipeId, rev: 1 })}, 1, '{"name":"Eggs"}') returning id`);
    expect(await undo(legacy)).toEqual({ status: 422, code: "undo_local_only" });
    expect(runSql(`select count(*) from recipes where user_id = '${a.id}' and deleted_at is null`)).toBe("2");
  });

  it("E3: a recipe changed at the same revision is refused; it and its twin stay", async () => {
    const recipe = saveRecipe("Eggs", 100);
    receipt(a.id, "act-r", "save_recipe", "recipes", recipe.recipeId, recipe.applied);
    const id = receiptRecord(a.id, "act-r", "save_recipe");
    runSql(`update recipe_items set grams = 150 where recipe_revision_id = '${recipe.applied.revisionId}'`);
    expect(await undo(id)).toEqual({ status: 409, code: "undo_receipt_mismatch" });
    expect(runSql(`select (select deleted_at is null from recipes where id = '${recipe.recipeId}')
      and (select deleted_at is null from user_foods where id = '${recipe.recipeId}')`)).toBe("t");
  });

  it("E5: a matched recipe Undo tombstones the recipe and its twin, a change_log row each", async () => {
    const recipe = saveRecipe("Eggs", 100);
    receipt(a.id, "act-r", "save_recipe", "recipes", recipe.recipeId, recipe.applied);
    const id = receiptRecord(a.id, "act-r", "save_recipe");
    expect(await undo(id)).toBe("undone");
    expect(runSql(`select (select deleted_at is not null from recipes where id = '${recipe.recipeId}')
      and (select deleted_at is not null from user_foods where id = '${recipe.recipeId}')`)).toBe("t");
    expect(runSql(`select string_agg(entity, ',' order by entity) from change_log
      where user_id = '${a.id}' and entity_key = '${recipe.recipeId}' and op = 'delete'`))
      .toBe("recipes,user_foods");
  });

  it("one receipt per action, no receipt without its record's kind, and receipts never change", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const admin = adminClient();
    const second = await admin.from("coach_action_receipts").insert({ user_id: a.id, action_id: "act-log",
      kind: "log_meal", op_id: crypto.randomUUID(), entity: "log_entries", entity_id: meal.entryId,
      source_check: "match", applied: meal.applied });
    expect(second.error?.code).toBe("23505");
    const where = { user_id: a.id, action_id: "act-log" };
    expect((await admin.from("coach_action_receipts").update({ source_check: "none" }).match(where))
      .error?.message).toMatch(/permission denied/);
    expect((await admin.from("coach_action_receipts").delete().match(where)).error?.message)
      .toMatch(/permission denied/);
    expect((await asA.from("coach_action_receipts").update({ source_check: "none" }).match(where))
      .error?.message).toMatch(/permission denied/);
    expect((await asA.from("coach_action_receipts").delete().match(where)).error?.message)
      .toMatch(/permission denied/);
    expect(() => runSql(`update coach_action_receipts set source_check = 'none' where action_id = 'act-log'`))
      .toThrow(/receipt_immutable/);
    // A receipt record of another kind than its receipt: inconsistent, nothing written.
    const wrong = receiptRecord(a.id, "act-log", "save_recipe");
    expect(await undo(wrong)).toEqual({ status: 422, code: "undo_receipt_inconsistent" });
    expect((await admin.from("coach_action_undos").update({ record_mode: "legacy" }).eq("id", wrong))
      .error?.message).toMatch(/record_mode_immutable/);
    expect(runSql(`select deleted_at is null from log_entries where id = '${meal.entryId}'`)).toBe("t");
  });

  it("T1: B reads none of A's receipts and cannot undo A's receipt record", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const id = receiptRecord(a.id, "act-log", "log_meal");
    expect((await asA.from("coach_action_receipts").select("action_id")).data).toEqual([{ action_id: "act-log" }]);
    expect((await asB.from("coach_action_receipts").select("action_id")).data).toEqual([]);
    await expect(performUndo(asB, b.id, id)).rejects.toMatchObject({ status: 404 });
    expect((await asB.rpc("perform_coach_undo", { p_undo_id: id, p_local: false })).data)
      .toMatchObject({ status: "not_found" });
    expect(open(id)).toBe("t");
  });

  it("R2-1: an old build cannot close a receipt record through either legacy endpoint", async () => {
    const meal = logEggs();
    receipt(a.id, "act-log", "log_meal", "log_entries", meal.entryId, meal.applied);
    const id = receiptRecord(a.id, "act-log", "log_meal");
    expect(await undo(id, { local: true })).toEqual({ status: 409, code: "undo_receipt_record" });
    expect((await asA.rpc("perform_coach_undo", { p_undo_id: id, p_local: true })).error?.message)
      .toContain("undo_receipt_record");
    await expect(recordUndo(asA, a.id, { actionId: "act-log", kind: "log_meal", token: { kind: "log_meal" },
      undone: true })).rejects.toMatchObject({ status: 409, code: "undo_receipt_record" });
    expect(open(id)).toBe("t");
    expect(runSql(`select deleted_at is null from log_entries where id = '${meal.entryId}'`)).toBe("t");
  });

  it("R1-5: a 500-record page with 500 receipts lists 500 complete cards", async () => {
    runSql(`insert into coach_action_receipts (user_id, action_id, kind, op_id, entity, entity_id,
        source_check, applied)
      select '${a.id}', 'bulk-' || n, 'log_meal', gen_random_uuid(), 'log_entries', gen_random_uuid()::text,
        'match', jsonb_build_object('entryId', gen_random_uuid(), 'date', '${DATE}', 'slot', 'snack',
          'eatenAt', '2041-03-04T08:00:00Z', 'rev', 1, 'title', null, 'items', '[]'::jsonb)
        from generate_series(1, ${LIST_LIMIT}) n;
      insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode, source_check)
      select '${a.id}', 'bulk-' || n, 'log_meal', '{}', 'receipt_v1', 'match'
        from generate_series(1, ${LIST_LIMIT}) n`);
    const page = await listUndos(asA, a.id, {});
    expect(page.undos).toHaveLength(LIST_LIMIT);
    expect(page.next).toBeNull();
    expect(page.undos.filter((u) => u.card.type === "receipt" && u.card.complete)).toHaveLength(LIST_LIMIT);
    expect(page.undos.every((u) => u.serverUndoable && u.target?.date === DATE)).toBe(true);
  }, 30_000);

  it("U1: a legacy set_slot_meal record bound to meal-3 lists once, as Coach change", async () => {
    const thread = returning(`insert into coach_threads (user_id, kind) values ('${a.id}', 'plan') returning id`);
    const items = [{ foodRefId: crypto.randomUUID(), grams: 100 }];
    const message = returning(`insert into coach_messages (user_id, thread_id, role, seq, content, tool_calls)
      values ('${a.id}', '${thread}', 'assistant', 1, 'two cards', ${q({ composed: [
        { wish: "eggs", slot: "meal-3", items },
        { wish: "eggs", slot: "meal-2", pendingSlots: [{ slot: "meal-3", label: "Meal 3" }], items }] })})
      returning id`);
    runSql(`insert into coach_action_undos (user_id, thread_id, message_id, action_id, kind, inverse, bind)
      values ('${a.id}', '${thread}', '${message}', 'tap-1', 'set_slot_meal',
      ${q({ kind: "set_slot_meal", date: DATE, slot: "meal-3" })}, '{"slot":"meal-3"}')`);
    const { undos } = await listUndos(asA, a.id, { threadId: thread });
    expect(undos).toHaveLength(1);
    expect(undos[0]).toMatchObject({ actionId: "tap-1", messageId: message, serverUndoable: false,
      card: { type: "generic", kind: "set_slot_meal", title: "Coach change" } });
  });
});
