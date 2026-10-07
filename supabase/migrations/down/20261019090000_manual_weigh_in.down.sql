-- Rollback of 20261019090000_manual_weigh_in.
--
-- The view goes back to 20261013090000's body: the latest `body_mass` sample of the local day,
-- whatever wrote it. Rows already written by `health_weigh_in` are NOT deleted — they are real
-- weigh-ins she typed, and the `weigh_ins` view and the estimator read them like any other sample.
-- Drop them by hand if that is really what is wanted.

create or replace view daily_health with (security_invoker = true) as
  with d as (select user_id, type, value, start_time, end_time,
                    (start_time at time zone tz)::date as local_date from health_samples)
  select user_id, local_date,
    sum(value) filter (where type = 'step_count')    as steps,
    sum(value) filter (where type = 'active_energy') as active_kcal,
    max(value) filter (where type = 'sleep_asleep')  as sleep_minutes,
    (array_agg(value order by start_time desc) filter (where type = 'body_mass'))[1] as body_mass_kg,
    (min(value) filter (where type = 'resting_heart_rate'))::numeric as resting_heart_rate,
    (avg(value) filter (where type = 'hrv_sdnn'))::numeric           as hrv_sdnn,
    ((array_agg(value order by end_time desc) filter (where type = 'readiness_score'))[1])::numeric
      as readiness_score
  from d group by user_id, local_date;
grant select on daily_health to authenticated;

drop function if exists health_weigh_in(date, text, numeric);
drop index if exists health_sources_one_manual;
