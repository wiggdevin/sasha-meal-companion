/**
 * Phase 18 D6 Favor on the real migrated schema (migration 20261215090000; SUPABASE_TEST_DB_URL):
 * `favor_family_sets` returns set_food_membership's exact family set, and `favor_food_families`
 * locks, re-checks the account rules and evidence versions, the exact ref sets, Avoid and the judged
 * allowed ids, then writes all or nothing. A rule change that commits on another connection first
 * answers rules_changed with nothing written; a ref minted after a Favor does not inherit `eats`.
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, asUser, background, dropAccounts, evidence, rules, userFood } from "../helpers/world-db";

type Outcome = { status: string; favored?: string[]; written?: string[]; family?: string; rules_rev?: number };

const sets = (user: string, families: string[]) => JSON.parse(runSql(`select public.favor_family_sets('${user}',
  array[${families.map((f) => `'${f}'`).join(",")}]::text[])`)) as { name: string; name_norm: string; ref_ids: string[] }[];

function favorSql(user: string, keyFamily: string, families: { name_norm: string; ref_ids: string[] }[], allowed: string[],
  rulesRev: number, evidenceRev: number): string {
  return `select public.favor_food_families('${user}', '${keyFamily}', '${JSON.stringify(families)}'::jsonb,
    array[${allowed.map((id) => `'${id}'`).join(",")}]::uuid[], ${rulesRev}, ${evidenceRev})`;
}

const favor = (...args: Parameters<typeof favorSql>) => JSON.parse(runSql(favorSql(...args))) as Outcome;

const state = (user: string) => runSql(`select coalesce(json_agg(row_to_json(m) order by m.name_norm), '[]')
  from (select name_norm, status, rev, favor_rev from public.food_membership_revisions where user_id = '${user}') m`)
  + runSql(`select coalesce(json_agg(row_to_json(p) order by p.food_ref_id), '[]')
  from (select food_ref_id, status, rev from public.user_food_prefs where user_id = '${user}') p`);

/** Two own foods of one family, and the plan the server would send for it. */
function kiwi(user: string) {
  const gold = userFood(user, "Kiwi, gold");
  const green = userFood(user, "Kiwi, green");
  const [set] = sets(user, ["kiwi"]);
  return { gold, green, set, ids: [gold.refId, green.refId].sort() };
}

describe.skipIf(!HAS_DB)("favor_food_families on the migrated schema (Phase 18 D6)", () => {
  afterAll(dropAccounts);

  it("reads the family set set_food_membership writes, owner-scoped", () => {
    const a = account();
    const b = account();
    const { set, ids } = kiwi(a);
    userFood(b, "Kiwi, B canary");
    expect(set).toEqual({ name: "kiwi", name_norm: "kiwi", ref_ids: ids });
    expect(sets(a, ["Kiwi, anything"])[0].ref_ids).toEqual(ids);
  });

  it("writes the captured set, marks favor_rev, and moves the rules clock once", () => {
    const a = account();
    const { ids } = kiwi(a);
    const before = rules(a);
    expect(favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: ids }], ids, before, evidence()))
      .toEqual({ status: "ok", favored: ["kiwi"], written: ["kiwi"] });
    expect(JSON.parse(runSql(`select row_to_json(m) from (select status, rev, favor_rev from public.food_membership_revisions
      where user_id = '${a}' and name_norm = 'kiwi') m`))).toEqual({ status: "eats", rev: 1, favor_rev: 1 });
    expect(runSql(`select string_agg(status, ',' order by food_ref_id) from public.user_food_prefs where user_id = '${a}'`))
      .toBe("eats,eats");
    expect(rules(a)).toBe(before + 1);
    // Already eats: favored again, nothing written.
    const after = state(a);
    expect(favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: ids }], ids, rules(a), evidence()))
      .toEqual({ status: "ok", favored: ["kiwi"], written: [] });
    expect(state(a)).toBe(after);
  });

  it("a rule change committed on another connection first: rules_changed, nothing written", async () => {
    const a = account();
    const { ids } = kiwi(a);
    const captured = rules(a);
    const ev = evidence();
    // The rule transaction holds the clock row while the Favor transaction waits for it.
    const rule = background(`begin; update public.constraint_profiles set avoid_allergens = '{milk}', rev = rev + 1
      where user_id = '${a}'; select pg_sleep(1); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = state(a);
    const out = favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: ids }], ids, captured, ev);
    expect((await rule).code).toBe(0);
    expect(out).toEqual({ status: "rules_changed", rules_rev: captured + 1, evidence_rev: ev });
    expect(state(a)).toBe(before);
    // Committed before the Favor even starts: the same.
    runSql(`update public.constraint_profiles set notes = 'moved', rev = rev + 1 where user_id = '${a}'`);
    expect(favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: ids }], ids, captured + 1, ev).status).toBe("rules_changed");
    expect(state(a)).toBe(before);
  });

  it("a changed family write set, a ref outside the judged ids, or an Avoid: rejected, nothing written", () => {
    const a = account();
    const { ids } = kiwi(a);
    const plan = [{ name_norm: "kiwi", ref_ids: ids }];
    const red = userFood(a, "Kiwi, red");
    const before = state(a);
    expect(favor(a, "kiwi", plan, ids, rules(a), evidence())).toEqual({ status: "set_changed", family: "kiwi" });
    const all = [...ids, red.refId].sort();
    expect(favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: all }], ids, rules(a), evidence()))
      .toEqual({ status: "not_allowed", family: "kiwi" });
    runSql(`insert into public.food_membership_revisions (user_id, name_norm, status, rev) values ('${a}', 'kiwis', 'avoid', 1)`);
    expect(favor(a, "kiwis", [{ name_norm: "kiwi", ref_ids: all }], all, rules(a), evidence()))
      .toEqual({ status: "avoid", family: "kiwis" });
    runSql(`insert into public.user_food_prefs (user_id, food_ref_id, status) values ('${a}', '${red.refId}', 'avoid')`);
    const avoided = state(a);
    expect(favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: all }], all, rules(a), evidence()))
      .toEqual({ status: "avoid", family: "kiwi" });
    expect(state(a)).toBe(avoided);
    expect(before).not.toBe(avoided);
  });

  it("is all or nothing across families: one failing family writes none", () => {
    const a = account();
    const { ids } = kiwi(a);
    const fig = userFood(a, "Fig, dried");
    const before = state(a);
    expect(favor(a, "kiwi", [{ name_norm: "fig", ref_ids: [fig.refId] }, { name_norm: "kiwi", ref_ids: [ids[0]] }],
      [fig.refId, ...ids], rules(a), evidence())).toEqual({ status: "set_changed", family: "kiwi" });
    expect(state(a)).toBe(before);
    expect(favor(a, "kiwi", [{ name_norm: "fig", ref_ids: [fig.refId] }, { name_norm: "kiwi", ref_ids: ids }],
      [fig.refId, ...ids], rules(a), evidence())).toMatchObject({ status: "ok", favored: ["fig", "kiwi"] });
  });

  it("a ref minted after a Favor does not inherit eats; a later ordinary mark restores the backfill", () => {
    const a = account();
    const { ids } = kiwi(a);
    favor(a, "kiwi", [{ name_norm: "kiwi", ref_ids: ids }], ids, rules(a), evidence());
    const mint = (name: string) => {
      const food = runSql(`insert into public.user_foods (user_id, name, kind) values ('${a}', '${name}', 'custom') returning id`)
        .split("\n")[0];
      const ref = /[0-9a-f-]{36}/.exec(asUser(a, `select public.get_or_create_food_ref('${a}', 'user', null, '${food}')`))![0];
      return runSql(`select coalesce((select status from public.user_food_prefs where user_id = '${a}'
        and food_ref_id = '${ref}'), 'none')`);
    };
    expect(mint("Kiwi, baby")).toBe("none");
    runSql(`select public.set_food_membership('${a}', 'kiwi', 'eats', null, 5)`);
    expect(mint("Kiwi, hardy")).toBe("eats");
  });

  it("only the service role may call either function", () => {
    const a = account();
    expect(() => asUser(a, `select public.favor_family_sets('${a}', array['kiwi']::text[])`)).toThrow();
    expect(() => asUser(a, `select public.favor_food_families('${a}', 'kiwi', '[]'::jsonb, '{}'::uuid[], 0, 0)`)).toThrow();
    expect(runSql(`select has_function_privilege('authenticated',
      'public.favor_food_families(uuid,text,jsonb,uuid[],bigint,bigint)', 'execute')`)).toBe("f");
  });
});
