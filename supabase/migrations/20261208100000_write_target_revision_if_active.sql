-- Server-side target recompute (lib/server/target-recompute.ts) plans a derivation from the active
-- revision and the user_settings row it read, then writes. Without a check, a weigh-in, pin,
-- proposal or another recompute that committed in between would be buried under the older plan.
-- This wrapper takes the same per-user advisory lock write_target_revision takes
-- (transaction-scoped, re-entrant), re-reads the revision active on the new row's effective date
-- and the user_settings rev, and writes only when both are still what the caller planned from
-- (p_expected_id null = "no active revision"; p_expected_settings_rev null = not checked).
-- Otherwise it writes nothing and returns {"conflict": true, ...} so the caller re-plans.
create or replace function write_target_revision_if_active(
  p_user_id uuid, p_row jsonb, p_expected_id uuid, p_expected_settings_rev bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active uuid;
  v_settings_rev bigint;
begin
  perform _sync_assert_caller(p_user_id);
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select id into v_active from target_profiles
    where user_id = p_user_id and effective_from <= (p_row->>'effective_from')::date
    order by effective_from desc, rev desc
    limit 1;
  if p_expected_settings_rev is not null then
    -- FOR UPDATE: a settings write cannot commit between this check and the insert below; it
    -- waits for this transaction and its own recompute then plans from the row written here.
    select rev into v_settings_rev from user_settings where user_id = p_user_id for update;
  end if;
  -- A revision dated after the new row (a phone clock ahead of the account zone) would win once its
  -- date arrives; the recompute does not write under one (lib/server/target-recompute.ts).
  if v_active is distinct from p_expected_id
     or (p_expected_settings_rev is not null and v_settings_rev is distinct from p_expected_settings_rev)
     or exists (select 1 from target_profiles where user_id = p_user_id
                and effective_from > (p_row->>'effective_from')::date) then
    return jsonb_build_object('conflict', true, 'active_id', v_active);
  end if;
  return write_target_revision(p_user_id, p_row);
end;
$$;
revoke execute on function write_target_revision_if_active(uuid, jsonb, uuid, bigint) from public, anon;
grant execute on function write_target_revision_if_active(uuid, jsonb, uuid, bigint) to authenticated, service_role;
