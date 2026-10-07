-- Phase 4 spec §4, "20260916090100_media_bucket.sql". The bucket id is the literal 'media'
-- (contracts §5). 8 MB and the six MIME types are the outer bound; lib/media/validate.ts is the
-- real gate, because a declared content type is a claim, not evidence.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media','media', false, 8388608,
          array['image/jpeg','image/png','audio/mp4','audio/aac','audio/mpeg','audio/wav'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types, public = false;

-- The §4.2 owner re-check, enforceable in the database as well as in the handler. The object NAME
-- inside the bucket is '<uid>/<uuid>.<ext>', so foldername(name)[1] is the uid.
drop policy if exists media_own_folder on storage.objects;
create policy media_own_folder on storage.objects for all to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create table if not exists media_objects (
  path text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('image','audio')),
  bytes integer not null,
  entry_id uuid references log_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz);
create index if not exists media_objects_sweep on media_objects (created_at) where deleted_at is null;
alter table media_objects enable row level security;
drop policy if exists media_objects_rw on media_objects;
create policy media_objects_rw on media_objects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on table media_objects from anon;
grant select, insert, update, delete on table media_objects to authenticated;
grant all on table media_objects to service_role;
