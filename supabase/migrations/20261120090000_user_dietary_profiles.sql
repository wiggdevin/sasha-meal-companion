-- Phase 13 slice 4 (§4, §9 R5): one row per confirmed dietary-profile instance an account holds.
--
-- `rules` is the JSON array of the typed `RuleItem`s lib/policy/profiles/types.ts already defines
-- (id, facet, strength, hard_basis, evidence_strength, confirmation, expires_at, budget, context,
-- target_modifiers) — this table stores whatever `buildProfileInstance` produced, it does not
-- interpret it. `evaluatePolicy` only ever reads a row whose per-item `confirmation` is
-- "confirmed" (isActiveHardRule, lib/policy/profiles/account-rules.ts): a medical
-- `user_confirmed_safety` item the user has not individually confirmed sits in this table as
-- `unconfirmed` and stays inert, same as it would unsaved (R5 — no separate "pending" table).
--
-- The 12 legacy `PREFERENCE_FLAGS` (lib/profile/onboarding-state.ts) are NOT backfilled into this
-- table by this migration: no row here yet is not "no profile", it is "not migrated". The account
-- rules loader (lib/policy/profiles/account-rules.ts) synthesizes a ProfileInstance from
-- `user_settings.diet_prefs.flags` for any flag this table has no row for
-- (lib/policy/profiles/legacy-flags.ts), confirmed=true for every one of the 12 (none is a
-- medical hard-basis item). A flag becomes a first-class row here the first time onboarding or
-- chat capture writes it, at which point it wins over the synthesized read.
--
-- One row per (user, profile): re-confirming an already-held profile updates it in place, and a
-- per-item confirmation flips from "unconfirmed" straight to whatever the new write says.

create table user_dietary_profiles (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id text not null check (profile_id = btrim(profile_id) and profile_id <> ''),
  source text not null
    constraint user_dietary_profiles_source
    check (source in ('user_stated', 'clinician_directed_per_user', 'coach_suggested_confirmed')),
  confirmed_at timestamptz not null,
  rules jsonb not null default '[]'::jsonb
    constraint user_dietary_profiles_rules_array check (jsonb_typeof(rules) = 'array'),
  options jsonb not null default '{}'::jsonb
    constraint user_dietary_profiles_options_object check (jsonb_typeof(options) = 'object'),
  notes text,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id)
);

create index user_dietary_profiles_user on user_dietary_profiles (user_id);

alter table user_dietary_profiles enable row level security;
alter table user_dietary_profiles force row level security;

-- The owner reads and writes their own rows; nobody reads or writes another account's (R5's
-- confirmation state is only ever this account's own say-so). app/api/profile/instances (the only
-- write path) uses the request-scoped, RLS-bound client — same pattern as
-- app/api/expenditure/route.ts — so this policy alone is what scopes it; the service_role policy
-- exists for background/admin tooling the same pattern already gives every table, same as
-- food_allergen_evidence / user_allergen_checks (20261118090000_allergen_evidence.sql).
create policy user_dietary_profiles_rw on user_dietary_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy user_dietary_profiles_service_role on user_dietary_profiles for all to service_role
  using (true) with check (true);
revoke all on table user_dietary_profiles from public, anon, authenticated;
grant select, insert, update, delete on table user_dietary_profiles to authenticated;
grant all on table user_dietary_profiles to service_role;

-- Down: supabase/migrations/down/20261120090000_user_dietary_profiles.down.sql drops the table.
