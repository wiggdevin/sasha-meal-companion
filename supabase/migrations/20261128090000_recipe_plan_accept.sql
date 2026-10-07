-- Recipe and shopping previews are account-owned, short-lived proofs. Selection rows are
-- separate from legacy plan_days because the old offline writer replaces entire day rows.
create table public.recipe_plan_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rev bigint not null default 0
);
create table public.recipe_plan_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('recipe','shopping')),
  proof jsonb not null check (jsonb_typeof(proof) = 'object'),
  state_rev bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_request_id uuid,
  accepted_result jsonb,
  unique (user_id, accepted_request_id)
);
create index recipe_plan_previews_owner on public.recipe_plan_previews(user_id, created_at desc);
create table public.recipe_plan_selections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  slot_id text not null check (slot_id ~ '^meal-[1-6]$'),
  recipe_id uuid not null references public.recipe_catalog(id),
  recipe_revision_id uuid not null references public.recipe_catalog_revisions(id),
  recipe_name text not null,
  serving_fraction numeric not null check (serving_fraction > 0 and serving_fraction <= 2),
  batch_id text,
  prepared_on date,
  reuse_limit_days integer check (reuse_limit_days = 3),
  storage_guidance text,
  ingredient_snapshot jsonb not null,
  nutrition_snapshot jsonb not null,
  exact_fit_available boolean not null,
  approximate_fit_available boolean not null,
  evidence_issues jsonb not null,
  target_revision_id uuid not null references public.target_profiles(id),
  plan_revision integer not null default 1,
  baseline_swap jsonb,
  baseline_override jsonb,
  accepted_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, local_date, slot_id)
);
-- Keep the existing id FK for reference inventory, and enforce ownership for every writer,
-- including the service role and a later attempt to move the target to another account.
alter table public.target_profiles add constraint target_profiles_id_user_key unique (id, user_id);
alter table public.recipe_plan_selections add constraint recipe_plan_selections_target_owner_fk
  foreign key (target_revision_id, user_id)
  references public.target_profiles(id, user_id) on update restrict;
create index recipe_plan_selections_owner_dates on public.recipe_plan_selections(user_id, local_date);

alter table public.recipe_plan_state enable row level security;
alter table public.recipe_plan_previews enable row level security;
alter table public.recipe_plan_selections enable row level security;
create policy recipe_plan_state_owner on public.recipe_plan_state for select to authenticated
  using (user_id = (select auth.uid()));
create policy recipe_plan_previews_owner on public.recipe_plan_previews for select to authenticated
  using (user_id = (select auth.uid()));
create policy recipe_plan_selections_owner on public.recipe_plan_selections for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.recipe_plan_state, public.recipe_plan_previews,
  public.recipe_plan_selections to authenticated;

-- A revision clock catches all existing update paths, including the legacy sync RPC.
-- The accept function takes a row lock on this clock before testing and writing.
create function public.recipe_plan_bump_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  -- Cascading auth.users deletion fires child-row triggers after the parent
  -- disappears. Do not recreate an FK-backed state row for that retired user.
  if exists (select 1 from auth.users where id=v_user) then
    insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
      on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
  end if;
  if tg_op = 'UPDATE' then
    if old.user_id is distinct from new.user_id
      and exists (select 1 from auth.users where id=old.user_id) then
      insert into public.recipe_plan_state(user_id, rev) values (old.user_id, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_state() from public, anon, authenticated;
create trigger recipe_state_targets after insert or update or delete on public.target_profiles
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_rules after insert or update or delete on public.constraint_profiles
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_settings after insert or update or delete on public.user_settings
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_food_prefs after insert or update or delete on public.user_food_prefs
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_user_foods after insert or update or delete on public.user_foods
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_periods after insert or update or delete on public.shopping_periods
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_lines after insert or update or delete on public.shopping_lines
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_purchase_windows after insert or update or delete
  on public.shopping_purchase_windows
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_pantry after insert or update or delete on public.shopping_pantry
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_plan_days after insert or update or delete on public.plan_days
  for each row execute function public.recipe_plan_bump_state();
-- An explicit legacy clear, swap, or edited meal supersedes the separate
-- accepted selection. Old full-row sync can no longer resurrect it in Today.
create function public.recipe_plan_supersede_on_day() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_plan_selections s set superseded_at=now(), updated_at=now()
    where s.user_id=new.user_id and s.local_date=new.local_date
      and s.superseded_at is null and
      (new.swaps ? s.slot_id or (new.item_overrides ? s.slot_id and
        coalesce((new.item_overrides->s.slot_id->>'followPlan')::boolean,false)=false))
      -- A delayed full-row replay of the exact captured pre-accept slot is
      -- older than the selection. A changed slot is a new authoring event.
      and ((new.swaps->s.slot_id) is distinct from s.baseline_swap
        or (new.item_overrides->s.slot_id) is distinct from s.baseline_override);
  return new;
end $$;
revoke all on function public.recipe_plan_supersede_on_day() from public, anon, authenticated;
create trigger recipe_selection_supersede after insert or update on public.plan_days
  for each row execute function public.recipe_plan_supersede_on_day();
create trigger recipe_state_selections after insert or update or delete on public.recipe_plan_selections
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_favorites after insert or update or delete on public.favorites_catalog_recipes
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_favorite_foods after insert or update or delete on public.favorites_foods
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_dietary_profiles after insert or update or delete on public.user_dietary_profiles
  for each row execute function public.recipe_plan_bump_state();
create trigger recipe_state_allergen_checks after insert or update or delete on public.user_allergen_checks
  for each row execute function public.recipe_plan_bump_state();

-- Shared publication and evidence changes invalidate every outstanding owner proof.
create function public.recipe_plan_bump_global_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
  return null;
end $$;
revoke all on function public.recipe_plan_bump_global_state() from public, anon, authenticated;
create trigger recipe_state_catalog after insert or update or delete on public.recipe_catalog
  for each statement execute function public.recipe_plan_bump_global_state();
create trigger recipe_state_catalog_evidence after insert or update or delete on public.catalog_food_revisions
  for each statement execute function public.recipe_plan_bump_global_state();
create trigger recipe_state_food_refs after insert or update or delete on public.food_refs
  for each statement execute function public.recipe_plan_bump_global_state();
create function public.recipe_plan_bump_allergen_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_previous uuid; v_global boolean := false;
begin
  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_op = 'UPDATE' then
    v_previous := old.user_id;
    v_global := v_previous is distinct from v_user
      and (v_previous is null or v_user is null);
  end if;
  if v_user is null or v_global then
    update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
  else
    if exists (select 1 from auth.users where id=v_user) then
      insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
    if v_previous is not null and v_previous is distinct from v_user
      and exists (select 1 from auth.users where id=v_previous) then
      insert into public.recipe_plan_state(user_id, rev) values (v_previous, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_allergen_evidence() from public, anon, authenticated;
create trigger recipe_state_allergen_evidence after insert or update or delete on public.food_allergen_evidence
  for each row execute function public.recipe_plan_bump_allergen_evidence();

-- Only the server role can issue a proof after session-scoped policy reads.
-- The explicit owner comes from the verified request session, never the body.
create function public.recipe_store_preview(p_user_id uuid, p_kind text, p_proof jsonb,
  p_state_rev bigint, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_rev bigint; v_expiry timestamptz;
begin
  if auth.role() is distinct from 'service_role' or p_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_kind not in ('recipe','shopping') or jsonb_typeof(p_proof) <> 'object'
    or pg_catalog.octet_length(p_proof::text) > 2000000 then
    raise exception 'invalid preview' using errcode = '22023';
  end if;
  v_expiry := least(p_expires_at, pg_catalog.clock_timestamp() + interval '30 minutes');
  if v_expiry is null or v_expiry <= pg_catalog.clock_timestamp() then
    raise exception 'preview authority expired' using errcode = '40001';
  end if;
  insert into public.recipe_plan_state(user_id) values (p_user_id) on conflict do nothing;
  select rev into v_rev from public.recipe_plan_state where user_id = p_user_id for update;
  if v_rev <> p_state_rev then raise exception 'stale preview' using errcode = '40001'; end if;
  insert into public.recipe_plan_previews(user_id, kind, proof, state_rev, expires_at)
    values (p_user_id, p_kind, p_proof, v_rev, v_expiry) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.recipe_store_preview(uuid,text,jsonb,bigint,timestamptz)
  from public, anon, authenticated;
grant execute on function public.recipe_store_preview(uuid,text,jsonb,bigint,timestamptz)
  to service_role;

create function public.recipe_accept_preview(p_preview_id uuid, p_request_id uuid,
  p_accept_approximate boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_preview public.recipe_plan_previews%rowtype;
  v_rev bigint; v_proof jsonb; v_choice jsonb; v_line jsonb;
  v_period public.shopping_periods%rowtype; v_selection public.recipe_plan_selections%rowtype;
  v_day public.plan_days%rowtype; v_baseline jsonb;
  v_recipe public.recipe_catalog%rowtype; v_target public.target_profiles%rowtype;
  v_revision public.recipe_catalog_revisions%rowtype;
  v_ingredients jsonb; v_nutrition jsonb; v_fraction numeric;
  v_code text; v_nutrient_value numeric;
  v_date date; v_result jsonb; v_lines jsonb := '[]'::jsonb;
  v_selections jsonb := '[]'::jsonb; v_line_id uuid; v_prior public.shopping_lines%rowtype;
  v_expected integer;
  v_expected_lines jsonb := '[]'::jsonb; v_expected_line jsonb;
  v_stock numeric; v_sources jsonb;
  v_replen jsonb; v_expected_windows jsonb; v_expected_window jsonb;
  v_window_line jsonb; v_window_need numeric; v_window_stock numeric;
  v_window_buy numeric; v_stock_remaining numeric;
  v_window public.shopping_purchase_windows%rowtype;
  v_window_ids jsonb := '[]'::jsonb; v_window_count integer := 0;
  v_preserve boolean;
begin
  if v_user is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  select * into v_preview from public.recipe_plan_previews
    where id = p_preview_id and user_id = v_user for update;
  if not found then raise exception 'preview not found' using errcode = 'P0002'; end if;
  if v_preview.accepted_request_id is not null then
    if v_preview.accepted_request_id = p_request_id then return v_preview.accepted_result; end if;
    raise exception 'preview already accepted' using errcode = '40001';
  end if;
  if v_preview.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'preview expired' using errcode = '40001';
  end if;
  select rev into v_rev from public.recipe_plan_state where user_id = v_user for update;
  if v_rev is distinct from v_preview.state_rev then
    raise exception 'stale preview' using errcode = '40001';
  end if;
  v_proof := v_preview.proof;
  if jsonb_array_length(coalesce(v_proof->'blockingIssues','[]'::jsonb)) > 0 then
    raise exception 'infeasible plan' using errcode = '22023';
  end if;
  v_date := (v_proof->>'authorityDate')::date;
  select * into v_target from public.target_profiles where user_id = v_user
    and effective_from <= v_date order by effective_from desc, rev desc, id desc limit 1 for share nowait;
  if not found or v_target.id::text is distinct from v_proof->'authority'->>'targetRevisionId'
    or v_target.rev is distinct from (v_proof->'authority'->>'targetRevision')::integer then
    raise exception 'target changed' using errcode = '40001';
  end if;
  if v_preview.kind = 'shopping' then
    if v_proof->>'periodId' is null then
      insert into public.shopping_periods(user_id,start_date,end_date,timezone,people,
        meal_coverage,mode,effort,max_active_minutes,variety,budget_amount,currency,locale,lock_mode)
      values (v_user,(v_proof->'period'->>'startDate')::date,
        (v_proof->'period'->>'endDate')::date,v_proof->'period'->>'timezone',
        (v_proof->'period'->>'people')::numeric,
        array(select jsonb_array_elements_text(v_proof->'period'->'mealCoverage')),
        v_proof->'period'->>'mode',v_proof->'period'->>'effort',
        (v_proof->'period'->>'maxActiveMinutes')::integer,
        v_proof->'period'->>'variety',(v_proof->'period'->>'budgetAmount')::numeric,
        v_proof->'period'->>'currency',v_proof->'period'->>'locale',
        v_proof->'period'->>'lockMode') returning * into v_period;
    else
      select * into v_period from public.shopping_periods where id = (v_proof->>'periodId')::uuid
        and user_id = v_user and deleted_at is null for update nowait;
      if not found or v_period.rev is distinct from (v_proof->>'periodRevision')::integer then
        raise exception 'period changed' using errcode = '40001';
      end if;
      update public.shopping_periods set
        start_date=(v_proof->'period'->>'startDate')::date,
        end_date=(v_proof->'period'->>'endDate')::date,
        timezone=v_proof->'period'->>'timezone',people=(v_proof->'period'->>'people')::numeric,
        meal_coverage=array(select jsonb_array_elements_text(v_proof->'period'->'mealCoverage')),
        mode=v_proof->'period'->>'mode',effort=v_proof->'period'->>'effort',
        max_active_minutes=(v_proof->'period'->>'maxActiveMinutes')::integer,
        variety=v_proof->'period'->>'variety',budget_amount=(v_proof->'period'->>'budgetAmount')::numeric,
        currency=v_proof->'period'->>'currency',locale=v_proof->'period'->>'locale',
        lock_mode=v_proof->'period'->>'lockMode',rev=rev+1,plan_revision=plan_revision+1,
        updated_at=now() where id=v_period.id returning * into v_period;
    end if;
  end if;
  for v_choice in select value from jsonb_array_elements(coalesce(v_proof->'choices','[]'::jsonb)) loop
    v_date := (v_choice->>'localDate')::date;
    if v_choice->>'slotId' !~ '^meal-[1-6]$' then
      raise exception 'invalid slot' using errcode = '22023';
    end if;
    if v_preview.kind = 'shopping' and (v_date < v_period.start_date or v_date > v_period.end_date) then
      raise exception 'date outside period' using errcode = '22023';
    end if;
    v_baseline := v_choice->'slotBaseline';
    if v_baseline is null or jsonb_typeof(v_baseline) <> 'object'
      or not (v_baseline ? 'dayRevision' and v_baseline ? 'swap'
        and v_baseline ? 'override' and v_baseline ? 'eaten') then
      raise exception 'missing slot baseline' using errcode = '22023';
    end if;
    select * into v_day from public.plan_days
      where user_id=v_user and local_date=v_date for share nowait;
    if coalesce(v_day.rev,0) is distinct from (v_baseline->>'dayRevision')::integer
      or coalesce(v_day.swaps->(v_choice->>'slotId'),'null'::jsonb) is distinct from v_baseline->'swap'
      or coalesce(v_day.item_overrides->(v_choice->>'slotId'),'null'::jsonb) is distinct from v_baseline->'override'
      or coalesce(v_day.eaten_slots->(v_choice->>'slotId'),'null'::jsonb) is distinct from v_baseline->'eaten' then
      raise exception 'meal baseline changed' using errcode = '40001';
    end if;
    if nullif(v_day.eaten_slots->(v_choice->>'slotId')->>'eaten_at','') is not null then
      raise exception 'meal already eaten' using errcode = '40001';
    end if;
    -- Each date resolves its own effective revision. An intervening scheduled
    -- revision cannot inherit the period's first-day target by accident.
    select * into v_target from public.target_profiles where user_id = v_user
      and effective_from <= v_date order by effective_from desc, rev desc, id desc limit 1 for share nowait;
    if not found or v_target.id::text is distinct from v_proof->'authority'->>'targetRevisionId' then
      raise exception 'target changed for meal date' using errcode = '40001';
    end if;
    select * into v_recipe from public.recipe_catalog
      where id=(v_choice->>'recipeId')::uuid for share nowait;
    if not found or v_recipe.publication_state <> 'published'
      or v_recipe.current_revision_id::text is distinct from v_choice->>'recipeRevisionId' then
      raise exception 'recipe changed' using errcode = '40001';
    end if;
    if not exists (select 1 from public.recipe_catalog_items
      where recipe_revision_id=v_recipe.current_revision_id) then
      raise exception 'recipe incomplete' using errcode = '22023';
    end if;
    -- A direct RPC invocation must not bypass the application's eligibility gate.
    -- Until a revision has SQL-verifiable policy evidence, active restrictions fail
    -- closed. Bundled pilot foods are only accepted for unrestricted accounts.
    if exists (select 1 from public.constraint_profiles p where p.user_id=v_user
      and (cardinality(p.avoid_allergens)>0 or cardinality(p.banned_categories)>0
        or cardinality(p.conditions)>0))
      or exists (select 1 from public.user_settings s where s.user_id=v_user
        and case when jsonb_typeof(s.diet_prefs->'flags')='array'
          then jsonb_array_length(s.diet_prefs->'flags')>0 else false end)
      or exists (select 1 from public.user_dietary_profiles p
        cross join lateral jsonb_array_elements(p.rules) as r(item)
        where p.user_id=v_user and r.item->>'strength'='never'
          and r.item->>'confirmation'='confirmed'
          and nullif(r.item->>'hardBasis','') is not null)
      or exists (select 1 from public.constraint_profiles p
        join public.recipe_catalog_items i on i.food_ref_id=any(p.avoid_food_ref_ids)
        where p.user_id=v_user and i.recipe_revision_id=v_recipe.current_revision_id)
      or exists (select 1 from public.recipe_catalog_items i
        join public.user_food_prefs f on f.user_id=v_user and f.status='avoid'
          and f.food_ref_id=i.food_ref_id
        where i.recipe_revision_id=v_recipe.current_revision_id)
      or exists (select 1 from public.recipe_catalog_items i
        join public.user_food_prefs f on f.user_id=v_user and f.status='avoid'
        join public.food_refs ref on ref.id=f.food_ref_id
        left join public.user_foods mine on mine.id=ref.user_food_id and mine.user_id=v_user
        left join public.catalog_food_revisions catalog
          on catalog.catalog_food_id=ref.catalog_food_id and catalog.is_active=true
        where i.recipe_revision_id=v_recipe.current_revision_id
          and split_part(lower(trim(i.name)),',',1) in
            (split_part(lower(trim(mine.name)),',',1),
             split_part(lower(trim(catalog.description)),',',1))) then
      raise exception 'recipe policy requires review' using errcode = '22023';
    end if;
    select * into v_revision from public.recipe_catalog_revisions
      where id=v_recipe.current_revision_id;
    v_fraction := (v_choice->>'servingFraction')::numeric;
    if v_fraction < v_revision.min_serving_fraction
      or v_fraction > v_revision.max_serving_fraction then
      raise exception 'portion out of bounds' using errcode = '22023';
    end if;
    -- No catalog recipe in this pilot has a fully verified retention/yield chain.
    if not p_accept_approximate then
      raise exception 'approximate plan requires confirmation' using errcode = '22023';
    end if;
    -- Snapshot values come from sealed catalog rows, never from the submitted proof.
    select coalesce(jsonb_agg(jsonb_build_object(
      'seq',i.seq,'name',i.name,'foodRefId',i.food_ref_id,'foodDbId',i.food_db_id,
      'foodRevisionId',i.food_revision_id,
      'quantity',round(i.quantity*v_fraction/v_revision.servings,4),
      'unit',i.unit,'grams',round(i.grams*v_fraction/v_revision.servings,4),
      'purchaseGrams',round(i.purchase_grams*v_fraction/v_revision.servings,4),
      'state',i.state,'nutritionEvidence',i.nutrition) order by i.seq),'[]'::jsonb) into v_ingredients
      from public.recipe_catalog_items i where i.recipe_revision_id=v_revision.id;
    -- Match the preview's per-line arithmetic exactly. The authored summary is
    -- rounded per serving and can drift from a fractional line-level total.
    v_nutrition := '{}'::jsonb;
    for v_code in select unnest(array['kcal','protein','carbs','fat']) loop
      select case when count(*) filter (where i.nutrition->v_code->>'value' is null
          or i.nutrition->v_code->>'status'='unknown') > 0
        then null else round(sum((i.nutrition->v_code->>'value')::numeric)
          *v_fraction/v_revision.servings,4) end into v_nutrient_value
        from public.recipe_catalog_items i where i.recipe_revision_id=v_revision.id;
      v_nutrition := v_nutrition || jsonb_build_object(v_code, jsonb_build_object(
        'value',v_nutrient_value,'status',case when v_nutrient_value is null
          then 'unknown' else 'estimated' end,'sourceRevisionId',null));
    end loop;
    if exists (select 1 from unnest(array['kcal','protein','carbs','fat']) as m(code)
      where (v_nutrition->m.code)->>'value' is null) then
      raise exception 'recipe nutrition is incomplete' using errcode = '22023';
    end if;
    select * into v_selection from public.recipe_plan_selections
      where user_id=v_user and local_date=v_date and slot_id=v_choice->>'slotId' for update nowait;
    v_expected := coalesce((v_choice->>'expectedPlanRevision')::integer,0);
    if coalesce(v_selection.plan_revision,0) <> v_expected then
      raise exception 'plan selection changed' using errcode = '40001';
    end if;
    insert into public.recipe_plan_selections(user_id,local_date,slot_id,recipe_id,
      recipe_revision_id,recipe_name,serving_fraction,batch_id,prepared_on,
      reuse_limit_days,storage_guidance,ingredient_snapshot,nutrition_snapshot,
      exact_fit_available,approximate_fit_available,evidence_issues,target_revision_id,plan_revision,
      baseline_swap,baseline_override,accepted_at)
    values (v_user,v_date,v_choice->>'slotId',v_recipe.id,v_recipe.current_revision_id,
      v_revision.name,v_fraction,v_choice->>'batchId',
      case when v_choice->>'batchId' is null then null
        else (v_choice->>'preparedOn')::date end,
      case when v_choice->>'batchId' is null then null else 3 end,
      case when v_choice->>'batchId' is null then null
        else 'Reused within three calendar days in one shopping week; follow recipe storage instructions.' end,
      v_ingredients,coalesce(v_nutrition,'{}'::jsonb),
      false,true,
      v_choice->'evidenceIssues',v_target.id,v_expected+1,
      nullif(v_baseline->'swap','null'::jsonb),nullif(v_baseline->'override','null'::jsonb),
      clock_timestamp())
    on conflict(user_id,local_date,slot_id) do update set
      recipe_id=excluded.recipe_id,recipe_revision_id=excluded.recipe_revision_id,
      recipe_name=excluded.recipe_name,serving_fraction=excluded.serving_fraction,
      batch_id=excluded.batch_id,prepared_on=excluded.prepared_on,
      reuse_limit_days=excluded.reuse_limit_days,storage_guidance=excluded.storage_guidance,
      ingredient_snapshot=excluded.ingredient_snapshot,nutrition_snapshot=excluded.nutrition_snapshot,
      exact_fit_available=excluded.exact_fit_available,
      approximate_fit_available=excluded.approximate_fit_available,evidence_issues=excluded.evidence_issues,
      target_revision_id=excluded.target_revision_id,plan_revision=excluded.plan_revision,
      baseline_swap=excluded.baseline_swap,baseline_override=excluded.baseline_override,
      accepted_at=excluded.accepted_at,
      superseded_at=null,updated_at=now() returning * into v_selection;
    v_selections := v_selections || jsonb_build_array(to_jsonb(v_selection));
  end loop;
  if v_preview.kind = 'shopping' then
    -- Every dated proof window is exactly one period-relative seven-day slice.
    -- These checks reject gaps, duplicates, overlaps and out-of-period dates.
    if jsonb_typeof(v_proof->'replenishment') <> 'array'
      or jsonb_array_length(v_proof->'replenishment') <> (v_period.end_date-v_period.start_date)/7+1
    then raise exception 'invalid purchase windows' using errcode = '22023'; end if;
    for v_replen in select value from jsonb_array_elements(v_proof->'replenishment') loop
      if v_replen->'window'->>'startDate' is null
        or v_replen->'window'->>'endDate' is null
        or (v_replen->'window'->>'startDate')::date < v_period.start_date
        or (v_replen->'window'->>'startDate')::date > v_period.end_date
        or ((v_replen->'window'->>'startDate')::date-v_period.start_date)%7 <> 0
        or (v_replen->'window'->>'endDate')::date is distinct from
          least((v_replen->'window'->>'startDate')::date+6,v_period.end_date)
        or (select count(*) from jsonb_array_elements(v_proof->'replenishment') as x(value)
          where x.value->'window'->>'startDate'=v_replen->'window'->>'startDate') <> 1
        or jsonb_typeof(v_replen->'lines') <> 'array'
      then raise exception 'invalid purchase windows' using errcode = '22023'; end if;
    end loop;
    if exists (
      with u as (select value as row from jsonb_array_elements(v_proof->'choices'))
      select 1 from u where (row->>'servingsConsumed')::numeric
        is distinct from round(v_period.people * (row->>'servingFraction')::numeric,4)
        or row->>'batchId' is null
    ) then raise exception 'invalid recipe allocation' using errcode = '22023'; end if;
    if exists (
      with u as (select value as row from jsonb_array_elements(v_proof->'choices')),
      batches as (select row->>'batchId' as batch_id,
        min((row->>'localDate')::date) as first_day,
        max((row->>'localDate')::date) as last_day,
        count(distinct row->>'recipeRevisionId') as recipes
        from u group by row->>'batchId')
      select 1 from batches where last_day-first_day > 2 or recipes <> 1
        or (first_day-v_period.start_date)/7 <> (last_day-v_period.start_date)/7
    ) then raise exception 'batch storage window exceeded' using errcode = '22023'; end if;
    if exists (
      with u as (select value as row from jsonb_array_elements(v_proof->'choices')),
      dates as (select row->>'batchId' as batch_id,
        min((row->>'localDate')::date) as first_day from u group by row->>'batchId')
      select 1 from u join dates d on d.batch_id=(u.row->>'batchId')
        where (u.row->>'preparedOn')::date is distinct from d.first_day
    ) then raise exception 'batch preparation date changed' using errcode = '22023'; end if;
    -- Reconstruct every required purchase identity and amount from immutable catalog
    -- rows. A direct authenticated RPC caller cannot invent or omit basket lines.
    with uses as (
      select value as row from jsonb_array_elements(v_proof->'choices')
    ), needs as (
      select jsonb_build_object('foodRefId',i.food_ref_id,'foodDbId',i.food_db_id,
        'catalogFoodRevisionId',i.food_revision_id,'purchaseState',i.state,
        'variantKey',i.state) as identity,
        i.name, i.required,
        case when i.purchase_conversion_status='unknown' then null
          else round(i.purchase_grams*(u.row->>'servingsConsumed')::numeric/r.servings,4) end as grams,
        i.purchase_conversion_status as conversion
      from uses u join public.recipe_catalog_revisions r
        on r.id=(u.row->>'recipeRevisionId')::uuid
      join public.recipe_catalog_items i on i.recipe_revision_id=r.id
    ), grouped as (
      select identity,min(name) as name,bool_or(required) as required,
        case when count(*) filter (where grams is null)>0 then null
          else sum(grams) end as grams,
        case when bool_or(conversion='unknown') then 'unknown'
          when bool_or(conversion='estimated') then 'estimated' else 'known' end as conversion
      from needs group by identity
    )
    select coalesce(jsonb_agg(jsonb_build_object('identity',identity,'name',name,
      'category',case when required then 'core' else 'optional_extra' end,
      'needGrams',grams,'conversion',conversion)),'[]'::jsonb)
      into v_expected_lines from grouped;
    if jsonb_array_length(v_expected_lines) <> (
      select count(*) from jsonb_array_elements(v_proof->'lines') as x(value)
      where value->>'origin'='plan' and coalesce((value->>'retained')::boolean,false)=false) then
      raise exception 'shopping lines do not match recipes' using errcode = '22023';
    end if;
    -- Only derived lines are refreshed. Manual rows are left byte-for-byte intact.
    for v_line in select value from jsonb_array_elements(coalesce(v_proof->'lines','[]'::jsonb)) loop
      if v_line->>'origin' <> 'plan' or coalesce((v_line->>'retained')::boolean,false)
        then continue; end if;
      select value into v_expected_line from jsonb_array_elements(v_expected_lines) as x(value)
        where value->'identity'=v_line->'identity';
      if not found or v_expected_line->'needGrams' is distinct from v_line->'needGrams' then
        raise exception 'shopping quantity changed' using errcode = '22023';
      end if;
      if (select count(*) from jsonb_array_elements(v_proof->'lines') as x(value)
        where value->>'origin'='plan' and value->'identity'=v_line->'identity'
          and coalesce((value->>'retained')::boolean,false)=false) <> 1 then
        raise exception 'duplicate shopping identity' using errcode = '22023';
      end if;
      select coalesce(sum(confirmed_grams),0) into v_stock from public.shopping_pantry
        where user_id=v_user and deleted_at is null and identity=v_line->'identity';
      with uses as (
        select value as row from jsonb_array_elements(v_proof->'choices')
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'localDate',u.row->>'localDate','slotId',u.row->>'slotId',
        'recipeId',u.row->>'recipeId','recipeRevisionId',u.row->>'recipeRevisionId',
        'ingredientSeq',i.seq,'batchId',u.row->>'batchId',
        'requiredGrams',case when i.purchase_conversion_status='unknown' then null
          else round(i.purchase_grams*(u.row->>'servingsConsumed')::numeric/r.servings,4) end)
        order by u.row->>'localDate',u.row->>'slotId',i.seq),'[]'::jsonb)
        into v_sources
      from uses u join public.recipe_catalog_revisions r
        on r.id=(u.row->>'recipeRevisionId')::uuid
      join public.recipe_catalog_items i on i.recipe_revision_id=r.id
      where jsonb_build_object('foodRefId',i.food_ref_id,'foodDbId',i.food_db_id,
        'catalogFoodRevisionId',i.food_revision_id,'purchaseState',i.state,
        'variantKey',i.state)=v_line->'identity';
      if v_period.lock_mode='available_quantities' and
        (v_expected_line->>'needGrams' is null
          or v_stock < (v_expected_line->>'needGrams')::numeric) then
        raise exception 'confirmed pantry quantity is insufficient' using errcode = '22023';
      end if;
      if v_period.lock_mode='ingredients' and v_stock=0 and not exists (
        select 1 from jsonb_array_elements(coalesce(v_proof->'basket','[]'::jsonb)) as x(value)
          where value=v_line->'identity') then
        raise exception 'ingredient outside locked basket' using errcode = '22023';
      end if;
      v_line_id := null;
      if v_line->>'id' !~ '^preview:' then
        v_line_id := (v_line->>'id')::uuid;
        select * into v_prior from public.shopping_lines where id=v_line_id
          and user_id=v_user and period_id=v_period.id and origin='plan'
          and deleted_at is null for update nowait;
        if not found then raise exception 'line changed' using errcode = '40001'; end if;
      end if;
      if v_line_id is null then
        insert into public.shopping_lines(period_id,user_id,origin,name,identity,category,
          need_grams,confirmed_stock_grams,buy_grams,package_grams,purchase_conversion_status,
          sources,pinned,checked,note)
        values(v_period.id,v_user,'plan',v_expected_line->>'name',v_line->'identity',
          v_expected_line->>'category',
          (v_expected_line->>'needGrams')::numeric,
          least((v_expected_line->>'needGrams')::numeric,v_stock),
          case when (v_expected_line->>'needGrams')::numeric <= v_stock then 0 else null end,
          null,v_expected_line->>'conversion',v_sources,false,false,null)
        returning id into v_line_id;
      else
        update public.shopping_lines set name=v_expected_line->>'name',identity=v_line->'identity',
          category=v_expected_line->>'category',need_grams=(v_expected_line->>'needGrams')::numeric,
          confirmed_stock_grams=least((v_expected_line->>'needGrams')::numeric,v_stock),
          buy_grams=case when (v_expected_line->>'needGrams')::numeric <= v_stock then 0 else null end,
          package_grams=null,
          purchase_conversion_status=v_expected_line->>'conversion',sources=v_sources,
          checked=case when need_grams is not null and (v_line->>'needGrams')::numeric > need_grams
            then false else checked end,rev=rev+1,updated_at=now()
        where id=v_line_id;
      end if;
      v_lines := v_lines || jsonb_build_array(v_line_id);
      -- Rebuild dated needs from the pinned catalog ingredient sources. The
      -- client-visible proof may describe them, but it cannot supply amounts.
      select coalesce(jsonb_agg(jsonb_build_object('startDate',q.window_start,
        'endDate',least(q.window_start+6,v_period.end_date),'needGrams',q.grams)
        order by q.window_start),'[]'::jsonb) into v_expected_windows
      from (
        select v_period.start_date + 7*floor(
          ((s.value->>'localDate')::date-v_period.start_date)/7)::integer as window_start,
          case when count(*) filter (where s.value->>'requiredGrams' is null)>0
            then null else round(sum((s.value->>'requiredGrams')::numeric),4) end as grams
        from jsonb_array_elements(v_sources) as s(value)
        group by 1
      ) q;
      v_stock_remaining := v_stock;
      for v_expected_window in select value from jsonb_array_elements(v_expected_windows) loop
        v_window_need := (v_expected_window->>'needGrams')::numeric;
        v_window_stock := case when v_window_need is null then null
          else least(v_window_need,v_stock_remaining) end;
        if v_window_stock is not null then
          v_stock_remaining := v_stock_remaining-v_window_stock;
        end if;
        -- No package size is SQL-verifiable in the pilot catalog. A positive
        -- net purchase therefore remains unknown, never the period total.
        v_window_buy := case when v_window_need is null then null
          when v_window_need=v_window_stock then 0 else null end;
        select l.value into v_window_line
          from jsonb_array_elements(v_proof->'replenishment') as r(value)
          cross join lateral jsonb_array_elements(r.value->'lines') as l(value)
          where r.value->'window'->>'startDate'=v_expected_window->>'startDate'
            and l.value->>'lineId'=v_line->>'id';
        if not found or (select count(*)
          from jsonb_array_elements(v_proof->'replenishment') as r(value)
          cross join lateral jsonb_array_elements(r.value->'lines') as l(value)
          where r.value->'window'->>'startDate'=v_expected_window->>'startDate'
            and l.value->>'lineId'=v_line->>'id') <> 1
          or not (v_window_line ? 'needGrams' and v_window_line ? 'confirmedStockGrams'
            and v_window_line ? 'buyGrams')
          or (v_window_line->>'needGrams')::numeric is distinct from v_window_need
          or (v_window_line->>'confirmedStockGrams')::numeric is distinct from v_window_stock
          or (v_window_line->>'buyGrams')::numeric is distinct from v_window_buy
        then raise exception 'purchase window changed' using errcode = '22023'; end if;
        v_window_count := v_window_count+1;
        select * into v_window from public.shopping_purchase_windows
          where period_id=v_period.id and line_id=v_line_id
            and window_start_date=(v_expected_window->>'startDate')::date for update nowait;
        if not found then
          insert into public.shopping_purchase_windows(user_id,period_id,line_id,
            window_start_date,window_end_date,need_grams,confirmed_stock_grams,buy_grams)
          values(v_user,v_period.id,v_line_id,(v_expected_window->>'startDate')::date,
            (v_expected_window->>'endDate')::date,v_window_need,v_window_stock,v_window_buy)
          returning * into v_window;
        else
          v_preserve := v_window.deleted_at is null and v_window_need is not null
            and v_window.need_grams is not null and v_window_need <= v_window.need_grams
            and (case when v_window_buy is null then v_window.buy_grams is null
              else v_window.buy_grams is null or v_window_buy <= v_window.buy_grams end);
          if v_window.window_end_date is distinct from (v_expected_window->>'endDate')::date
            or v_window.need_grams is distinct from v_window_need
            or v_window.confirmed_stock_grams is distinct from v_window_stock
            or v_window.buy_grams is distinct from v_window_buy
            or v_window.deleted_at is not null
            or (not v_preserve and (v_window.checked or v_window.note is not null)) then
            update public.shopping_purchase_windows set
              window_end_date=(v_expected_window->>'endDate')::date,
              need_grams=v_window_need,confirmed_stock_grams=v_window_stock,
              buy_grams=v_window_buy,
              checked=case when v_preserve then checked else false end,
              note=case when v_preserve then note else null end,
              deleted_at=null,rev=rev+1,updated_at=now()
              where id=v_window.id returning * into v_window;
          end if;
        end if;
        v_window_ids := v_window_ids || jsonb_build_array(v_window.id);
      end loop;
    end loop;
    if v_window_count <> (select coalesce(sum(jsonb_array_length(r.value->'lines')),0)
      from jsonb_array_elements(v_proof->'replenishment') as r(value)) then
      raise exception 'extra purchase window line' using errcode = '22023';
    end if;
    update public.shopping_purchase_windows set deleted_at=now(),rev=rev+1,updated_at=now()
      where user_id=v_user and period_id=v_period.id and deleted_at is null
        and id not in (select value::text::uuid from jsonb_array_elements_text(v_window_ids));
    update public.shopping_lines set origin='manual',category='manual',sources='[]'::jsonb,
      rev=rev+1,updated_at=now() where period_id=v_period.id and user_id=v_user
      and origin='plan' and deleted_at is null
      and id not in (select value::text::uuid from jsonb_array_elements_text(v_lines))
      and (checked or pinned or note is not null);
    update public.shopping_lines set deleted_at=now(),rev=rev+1 where period_id=v_period.id
      and user_id=v_user and origin='plan' and deleted_at is null
      and id not in (select value::text::uuid from jsonb_array_elements_text(v_lines));
    if v_proof->>'periodId' is null then
      update public.shopping_periods set plan_revision=1 where id=v_period.id returning * into v_period;
    end if;
  end if;
  v_result := jsonb_build_object('periodId',v_period.id,'lineIds',v_lines,
    'selections',v_selections);
  update public.recipe_plan_previews set accepted_request_id=p_request_id,
    accepted_result=v_result where id=v_preview.id;
  return v_result;
end $$;
revoke all on function public.recipe_accept_preview(uuid,uuid,boolean) from public, anon;
grant execute on function public.recipe_accept_preview(uuid,uuid,boolean) to authenticated;

-- B replaces only A's window edit RPC to establish the shared lock order.
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
  -- Match accept's state-before-window lock order. A request receipt replay also
  -- takes the state lock before reading its window, so both paths serialize.
  insert into public.recipe_plan_state(user_id) values (v_user) on conflict do nothing;
  perform 1 from public.recipe_plan_state where user_id=v_user for update;
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
