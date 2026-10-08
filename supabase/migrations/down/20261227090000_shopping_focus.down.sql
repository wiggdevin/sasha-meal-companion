set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.shopping_focus_undo(uuid, uuid);
drop function if exists public.shopping_focus_set(uuid, timestamptz);
drop trigger if exists user_settings_shopping_focus_guard on public.user_settings;
drop function if exists public.user_settings_shopping_focus_guard();
alter table public.user_settings
  drop column if exists shopping_focus_previous,
  drop column if exists shopping_focus_action,
  drop column if exists shopping_focus_until;
