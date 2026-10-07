-- Loop-3 data-integrity finding (2026-10-03): the production sweep's `membership_contradictions`
-- "partial" families (U3's `food_membership_contradictions`, 20261023090400) are same-name
-- catalog families where some food_refs carry this account's eats/avoid mark and others carry no
-- `user_food_prefs` row at all. `set_food_membership` only marks the food_refs that EXIST at the
-- moment it runs (up to its 50-ref cap); a catalog food_ref is created lazily, the first time
-- ANYONE references that specific row (`get_or_create_food_ref`'s unique index on
-- `catalog_food_id`), so a same-name catalog row this account had never touched before gets a
-- brand-new, neutral ref the moment this account's own search, barcode scan, log entry or recipe
-- match is the first ever to mint it — with nothing to tell it the account already marked that
-- food. This keeps recurring for any account that logs, scans or gets a recipe match on a food
-- family after marking it, so it is fixed at the only place a same-name ref can newly exist:
-- `get_or_create_food_ref` now looks up the CALLING account's own `food_membership_revisions` row
-- for the ref's normalized name and, if one exists and carries a status, gives the ref that
-- status — `on conflict (user_id, food_ref_id) do nothing` against the table's own primary key,
-- so an existing pref row (this account's deliberate state for that exact ref) is never touched.
--
-- Post-audit fixes (2026-10-03, Grok + DeepSeek both FAILED the first version):
-- * The lookup now also takes the family's note from `food_membership_revisions.note` — the
--   same column `set_food_membership` itself copies onto every ref it marks — instead of
--   leaving the backfilled row's note null. `food_membership_revisions` carries a primary key on
--   (user_id, name_norm), so this can only ever match zero or one row; `order by ... limit 1` is
--   added anyway so the lookup stays correct even if that constraint is ever relaxed.
-- * The new row is inserted at `rev = 1`, matching `set_food_membership`'s OWN canonical insert
--   for a food_ref it is marking for the first time (`... values (p_user, ref_id, p_status,
--   v_note, 1, now())`, 20261205090000) — this column is a per-ref write counter the generic
--   sync route's optimistic concurrency reads (`lib/sync/merge.ts` resolves `user_food_prefs`
--   field-wise by `client_ts`, not by comparing this counter against the name-level
--   `food_membership_revisions.rev`, a different counter in a different table). Copying the
--   name-level rev here would make a ref backfilled through this path start at a DIFFERENT rev
--   than an identical ref `set_food_membership` marks directly, which is the inconsistency to
--   avoid, not the one to fix.
-- * The backfill is wrapped in its own nested block: a failure in the membership lookup or
--   insert — including the lookup for `v_name` itself, now covered by the same block — is caught
--   and logged with `raise warning`, not raised, so `get_or_create_food_ref` always returns the
--   ref id it just resolved or created even when the backfill itself cannot complete.
-- * The catalog branch's `v_name` lookup orders by `cr.valid_from desc` instead of
--   `cr.catalog_food_id` (a no-op order on rows that already share one `catalog_food_id`).
--   `catalog_food_revisions_one_active` (20260911000100) is a unique index on `catalog_food_id`
--   WHERE `is_active`, so at most one row can ever match `cr.is_active` for a given
--   `p_catalog_food_id` — a reviewer flagged this ordering as picking a nondeterministic revision
--   name when a food has multiple active revisions, which the schema does not allow. The order-by
--   stays anyway, belt-and-suspenders, so a future relaxation of that constraint still resolves to
--   the newest row rather than reviving the previous no-op order.
-- * The backfill's own lookup is scoped exactly the way the rest of this function already is:
--   `_sync_assert_caller(p_user_id)` (unchanged, above) refuses an authenticated caller whose
--   `auth.uid()` does not equal `p_user_id`, and the backfill's `where membership.user_id =
--   p_user_id` then reads only THAT account's `food_membership_revisions` row — `security
--   definer` lets the function read the table past RLS, but the `where` clause is what decides
--   whose row comes back, and it is never anyone but the asserted caller. A same-name ref minted
--   by a DIFFERENT account is never backfilled from this account's mark, and vice versa; the new
--   DB test drives this as an authenticated cross-user call, not an admin one.
create or replace function get_or_create_food_ref(p_user_id uuid, p_kind text,
                                       p_catalog_food_id bigint, p_user_food_id uuid)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _sync_assert_caller(p_user_id);
  if p_kind = 'catalog' then
    if p_catalog_food_id is null then raise exception 'catalog_food_id_required' using errcode = '22023'; end if;
    select id into v_id from food_refs where catalog_food_id = p_catalog_food_id;
    if v_id is null then
      insert into food_refs (kind, catalog_food_id) values ('catalog', p_catalog_food_id)
        on conflict (catalog_food_id) where catalog_food_id is not null do nothing
        returning id into v_id;
      if v_id is null then select id into v_id from food_refs where catalog_food_id = p_catalog_food_id; end if;
    end if;
  elsif p_kind = 'user' then
    if p_user_food_id is null then raise exception 'user_food_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from user_foods f where f.id = p_user_food_id and f.user_id = p_user_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    select id into v_id from food_refs where user_food_id = p_user_food_id;
    if v_id is null then
      insert into food_refs (kind, user_food_id) values ('user', p_user_food_id)
        on conflict (user_food_id) where user_food_id is not null do nothing
        returning id into v_id;
      if v_id is null then select id into v_id from food_refs where user_food_id = p_user_food_id; end if;
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;

  -- Best-effort: the caller is owed the ref id above no matter what happens here.
  begin
    declare
      v_name text;
      v_status text;
      v_note text;
    begin
      if p_kind = 'catalog' then
        select food_name_norm(cr.description) into v_name
          from catalog_food_revisions cr
         where cr.catalog_food_id = p_catalog_food_id and cr.is_active
         order by cr.valid_from desc, cr.id desc limit 1;
      else
        select food_name_norm(f.name) into v_name from user_foods f where f.id = p_user_food_id;
      end if;
      if v_id is not null and v_name is not null and v_name <> '' then
        select membership.status, membership.note into v_status, v_note
          from food_membership_revisions membership
         where membership.user_id = p_user_id and membership.name_norm = v_name
         order by membership.updated_at desc limit 1;
        if v_status is not null then
          insert into user_food_prefs (user_id, food_ref_id, status, note, rev, updated_at)
          values (p_user_id, v_id, v_status, v_note, 1, now())
          on conflict (user_id, food_ref_id) do nothing;
        end if;
      end if;
    end;
  exception when others then
    raise warning 'get_or_create_food_ref membership backfill failed for user % ref %: %',
      p_user_id, v_id, sqlerrm;
  end;

  return v_id;
end; $$;
revoke execute on function get_or_create_food_ref(uuid, text, bigint, uuid) from public, anon;
grant execute on function get_or_create_food_ref(uuid, text, bigint, uuid) to authenticated, service_role;
