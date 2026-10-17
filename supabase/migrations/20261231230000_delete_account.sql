-- Self-serve account deletion (reconciliation audit 2026-10-08, finding
-- no-self-serve-account-deletion): `delete_account(user)` removes one account and every row it owns
-- in ONE transaction, so a failure part-way leaves the account whole, never half-deleted.
--
--   1. A transaction advisory lock per account: two deletes of one account serialize, and the
--      second answers `already_gone`. Then the W034 clock lock order (migration
--      20261231200000): `evidence_clock`, then the account's `account_rules_clock` row, before any
--      delete below bumps either, so a sync on the account's other device cannot deadlock with it.
--   2. The account's rows in every public table with a `user_id` column, read from pg_catalog on
--      every call (not written here), so a table added later is covered without a change to this
--      function. Shared rows (`user_id is null`, the catalog) never match. This step is what
--      reaches tables no cascade does (`food_facets` today), and it also clears the order the
--      cascade alone cannot: an account's `food_refs` row cascades from `user_foods` while its
--      `recipe_items`, `log_items` and favourites still point at it with a NO ACTION key, and
--      that check fails mid-cascade. Tables are tried in name order; one that a row elsewhere
--      still references (23503) is retried after the others, until a pass deletes from no new
--      table. A table whose guard refuses while the auth row exists (P0001: a held Jev row in
--      `food_allergen_evidence` steps aside only once the account is gone) is left for step 4.
--      Each try is its own subtransaction, so a refused one changes nothing. Deleting the
--      account's `food_refs` and `food_facets` rows bumps the global evidence clock, as any food
--      write does, so open-world phones refetch their snapshot once.
--   3. Pending background work that names the account outside a foreign key: its id in a job
--      cursor's retry list, and the rate-limit windows whose key ends in the user id (the
--      per-account keys; a token- or IP-keyed window names no account and expires by itself).
--   4. The `auth.users` row itself. Every account-owned table (the tenancy manifest,
--      tests/tenancy/table-ops.json) reaches it through ON DELETE CASCADE, so this one statement
--      also removes whatever step 2 left, and any row a step-2 delete's trigger wrote back (a
--      clock bump). Their triggers
--      already treat a missing auth row as "the account is being deleted" (no clock re-created,
--      the held-allergen guard steps aside). The auth schema's own tables (identities, sessions,
--      refresh tokens, MFA factors) cascade from it too.
--
-- Storage objects are not rows here: the route (lib/server/account-delete.ts) removes the
-- account's `media/<user id>/` objects BEFORE it calls this function, while the account still
-- exists to retry from, and calls the Auth admin API after it (which then finds no user).
--
-- Never touches a catalog table: step 2 only reads tables with a user_id column and only deletes
-- rows whose user_id is this account; step 4 only deletes the auth row.
--
-- Service role only (the route's admin client); `authenticated` and `anon` cannot execute it.
-- Live-safe: one new function; no table is altered or locked by applying it.
-- Apply order: this file alone, its own transaction, BEFORE ACCOUNT_DELETION_ENABLED=1 is set.
-- Down: supabase/migrations/down/20261231230000_delete_account.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function public.delete_account(p_user_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  v_table regclass;
  v_left regclass[];
  v_next regclass[];
begin
  if p_user_id is null then
    raise exception 'delete_account: a user id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('delete_account:' || p_user_id::text, 0));
  if not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('status', 'already_gone');
  end if;
  perform public._clock_lock_evidence();
  perform public._clock_lock_rules(p_user_id);

  -- 2. The account's rows in every table with a user_id column, children before parents.
  select coalesce(array_agg(c.oid::regclass order by c.relname), '{}')
    into v_left
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
   where c.relkind = 'r';
  loop
    v_next := '{}';
    foreach v_table in array v_left loop
      begin
        execute format('delete from %s where user_id = $1', v_table) using p_user_id;
      exception when foreign_key_violation or raise_exception then
        v_next := v_next || v_table;
      end;
    end loop;
    exit when cardinality(v_next) = 0 or cardinality(v_next) = cardinality(v_left);
    v_left := v_next;
  end loop;

  -- 3. Pending work that names the account without a foreign key.
  update public.job_cursors set retry_keys = array_remove(retry_keys, p_user_id::text)
   where p_user_id::text = any (retry_keys);
  delete from public.rate_limits where right(key, 36) = p_user_id::text;

  -- 4. The account. Every account-owned table cascades from this one statement.
  delete from auth.users where id = p_user_id;
  return jsonb_build_object('status', 'deleted');
end $$;

comment on function public.delete_account(uuid) is
  'Self-serve account deletion: removes one account and every row it owns in one transaction (its rows in every user_id table, its job-cursor retry keys and rate-limit windows, then auth.users, which every account table cascades from). Service role only; lib/server/account-delete.ts.';

revoke all on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;
