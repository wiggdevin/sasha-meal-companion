/**
 * Phase 18 W2b admission-input versions on the real migrated schema (SUPABASE_TEST_DB_URL: the CI
 * Integration job's local Supabase; migrations 20261213090200 to 20261213091200).
 *
 * Acceptance 9 as re-planned (2026-10-06): any insert, update or delete of a table admission reads
 * (lib/foods/world/admission-inputs.ts) moves the matching counter by exactly 1 per transaction,
 * including the inputs the column-by-column triggers missed: an Avoid mark's food_ref_id swap, a
 * family mark's name_norm change, a catalog description change and a nutrient amount change. One
 * transaction writing several inventory tables moves a counter once; two concurrent transactions
 * move it twice. Eats-only, water and meal-count writes move it too (on purpose).
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import {
  account, asUser, background, catalogRevision, dropAccounts, evidence, moves, rules, step, userFood,
} from "../helpers/world-db";

describe.skipIf(!HAS_DB)("admission-input versions on the migrated schema (W2b acceptance 9)", () => {
  afterAll(dropAccounts);

  it("each rule input moves rulesVersion by exactly 1", () => {
    const a = account();
    expect(moves(a, () => asUser(a, `update public.constraint_profiles
      set avoid_allergens = '{peanut}', rev = rev + 1 where user_id = '${a}'`))).toBe(1);
    expect(moves(a, () => asUser(a, `select public.set_food_membership('${a}', 'chicken', 'avoid', null, 1)`))).toBe(1);
    expect(moves(a, () => asUser(a, `select public.set_food_membership('${a}', 'chicken', null, null, 2)`))).toBe(1);
    expect(moves(a, () => runSql(`update public.user_settings
      set diet_prefs = jsonb_set(diet_prefs, '{flags}', '["vegetarian"]') where user_id = '${a}'`))).toBe(1);
    expect(moves(a, () => asUser(a, `insert into public.user_dietary_profiles (user_id, profile_id, source, confirmed_at)
      values ('${a}', 'vegetarian', 'user_stated', now())`))).toBe(1);
    expect(moves(a, () => runSql(`insert into public.food_world_condition_confirmations (user_id, condition_key, choice)
      values ('${a}', 'celiac', 'no_limit')`))).toBe(1);
    expect(moves(a, () => runSql(`update public.user_settings set food_world = 'open' where user_id = '${a}'`))).toBe(1);
    expect(moves(a, () => runSql(`update public.user_settings set food_world = 'closed' where user_id = '${a}'`))).toBe(1);
  });

  it("an Avoid mark's food_ref_id swap and a family mark's name_norm change each move it by 1 (Sol r2)", () => {
    const a = account();
    const [rice, chicken] = [userFood(a, "Rice, brown"), userFood(a, "Chicken breast")];
    runSql(`insert into public.user_food_prefs (user_id, food_ref_id, status) values ('${a}', '${rice.refId}', 'avoid');
      insert into public.food_membership_revisions (user_id, name_norm, status, rev) values ('${a}', 'rice', 'avoid', 1)`);
    expect(moves(a, () => runSql(`update public.user_food_prefs set food_ref_id = '${chicken.refId}'
      where user_id = '${a}' and food_ref_id = '${rice.refId}'`))).toBe(1);
    expect(moves(a, () => runSql(`update public.food_membership_revisions set name_norm = 'chicken'
      where user_id = '${a}' and name_norm = 'rice'`))).toBe(1);
  });

  it("every account inventory table moves it on insert, update and delete", () => {
    const a = account();
    const food = userFood(a, "W2b oats");
    const revision = catalogRevision();
    const cases: [string, string, string, string][] = [
      ["user_foods", `insert into public.user_foods (user_id, name, kind) values ('${a}', 'W2b extra', 'custom')`,
        `update public.user_foods set per_100g = '{"protein": 1}' where user_id = '${a}' and name = 'W2b extra'`,
        `delete from public.user_foods where user_id = '${a}' and name = 'W2b extra'`],
      ["user_food_prefs", `insert into public.user_food_prefs (user_id, food_ref_id, status) values ('${a}', '${food.refId}', 'eats')`,
        `update public.user_food_prefs set note = 'W2b' where user_id = '${a}'`,
        `delete from public.user_food_prefs where user_id = '${a}'`],
      ["food_membership_revisions", `insert into public.food_membership_revisions (user_id, name_norm, status, rev)
        values ('${a}', 'oats', 'eats', 1)`, `update public.food_membership_revisions set note = 'W2b' where user_id = '${a}'`,
        `delete from public.food_membership_revisions where user_id = '${a}'`],
      ["user_dietary_profiles", `insert into public.user_dietary_profiles (user_id, profile_id, source, confirmed_at)
        values ('${a}', 'vegan', 'user_stated', now())`, `update public.user_dietary_profiles set notes = 'W2b' where user_id = '${a}'`,
        `delete from public.user_dietary_profiles where user_id = '${a}'`],
      ["food_world_condition_confirmations", `insert into public.food_world_condition_confirmations (user_id, condition_key, choice)
        values ('${a}', 'gout', 'no_limit')`, `update public.food_world_condition_confirmations set choice = 'pack' where user_id = '${a}'`,
        `delete from public.food_world_condition_confirmations where user_id = '${a}'`],
      ["user_allergen_checks", `insert into public.user_allergen_checks (user_id, food_key, allergen)
        values ('${a}', 'catalog_revision:${revision.id}', 'peanut')`,
        `update public.user_allergen_checks set checked_at = now() where user_id = '${a}'`,
        `delete from public.user_allergen_checks where user_id = '${a}'`],
      ["constraint_profiles", `delete from public.constraint_profiles where user_id = '${a}'`,
        `insert into public.constraint_profiles (user_id, avoid_allergens, banned_categories) values ('${a}', '{}', '{}')`,
        `update public.constraint_profiles set notes = 'W2b' where user_id = '${a}'`],
      ["user_settings", `update public.user_settings set meals_per_day = 5 where user_id = '${a}'`,
        `update public.user_settings set diet_prefs = jsonb_set(diet_prefs, '{water}', '{"unit": "ml"}') where user_id = '${a}'`,
        `delete from public.user_settings where user_id = '${a}'`],
    ];
    for (const [table, ...writes] of cases) {
      expect([table, writes.map((sql) => moves(a, () => runSql(sql)))]).toEqual([table, [1, 1, 1]]);
    }
    revision.drop();
  });

  it("an update that moves a row to another account moves both counters", () => {
    const [a, b] = [account(), account()];
    runSql(`insert into public.food_world_condition_confirmations (user_id, condition_key, choice)
      values ('${a}', 'gout', 'no_limit')`);
    const [beforeA, beforeB] = [rules(a), rules(b)];
    // user_foods pins its owner (cross_account_reference); this table does not.
    runSql(`update public.food_world_condition_confirmations set user_id = '${b}' where user_id = '${a}'`);
    expect([rules(a) - beforeA, rules(b) - beforeB]).toEqual([1, 1]);
  });

  it("one transaction writing several inventory tables moves each counter once", () => {
    const a = account();
    const revision = catalogRevision();
    const before = [rules(a), evidence()];
    runSql(`begin;
      update public.user_settings set meals_per_day = 4 where user_id = '${a}';
      update public.constraint_profiles set notes = 'one' where user_id = '${a}';
      insert into public.food_membership_revisions (user_id, name_norm, status, rev) values ('${a}', 'kale', 'avoid', 1);
      update public.catalog_food_revisions set description = 'W2b one' where id = ${revision.id};
      insert into public.catalog_ingredients (food_revision_id, seq, name) values (${revision.id}, 1, 'kale');
      commit;`);
    expect([rules(a) - before[0], evidence() - before[1]]).toEqual([1, 1]);
    const mid = evidence();
    runSql(`begin;
      update public.catalog_food_revisions set description = 'W2b two' where id = ${revision.id};
      update public.catalog_ingredients set name = 'kale, raw' where food_revision_id = ${revision.id};
      insert into public.food_allergen_evidence (food_key, allergen, level, source)
        values ('catalog_revision:${revision.id}', 'sesame', 'no_evidence', 'legacy');
      commit;`);
    expect(evidence() - mid).toBe(1);
    runSql(`delete from public.food_allergen_evidence where food_key = 'catalog_revision:${revision.id}'`);
    revision.drop();
  });

  it("two concurrent Avoid writes on different families, from two connections, move it by 2", async () => {
    const a = account();
    const before = rules(a);
    const write = (name: string) => background(`begin; set local role authenticated;
      set local request.jwt.claim.sub = '${a}';
      set local request.jwt.claims = '{"sub": "${a}", "role": "authenticated"}';
      select public.set_food_membership('${a}', '${name}', 'avoid', null, 1);
      select pg_sleep(0.5); commit;`);
    const results = await Promise.all([write("shrimp"), write("walnut")]);
    expect(results.map((r) => [r.code, r.err])).toEqual([[0, ""], [0, ""]]);
    expect(rules(a) - before).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the shared admission-input version (evidenceVersion)", () => {
  it("a revision description change and a nutrient amount change each move it by 1 (Sol r2)", () => {
    const revision = catalogRevision();
    expect(step(`insert into public.catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
      values (${revision.id}, 'protein', 12)`)).toBe(1);
    expect(step(`update public.catalog_food_revisions set description = 'W2b bread, white' where id = ${revision.id}`)).toBe(1);
    expect(step(`update public.catalog_food_nutrients set amount_per_100g = null
      where food_revision_id = ${revision.id} and nutrient_code = 'protein'`)).toBe(1);
    revision.drop();
  });

  it("every shared inventory table moves it on insert, update and delete, once per statement", () => {
    const revision = catalogRevision();
    const owner = account();
    const key = `catalog_revision:${revision.id}`;
    const foodId = runSql(`select catalog_food_id from public.catalog_food_revisions where id = ${revision.id}`);
    const tag = crypto.randomUUID();
    const cases: [string, string, string, string][] = [
      ["food_allergen_evidence", `insert into public.food_allergen_evidence (food_key, allergen, level, source)
        values ('${key}', 'peanut', 'no_evidence', 'legacy'), ('${key}', 'sesame', 'no_evidence', 'legacy')`,
        `update public.food_allergen_evidence set updated_at = now() where food_key = '${key}'`,
        `delete from public.food_allergen_evidence where food_key = '${key}'`],
      ["catalog_ingredients", `insert into public.catalog_ingredients (food_revision_id, seq, name) values (${revision.id}, 1, 'flour')`,
        `update public.catalog_ingredients set allergen_tags = '{wheat}' where food_revision_id = ${revision.id}`,
        `delete from public.catalog_ingredients where food_revision_id = ${revision.id}`],
      ["catalog_food_nutrients", `insert into public.catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
        values (${revision.id}, 'protein', 3)`,
        `update public.catalog_food_nutrients set amount_per_100g = 4 where food_revision_id = ${revision.id}`,
        `delete from public.catalog_food_nutrients where food_revision_id = ${revision.id}`],
      ["catalog_portions", `insert into public.catalog_portions (food_revision_id, description, gram_weight, seq)
        values (${revision.id}, 'slice', 30, 1)`,
        `update public.catalog_portions set gram_weight = 32 where food_revision_id = ${revision.id}`,
        `delete from public.catalog_portions where food_revision_id = ${revision.id}`],
      ["food_refs", `insert into public.food_refs (kind, catalog_food_id) values ('catalog', ${foodId})`,
        `update public.food_refs set catalog_food_id = catalog_food_id where catalog_food_id = ${foodId}`,
        `delete from public.food_refs where catalog_food_id = ${foodId}`],
      ["food_facets", `insert into public.food_facets (food_key, input_hash, facet, rubric_version, p, model, user_id)
        values ('w2b-${tag}', '\\x00', 'human_food', 1, 0.5, 'test', '${owner}')`,
        `update public.food_facets set p = 0.6 where food_key = 'w2b-${tag}'`,
        `delete from public.food_facets where food_key = 'w2b-${tag}'`],
      ["catalog_foods", `insert into public.catalog_foods (source, source_id) values ('fdc_sr_legacy', 'w2b-extra-${tag}')`,
        `update public.catalog_foods set source_id = 'w2b-extra2-${tag}' where source_id = 'w2b-extra-${tag}'`,
        `delete from public.catalog_foods where source_id = 'w2b-extra2-${tag}'`],
    ];
    for (const [table, ...writes] of cases) {
      expect([table, writes.map((sql) => step(sql))]).toEqual([table, [1, 1, 1]]);
    }
    expect(step(`update public.catalog_food_revisions set policy_categories = '{}' where id = ${revision.id}`)).toBe(1);
    expect(step(`delete from public.catalog_food_revisions where id = -1`)).toBe(0); // an empty statement
    const before = evidence();
    revision.drop(); // catalog_food_revisions and catalog_foods deletes, one transaction
    expect(evidence() - before).toBe(1);
    const born = evidence();
    catalogRevision().drop();
    expect(evidence() - born).toBe(2); // the insert transaction, then the delete transaction
  });
});
