-- Phase 0: architecture v2.1 §2.2 api_tokens and §3.5 health tables. The 'manual' kind is the
-- phase-spec addition, so a typed weigh-in has a source row the backfill can point at.
create table api_tokens (id uuid primary key default gen_random_uuid(), label text not null,
  user_id uuid not null references auth.users(id) on delete cascade, expires_at timestamptz,
  token_hash bytea not null unique, scopes text[] not null default '{read}', revoked_at timestamptz,
  created_at timestamptz not null default now(), last_used_at timestamptz);

create table health_sources (id uuid primary key default gen_random_uuid(), device_label text,
  user_id uuid not null references auth.users(id) on delete cascade, token_hash bytea,
  kind text not null check (kind in ('apple_health_shortcut','health_auto_export','oura','manual')),
  oauth jsonb,      -- encrypted at rest
  created_at timestamptz not null default now(), revoked_at timestamptz);
create table ingest_events (id uuid primary key default gen_random_uuid(), status text not null,
  user_id uuid not null references auth.users(id) on delete cascade, error text,
  source_id uuid not null references health_sources(id), payload_hash bytea not null,
  received_at timestamptz not null default now(), unique (source_id, payload_hash));
create table health_samples (id uuid primary key default gen_random_uuid(), type text not null,
  user_id uuid not null references auth.users(id) on delete cascade, value numeric not null,
  source_id uuid not null references health_sources(id), unit text not null, vendor_sample_id text,
  vendor_version text, vendor_updated_at timestamptz, start_time timestamptz not null,
  end_time timestamptz not null, tz text not null, received_at timestamptz not null default now(),
  ingest_event_id uuid references ingest_events(id),
  -- extract(epoch from timestamptz) is only STABLE and is rejected in a stored generated column
  -- (Postgres date_part on timestamptz is volatility-tagged stable regardless of the field).
  -- Subtracting the epoch first yields an interval, and extract(epoch from interval) is IMMUTABLE.
  dedupe_key text generated always as (coalesce(vendor_sample_id,
    type || '|' || (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text
         || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text)) stored);
create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);
