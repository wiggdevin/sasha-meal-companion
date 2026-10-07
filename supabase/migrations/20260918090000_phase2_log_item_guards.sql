-- Phase 2, spec "Data changes". log_items has no user_id, so the §2.1 policy pair binds through
-- its parent entry. Dropped by name first, so this is a no-op where Phase 0 already shipped it.
alter table log_items enable row level security;
drop policy if exists log_items_rw on log_items;
create policy log_items_rw on log_items for all to authenticated
  using (exists (select 1 from log_entries le
                  where le.id = log_items.entry_id and le.user_id = (select auth.uid())))
  with check (exists (select 1 from log_entries le
                  where le.id = log_items.entry_id and le.user_id = (select auth.uid())));
create index if not exists log_items_entry on log_items (entry_id);
create index if not exists log_entries_export on log_entries (user_id, local_date, eaten_at, id);
