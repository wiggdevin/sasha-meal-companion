-- Reverse of 20261225090300_care_accolades.sql. Refuses while any account holds a grant, unless
-- app.allow_down_data_loss = on: dropping the table would forget every earned accolade.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and to_regclass('public.care_accolades') is not null
     and exists (select 1 from public.care_accolades) then
    raise exception 'care_accolades down: accounts hold grants; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.care_accolades_seen(uuid, text[]);
drop function if exists public.care_accolades_sync(uuid, date, text);
drop function if exists public._care_accolade_grant(uuid, text, jsonb);
drop table if exists public.care_accolades;
drop table if exists public.care_accolade_defs;
