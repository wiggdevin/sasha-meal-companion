-- Reverse of 20261225090100_care_points_ledger.sql. Refuses while any account holds a non-zero
-- settled balance, unless app.allow_down_data_loss = on: dropping the table would forget it.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and to_regclass('public.care_points_ledger') is not null
     and exists (select 1 from public.care_points_ledger where status = 'settled') then
    raise exception 'care_points_ledger down: accounts hold settled Seeds; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.care_points_sync(uuid, date, text);
drop function if exists public._care_points_settle(uuid, date);
drop function if exists public._care_points_recheck(uuid, public.care_points_ledger);
drop function if exists public._care_water_goal(uuid, date);
drop function if exists public._care_effective_zone(uuid, text);
drop function if exists public._care_points_award(uuid, text, text, text, integer, date, text, text, jsonb);
drop table if exists public.care_points_ledger;
