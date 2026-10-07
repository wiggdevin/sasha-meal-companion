-- Phase 14 slice 1: live dictation ("the ears", docs/specs/phase-14-voice-agent.md §4.1).
--
-- One row per ephemeral Gemini Live transcription token the server mints for a user. The row is
-- the minute ledger, and it charges every minted token its WHOLE lifetime: the phone cannot prove
-- how long it streamed, and Google keeps accepting audio on a token until it expires, so a charge
-- that trusted the phone's report could be talked down (GPT-6 Sol r1 finding 1). A token the
-- provider refused to mint (`refused`) charges nothing. `closed` only frees the one-open-token slot
-- early, so the next hold does not wait for the last token to expire; it does not lower the charge.
--
-- The functions are service-role only: the route calls them through the admin client with the
-- verified user id. Supabase grants EXECUTE on new public functions to `authenticated` by default
-- (20261103090000_sync_internals_revoke_authenticated.sql), so each one is revoked explicitly.

create table if not exists voice_ears (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reserved_seconds integer not null check (reserved_seconds between 1 and 600),
  status text not null default 'open' check (status in ('open', 'closed', 'refused')),
  minted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);

create index if not exists voice_ears_user_minted on voice_ears (user_id, minted_at desc);

alter table voice_ears enable row level security;
alter table voice_ears force row level security;
revoke all on table voice_ears from anon, authenticated;
grant all on table voice_ears to service_role;

-- Reserve one token's lifetime, atomically per user. Outcomes:
--   ok        a row was inserted; ears_id and expires_at are set
--   busy      another reservation is still open and unexpired (one live transcription at a time)
--   exhausted today's (UTC) charged seconds plus this reservation would pass the cap
create or replace function voice_ears_open(
  p_user_id uuid, p_reserved_seconds integer, p_daily_cap_seconds integer
) returns table (outcome text, ears_id uuid, expires_at timestamptz, used_seconds integer)
language plpgsql security definer set search_path = public as $$
declare
  v_used integer;
  v_id uuid;
  v_expires timestamptz;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  if p_user_id is null or p_reserved_seconds is null or p_reserved_seconds < 1
     or p_daily_cap_seconds is null or p_daily_cap_seconds < 0 then
    raise exception 'invalid voice_ears_open arguments' using errcode = '22023';
  end if;
  -- Serialise every reservation of one user: two taps, two tabs or two instances cannot both pass.
  perform pg_advisory_xact_lock(hashtextextended('voice_ears:' || p_user_id::text, 0));

  if exists (select 1 from voice_ears v where v.user_id = p_user_id and v.status = 'open'
             and v.expires_at > now()) then
    return query select 'busy'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  select coalesce(sum(v.reserved_seconds), 0)::integer into v_used
    from voice_ears v
   where v.user_id = p_user_id and v.status <> 'refused' and v.minted_at >= v_day_start;

  if v_used + p_reserved_seconds > p_daily_cap_seconds then
    return query select 'exhausted'::text, null::uuid, null::timestamptz, v_used;
    return;
  end if;

  insert into voice_ears (user_id, reserved_seconds, expires_at)
    values (p_user_id, p_reserved_seconds, now() + make_interval(secs => p_reserved_seconds))
    returning id, voice_ears.expires_at into v_id, v_expires;
  return query select 'ok'::text, v_id, v_expires, v_used;
end;
$$;

-- The phone is done with a token: free the one-open-token slot. The charge does not change.
-- Answers true when an open row of this user with this id was closed, false otherwise.
create or replace function voice_ears_close(p_user_id uuid, p_ears_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update voice_ears v set status = 'closed', closed_at = now()
   where v.id = p_ears_id and v.user_id = p_user_id and v.status = 'open';
  return found;
end;
$$;

-- The provider refused to mint: nothing was spent, so nothing is charged.
create or replace function voice_ears_refuse(p_user_id uuid, p_ears_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update voice_ears v set status = 'refused', closed_at = now()
   where v.id = p_ears_id and v.user_id = p_user_id and v.status = 'open';
end;
$$;

revoke execute on function voice_ears_open(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function voice_ears_close(uuid, uuid) from public, anon, authenticated;
revoke execute on function voice_ears_refuse(uuid, uuid) from public, anon, authenticated;
grant execute on function voice_ears_open(uuid, integer, integer) to service_role;
grant execute on function voice_ears_close(uuid, uuid) to service_role;
grant execute on function voice_ears_refuse(uuid, uuid) to service_role;
