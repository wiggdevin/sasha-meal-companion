-- UI-NEEDS SPROUT-CARE item 4 (coord.md 2026-10-07T04:15Z; shape matches components/today/care/
-- CareNotes.tsx's `CareNote` union). Server-generated only: no client role may insert a message
-- (copy that "observes; never tells anyone to eat" is the server's to write, not the phone's), so
-- `care_messages` grants authenticated select only; `care_message_mark` is the one write path, and
-- it only ever sets `read_at` / `dismissed_at` on the caller's own row.
--
-- Wired to produce a message automatically only where this migration set is already sure of the
-- trigger: `_care_accolade_grant` (20261225090300) now also enqueues one 'accolade' message per
-- real grant, so a fresh accolade always has something in the inbox. 'tip' / 'observation' /
-- 'system' / 'shop' / 'streak' messages are not auto-generated yet -- the table, RLS and
-- read/dismiss API are ready for them, but nothing in this migration decides when a tip or a
-- streak note is worth sending; that is a follow-up once the owner names the triggers.
--
-- Live-safe: one new table, RLS on from creation, one new function, one `create or replace` of an
-- existing function (`_care_accolade_grant`) that takes no table lock.
-- Down: supabase/migrations/down/20261225090400_care_messages.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.care_messages') is not null then
    raise exception '20261225090400_care_messages: already applied';
  end if;
end $$;

create table public.care_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('tip', 'accolade', 'observation', 'system', 'shop', 'streak')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz
);
create index care_messages_inbox on public.care_messages (user_id, created_at desc);
comment on table public.care_messages is
  'UI-NEEDS SPROUT-CARE item 4: the well''s message inbox. Written only by care_message_mark '
  '(read_at/dismissed_at) and server triggers (_care_accolade_grant today).';

alter table public.care_messages enable row level security;
create policy care_messages_select on public.care_messages for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_messages from public, anon, authenticated, service_role;
grant select on table public.care_messages to authenticated;
grant select, insert on table public.care_messages to service_role;

-- Sets `read_at` or `dismissed_at` (p_action) on the caller's own message, once. A second call
-- for an already-marked message, or an unknown id, is a harmless no-op.
create function public.care_message_mark(p_user_id uuid, p_id uuid, p_action text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  perform _sync_assert_caller(p_user_id);
  if p_action = 'read' then
    update care_messages set read_at = now() where id = p_id and user_id = p_user_id and read_at is null;
  elsif p_action = 'dismiss' then
    update care_messages set dismissed_at = now()
     where id = p_id and user_id = p_user_id and dismissed_at is null;
  else
    raise exception 'bad_action' using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.care_message_mark(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.care_message_mark(uuid, uuid, text) to authenticated, service_role;

-- Re-declared to also enqueue one message per real grant (CareNotes.tsx's `{type: "accolade",
-- award}` reads `payload.key`; the phone already has the full award catalog, so the payload only
-- names the key, never duplicates its copy or art).
create or replace function public._care_accolade_grant(p_user uuid, p_key text, p_evidence jsonb)
  returns public.care_accolades
  language plpgsql security definer set search_path = public as $$
declare v_version integer; v_row care_accolades%rowtype;
begin
  select version into v_version from care_accolade_defs where key = p_key;
  if v_version is null then return null; end if;
  insert into care_accolades (user_id, key, version, evidence)
  values (p_user, p_key, v_version, p_evidence)
  on conflict (user_id, key, version) do nothing
  returning * into v_row;
  if v_row.key is not null then
    insert into care_messages (user_id, type, payload)
    values (p_user, 'accolade', jsonb_build_object('key', p_key, 'version', v_version));
  end if;
  return v_row;
end $$;
revoke all on function public._care_accolade_grant(uuid, text, jsonb) from public, anon, authenticated;
