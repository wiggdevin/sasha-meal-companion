/**
 * Spec 3.4 (Phase 9 slice 3): each RLS policy on a declared table is weakened inside a transaction
 * that is rolled back (its `using` and `with check` become `true`, it applies to `authenticated`,
 * and every operation is granted). The probe that runs as user A must see the leak once weakened
 * and must see nothing without the change. A probe that cannot tell the two apart is a check that
 * would not notice a broken policy.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql } from "../helpers/supabase";
import manifest from "./table-ops.json";
import { build, ownerPredicate, purge, seed } from "./seed";
import type { Fixture } from "./fixtures";

type Policy = { table: string; name: string; cmd: string; hasUsing: boolean; hasCheck: boolean };
const tables = Object.keys(manifest);

const policies: Policy[] = HAS_DB ? runSql(`
  select tablename || '|' || policyname || '|' || cmd || '|' || (qual is not null) || '|' ||
    (with_check is not null)
  from pg_policies where schemaname = 'public'
    and tablename = any(array[${tables.map((t) => `'${t}'`).join(",")}]) order by 1`)
  .split("\n").filter(Boolean).map((line) => {
    const [table, name, cmd, hasUsing, hasCheck] = line.split("|");
    return { table, name, cmd, hasUsing: hasUsing === "true", hasCheck: hasCheck === "true" };
  }) : [];

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Runs `body` as A inside a DO block; `body` sets `n` to the rows it reached. The count is read
 * back after `reset role`. An error (a missing grant, a refused check) counts as zero rows reached:
 * that refusal is the expected outcome without the mutation.
 */
function counted(body: string): string {
  return `do $$ declare n integer := 0; begin
      ${body}
      perform set_config('tenancy.reached', n::text, true);
    exception when others then
      perform set_config('tenancy.reached', '0', true);
    end $$;
    reset role;
    select current_setting('tenancy.reached')::integer;`;
}

const written = (statement: string) => counted(`${statement}; get diagnostics n = row_count;`);

/**
 * A filter for B's rows that A can evaluate without reading another table: a child's parent keys
 * are resolved first, as the owner role, so the parent's own policy cannot hide them.
 */
function ownerFilter(table: string, b: string): string {
  const owner = (manifest as Record<string, { owner: unknown }>)[table].owner;
  if (owner === "user_id") return `user_id = '${b}'`;
  const fk = (owner as { fk: string }).fk;
  const keys = runSql(`select coalesce(string_agg(distinct ${fk}::text, ','), '')
    from public.${table} where ${ownerPredicate(table, b)}`);
  return `${fk}::text = any(string_to_array('${keys}', ','))`;
}

function probeSql(p: Policy, actor: string, b: string, insertRow: Fixture): string {
  const t = `public.${p.table}`;
  if (p.cmd === "SELECT" || p.cmd === "ALL") {
    return counted(`select count(*) into n from ${t} where ${ownerFilter(p.table, b)};`);
  }
  if (p.cmd === "INSERT") {
    const cols = Object.keys(insertRow.row).join(", ");
    return written(`insert into ${t} (${cols}) select ${cols}
      from json_populate_record(null::${t}, ${literal(JSON.stringify(insertRow.row))})`);
  }
  // No WHERE on purpose: a WHERE clause would bring in the (unchanged) select policy, which hides
  // B's rows, so the weakened update or delete policy alone would never be exercised.
  if (p.cmd === "UPDATE") {
    const touch = insertRow.touch(actor);
    const sets = Object.keys(touch).map((c) => `${c} = r.${c}`).join(", ");
    return written(`update ${t} set ${sets}
      from json_populate_record(null::${t}, ${literal(JSON.stringify(touch))}) r`);
  }
  return written(`delete from ${t}`);
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("policy mutation (spec 3.4)", () => {
  let a = "";
  let b = "";

  beforeAll(async () => {
    [a, b] = (await Promise.all([ensureUser("a"), ensureUser("b")])).map((u) => u.id);
    // A owns nothing, so a WHERE-less write counts only rows a weakened policy lets her reach.
    await purge([a, b]);
    for (const [table, e] of Object.entries(manifest as Record<string, { seed: string }>)) {
      if (policies.some((p) => p.table === table)) await seed(e.seed, b);
    }
  });

  afterAll(async () => {
    await purge([a, b]);
  });

  it("finds at least one policy to weaken", () => {
    expect(policies.length).toBeGreaterThan(0);
  });

  for (const p of policies) {
    it(`${p.table}.${p.name} (${p.cmd}): weakened, A's probe reaches B's rows`, async () => {
      const seedId = (manifest as Record<string, { seed: string }>)[p.table].seed;
      const insertRow = await build(seedId, b);
      const clauses = [p.hasUsing ? "using (true)" : "", p.hasCheck ? "with check (true)" : ""]
        .join(" ");
      const run = (mutate: boolean) => Number(runSql(`begin;
        ${mutate ? `alter policy "${p.name}" on public.${p.table} to authenticated ${clauses};
          grant select, insert, update, delete on public.${p.table} to authenticated;` : ""}
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"${a}","role":"authenticated"}';
        ${probeSql(p, a, b, insertRow)}
        rollback;`).split("\n").filter((l) => /^\d+$/.test(l)).pop());
      expect(run(false)).toBe(0);
      expect(run(true)).toBeGreaterThan(0);
    });
  }
});
