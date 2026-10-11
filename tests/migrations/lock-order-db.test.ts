/**
 * W034 (audit 2026-10-10 F23: A096, A162, A163): one lock order for the three clock rows,
 * evidence_clock, then account_rules_clock, then recipe_plan_state (migration 20261231200000), on
 * the real migrated schema (SUPABASE_TEST_DB_URL).
 *
 * Each case runs one audited deadlock pair on two connections. A third "gate" connection holds one
 * clock row for 1.5 s, so the pair interleaves the way the audit described it: under the old order
 * one side died with 40P01 "deadlock detected" (or, inside get_or_create_food_ref's backfill, a
 * swallowed warning). Under the one order the later side waits, and all three commit.
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, background, dropAccounts, evidence, rules, userFood } from "../helpers/world-db";

const HOLD_S = 1.5;
const drops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The gate takes `lock` and holds it for HOLD_S; `first` starts 0.2 s in and `second` 0.5 s in, each
 * on its own connection. Answers "ok" per connection, else its error text.
 */
async function race(lock: string, first: string, second: string): Promise<string[]> {
  const gate = background(`begin; ${lock}; select pg_sleep(${HOLD_S}); commit;`);
  await sleep(200);
  const one = background(first);
  await sleep(300);
  const two = background(second);
  return (await Promise.all([gate, one, two]))
    .map(({ code, err }) => (code === 0 && !/deadlock/i.test(err) ? "ok" : err.trim() || `exit ${code}`));
}

const ALL_OK = ["ok", "ok", "ok"];
const EVIDENCE_SHARE = "select 1 from public.evidence_clock where id = 1 for share";
const recipeStateOf = (user: string) =>
  `select 1 from public.recipe_plan_state where user_id = '${user}' for update`;

/** A catalog food nobody has a ref for yet (its first get_or_create_food_ref mints one). */
function catalogFood(description: string): string {
  const tag = crypto.randomUUID();
  const foodId = runSql(`with v as (insert into public.catalog_versions (source, version_label)
      values ('fdc_sr_legacy', 'w034-${tag}') returning id),
    f as (insert into public.catalog_foods (source, source_id) values ('fdc_sr_legacy', 'w034-${tag}') returning id)
    insert into public.catalog_food_revisions (description, catalog_food_id, catalog_version_id, quality_class,
      content_hash, is_active)
    select '${description}', f.id, v.id, 'survey', 'w034-${tag}', true from f, v returning catalog_food_id`).split("\n")[0];
  drops.push(() => runSql(`delete from public.food_refs where catalog_food_id = ${foodId};
    delete from public.catalog_food_revisions where catalog_food_id = ${foodId};
    delete from public.catalog_foods where id = ${foodId};
    delete from public.catalog_versions where version_label = 'w034-${tag}';`));
  return foodId;
}

/** A barcode nobody has scanned: catalog_write_provider_revision writes the catalog rows and the ref. */
function newGtin(): string {
  const gtin = `9${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`;
  drops.push(() => runSql(`delete from public.catalog_barcodes where gtin14 = '${gtin}';
    delete from public.food_refs where catalog_food_id in
      (select id from public.catalog_foods where source = 'off' and source_id = '${gtin}');
    delete from public.catalog_food_revisions where catalog_food_id in
      (select id from public.catalog_foods where source = 'off' and source_id = '${gtin}');
    delete from public.catalog_foods where source = 'off' and source_id = '${gtin}';`));
  return gtin;
}

const mint = (user: string, foodId: string) =>
  `select public.get_or_create_food_ref('${user}', 'catalog', ${foodId}, null)`;
const barcode = (user: string, gtin: string) => `select public.catalog_write_provider_revision('${user}', 'off',
  '${gtin}', '{"description": "W034 bar ${gtin}", "per100g": {"protein": 1}}'::jsonb)`;
const settingsWrite = (user: string) => `update public.user_settings set meals_per_day = 4 where user_id = '${user}'`;

/** The Favor the server would send for the account's "kiwi" family, at the clocks as they stand. */
function favorOf(user: string): string {
  const [set] = JSON.parse(runSql(`select public.favor_family_sets('${user}', array['kiwi']::text[])`)) as
    { name_norm: string; ref_ids: string[] }[];
  return `select public.favor_food_families('${user}', 'kiwi', '${JSON.stringify([set])}'::jsonb,
    array[${set.ref_ids.map((id) => `'${id}'`).join(",")}]::uuid[], ${rules(user)}, ${evidence()})`;
}

/** An account with a "kiwi" family to Favor and an Avoid mark the plum's first ref inherits. */
function favorAccount(): string {
  const user = account();
  userFood(user, "Kiwi, gold");
  userFood(user, "Kiwi, green");
  runSql(`select public.set_food_membership('${user}', 'w034 plum', 'avoid', null, 1)`);
  return user;
}

describe.skipIf(!HAS_DB)("one clock lock order (W034): the audited deadlock pairs commit", () => {
  afterAll(() => {
    dropAccounts();
    for (const drop of drops.splice(0)) drop();
  });

  it("A096: Favor and the same account's first ref for a catalog food", async () => {
    const a = favorAccount();
    const plum = catalogFood("W034 Plum");
    expect(await race(EVIDENCE_SHARE, mint(a, plum), favorOf(a))).toEqual(ALL_OK);
    // The ref exists and inherited the family's Avoid (the backfill was not swallowed).
    expect(runSql(`select p.status from public.user_food_prefs p join public.food_refs r on r.id = p.food_ref_id
      where p.user_id = '${a}' and r.catalog_food_id = ${plum}`)).toBe("avoid");
  });

  it("A162: one account's first catalog ref and another account's barcode import", async () => {
    const [x, y] = [account(), account()];
    const plum = catalogFood("W034 Plum");
    const gtin = newGtin();
    expect(await race(EVIDENCE_SHARE, barcode(x, gtin), mint(y, plum))).toEqual(ALL_OK);
    expect(runSql(`select count(*) from public.food_refs where catalog_food_id = ${plum}`)).toBe("1");
  });

  it("A162: one account's first catalog ref and another account's Favor", async () => {
    const x = favorAccount();
    const y = account();
    const plum = catalogFood("W034 Plum");
    expect(await race(EVIDENCE_SHARE, mint(y, plum), favorOf(x))).toEqual(ALL_OK);
    expect(runSql(`select string_agg(status, ',') from public.user_food_prefs where user_id = '${x}'
      and food_ref_id in (select id from public.food_refs where user_food_id is not null)`)).toBe("eats,eats");
  });

  it("A163: Favor and a settings write on the same account", async () => {
    const a = favorAccount();
    const favor = favorOf(a);
    expect(await race(recipeStateOf(a), settingsWrite(a), favor)).toEqual(ALL_OK);
    expect(runSql(`select meals_per_day from public.user_settings where user_id = '${a}'`)).toBe("4");
  });

  it("A163: set_food_membership and a settings write on the same account", async () => {
    const a = favorAccount();
    const mark = `select public.set_food_membership('${a}', 'kiwi', 'avoid', null, 1)`;
    expect(await race(recipeStateOf(a), settingsWrite(a), mark)).toEqual(ALL_OK);
    expect(runSql(`select status from public.food_membership_revisions where user_id = '${a}' and name_norm = 'kiwi'`))
      .toBe("avoid");
  });

  it("an account's allergen evidence write and its Favor", async () => {
    const a = favorAccount();
    const food = userFood(a, "W034 granola");
    const write = `insert into public.food_allergen_evidence (food_key, allergen, level, source, user_id)
      values ('user_food:${food.foodId}:1', 'peanut', 'no_evidence', 'ingredients', '${a}')`;
    expect(await race(EVIDENCE_SHARE, write, favorOf(a))).toEqual(ALL_OK);
  });

  it("recipe_plan_bump_state takes the rules row first on every table that also has a rules clock", () => {
    const both = runSql(`select string_agg(c.relname, ',' order by c.relname) from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and exists (select 1 from pg_trigger t where t.tgrelid = c.oid
          and t.tgfoid = 'public.recipe_plan_bump_state()'::regprocedure)
        and exists (select 1 from pg_trigger t where t.tgrelid = c.oid
          and t.tgfoid = 'public.rules_clock_bump()'::regprocedure)`).split(",");
    const source = runSql(`select prosrc from pg_proc where oid = 'public.recipe_plan_bump_state()'::regprocedure`);
    const listed = [.../tg_table_name in \(([^)]*)\)/.exec(source)![1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(both);
  });

  // Not an audited pair: Favor now takes evidence_clock first, so a recipe's first save (its account
  // food, then that food's first ref, in one apply_sync_op transaction) must take it first too.
  it("a recipe's first save and the same account's Favor", async () => {
    const a = favorAccount();
    const id = crypto.randomUUID();
    const op = JSON.stringify({ op_id: crypto.randomUUID(), entity: "recipes", entity_id: id, kind: "create",
      base_rev: null, payload: { name: "W034 stew", servings: 1, items: [] }, client_ts: new Date().toISOString() });
    const save = `select public.apply_sync_op('${a}', '${op}'::jsonb)`;
    expect(await race(EVIDENCE_SHARE, save, favorOf(a))).toEqual(ALL_OK);
    expect(runSql(`select count(*) from public.food_refs where user_food_id = '${id}'`)).toBe("1");
  });
});
