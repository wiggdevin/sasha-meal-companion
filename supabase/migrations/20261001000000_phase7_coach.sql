-- Phase 7 coach, contracts §4 (reconciled): Phase 0 already shipped coach_threads,
-- coach_messages and constraint_profiles, so this migration only ALTERs them. RLS is
-- already the §2.1 pair on all three (20260911000500_rls.sql) and is not touched.
-- ai_calls.purpose has no check constraint in Phase 0, so there is nothing to widen:
-- coach purposes are the adapter keys 'coach' and 'weeklyReview' (contracts §4).

-- ---------- coach_threads -------------------------------------------------------------
alter table coach_threads add column kind text not null default 'chat'
  check (kind in ('chat','weekly_review'));
alter table coach_threads add column rev integer not null default 1;
alter table coach_threads add column last_message_at timestamptz;
alter table coach_threads add column deleted_at timestamptz;

create index coach_threads_user on coach_threads (user_id, last_message_at desc);
create unique index coach_threads_one_weekly on coach_threads (user_id)
  where kind = 'weekly_review' and deleted_at is null;

-- ---------- coach_messages ------------------------------------------------------------
-- user_id is denormalised from the thread so a privileged read can filter on it directly
-- (§2.2 rule 3) instead of joining. Backfill, then NOT NULL.
alter table coach_messages add column user_id uuid references auth.users(id) on delete cascade;
update coach_messages m set user_id = t.user_id
  from coach_threads t where t.id = m.thread_id and m.user_id is null;
alter table coach_messages alter column user_id set not null;

alter table coach_messages add column deflected boolean not null default false;
alter table coach_messages add column model_id text;
alter table coach_messages add column ai_call_id uuid references ai_calls(id);
alter table coach_messages add column seq integer;

-- Phase 0 ordered messages by created_at only. Number the existing rows in that order
-- so (thread_id, seq) can become unique without losing a transcript.
with numbered as (
  select id, row_number() over (partition by thread_id order by created_at, id) as n
    from coach_messages)
update coach_messages m set seq = numbered.n from numbered where numbered.id = m.id;
alter table coach_messages alter column seq set not null;
alter table coach_messages add constraint coach_messages_thread_seq unique (thread_id, seq);

-- Phase 0 left content nullable and the two jsonb columns without defaults.
update coach_messages set content = '' where content is null;
alter table coach_messages alter column content set default '';
alter table coach_messages alter column content set not null;
update coach_messages set tool_calls = '[]'::jsonb where tool_calls is null;
alter table coach_messages alter column tool_calls set default '[]'::jsonb;
alter table coach_messages alter column tool_calls set not null;
update coach_messages set policy_checks = '[]'::jsonb where policy_checks is null;
alter table coach_messages alter column policy_checks set default '[]'::jsonb;
alter table coach_messages alter column policy_checks set not null;

create index coach_messages_thread on coach_messages (thread_id, seq);

-- ---------- constraint_profiles -------------------------------------------------------
alter table constraint_profiles add column updated_at timestamptz not null default now();
