-- Reverse of BOTH forward migrations' live-safety split, done correctly this time (Sol r2 WARN):
-- down files run in REVERSE chronological order (this one, 090100, runs BEFORE 090000's), so the
-- two lock-sensitive steps are split across THIS file (the quick ACCESS EXCLUSIVE add) and
-- 090000's down file (the SHARE UPDATE EXCLUSIVE validate scan, which must run second) — not
-- both in one file, where a single transaction holds the table's ACCESS EXCLUSIVE lock for the
-- validate's full scan too, defeating the whole point of the NOT VALID split (the bug an earlier
-- draft of this rollback had). The exists-check guard belongs here, before anything is dropped.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.user_settings where sex = 'unspecified') then
    raise exception 'user_settings_sex_unspecified down: unspecified rows exist';
  end if;
end $$;

alter table public.user_settings drop constraint if exists user_settings_sex_check;
alter table public.user_settings add constraint user_settings_sex_check
  check (sex in ('female', 'male')) not valid;
