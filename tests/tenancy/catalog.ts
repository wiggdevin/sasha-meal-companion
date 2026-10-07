/**
 * Catalog generators for the tenancy checks (spec 3.1, 3.3). They read `pg_catalog` only, never
 * the manifests they are compared with (plan audit r1 finding 9).
 */
import { runSql } from "../helpers/supabase";

export type OwnedTable = { table: string; parent: string | null; fk: string | null };

/**
 * Account-owned tables: every public table with a `user_id` column, plus every public table that
 * reaches one of those through a chain of single-column ON DELETE CASCADE foreign keys (for
 * example `log_items.entry_id` → `log_entries`). A nullable cascading key counts too:
 * `food_refs.user_food_id` is null for shared catalog refs, but a `kind='user'` ref belongs to its
 * food's owner (review r1 finding 3). A non-cascading key (a reference, not ownership) does not
 * make a row the parent's; see `crossRefs()` for those. When a child reaches owned
 * parents through more than one key, the shortest chain wins, then the parent name, then the key.
 */
export function ownedTables(): OwnedTable[] {
  return runSql(`
    with recursive direct as (
      select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
    ), owned(oid, parent, fk, depth) as (
      select oid, null::text collate "C", null::text collate "C", 0 from direct
      union
      select ch.oid, o_rel.relname::text collate "C", att.attname::text collate "C", o.depth + 1
      from owned o
      join pg_class o_rel on o_rel.oid = o.oid
      join pg_constraint k on k.confrelid = o.oid and k.contype = 'f'
        and array_length(k.conkey, 1) = 1 and k.confdeltype = 'c'
      join pg_class ch on ch.oid = k.conrelid and ch.relkind = 'r'
      join pg_namespace n on n.oid = ch.relnamespace and n.nspname = 'public'
      join pg_attribute att on att.attrelid = ch.oid and att.attnum = k.conkey[1]
      where ch.oid not in (select oid from direct) and o.depth < 5
    )
    select distinct on (c.relname) c.relname || '|' || coalesce(o.parent, '') || '|' || coalesce(o.fk, '')
    from owned o join pg_class c on c.oid = o.oid
    order by c.relname, o.depth, o.parent, o.fk`)
    .split("\n").filter(Boolean).map((line) => {
      const [table, parent, fk] = line.split("|");
      return { table, parent: parent || null, fk: fk || null };
    });
}

export type CrossRef = { table: string; column: string; references: string };

/**
 * Every single-column foreign key from an account-owned table to another account-owned table that
 * is not the child's ownership edge (review r1 finding 2): for example
 * `duplicate_group_members.entry_id` → `log_entries` or `log_items.food_ref_id` → `food_refs`. A
 * row one account owns must never point at a row another account owns through one of these.
 */
export function crossRefs(): CrossRef[] {
  const owned = ownedTables();
  const names = owned.map((t) => `'${t.table}'`).join(",");
  const edges = new Set(owned.filter((t) => t.fk).map((t) => `${t.table}.${t.fk}`));
  return runSql(`
    select c.relname || '|' || a.attname || '|' || p.relname
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class p on p.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_namespace pn on pn.oid = p.relnamespace and pn.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.conkey[1]
    where k.contype = 'f' and array_length(k.conkey, 1) = 1
      and c.relname in (${names}) and p.relname in (${names})
    order by 1`).split("\n").filter(Boolean).map((line) => {
      const [table, column, references] = line.split("|");
      return { table, column, references };
    }).filter((r) => !edges.has(`${r.table}.${r.column}`));
}

export function userTables(): string[] {
  return ownedTables().map((t) => t.table).sort();
}

export function rlsState(tables: string[]): { table: string; rlsEnabled: boolean; anonPolicies: number }[] {
  const list = tables.map((t) => `'${t}'`).join(",");
  return runSql(`
    select c.relname || '|' || c.relrowsecurity || '|' ||
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
         and ('anon' = any(p.roles) or 'public' = any(p.roles)))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in (${list}) order by 1`)
    .split("\n").filter(Boolean).map((line) => {
      const [table, rls, anon] = line.split("|");
      return { table, rlsEnabled: rls === "true", anonPolicies: Number(anon) };
    });
}

/**
 * Full signatures (`name(arg types)`) of every public function `authenticated` may execute, so an
 * overload is its own manifest entry. Functions an extension owns (pg_trgm, unaccent) are left out:
 * they are not application surface and read no account data.
 */
export function authenticatedFunctions(): { signature: string; securityDefiner: boolean }[] {
  return runSql(`
    select p.oid::regprocedure::text || '|' || p.prosecdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                        and d.objid = p.oid and d.deptype = 'e')
    order by 1`).split("\n").filter(Boolean).map((line) => {
      const [signature, definer] = line.split("|");
      return { signature, securityDefiner: definer === "true" };
    });
}
