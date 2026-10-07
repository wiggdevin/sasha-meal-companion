-- Schema-only rollback of the retired singleton JSON store.
--
-- Mirrored from the read-only production backup
-- ~/Backups/supabase/meal-companion/2026-09-20T183149Z-cdffe97b.sql:
--   table DDL          6985 (days), 7178 (foods), 7368 (settings)
--   primary key        465415, 465519, 465671
--   row level security 467853, 467992, 468180
--   grants             470284-470286, 470373-470375, 470460-470462
-- The dump records NO row-level security policy, NO trigger and NO function on
-- public.foods, public.days or public.settings: the 48 CREATE POLICY statements
-- name other tables only, the dump holds no CREATE TRIGGER at all, and no
-- function body references these three tables. Table, primary key, RLS flag and
-- the three default grants are therefore the whole of what existed.
--
-- The COPY blocks for all three tables are empty (463460, 464212, 464378), so
-- this file restores schema only and never data.
create table if not exists public.foods (
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint foods_pkey primary key (id)
);

create table if not exists public.days (
  date text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint days_pkey primary key (date)
);

create table if not exists public.settings (
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint settings_pkey primary key (id)
);

alter table public.foods enable row level security;
alter table public.days enable row level security;
alter table public.settings enable row level security;

-- RLS was on with no policy, so only service_role could read; these grants are
-- what the dump held, restored explicitly rather than left to default privileges.
grant all on table public.foods to anon, authenticated, service_role;
grant all on table public.days to anon, authenticated, service_role;
grant all on table public.settings to anon, authenticated, service_role;
