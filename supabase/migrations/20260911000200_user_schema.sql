-- Phase 0: architecture v2.1 §3.2 user food layer, §3.3 logging, §3.4 targets, §3.6 constraints
-- and coach, plus the three tables the phase spec adds (plan_days, user_settings, gut_log).
-- RLS is enabled in 20260911000500_rls.sql, not here.

-- ---------- §3.2 user food layer and the food registry -----------------------------
create table user_foods (id uuid primary key default gen_random_uuid(), name text not null, brand text,
  user_id uuid not null references auth.users(id) on delete cascade, ingredients_text text,
  catalog_food_id bigint references catalog_foods(id), rev integer not null default 1,
  kind text not null check (kind in ('custom','label_scan','recipe')), deleted_at timestamptz,
  per_100g jsonb not null default '{}'::jsonb,      -- {nutrient_code: amount|null}
  allergen_tags text[] not null default '{}', created_at timestamptz not null default now());
create index user_foods_owner on user_foods (user_id);
create table food_refs (id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('catalog','user')),
  catalog_food_id bigint references catalog_foods(id),
  user_food_id uuid references user_foods(id) on delete cascade,
  constraint food_refs_exactly_one check (
    (kind = 'catalog' and catalog_food_id is not null and user_food_id    is null) or
    (kind = 'user'    and user_food_id    is not null and catalog_food_id is null)));
create unique index food_refs_catalog_uniq on food_refs (catalog_food_id)
  where catalog_food_id is not null;
create unique index food_refs_user_uniq on food_refs (user_food_id) where user_food_id is not null;
create table user_food_prefs (user_id uuid not null references auth.users(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id), note text,   -- "hurt on 9/12"; never deleted
  status text not null check (status in ('eats','avoid')),
  role text check (role in ('protein','carb','fat')), no_cook boolean not null default false,
  rev integer not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id, food_ref_id));

-- Owners of the item tables (§3.2 prose). Phase 3 builds the UI; the shells ship now so every
-- food_ref_id foreign key resolves.
create table recipes (id uuid primary key default gen_random_uuid(), name text not null,
  user_id uuid not null references auth.users(id) on delete cascade, rev integer not null default 1,
  servings numeric not null check (servings > 0), yield_grams numeric, deleted_at timestamptz);
create table recipe_revisions (id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade, rev integer not null,
  created_at timestamptz not null default now(),
  nutrients_per_serving jsonb not null default '{}'::jsonb, unique (recipe_id, rev));
create table recipe_items (seq integer not null, qty numeric not null, unit text not null,
  recipe_revision_id uuid not null references recipe_revisions(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id), grams numeric not null check (grams >= 0),
  food_revision_id bigint references catalog_food_revisions(id),
  state text not null default 'raw' check (state in ('raw','cooked')),
  primary key (recipe_revision_id, seq));
create table favorites_foods (user_id uuid not null references auth.users(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id), sort integer not null default 0,
  primary key (user_id, food_ref_id));
create table favorites_recipes (user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete cascade, sort integer not null default 0,
  primary key (user_id, recipe_id));
create table favorites_meals (id uuid primary key default gen_random_uuid(), name text not null,
  user_id uuid not null references auth.users(id) on delete cascade, rev integer not null default 1,
  sort integer not null default 0);
create table favorites_meal_items (seq integer not null,     -- typed, not jsonb
  meal_id uuid not null references favorites_meals(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id),
  grams numeric not null check (grams > 0), primary key (meal_id, seq));

-- ---------- §3.3 logging ------------------------------------------------------------
create table log_entries (id uuid primary key,        -- client-generated
  user_id uuid not null references auth.users(id) on delete cascade, note text, media_ref text,
  eaten_at timestamptz not null, tz text not null, local_date date not null, slot text not null,
  method text not null check (method in ('search','barcode','label','photo','voice','text','plan')),
  rev integer not null default 1, deleted_at timestamptz);
create index log_entries_day on log_entries (user_id, local_date);
create table log_items (id uuid primary key, seq integer not null, qty numeric not null,
  entry_id uuid not null references log_entries(id) on delete cascade, unit text not null,
  food_ref_id uuid not null references food_refs(id), snapshot jsonb not null,
  food_revision_id bigint references catalog_food_revisions(id), was_edited boolean not null default false,
  portion_id bigint references catalog_portions(id), grams numeric not null check (grams >= 0),
  confidence numeric check (confidence between 0 and 1), unique (entry_id, seq));
create table water_log (user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null, cups integer not null default 0 check (cups >= 0),
  rev integer not null default 1, primary key (user_id, local_date));

-- ---------- phase-0-foundations.md: the three tables v2.1 does not define ------------
create table plan_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  day_type_override text check (day_type_override in ('training-10','training-7-fasted','rest')),
  floor_day boolean not null default false,
  swaps jsonb not null default '{}'::jsonb,          -- {slot_id: meal_id}
  slot_notes jsonb not null default '{}'::jsonb,     -- {slot_id: text}
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, local_date));

create table user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_opened_at timestamptz not null,
  scale_warning_dismissed boolean not null default false,
  training_kcal integer, rest_kcal integer, protein_g numeric,   -- null = follow the ramp
  protein_locked boolean not null default true,
  ramp_override smallint check (ramp_override between 1 and 3),
  slot_times jsonb not null default '{}'::jsonb,
  shift_minutes integer not null default 0,
  changed_at timestamptz, rev integer not null default 1);

create table gut_log (
  id uuid primary key,                               -- client-generated
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null, tz text not null,
  state text not null check (state in ('good','iffy','flare')),
  note text, rev integer not null default 1, deleted_at timestamptz,
  unique (user_id, local_date));

-- ---------- §3.4 targets and expenditure ---------------------------------------------
create table target_profiles (id uuid primary key default gen_random_uuid(), notes text,
  user_id uuid not null references auth.users(id) on delete cascade, effective_from date not null,
  rev integer not null default 1, kcal_train integer not null, kcal_rest integer not null,
  authored_by text not null check (authored_by in ('coach','engine_proposal','user')),
  mode text not null check (mode in ('grams','percent')),
  protein_g numeric, fat_g numeric, carb_g numeric,
  protein_pct numeric, fat_pct numeric, carb_pct numeric,
  kcal_min integer not null default 1650, protein_g_min numeric not null,
  fat_g_min numeric not null default 50, carb_g_min numeric not null default 0,
  goal_rate_bp_week integer not null default 0,        -- -50 = lose 0.5 %/week
  max_weekly_kcal_step integer not null default 150,
  constraint targets_grams_complete check (mode <> 'grams'
    or (protein_g is not null and fat_g is not null and carb_g is not null)),
  constraint targets_percent_complete check (mode <> 'percent'
    or (protein_pct is not null and fat_pct is not null and carb_pct is not null
        and round(protein_pct + fat_pct + carb_pct, 2) = 100
        and protein_pct between 5 and 70 and fat_pct between 5 and 70
        and carb_pct between 5 and 70)));
create table expenditure_estimates (id uuid primary key default gen_random_uuid(), reason text,
  user_id uuid not null references auth.users(id) on delete cascade, local_date date not null,
  weight_trend_kg numeric, intake_avg_kcal numeric, intake_completeness numeric, tdee_kcal numeric,
  confidence numeric, engine_version text not null, unique (user_id, local_date),
  status text not null check (status in ('burn_in','held','estimating','blocked')));
create table target_proposals (id uuid primary key default gen_random_uuid(), proposed jsonb not null,
  user_id uuid not null references auth.users(id) on delete cascade, decided_by uuid,
  based_on_estimate_id uuid references expenditure_estimates(id), decided_at timestamptz,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')));

-- ---------- §3.6 constraints and coach ------------------------------------------------
create table constraint_profiles (user_id uuid primary key references auth.users(id) on delete cascade,
  rev integer not null default 1, conditions text[] not null default '{}', notes text,
  avoid_allergens text[] not null default '{gluten,dairy,apple}',
  avoid_food_ref_ids uuid[] not null default '{}',
  banned_categories text[] not null default '{simple_sugars}');
create table coach_threads (id uuid primary key default gen_random_uuid(), title text,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now());
create table coach_messages (id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references coach_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')), content text,
  tool_calls jsonb, policy_checks jsonb, created_at timestamptz not null default now());
create table ai_calls (id uuid primary key default gen_random_uuid(), purpose text not null,
  user_id uuid not null references auth.users(id) on delete cascade, provider text not null,
  model_id text not null, sdk_version text not null, input_tokens integer, output_tokens integer,
  latency_ms integer, input_hash bytea, cost_estimate numeric,
  created_at timestamptz not null default now());
create index ai_calls_user_day on ai_calls (user_id, created_at);
