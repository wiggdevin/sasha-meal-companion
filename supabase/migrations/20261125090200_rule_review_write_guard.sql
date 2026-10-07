-- The review marker belongs to the verified server route. Phase 0 granted authenticated clients
-- table-wide writes, which would otherwise let direct PostgREST updates bypass Keep/Remove.
set local lock_timeout = '5s';

revoke insert, update, delete on table public.constraint_profiles from authenticated;

-- Ordinary account rule edits still use the existing RLS policy and revision-checked route.
-- No authenticated INSERT/UPDATE grant includes either server-owned review marker column.
grant insert (user_id, rev, conditions, notes, avoid_allergens,
  avoid_food_ref_ids, banned_categories, updated_at)
  on table public.constraint_profiles to authenticated;
grant update (user_id, rev, conditions, notes, avoid_allergens,
  avoid_food_ref_ids, banned_categories, updated_at)
  on table public.constraint_profiles to authenticated;

-- Deleting and recreating a row would also erase the marker. Account deletion still cascades
-- through auth.users under the privileged account-deletion path.
