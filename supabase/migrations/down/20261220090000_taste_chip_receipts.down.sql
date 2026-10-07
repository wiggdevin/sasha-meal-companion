-- Reverse of 20261220090000_taste_chip_receipts.sql. Run 20261220090100's down file first.
-- Refuses while any receipt exists: dropping it would leave written chips no Undo can attribute.
-- The chips themselves stay in user_settings (they are the user's confirmed settings).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.taste_chip_receipts) then
    raise exception 'taste_chip_receipts down: receipts exist; their Undo would be lost';
  end if;
end $$;

drop trigger if exists taste_chip_holds_release on public.user_settings;
drop trigger if exists taste_chip_holds_release_row on public.user_settings;
drop function if exists public.taste_chips_undo(uuid, uuid);
drop function if exists public._taste_chips_undo_locked(uuid, uuid);
drop function if exists public.taste_chips_confirm(uuid, uuid, text, text[], text[], jsonb);
drop function if exists public._taste_chips_write(uuid, jsonb, text[]);
drop function if exists public._taste_chips_with_dislikes(jsonb, text[]);
drop function if exists public._taste_chips_dislikes_of(jsonb);
drop function if exists public._taste_chips_answer(public.taste_chip_receipts, text, jsonb);
drop function if exists public._taste_chips_request_valid(text[], text[]);
drop function if exists public._taste_chip_holds_release();
drop table if exists public.taste_chip_holds;
drop table if exists public.taste_chip_receipts;
drop function if exists public._taste_chip_receipts_guard();
