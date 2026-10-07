-- Ruling 7: at most one pending target_proposals row per user, DB-enforced. write_target_proposal
-- rejects every other pending proposal for the user and inserts the new one in one transaction,
-- so a crash between the two statements can never leave two pending rows visible. Called by the
-- weekly-proposal cron job on the service-role admin client, never by the browser.

create unique index target_proposals_one_pending on target_proposals (user_id)
  where status = 'pending';

create function write_target_proposal(p_user_id uuid, p_week_start date,
    p_based_on_estimate_id uuid, p_proposed jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;

  update target_proposals set status = 'rejected', decided_at = now()
    where user_id = p_user_id and status = 'pending' and week_start <> p_week_start;

  insert into target_proposals (user_id, week_start, status, based_on_estimate_id, proposed)
  values (p_user_id, p_week_start, 'pending', p_based_on_estimate_id, p_proposed)
  on conflict (user_id, week_start) do nothing
  returning id into v_id;

  return v_id;
end; $$;
revoke execute on function write_target_proposal(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function write_target_proposal(uuid, date, uuid, jsonb) to service_role;
