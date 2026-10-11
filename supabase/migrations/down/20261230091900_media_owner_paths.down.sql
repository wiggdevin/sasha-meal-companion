-- Down for supabase/migrations/20261230091900_media_owner_paths.sql: drops the owner-path CHECK
-- and puts back 20260920090100's single `for all` own-folder policy (which lets a signed-in user
-- upload straight to her own folder again, audit 2026-10-10 A055).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.media_objects drop constraint if exists media_objects_owner_path;

drop policy if exists media_own_read on storage.objects;
drop policy if exists media_own_delete on storage.objects;
drop policy if exists media_own_folder on storage.objects;
create policy media_own_folder on storage.objects for all to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
