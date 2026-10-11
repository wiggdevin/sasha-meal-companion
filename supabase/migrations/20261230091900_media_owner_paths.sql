-- W019 (audit 2026-10-10 F20: A055, P08), step 1 of 2. Media objects and their rows stay inside
-- the owner's own folder.
--
-- 1. storage.objects: `media_own_folder` (20260920090100) granted `for all` to authenticated, so a
--    signed-in user could PUT objects straight into media/<uid>/ with her own JWT. Such an object
--    has no media_objects row: the daily sweep never sees it and the sign route's 30/min limit
--    never applies. Every app upload already goes through the server-signed URL (`signUpload`,
--    lib/server/media.ts: the row first, then `createSignedUploadUrl` with the service role;
--    Storage writes a signed upload as its own superuser, never through these policies). So the
--    authenticated policy keeps only select and delete on the caller's own folder: no insert, no
--    update, and so no direct upload, upsert, move or copy.
-- 2. media_objects.path: nothing tied it to the row's owner, and the sweep deletes the named object
--    with the service role. The CHECK holds every row, whoever writes it, to the one shape
--    signUpload mints: media/<user_id>/<uuid>.<ext>. lib/server/media.ts `ownedObjectKey` is its
--    twin, and the sweep skips any row that fails it.
--
-- Added NOT VALID (a metadata-only lock); step 2 (20261230091901) validates it. Code does not
-- depend on this migration: apply it either side of the deploy.
-- Down: supabase/migrations/down/20261230091900_media_owner_paths.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop policy if exists media_own_folder on storage.objects;
drop policy if exists media_own_read on storage.objects;
drop policy if exists media_own_delete on storage.objects;
create policy media_own_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter table public.media_objects drop constraint if exists media_objects_owner_path;
alter table public.media_objects add constraint media_objects_owner_path check (
  path ~ ('^media/' || user_id::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|m4a|aac|mp3|wav)$')
) not valid;

comment on constraint media_objects_owner_path on public.media_objects is
  'W019: path is media/<user_id>/<uuid>.<ext>, the object signUpload minted in the owner''s own '
  'folder. The media sweep deletes the named object with the service role.';
