-- Shared published recipes remain separate from the owner's private recipes and sync rows.
create table public.recipe_catalog (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  author text not null,
  source_url text,
  rights_kind text not null check (rights_kind in ('original','licensed','link_only')),
  rights_record text not null check (length(rights_record) > 10),
  source_revision text not null,
  kitchen_tested boolean not null default false,
  current_revision_id uuid,
  publication_state text not null default 'draft'
    check (publication_state in ('draft','published','withdrawn','superseded')),
  withdrawal_reason text,
  updated_at timestamptz not null default now(),
  constraint withdrawal_has_reason check
    (publication_state <> 'withdrawn' or nullif(trim(withdrawal_reason), '') is not null)
);

create table public.recipe_catalog_revisions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipe_catalog(id) on delete restrict,
  rev integer not null check (rev > 0),
  name text not null check (length(trim(name)) > 2),
  cuisine text,
  dish_tags text[] not null default '{}',
  search_doc tsvector,
  active_minutes integer check (active_minutes >= 0),
  total_minutes integer check (total_minutes >= 0),
  effort text not null check (effort in ('none','minimal','standard')),
  servings numeric not null check (servings > 0),
  yield_grams numeric check (yield_grams > 0),
  yield_status text not null check (yield_status in ('known','estimated','unknown')),
  min_serving_fraction numeric not null default 0.5 check (min_serving_fraction > 0),
  max_serving_fraction numeric not null default 2 check (max_serving_fraction >= 1),
  nutrition_per_serving jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (recipe_id, rev),
  unique (recipe_id, id),
  constraint serving_bounds check (min_serving_fraction <= max_serving_fraction)
);
alter table public.recipe_catalog add constraint current_revision_belongs_to_recipe
  foreign key (id, current_revision_id)
  references public.recipe_catalog_revisions(recipe_id, id) deferrable initially deferred;

create table public.recipe_catalog_items (
  recipe_revision_id uuid not null references public.recipe_catalog_revisions(id) on delete restrict,
  seq integer not null check (seq > 0),
  name text not null check (length(trim(name)) > 1),
  food_ref_id uuid references public.food_refs(id),
  food_revision_id bigint references public.catalog_food_revisions(id),
  food_db_id text,
  quantity numeric not null check (quantity > 0),
  unit text not null,
  grams numeric check (grams > 0),
  state text not null check (state in ('raw','cooked','as_purchased')),
  required boolean not null default true,
  purchase_grams numeric check (purchase_grams > 0),
  purchase_conversion_status text not null
    check (purchase_conversion_status in ('known','estimated','unknown')),
  nutrition jsonb not null default '{}'::jsonb,
  allergen_evidence jsonb not null default '{}'::jsonb,
  primary key (recipe_revision_id, seq),
  constraint resolved_food_identity check (food_ref_id is not null or food_db_id is not null),
  constraint known_purchase_has_amount check
    (purchase_conversion_status <> 'known' or purchase_grams is not null)
);
create table public.recipe_catalog_steps (
  recipe_revision_id uuid not null references public.recipe_catalog_revisions(id) on delete restrict,
  seq integer not null check (seq > 0),
  instruction text not null check (length(trim(instruction)) > 8),
  primary key (recipe_revision_id, seq)
);

create function public.recipe_catalog_search_doc() returns trigger language plpgsql
  set search_path = '' as $$
begin
  new.search_doc := pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig,
    new.name || ' ' || coalesce(new.cuisine,'') || ' '
    || pg_catalog.array_to_string(new.dish_tags,' '));
  return new;
end $$;
create trigger recipe_catalog_search_doc before insert on public.recipe_catalog_revisions
  for each row execute function public.recipe_catalog_search_doc();

create table public.recipe_catalog_seals (
  recipe_revision_id uuid primary key references public.recipe_catalog_revisions(id) on delete restrict,
  sealed_at timestamptz not null default now()
);
create function public.recipe_catalog_content_guard() returns trigger language plpgsql
  set search_path = '' as $$
begin
  perform 1 from public.recipe_catalog c join public.recipe_catalog_revisions r
    on r.recipe_id = c.id where r.id = new.recipe_revision_id for update of c;
  if exists (select 1 from public.recipe_catalog_seals s
    where s.recipe_revision_id = new.recipe_revision_id) then
    raise exception 'published recipe content is sealed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger recipe_catalog_items_sealed before insert on public.recipe_catalog_items
  for each row execute function public.recipe_catalog_content_guard();
create trigger recipe_catalog_steps_sealed before insert on public.recipe_catalog_steps
  for each row execute function public.recipe_catalog_content_guard();

create function public.recipe_catalog_publish_guard() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.publication_state <> 'draft' or new.current_revision_id is not null then
      raise exception 'catalog root must begin as an unpublished draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.publication_state <> 'draft' and row(new.slug, new.author, new.source_url,
    new.rights_kind, new.rights_record, new.source_revision, new.kitchen_tested)
    is distinct from row(old.slug, old.author, old.source_url,
      old.rights_kind, old.rights_record, old.source_revision, old.kitchen_tested) then
    raise exception 'published recipe provenance is immutable' using errcode = '23514';
  end if;
  if old.publication_state = 'withdrawn' and new.publication_state <> 'withdrawn' then
    raise exception 'withdrawn catalog content cannot be republished' using errcode = '23514';
  end if;
  if old.publication_state in ('published','superseded')
    and new.publication_state = 'draft' then
    raise exception 'published catalog content cannot return to draft' using errcode = '23514';
  end if;
  if old.publication_state = 'withdrawn'
    and new.current_revision_id is distinct from old.current_revision_id then
    raise exception 'withdrawn catalog revision cannot change' using errcode = '23514';
  end if;
  if new.publication_state = 'published' then
    if new.rights_kind = 'link_only' or new.current_revision_id is null
      or not exists (select 1 from public.recipe_catalog_items i
        where i.recipe_revision_id = new.current_revision_id and i.required)
      or not exists (select 1 from public.recipe_catalog_steps s
        where s.recipe_revision_id = new.current_revision_id) then
      raise exception 'incomplete or link-only recipe cannot be published' using errcode = '23514';
    end if;
    insert into public.recipe_catalog_seals (recipe_revision_id)
      values (new.current_revision_id) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger recipe_catalog_publish_guard before insert or update on public.recipe_catalog
  for each row execute function public.recipe_catalog_publish_guard();

-- Content revisions are append-only. Correct ingredient evidence with a new revision;
-- publication/withdrawal remains mutable on the root for urgent rights corrections.
create function public.recipe_catalog_immutable() returns trigger language plpgsql
  set search_path = '' as $$
begin
  raise exception 'recipe catalog revisions are immutable' using errcode = '23514';
end $$;
create trigger recipe_catalog_revisions_immutable before update or delete
  on public.recipe_catalog_revisions for each row execute function public.recipe_catalog_immutable();
create trigger recipe_catalog_items_immutable before update or delete
  on public.recipe_catalog_items for each row execute function public.recipe_catalog_immutable();
create trigger recipe_catalog_steps_immutable before update or delete
  on public.recipe_catalog_steps for each row execute function public.recipe_catalog_immutable();
create trigger recipe_catalog_seals_immutable before update or delete
  on public.recipe_catalog_seals for each row execute function public.recipe_catalog_immutable();

create index recipe_catalog_revisions_search on public.recipe_catalog_revisions
  using gin (search_doc);
create index recipe_catalog_revisions_filters on public.recipe_catalog_revisions
  (effort, total_minutes, recipe_id);
create index recipe_catalog_published on public.recipe_catalog (publication_state, current_revision_id);

-- A subtype of the existing Favorites concept: no copy into private recipe ownership.
create table public.favorites_catalog_recipes (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipe_catalog(id),
  sort integer not null default 0,
  rev integer not null default 1 check (rev > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  last_request_id uuid,
  primary key (user_id, recipe_id)
);

create table public.shopping_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  timezone text not null,
  people numeric not null check (people > 0 and people <= 30),
  meal_coverage text[] not null default '{}',
  mode text not null check (mode in ('simple','balanced')),
  effort text not null check (effort in ('none','minimal','standard')),
  max_active_minutes integer check (max_active_minutes >= 0),
  variety text not null check (variety in ('repeat_friendly','balanced','high')),
  budget_amount numeric check (budget_amount >= 0),
  currency text,
  locale text,
  lock_mode text not null default 'none'
    check (lock_mode in ('none','ingredients','available_quantities')),
  plan_revision integer not null default 0 check (plan_revision >= 0),
  rev integer not null default 1 check (rev > 0),
  request_id uuid,
  last_request_id uuid,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, request_id),
  constraint shopping_period_dates check (start_date <= end_date and end_date <= start_date + 366)
);
create index shopping_periods_owner_dates on public.shopping_periods (user_id, start_date, end_date)
  where deleted_at is null;

create table public.shopping_lines (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null,
  user_id uuid not null,
  origin text not null check (origin in ('plan','manual')),
  name text not null,
  identity jsonb,
  category text not null check (category in ('core','pantry_top_up','optional_extra','manual')),
  need_grams numeric check (need_grams >= 0),
  confirmed_stock_grams numeric check (confirmed_stock_grams >= 0),
  buy_grams numeric check (buy_grams >= 0),
  package_grams numeric check (package_grams > 0),
  purchase_conversion_status text not null
    check (purchase_conversion_status in ('known','estimated','unknown')),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  pinned boolean not null default false,
  checked boolean not null default false,
  note text,
  rev integer not null default 1 check (rev > 0),
  request_id uuid,
  create_fingerprint text check (create_fingerprint is null
    or create_fingerprint ~ '^[0-9a-f]{64}$'),
  last_request_id uuid,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (period_id, user_id) references public.shopping_periods(id, user_id) on delete cascade,
  unique (user_id, request_id),
  unique (id, user_id, period_id)
);
create index shopping_lines_period on public.shopping_lines (user_id, period_id) where deleted_at is null;

-- The create receipt stays fixed while a line's visible fields can change later.
create function public.shopping_create_receipt_guard() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if new.request_id is distinct from old.request_id
    or new.create_fingerprint is distinct from old.create_fingerprint then
    raise check_violation using message = 'shopping create receipt is immutable';
  end if;
  return new;
end $$;
create trigger shopping_line_create_receipt before update on public.shopping_lines
  for each row execute function public.shopping_create_receipt_guard();

create table public.shopping_pantry (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  identity jsonb not null,
  confirmed_grams numeric check (confirmed_grams >= 0),
  confirmed_at timestamptz not null default now(),
  rev integer not null default 1 check (rev > 0),
  request_id uuid,
  create_fingerprint text check (create_fingerprint is null
    or create_fingerprint ~ '^[0-9a-f]{64}$'),
  last_request_id uuid,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index shopping_pantry_owner on public.shopping_pantry (user_id) where deleted_at is null;
create trigger shopping_pantry_create_receipt before update on public.shopping_pantry
  for each row execute function public.shopping_create_receipt_guard();
-- A stock confirmation is one current quantity for one canonical purchase identity.
-- Distinct request IDs cannot manufacture two copies of the same physical stock.
create unique index shopping_pantry_active_identity on public.shopping_pantry
  (user_id, (coalesce(identity->>'foodRefId', '')),
   (coalesce(identity->>'foodDbId', '')),
   (coalesce(identity->>'catalogFoodRevisionId', '')),
   (coalesce(identity->>'purchaseState', '')),
   (coalesce(identity->>'variantKey', '')))
  where deleted_at is null;

-- Period-level lines remain the totals; these rows are independent dated purchases.
-- They are written only by the server's validated plan-accept transaction.
create table public.shopping_purchase_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_id uuid not null,
  line_id uuid not null,
  window_start_date date not null,
  window_end_date date not null,
  need_grams numeric check (need_grams >= 0),
  confirmed_stock_grams numeric check (confirmed_stock_grams >= 0),
  buy_grams numeric check (buy_grams >= 0),
  checked boolean not null default false,
  note text check (char_length(note) <= 500),
  rev integer not null default 1 check (rev > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (line_id, user_id, period_id)
    references public.shopping_lines(id, user_id, period_id) on delete cascade,
  unique (id, user_id),
  unique (period_id, line_id, window_start_date),
  constraint shopping_purchase_window_dates check
    (window_end_date >= window_start_date and window_end_date <= window_start_date + 6),
  constraint shopping_purchase_window_quantities check
    ((need_grams is not null or (confirmed_stock_grams is null and buy_grams is null))
     and (confirmed_stock_grams is null or confirmed_stock_grams <= need_grams))
);
create index shopping_purchase_windows_period on public.shopping_purchase_windows
  (user_id, period_id, window_start_date) where deleted_at is null;

-- Request receipts are durable across subsequent checked/note edits.
create table public.shopping_purchase_window_edits (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  window_id uuid not null,
  submitted jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id),
  foreign key (window_id, user_id)
    references public.shopping_purchase_windows(id, user_id) on delete cascade
);

create function public.shopping_patch_purchase_window(
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

-- Shared content is read-only to authenticated accounts; only published text is visible.
alter table public.recipe_catalog enable row level security;
alter table public.recipe_catalog_revisions enable row level security;
alter table public.recipe_catalog_items enable row level security;
alter table public.recipe_catalog_steps enable row level security;
alter table public.recipe_catalog_seals enable row level security;
create policy recipe_catalog_read on public.recipe_catalog for select to authenticated
  using (publication_state in ('published','withdrawn','superseded'));
create policy recipe_catalog_revisions_read on public.recipe_catalog_revisions for select to authenticated
  using (exists (select 1 from public.recipe_catalog c
    where c.id = recipe_catalog_revisions.recipe_id
    and c.publication_state = 'published'
    and c.current_revision_id = recipe_catalog_revisions.id));
create policy recipe_catalog_items_read on public.recipe_catalog_items for select to authenticated
  using (exists (select 1 from public.recipe_catalog_revisions r where r.id = recipe_revision_id));
create policy recipe_catalog_steps_read on public.recipe_catalog_steps for select to authenticated
  using (exists (select 1 from public.recipe_catalog_revisions r where r.id = recipe_revision_id));

alter table public.favorites_catalog_recipes enable row level security;
alter table public.shopping_periods enable row level security;
alter table public.shopping_lines enable row level security;
alter table public.shopping_pantry enable row level security;
alter table public.shopping_purchase_windows enable row level security;
alter table public.shopping_purchase_window_edits enable row level security;
create policy favorites_catalog_owner on public.favorites_catalog_recipes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy shopping_periods_owner on public.shopping_periods for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy shopping_lines_owner on public.shopping_lines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy shopping_pantry_owner on public.shopping_pantry for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy shopping_purchase_windows_owner on public.shopping_purchase_windows
  for select to authenticated using (user_id = (select auth.uid())
    and exists (select 1 from public.shopping_periods p
      where p.id = shopping_purchase_windows.period_id
        and p.user_id = shopping_purchase_windows.user_id and p.deleted_at is null)
    and exists (select 1 from public.shopping_lines l
      where l.id = shopping_purchase_windows.line_id
        and l.period_id = shopping_purchase_windows.period_id
        and l.user_id = shopping_purchase_windows.user_id
        and l.deleted_at is null and l.origin = 'plan'));
create policy shopping_purchase_window_edits_owner on public.shopping_purchase_window_edits
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.recipe_catalog, public.recipe_catalog_revisions,
  public.recipe_catalog_items, public.recipe_catalog_steps to authenticated;
grant select, insert, update, delete on public.favorites_catalog_recipes,
  public.shopping_periods, public.shopping_lines, public.shopping_pantry to authenticated;
-- Supabase default privileges can otherwise grant DML to authenticated/anon.
revoke all on public.shopping_purchase_windows,
  public.shopping_purchase_window_edits from public, anon, authenticated;
grant select on public.shopping_purchase_windows to authenticated;
