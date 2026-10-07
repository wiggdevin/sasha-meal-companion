-- Reverse of 20261210090300_coach_action_undos.sql. Deploy the app revert BEFORE running this:
-- app/api/coach/undo reads and writes coach_action_undos and calls perform_coach_undo by name.
-- Dropping the table loses the server-side undo records only; every phone keeps its local tokens.
drop function if exists perform_coach_undo(uuid, boolean);
drop function if exists record_coach_undo(text, text, jsonb, bigint, uuid, boolean, uuid, integer);
drop function if exists scrub_coach_action_undos(timestamptz);
drop function if exists _coach_undo_slot_state(jsonb);
drop function if exists _coach_undo_items(jsonb);
drop function if exists _coach_undo_instant(text);
drop table if exists coach_action_undos;
drop function if exists _coach_action_undos_stamp();
