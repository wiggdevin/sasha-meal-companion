-- U4 / D4 / F9: one privacy-safe routing outcome per classified coach turn. The utterance and
-- extracted arguments never enter this table. Jev provider usage remains in ai_calls.

create table if not exists coach_intent_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  intent text check (intent is null or intent in (
    'shift_schedule','log_food','suggest_options','add_to_eats','add_to_avoid',
    'remove_from_eats','remove_from_avoid','log_water','log_weight','update_profile',
    'set_targets','question','other'
  )),
  winning_confidence real check (winning_confidence is null or winning_confidence between 0 and 1),
  min_argument_confidence real
    check (min_argument_confidence is null or min_argument_confidence between 0 and 1),
  fast_path_taken boolean not null,
  fallback_reason text not null check (fallback_reason in (
    'none','below_threshold','missing_arg','grounding','jev_down','clarifying'
  )),
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists coach_intent_events_user_created
  on coach_intent_events (user_id, created_at desc);

alter table coach_intent_events enable row level security;
alter table coach_intent_events force row level security;

revoke all on table coach_intent_events from anon, authenticated;
grant all on table coach_intent_events to service_role;

-- Phone-side fast-path action failures and successful Undo events use the existing timing stream.
alter table client_timings drop constraint if exists client_timings_step_check;
alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','sent','first-text','reply-done','action-applied',
                  'action-failed','action-undone'));
