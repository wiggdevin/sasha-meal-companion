-- Down for supabase/migrations/20260920090100_phase4_media_bucket.sql. Drops only what SQL is
-- allowed to drop; never destroys her uploads.
drop table if exists media_objects;
drop policy if exists media_own_folder on storage.objects;

-- The bucket row itself is left in place. Supabase's storage.protect_delete() trigger forbids
-- direct SQL deletes on storage tables ("Direct deletion from storage tables is not allowed. Use
-- the Storage API instead."), so this down migration cannot remove it. Leaving it is harmless: it
-- holds no objects once media_objects is gone and the sweep has run. An operator who wants the
-- (empty) bucket gone removes it through the Storage API instead, e.g.
-- `supabase storage rm ss:///media --recursive` after emptying it, or
-- `adminClient().storage.deleteBucket("media")`.
