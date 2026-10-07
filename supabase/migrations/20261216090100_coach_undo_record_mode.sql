-- Coach Undo receipts v1, deploy step 2a (docs/specs/coach-undo-receipt.md §6.2, §7).
--
-- `coach_action_undos.record_mode` decides a record's Undo path (spec §4.1): 'legacy' (today's
-- path, every record made so far) or 'receipt_v1' (a record made with a receipt by apply_coach_op,
-- step 6). Constant defaults and nullable columns, so the ALTERs are catalog-only (no rewrite, no
-- scan): every existing row reads 'legacy' at once. The CHECKs are added NOT VALID; step 2b
-- (20261216090200) validates them and sets NOT NULL.
--
--   record_mode    'legacy' | 'receipt_v1', immutable after insert (trigger below).
--   source         the stamp's source (composed card or food idea), receipt_v1 only.
--   source_check   'match' | 'mismatch' | 'none', receipt_v1 only.
--
-- A receipt_v1 record carries no inverse: `inverse = '{}'`, `expected_rev` null, `bind = '{}'`.
-- None of them authorizes an inverse; every function refuses a receipt_v1 record on the legacy
-- path (steps 3 and 4).
--
-- Down: supabase/migrations/down/20261216090100_coach_undo_record_mode.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'coach_action_undos' and column_name = 'record_mode') then
    raise exception '20261216090100_coach_undo_record_mode: already applied';
  end if;
end $$;

alter table public.coach_action_undos add column record_mode text default 'legacy';
alter table public.coach_action_undos add column source jsonb;
alter table public.coach_action_undos add column source_check text;

alter table public.coach_action_undos add constraint coach_action_undos_record_mode
  check (record_mode is not null and record_mode in ('legacy', 'receipt_v1')) not valid;
alter table public.coach_action_undos add constraint coach_action_undos_source
  check (source is null or jsonb_typeof(source) = 'object') not valid;
alter table public.coach_action_undos add constraint coach_action_undos_source_check
  check (source_check is null or source_check in ('match', 'mismatch', 'none')) not valid;
-- A legacy record has no source fields; a receipt_v1 record has a source check and no inverse.
alter table public.coach_action_undos add constraint coach_action_undos_mode_shape
  check (case when record_mode = 'receipt_v1'
              then source_check is not null and inverse = '{}'::jsonb and expected_rev is null
                   and bind = '{}'::jsonb
              else source is null and source_check is null end) not valid;

comment on column public.coach_action_undos.record_mode is
  'Coach Undo path (docs/specs/coach-undo-receipt.md §4.1): legacy = today''s inverse; receipt_v1 = the one receipt. Immutable.';

-- record_mode, source and source_check never change after insert.
create function public._coach_action_undos_mode_fixed() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.record_mode is distinct from old.record_mode or new.source is distinct from old.source
     or new.source_check is distinct from old.source_check then
    raise exception 'record_mode_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._coach_action_undos_mode_fixed() from public, anon, authenticated;

create trigger coach_action_undos_mode_fixed
  before update of record_mode, source, source_check on public.coach_action_undos
  for each row execute function public._coach_action_undos_mode_fixed();
