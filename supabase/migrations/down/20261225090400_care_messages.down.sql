-- Reverse of 20261225090400_care_messages.sql. Refuses while any account holds a message, unless
-- app.allow_down_data_loss = on.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and to_regclass('public.care_messages') is not null
     and exists (select 1 from public.care_messages) then
    raise exception 'care_messages down: accounts hold messages; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;

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
  return v_row;
end $$;
revoke all on function public._care_accolade_grant(uuid, text, jsonb) from public, anon, authenticated;

drop function if exists public.care_message_mark(uuid, uuid, text);
drop table if exists public.care_messages;
