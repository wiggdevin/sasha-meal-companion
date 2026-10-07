-- Reverse of 20261211090100_coach_action_undos_same_owner.sql. Rolling back reopens the two
-- cross-account references on coach_action_undos (thread_id, message_id) to any writer that is not
-- record_coach_undo, so run it only to unblock a broken deploy and re-apply the forward migration.
drop trigger if exists coach_action_undos_same_owner on public.coach_action_undos;
drop function if exists public._same_owner_coach_action_undos();
