-- Phase 18 W2b, step (c): the new tables, functions and grants, and no trigger on any existing
-- table (step d installs them one busy table at a time). Nothing here locks an existing table.
--
--   food_world_condition_confirmations  the user's confirmation of each stated condition in
--                                       reviewed wording; owner reads, the server writes.
--   account_rules_clock, evidence_clock the two admission-input versions (D11): the freshness token
--                                       `{ rulesVersion, evidenceVersion }`. Only the bump functions
--                                       below write them; the owner reads an account clock, any
--                                       signed-in client reads the evidence clock.
--   functions                           the food-world guard and condition gate (D4) and the two
--                                       bump functions, all revoked from clients. Their invariants,
--                                       live once step (d) installs the triggers:
--     (1)/(a) only the server moves food_world, and 'open' needs every stated condition confirmed;
--     (b) a condition saved on an open account closes it and sets the review marker in that write;
--     (c) the marker clears only when every stated condition is confirmed;
--     (d) removing a condition deletes its confirmation, so adding it again needs review again.
--     One per-account advisory lock orders (a) against (b).
--
-- Admission-input versions, not rule versions: every insert, update or delete of a table that
-- admission reads moves a counter (lib/foods/world/admission-inputs.ts holds the one inventory).
-- That over-invalidates on purpose (an Eats-only, water or meal-count write moves rulesVersion
-- too): a spurious refetch is cheap, an admission reused after its inputs changed is not.
-- Exactly one bump per transaction per counter: the upsert adds 1 to the committed value under the
-- row lock, so two concurrent transactions move it by 2, and one transaction that writes many rows
-- or tables moves it by 1.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table public.food_world_condition_confirmations (
  user_id uuid not null references auth.users(id) on delete cascade,
  condition_key text not null
    constraint food_world_condition_key check (condition_key <> '' and condition_key = lower(condition_key)),
  choice text not null constraint food_world_condition_choice check (choice in ('pack', 'no_limit')),
  confirmed_at timestamptz not null default now(),
  primary key (user_id, condition_key)
);
alter table public.food_world_condition_confirmations enable row level security;
alter table public.food_world_condition_confirmations force row level security;
create policy food_world_condition_confirmations_read on public.food_world_condition_confirmations
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.food_world_condition_confirmations from public, anon, authenticated;
grant select on table public.food_world_condition_confirmations to authenticated;
grant all on table public.food_world_condition_confirmations to service_role;

-- The one condition key: trimmed, inner whitespace collapsed, lower case
-- (lib/foods/world/condition-gate.ts conditionKey matches it).
create function public.food_world_condition_key(p_condition text) returns text
  language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p_condition, ''), E' \t\n\r\f\v'), E'[ \t\n\r\f\v]+', ' ', 'g'))
$$;
revoke all on function public.food_world_condition_key(text) from public, anon, authenticated;

-- True when a stated condition has no confirmation row.
create function public.food_world_unconfirmed(p_user uuid, p_conditions text[]) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from unnest(coalesce(p_conditions, '{}'::text[])) as c(text)
     where public.food_world_condition_key(c.text) <> ''
       and not exists (select 1 from public.food_world_condition_confirmations f
                        where f.user_id = p_user
                          and f.condition_key = public.food_world_condition_key(c.text)))
$$;
revoke all on function public.food_world_unconfirmed(uuid, text[]) from public, anon, authenticated;

create function public._food_world_lock(p_user uuid) returns void
  language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('food_world:' || p_user::text, 0))
$$;
revoke all on function public._food_world_lock(uuid) from public, anon, authenticated;
-- The guard below runs as the writing role; the server's own writes run as service_role.
grant execute on function public.food_world_condition_key(text) to service_role;
grant execute on function public.food_world_unconfirmed(uuid, text[]) to service_role;
grant execute on function public._food_world_lock(uuid) to service_role;

-- (1) and (a): only trusted code moves the switch, and 'open' needs every condition confirmed.
-- Security invoker on purpose: current_user is the role that ran the statement, so a direct
-- PostgREST write reads 'authenticated', while a definer trigger below reads its owner.
create function public.user_settings_food_world_guard() returns trigger
  language plpgsql set search_path = '' as $$
declare
  v_conditions text[];
  v_review boolean;
begin
  if tg_op = 'UPDATE' and new.food_world is not distinct from old.food_world then
    return new;
  end if;
  if tg_op = 'INSERT' and new.food_world = 'closed' then
    return new;
  end if;
  if current_user in ('authenticated', 'anon') then
    raise exception 'food_world is server-written' using errcode = '42501';
  end if;
  if new.food_world = 'open' then
    perform public._food_world_lock(new.user_id);
    select conditions, condition_review_required into v_conditions, v_review
      from public.constraint_profiles where user_id = new.user_id;
    if coalesce(v_review, false) or public.food_world_unconfirmed(new.user_id, v_conditions) then
      raise exception 'condition_review' using errcode = 'P0001',
        detail = 'A stated condition needs confirmation before the food world opens.';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.user_settings_food_world_guard() from public, anon, authenticated;
-- (b) and (c), on the constraint row itself so they hold for every writer (Settings, the coach,
-- sync, onboarding, the rule review).
create function public.constraint_profiles_condition_gate() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_world text;
begin
  perform public._food_world_lock(new.user_id);
  if tg_op = 'INSERT' or new.conditions is distinct from old.conditions then
    -- A confirmation lives only as long as its condition: removing a condition deletes it, so a
    -- condition added again later is unconfirmed and needs review again.
    delete from public.food_world_condition_confirmations f
     where f.user_id = new.user_id
       and not exists (select 1 from unnest(coalesce(new.conditions, '{}'::text[])) as c(text)
                        where public.food_world_condition_key(c.text) = f.condition_key);
    select food_world into v_world from public.user_settings where user_id = new.user_id;
    if v_world = 'open' and public.food_world_unconfirmed(new.user_id, new.conditions) then
      new.condition_review_required := true;
      update public.user_settings set food_world = 'closed' where user_id = new.user_id;
    end if;
  end if;
  -- (c): a pending review is never cleared while a stated condition is still unconfirmed. A closed
  -- account that never opened has no pending review, so its conditions alone pause nothing.
  if tg_op = 'UPDATE' and old.condition_review_required and not new.condition_review_required
     and public.food_world_unconfirmed(new.user_id, new.conditions) then
    new.condition_review_required := true;
  end if;
  return new;
end $$;
revoke all on function public.constraint_profiles_condition_gate() from public, anon, authenticated;
create table public.account_rules_clock (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rules_rev bigint not null default 0 constraint account_rules_clock_rev check (rules_rev >= 0),
  last_xact xid8,
  updated_at timestamptz not null default now()
);
alter table public.account_rules_clock enable row level security;
alter table public.account_rules_clock force row level security;
create policy account_rules_clock_read on public.account_rules_clock
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.account_rules_clock from public, anon, authenticated;
grant select on table public.account_rules_clock to authenticated;
grant all on table public.account_rules_clock to service_role;

create table public.evidence_clock (
  id smallint primary key constraint evidence_clock_singleton check (id = 1),
  evidence_rev bigint not null default 0 constraint evidence_clock_rev check (evidence_rev >= 0),
  last_xact xid8,
  updated_at timestamptz not null default now()
);
insert into public.evidence_clock (id) values (1);
alter table public.evidence_clock enable row level security;
alter table public.evidence_clock force row level security;
create policy evidence_clock_read on public.evidence_clock for select to authenticated using (true);
revoke all on table public.evidence_clock from public, anon, authenticated;
grant select on table public.evidence_clock to authenticated;
grant all on table public.evidence_clock to service_role;

create function public._bump_rules_clock(p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  -- An account cascade deletes the account's rows after the account itself: nothing to count.
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    return;
  end if;
  insert into public.account_rules_clock as c (user_id, rules_rev, last_xact, updated_at)
  values (p_user, 1, pg_current_xact_id(), now())
  on conflict (user_id) do update
    set rules_rev = c.rules_rev + 1, last_xact = excluded.last_xact, updated_at = now()
    where c.last_xact is distinct from excluded.last_xact;
end $$;
revoke all on function public._bump_rules_clock(uuid) from public, anon, authenticated;

-- Any insert, update or delete of an account's admission input; an update that moves a row to
-- another account moves both accounts' counters.
create function public.rules_clock_bump() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform public._bump_rules_clock(new.user_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.user_id is distinct from new.user_id) then
    perform public._bump_rules_clock(old.user_id);
  end if;
  return null;
end $$;
revoke all on function public.rules_clock_bump() from public, anon, authenticated;

-- Statement-level, one trigger per event (a transition table serves one event): a statement that
-- touched at least one row of a shared admission input moves the global counter once.
create function public.evidence_clock_bump() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_rows boolean;
begin
  -- Separate statements: an INSERT trigger has no old_rows and a DELETE trigger no new_rows, and
  -- one expression naming both fails to plan (found by the W2b rehearsal under load).
  if tg_op = 'DELETE' then
    v_rows := exists (select 1 from old_rows);
  else
    v_rows := exists (select 1 from new_rows);
  end if;
  if v_rows then
    update public.evidence_clock
       set evidence_rev = evidence_rev + 1, last_xact = pg_current_xact_id(), updated_at = now()
     where id = 1 and last_xact is distinct from pg_current_xact_id();
  end if;
  return null;
end $$;
revoke all on function public.evidence_clock_bump() from public, anon, authenticated;
