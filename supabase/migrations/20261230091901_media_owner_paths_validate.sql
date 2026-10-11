-- W019 step 2 of 2: validate the media_objects owner-path CHECK that step 1 (20261230091900) added
-- NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (reads and writes continue) for one
-- scan of media_objects.
-- Before production, this must answer 0 (every row signUpload ever wrote has this shape; a row
-- that does not is exactly the cross-folder row P08 describes, so investigate it, never delete it
-- blind):
--   select count(*) from public.media_objects where path !~ ('^media/' || user_id::text
--     || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|m4a|aac|mp3|wav)$');
-- Down: supabase/migrations/down/20261230091901_media_owner_paths_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.media_objects validate constraint media_objects_owner_path;
