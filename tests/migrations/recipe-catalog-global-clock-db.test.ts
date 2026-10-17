/**
 * W072 (scale step 10): migration 20270105110100_recipe_catalog_global_clock. A shared catalog
 * write moves ONE row (recipe_catalog_clock), never a recipe_plan_state row per account, and a
 * recipe or shopping preview still goes stale when the catalog changes: recipe_store_preview and
 * recipe_accept_preview compare "account rev + catalog rev" under the lock order
 * (evidence_clock, account_rules_clock, recipe_catalog_clock, recipe_plan_state).
 *
 * Runs on the real migrated schema (SUPABASE_TEST_DB_URL); skipped without it.
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, catalogRevision, dropAccounts, userFood } from "../helpers/world-db";

const drops: (() => void)[] = [];
const catalogRev = () => Number(runSql("select rev from public.recipe_catalog_clock where id = 1"));
/** Every listed account's recipe_plan_state row version (xmin moves on any update). */
const stateVersions = (users: string[]) => runSql(`select string_agg(user_id || ':' || rev || ':' || xmin, ','
  order by user_id) from public.recipe_plan_state where user_id in (${users.map((u) => `'${u}'`).join(",")})`);

function accounts(n: number): string[] {
  const users = Array.from({ length: n }, () => account());
  for (const u of users) {
    runSql(`insert into public.recipe_plan_state (user_id, rev) values ('${u}', 1) on conflict (user_id) do nothing`);
  }
  return users;
}

/** recipe_store_preview as the server calls it (service role), with a minimal proof. */
const store = (user: string, stateRev: number) => runSql(`begin;
  set local request.jwt.claim.role = 'service_role';
  set local request.jwt.claims = '{"role": "service_role"}';
  select public.recipe_store_preview('${user}', 'recipe', '{"choices": [], "blockingIssues": []}'::jsonb,
    ${stateRev}, now() + interval '10 minutes');
  commit;`).split("\n").find((line) => /^[0-9a-f-]{36}$/.test(line))!;
const accountRev = (user: string) =>
  Number(runSql(`select rev from public.recipe_plan_state where user_id = '${user}'`));

/** recipe_accept_preview as the signed-in owner; answers "ok" or the error text. */
function accept(user: string, preview: string): string {
  try {
    runSql(`begin; set local role authenticated;
      set local request.jwt.claim.sub = '${user}';
      set local request.jwt.claims = '{"sub": "${user}", "role": "authenticated"}';
      select public.recipe_accept_preview('${preview}', '${crypto.randomUUID()}', false); rollback;`);
    return "ok";
  } catch (e) {
    return String(e);
  }
}

describe.skipIf(!HAS_DB)("one global catalog clock (W072)", () => {
  afterAll(() => {
    dropAccounts();
    for (const drop of drops.splice(0)) drop();
  });

  it("N accounts and one catalog write change one row", () => {
    const users = accounts(6);
    const before = stateVersions(users);
    const rev = catalogRev();
    const revision = catalogRevision();
    drops.push(revision.drop);
    expect(catalogRev()).toBe(rev + 1);
    expect(stateVersions(users)).toBe(before);
    runSql(`update public.catalog_food_revisions set description = 'W072 bread' where id = ${revision.id}`);
    expect(catalogRev()).toBe(rev + 2);
    expect(stateVersions(users)).toBe(before);
  });

  it("moves the catalog rev once per transaction, however many catalog statements it runs", () => {
    const revision = catalogRevision();
    drops.push(revision.drop);
    const rev = catalogRev();
    runSql(`begin;
      update public.catalog_food_revisions set description = 'W072 a' where id = ${revision.id};
      update public.catalog_food_revisions set description = 'W072 b' where id = ${revision.id};
      commit;`);
    expect(catalogRev()).toBe(rev + 1);
  });

  it("global allergen evidence and a catalog ref move the clock; an account's own rows move only that account", () => {
    const users = accounts(3);
    const before = stateVersions(users);
    let rev = catalogRev();
    const evidenceOf = catalogRevision();
    drops.push(evidenceOf.drop);
    rev = catalogRev();
    const key = `catalog_revision:${evidenceOf.id}`;
    runSql(`insert into public.food_allergen_evidence (food_key, allergen, level, source)
      values ('${key}', 'peanut', 'no_evidence', 'ingredients')`);
    drops.unshift(() => runSql(`delete from public.food_allergen_evidence where food_key = '${key}'`));
    expect(catalogRev()).toBe(rev + 1);
    expect(stateVersions(users)).toBe(before);

    const refOf = catalogRevision();
    drops.push(refOf.drop);
    const food = runSql(`select catalog_food_id from public.catalog_food_revisions where id = ${refOf.id}`);
    rev = catalogRev();
    const ref = runSql(`insert into public.food_refs (kind, catalog_food_id) values ('catalog', ${food}) returning id`)
      .split("\n")[0];
    drops.unshift(() => runSql(`delete from public.food_refs where id = '${ref}'`));
    expect(catalogRev()).toBe(rev + 1);
    expect(stateVersions(users)).toBe(before);

    const [owner] = users;
    const ownerRev = accountRev(owner);
    rev = catalogRev();
    userFood(owner, "W072 oats");
    expect(accountRev(owner)).toBeGreaterThan(ownerRev);
    expect(catalogRev()).toBe(rev);
    expect(stateVersions(users.slice(1))).toBe(before.split(",").filter((v) => !v.startsWith(owner)).join(","));
  });

  it("stores the sum, records the catalog part, and refuses a sum from before a catalog write", () => {
    const [user] = accounts(1);
    const sum = accountRev(user) + catalogRev();
    const preview = store(user, sum);
    expect(runSql(`select state_rev || ':' || catalog_rev from public.recipe_plan_previews where id = '${preview}'`))
      .toBe(`${sum}:${catalogRev()}`);
    drops.push(catalogRevision().drop);
    expect(() => store(user, sum)).toThrow(/stale preview/);
    expect(() => store(user, accountRev(user))).toThrow(/stale preview/);
  });

  it("an accept goes stale on a catalog write, and only then", () => {
    const [user] = accounts(1);
    const fresh = store(user, accountRev(user) + catalogRev());
    expect(accept(user, fresh)).not.toMatch(/stale preview/);
    const stale = store(user, accountRev(user) + catalogRev());
    drops.push(catalogRevision().drop);
    expect(accept(user, stale)).toMatch(/stale preview/);
  });

  it("the clock is one row, readable by a signed-in user, written only by its triggers", () => {
    expect(runSql("select count(*) from public.recipe_catalog_clock")).toBe("1");
    expect(runSql(`select has_table_privilege('authenticated', 'public.recipe_catalog_clock', 'select') || ':' ||
      has_table_privilege('authenticated', 'public.recipe_catalog_clock', 'update') || ':' ||
      has_function_privilege('authenticated', 'public._recipe_catalog_bump()', 'execute')`)).toBe("true:false:false");
    expect(runSql(`select count(*) from pg_proc where prosrc like '%update public.recipe_plan_state set rev = rev + 1 where user_id is not null%'`))
      .toBe("0");
  });
});
