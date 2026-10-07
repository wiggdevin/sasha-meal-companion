revoke execute on function public.recipe_accept_preview(uuid,uuid,boolean) from authenticated;
revoke execute on function public.recipe_store_preview(uuid,text,jsonb,bigint,timestamptz) from service_role;
drop function if exists public.recipe_accept_preview(uuid,uuid,boolean);
drop function if exists public.recipe_store_preview(uuid,text,jsonb,bigint,timestamptz);
drop trigger if exists recipe_state_allergen_evidence on public.food_allergen_evidence;
drop function if exists public.recipe_plan_bump_allergen_evidence();
drop trigger if exists recipe_state_food_refs on public.food_refs;
drop trigger if exists recipe_state_catalog_evidence on public.catalog_food_revisions;
drop trigger if exists recipe_state_catalog on public.recipe_catalog;
drop function if exists public.recipe_plan_bump_global_state();
drop trigger if exists recipe_state_allergen_checks on public.user_allergen_checks;
drop trigger if exists recipe_state_dietary_profiles on public.user_dietary_profiles;
drop trigger if exists recipe_state_favorites on public.favorites_catalog_recipes;
drop trigger if exists recipe_state_favorite_foods on public.favorites_foods;
drop trigger if exists recipe_state_selections on public.recipe_plan_selections;
drop trigger if exists recipe_state_plan_days on public.plan_days;
drop trigger if exists recipe_selection_supersede on public.plan_days;
drop function if exists public.recipe_plan_supersede_on_day();
drop trigger if exists recipe_state_pantry on public.shopping_pantry;
drop trigger if exists recipe_state_purchase_windows on public.shopping_purchase_windows;
drop trigger if exists recipe_state_lines on public.shopping_lines;
drop trigger if exists recipe_state_periods on public.shopping_periods;
drop trigger if exists recipe_state_food_prefs on public.user_food_prefs;
drop trigger if exists recipe_state_user_foods on public.user_foods;
drop trigger if exists recipe_state_settings on public.user_settings;
drop trigger if exists recipe_state_rules on public.constraint_profiles;
drop trigger if exists recipe_state_targets on public.target_profiles;
drop function if exists public.recipe_plan_bump_state();
drop table if exists public.recipe_plan_selections;
alter table public.target_profiles drop constraint if exists target_profiles_id_user_key;
drop table if exists public.recipe_plan_previews;
-- Restore A-only window edit semantics before removing the B state table.
create or replace function public.shopping_patch_purchase_window(
  p_period_id uuid, p_window_id uuid, p_expected_revision integer,
  p_request_id uuid, p_patch jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_receipt public.shopping_purchase_window_edits%rowtype;
  v_window public.shopping_purchase_windows%rowtype;
  v_submitted jsonb := jsonb_build_object('periodId', p_period_id,
    'expectedRevision', p_expected_revision, 'patch', p_patch);
begin
  if v_user is null then raise insufficient_privilege; end if;
  if p_period_id is null or p_window_id is null or p_request_id is null
    or p_expected_revision is null or p_expected_revision < 1
    or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
    or exists (select 1 from jsonb_object_keys(p_patch) as k(key)
      where k.key not in ('checked','note'))
    or (p_patch ? 'checked' and jsonb_typeof(p_patch->'checked') <> 'boolean')
    or (p_patch ? 'note' and jsonb_typeof(p_patch->'note') not in ('string','null'))
    or char_length(p_patch->>'note') > 500 then
    raise invalid_parameter_value using message = 'invalid purchase-window edit';
  end if;
  -- Serialize one request ID even when two clients submit it against different rows.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_request_id::text, 0));
  select * into v_receipt from public.shopping_purchase_window_edits
    where user_id = v_user and request_id = p_request_id;
  if found then
    if v_receipt.window_id <> p_window_id or v_receipt.submitted <> v_submitted then
      return jsonb_build_object('status','idempotency_conflict');
    end if;
    select w.* into v_window from public.shopping_purchase_windows w
      join public.shopping_lines l on l.id = w.line_id and l.user_id = w.user_id
        and l.period_id = w.period_id
      join public.shopping_periods p on p.id = w.period_id and p.user_id = w.user_id
      where w.id = p_window_id and w.period_id = p_period_id and w.user_id = v_user
        and w.deleted_at is null and l.deleted_at is null and l.origin = 'plan'
        and p.deleted_at is null;
    if not found then return jsonb_build_object('status','not_found'); end if;
    return jsonb_build_object('status','ok','purchaseWindow',to_jsonb(v_window));
  end if;
  select w.* into v_window from public.shopping_purchase_windows w
    join public.shopping_lines l on l.id = w.line_id and l.user_id = w.user_id
      and l.period_id = w.period_id
    join public.shopping_periods p on p.id = w.period_id and p.user_id = w.user_id
    where w.id = p_window_id and w.period_id = p_period_id and w.user_id = v_user
      and w.deleted_at is null and l.deleted_at is null and l.origin = 'plan'
      and p.deleted_at is null
    for update of w;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_window.rev <> p_expected_revision then
    return jsonb_build_object('status','stale_revision');
  end if;
  update public.shopping_purchase_windows set
    checked = case when p_patch ? 'checked' then (p_patch->>'checked')::boolean else checked end,
    note = case when p_patch ? 'note' then p_patch->>'note' else note end,
    rev = rev + 1, updated_at = now()
    where id = v_window.id returning * into v_window;
  insert into public.shopping_purchase_window_edits
    (user_id, request_id, window_id, submitted)
    values (v_user, p_request_id, v_window.id, v_submitted);
  return jsonb_build_object('status','ok','purchaseWindow',to_jsonb(v_window));
end $$;
revoke all on function public.shopping_patch_purchase_window(
  uuid, uuid, integer, uuid, jsonb) from public, anon;
grant execute on function public.shopping_patch_purchase_window(
  uuid, uuid, integer, uuid, jsonb) to authenticated;

drop table if exists public.recipe_plan_state;
