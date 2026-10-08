-- Reverse of 20261226090100_taste_dislike_remove.sql. Refuses while any removal exists: dropping
-- it would leave a removed dislike with no receipt its Undo could attribute. user_settings itself
-- is untouched either way.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.taste_dislike_removals) then
    raise exception 'taste_dislike_remove down: removals exist; their Undo would be lost';
  end if;
end $$;

drop function if exists public.taste_dislike_remove_undo(uuid, uuid);
drop function if exists public._taste_dislike_remove_undo_locked(uuid, uuid);
drop function if exists public.taste_dislike_remove(uuid, uuid, text);
drop function if exists public._taste_dislike_key_valid(text);
drop table if exists public.taste_dislike_removals;
drop function if exists public._taste_dislike_removals_guard();
