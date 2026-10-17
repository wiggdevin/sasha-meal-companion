-- W074 (second file): validate the preset check on existing target_profiles rows. If a legacy row
-- holds another rate, say which accounts instead of failing with a bare constraint error; nothing
-- is rewritten. Fix those rows deliberately (an owner step), then apply this file again.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $migration$
declare
  off_preset integer;
begin
  select count(*) into off_preset from public.target_profiles
   where goal_rate_bp_week not in (-75, -50, -25, 0, 10, 20, 25);
  if off_preset > 0 then
    raise exception 'target_profiles_goal_rate_bp_week_check: % revision(s) hold a rate outside the presets; review them before validating', off_preset;
  end if;
end;
$migration$;

alter table public.target_profiles validate constraint target_profiles_goal_rate_bp_week_check;
