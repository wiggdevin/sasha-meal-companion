-- Phase 17 O2, D1 (docs/specs/phase-17-meal-occasion.md): a log entry carries the occasion it was
-- eaten at, so the account's own history can say "tuna is a breakfast for this person".
--
-- `occasion` is written by the server after a log is applied (lib/server/log-occasion.ts), from
-- the slot's clock on that local date (the account's slot times, shift and per-day time edit) or
-- the account's occasion override for the slot. No client sends it, so an old client keeps
-- working unchanged. Old rows stay null and history ignores them.
--
-- An edit that moves an entry (another slot, another day, or another eating time or zone, which
-- decide the occasion of an unscheduled slot) clears the stamp in the same write, so a stale
-- occasion never survives a move; the server restamps the moved entry after the op.
alter table log_entries
  add column if not exists occasion text
    check (occasion in ('breakfast', 'lunch', 'dinner', 'snack', 'other')),
  add column if not exists occasion_source text
    check (occasion_source in ('slot_clock', 'override', 'user'));

alter table log_entries drop constraint if exists log_entries_occasion_pair;
alter table log_entries add constraint log_entries_occasion_pair
  check ((occasion is null) = (occasion_source is null));

create or replace function public.log_entries_occasion_on_move() returns trigger
  language plpgsql set search_path = public as $$
begin
  -- A move keeps an occasion only when the same write sets it as the user's own choice; anything
  -- else (an untouched stamp, or one column set without the other) is cleared together.
  if (new.slot is distinct from old.slot or new.local_date is distinct from old.local_date
      or new.eaten_at is distinct from old.eaten_at or new.tz is distinct from old.tz)
     and not (new.occasion_source = 'user' and new.occasion is not null
              and (new.occasion is distinct from old.occasion
                   or new.occasion_source is distinct from old.occasion_source)) then
    new.occasion := null;
    new.occasion_source := null;
  end if;
  return new;
end $$;

-- Internal: only the trigger calls it (same rule as the body-fat provenance trigger).
revoke all on function public.log_entries_occasion_on_move() from public, anon, authenticated;

drop trigger if exists log_entries_occasion_on_move on log_entries;
create trigger log_entries_occasion_on_move
  before update of slot, local_date, eaten_at, tz on log_entries
  for each row execute function public.log_entries_occasion_on_move();

-- The history read: one account's live, stamped entries over a bounded date window. Not
-- CONCURRENTLY: migrations run in a transaction; log_entries is small (one person's logs per account).
create index if not exists log_entries_occasion_window on log_entries (user_id, local_date)
  where occasion is not null and deleted_at is null;
