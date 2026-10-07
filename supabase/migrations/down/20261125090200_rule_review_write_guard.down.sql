-- Restoring table-wide authenticated writes while the server marker exists is unsafe.
do $refuse$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'constraint_profiles'
                and column_name = 'rule_review_required') then
    raise exception 'rule_review_write_guard down: remove the review marker first'
      using errcode = '55000';
  end if;
end;
$refuse$;

revoke insert (user_id, rev, conditions, notes, avoid_allergens,
  avoid_food_ref_ids, banned_categories, updated_at)
  on table public.constraint_profiles from authenticated;
revoke update (user_id, rev, conditions, notes, avoid_allergens,
  avoid_food_ref_ids, banned_categories, updated_at)
  on table public.constraint_profiles from authenticated;
grant insert, update, delete on table public.constraint_profiles to authenticated;
