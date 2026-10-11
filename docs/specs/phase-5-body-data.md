# Phase 5 — Body data

Implementation spec. Authority: `docs/architecture.md` v2.1. Where this file and the architecture disagree, the architecture wins.
Numbers authority stays `../../analysis/targets.md`.

Depends on: Phase 0 (Supabase Auth, privileged server boundary §2.2, entity sync §3.7, `lib/server/privileged.ts`,
`lib/server/admin.ts`). Blocks: Phase 6, which reads `weigh_ins` and `daily_health`.

## 1. Goal

Get real body observations — steps, active energy, sleep and weight — into the database from her phone and her Oura ring, once per
day, without her doing anything after setup. Show them on one read-only dashboard so the Phase 6 estimator has qualified weigh-ins and
Devin can see whether the ingest is actually running.

## 2. Scope

**In.** `POST /api/health/ingest` with per-source revocable tokens. A written Health Auto Export recipe Devin installs on her phone
(architecture §10 records HAE as the recommendation over a hand-built Shortcut). Oura OAuth2 confidential authorization-code flow
(§5.2), encrypted token storage with rotation, and the idempotent `/api/jobs/oura-pull` daily job. The `daily_health` view (§3.5) and
the observation dashboard. One read-only MCP tool. Source management UI in Settings: connect, disconnect, issue token, revoke token,
last-received time.

**Out.** No estimator, weight trend, TDEE or proposals — all Phase 6; the dashboard shows observations only. No manual weight entry
screen (weight arrives as a `body_mass` sample). No Oura webhooks (§5.2 calls them an optional later optimisation). No Expo/HealthKit
shell, Withings, Garmin or Health Connect — Phase 8. No backfill older than the first pull window.

## 3. User stories

**Sasha.** Devin sets up her phone once. Every morning her weight, steps, energy and sleep are already in the app; she never opens
Health Auto Export again. She opens the Body screen and sees the last seven days, with an honest gap where a day is missing rather
than an interpolated number.

**Devin.** He issues one ingest token per source from Settings, pastes it into the HAE automation, and taps Connect Oura once. When
something stops, the Body screen tells him which source last delivered and when, and he revokes and re-issues a token without touching
the database.

**Agent via MCP.** A Codex or Claude session calls `get_body_data(from, to)` on the `/api/mcp` route with her personal token and gets
the same rolled-up days the dashboard shows, so a coaching answer can cite real sleep and weight. The tool is read-only and requires
the `read` scope (§2.2 rule 5).

## 4. Data changes

Phase 0 ships the §3.5 tables (`health_sources`, `ingest_events`, `health_samples` with its generated `dedupe_key` and unique index)
as part of the v2.1 user schema. Phase 5 adds only what ingest and Oura need on top. If Phase 0 lands without §3.5, move the three
`create table` blocks from architecture §3.5 into the first migration below unchanged.

`supabase/migrations/20260925000000_phase5_health_ingest.sql`

```sql
-- allowed sample types, so a malformed payload cannot invent a metric
alter table health_samples add constraint health_samples_type_ck check (type in
  ('body_mass','step_count','active_energy','basal_energy','sleep_asleep','sleep_in_bed',
   'resting_heart_rate','hrv_sdnn','readiness_score'));
create index health_samples_user_type_time on health_samples (user_id, type, start_time desc);
create index ingest_events_source_time on ingest_events (source_id, received_at desc);

alter table health_sources  enable row level security;
alter table health_samples  enable row level security;
alter table ingest_events   enable row level security;
create policy health_sources_rw on health_sources for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy health_samples_ro on health_samples for select to authenticated
  using (user_id = (select auth.uid()));
create policy ingest_events_ro on ingest_events for select to authenticated
  using (user_id = (select auth.uid()));
-- writes to health_samples and ingest_events come only from the privileged boundary (§2.2)

create view daily_health with (security_invoker = true) as
  with d as (select user_id, type, value, start_time,
                    (start_time at time zone tz)::date as local_date from health_samples)
  select user_id, local_date,
    sum(value) filter (where type = 'step_count')    as steps,
    sum(value) filter (where type = 'active_energy') as active_kcal,
    max(value) filter (where type = 'sleep_asleep')  as sleep_minutes,
    (array_agg(value order by start_time desc) filter (where type = 'body_mass'))[1] as body_mass_kg
  from d group by user_id, local_date;
grant select on daily_health to authenticated;
```

**These merge rules run at read time, not at ingest.** Samples arrive one at a time and out of order — a Watch step count and a
phone step count for the same window can land in either order, and Oura's sleep session may post before or after Apple's — so there
is no single insert moment at which the preferred source is known yet. The `daily_health` view above is therefore a **plain
aggregate only**; it is not where the §3.5 merge contract is met. Those rules — union of non-overlapping intervals for steps and
active energy preferring Watch-tagged samples, Oura sleep preferred over Apple — live in `lib/health/daily.ts`'s pure `rollUpDay`
(§7) and run inside `lib/server/health-daily.ts` (new, server-only, not pure): it reads the raw `health_samples` rows for one user
and date range and calls `rollUpDay` per local day. `GET /api/health/daily` and the MCP `get_body_data` tool below both read
through `lib/server/health-daily.ts`, never the `daily_health` view directly, so the dashboard, the Phase 6 estimator and MCP all
see the same merged numbers. `weigh_ins` (§2.1) is a Phase 0 object and is not redefined here.

**W025 (2026-10-11).** Steps and active energy now take ONE provider per day: Oura's daily total and the Apple sources' own
roll-up (the Watch-preferred union of HAE and Shortcut samples) are computed apart, and the larger wins, Apple on a tie. The union
alone summed them, because a folded HAE day spans one hour while Oura's spans the whole day. Oura sleep, resting heart rate, HRV
and readiness are dated in the account's stored zone (`user_settings.time_zone`, `lib/server/account-day.ts`; UTC only as the
logged last resort), so a night lands on the local day it began, the same day HAE uses. Daily activity keeps Oura's own `day`.
**Cut-over, no re-bucket script:** existing rows are left untouched. Every pull re-reads the previous two days and the correction
upsert moves each re-pulled row's `tz` (Oura rows carry no `vendor_updated_at`, so every re-pull applies), so the two most recent
days correct themselves on the first pull after deploy. Older Oura rows keep their UTC bucket; this lands before Oura is enabled for
any account, so none is expected. If a connected account turns up, re-pulling its history is the fix, not a SQL rewrite.

`supabase/migrations/20260926000000_phase5_oura_oauth.sql`

```sql
create table oauth_states (state_hash bytea primary key, provider text not null check (provider in ('oura')),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  consumed_at timestamptz);
alter table oauth_states enable row level security;   -- no policy: server boundary only

create table job_runs (job text not null, run_key text not null,   -- e.g. ('oura-pull','2026-09-15')
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));
alter table job_runs enable row level security;
create policy job_runs_ro on job_runs for select to authenticated
  using (user_id = (select auth.uid()));
```

`health_sources.oauth` holds `{access_token, refresh_token, expires_at, scope}` sealed by `lib/server/crypto.ts` (AES-256-GCM,
key `HEALTH_TOKEN_KEY`) before it reaches Postgres. No plaintext token is ever written. Refresh rotates in one transaction: the new
pair is sealed and written in the same statement that clears the old one (§5.2).

New env: `HEALTH_TOKEN_KEY` (32 random bytes, base64), `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`, `CRON_SECRET`.

## 5. API changes

All request and response types live in `lib/health/contract.ts` and are zod schemas with inferred types.

### `POST /api/health/ingest` — `app/api/health/ingest/route.ts`

Auth: per-source opaque token, `Authorization: Bearer <token>`; SHA-256 hashed and matched against `health_sources.token_hash`.
Privileged boundary (§2.2): the row yields one `user_id`, every write goes through `lib/server/privileged.ts`. Body limit 2 MB, rate
limit 30/hour/source, idempotency on `payload_hash` plus `dedupe_key`.

```ts
export type HealthIngestBody = {
  source_kind: "health_auto_export" | "apple_health_shortcut";
  sent_at: string;            // ISO 8601 with offset; 10-minute replay window
  tz: string;                 // IANA, e.g. "America/New_York"
  samples: Array<{
    type: "body_mass" | "step_count" | "active_energy" | "sleep_asleep" | "sleep_in_bed"
        | "resting_heart_rate" | "hrv_sdnn";
    value: number;
    unit: "kg" | "lb" | "count" | "kcal" | "min" | "bpm" | "ms";
    start_time: string;       // ISO 8601 with offset
    end_time: string;         // equals start_time for instantaneous samples
    vendor_sample_id?: string;
    vendor_updated_at?: string;
    device_label?: string;    // "Apple Watch" — drives overlap preference
  }>;
};

export type HealthIngestResponse = {
  event_id: string;
  status: "applied" | "duplicate";   // duplicate = same payload_hash seen before
  accepted: number;                  // rows inserted
  updated: number;                   // corrections applied (newer vendor_updated_at)
  skipped: number;                   // dedupe_key hit with no newer vendor data
  rejected: Array<{ index: number; reason: string }>;
};
```

Errors: `401` unknown, revoked or expired token; `403` source kind does not match the row; `409` `sent_at` outside the 10-minute
replay window (Shortcuts cannot sign requests, §5 matrix); `413` body over 2 MB; `422` zod failure or a sample whose `end_time` is
before `start_time`; `429` rate limit. A partially valid payload still applies its valid samples and lists the rest in `rejected`;
the whole request fails only on `401`, `403`, `409`, `413`, or a zod failure at the envelope level.

### `GET /api/health/oura/start` — `app/api/health/oura/start/route.ts`

JWT. Generates 32 random bytes as `state`, stores its SHA-256 in `oauth_states` with a 10-minute expiry, and 302s to Oura's
authorize URL with `client_id`, `redirect_uri`, `response_type=code`, `scope=daily personal`, `state`.

### `GET /api/health/oura/callback` — `app/api/health/oura/callback/route.ts`

No JWT is assumed (the browser may return in a new context); identity comes from the `oauth_states` row. Verifies the state hash,
that it is unconsumed and unexpired, marks it consumed in the same transaction, exchanges the code server-side with
`client_secret`, seals the token pair, and upserts the `health_sources` row with `kind = 'oura'`. Then it kicks one immediate pull.
Errors: `400` missing or unknown state, consumed state, expired state, provider `error` parameter; `502` token exchange failure. On
any error it redirects to `/settings?oura=error&reason=<code>` and writes nothing.
The return page is one of an allowlist (`/`, `/settings`, `/onboarding`, `/body`, `/foods`, with its own query and hash;
`lib/health/oura-return.ts`), and the redirect is rebuilt on this origin, so a crafted `state` cannot send the browser off-site (W025).
A 401 from Oura forces one token refresh per pull, ignoring the stored expiry; the rotated pair is stored by a compare-and-swap whose
result is checked (no row matched: the stored winner's pair is used; a failed write is retried once, then the pull fails).

### `POST /api/health/oura/disconnect` — `app/api/health/oura/disconnect/route.ts`

JWT. Sets `revoked_at` and nulls `oauth`. Samples already ingested stay; they are observations, not credentials.

### `POST /api/jobs/oura-pull` — `app/api/jobs/oura-pull/route.ts`

`Authorization: Bearer $CRON_SECRET`. Vercel cron at 06:00 user tz. For each active `oura` source: take the `job_runs` lock on
`(job, user_id, run_key = local_date)`; refresh the access token when it expires within 5 minutes; request the previous two local
days from `daily_sleep`, `daily_readiness` and `daily_activity`; map to samples; upsert through the §3.5 correction statement. A
re-run of the same day changes no row.

```ts
export type OuraPullResponse = { users: number; sources: number;
  results: Array<{ user_id: string; inserted: number; updated: number; skipped: number; error?: string }> };
```

### `GET /api/health/daily` — `app/api/health/daily/route.ts`

JWT, RLS path (§2.1). `?from=YYYY-MM-DD&to=YYYY-MM-DD`, max 90 days. Reads through
`lib/server/health-daily.ts` (above), not the plain `daily_health` view, so every returned row already
carries the §3.5 interval-union and source-preference merge.

```ts
export type DailyHealthRow = { local_date: string; steps: number | null; active_kcal: number | null;
  sleep_minutes: number | null; body_mass_kg: number | null; sources: string[] };
export type DailyHealthResponse = { days: DailyHealthRow[];
  sources: Array<{ id: string; kind: string; device_label: string | null;
                   last_received_at: string | null; revoked: boolean }> };
```

`null` means no observation for that day. It is never filled in.

### `POST /api/health/tokens` and `DELETE /api/health/tokens/[id]`

JWT. Issue and revoke a source ingest token. The plaintext token is returned exactly once on issue and never stored.

### MCP — `app/api/mcp/route.ts` (edit)

Add one read-only tool, `get_body_data({ from, to })`, returning `DailyHealthRow[]`. It runs on the privileged boundary, requires
the `read` scope, and filters on the token's `user_id`. Like `/api/health/daily`, it reads through `lib/server/health-daily.ts` for
the merged rows, never the raw `daily_health` view. No write tool is added in this phase.

## 6. Client changes

**New screen** `app/body/page.tsx` — the observation dashboard. Four metric cards (Weight, Sleep, Steps, Active energy), each with
the latest value, the seven-day sparkline, and the count of days with data out of the window. Below them, a Sources block: one row
per `health_sources` row with kind, device label, and "last received 4 h ago" or "never". A day with no observation renders a gap in
the sparkline and an em dash in the value, never a zero and never an interpolated point.

Components: `components/BodyDashboard.tsx`, `components/HealthMetricCard.tsx`, `components/Sparkline.tsx` (pure SVG, no library),
`components/HealthSourcesSheet.tsx` (issue token, copy once, revoke, Connect Oura / Disconnect).

**Entry point.** Settings gains a "Body data" row linking to `/body`; the Today header gains a weight chip that links there once a
`body_mass` sample exists. The tab bar stays at four tabs — a fifth tab is a design decision for Devin (§11).

**Offline.** Health data is server-owned and read-only on the client: pulled by the §3.7 cursor into an IndexedDB read model
(`health_daily`), never queued in the outbox, never merged — there is no client write to conflict. Offline, the dashboard renders
cached rows with a "last synced <time>" line. Issue token, revoke and Connect Oura are online-only and disabled with a plain reason,
because each needs a round trip that cannot be replayed safely.

## 7. Engines and logic

Pure functions, unit-testable without a database or network.

```ts
// lib/health/units.ts
export function toCanonical(type: SampleType, value: number, unit: string): { value: number; unit: string };
export function canonicalUnit(type: SampleType): string;   // kg | count | kcal | min | bpm | ms

// lib/health/dedupe.ts — must produce byte-identical output to the generated column in §3.5
export function dedupeKey(s: { vendor_sample_id?: string; type: string;
                               start_time: string; end_time: string }): string;

// lib/health/intervals.ts
export type Interval = { start: number; end: number; value: number; preferred: boolean };
export function unionNonOverlapping(intervals: Interval[]): number;   // §3.5 steps and active energy

// lib/health/normalize.ts
export function normalizeHealthAutoExport(payload: unknown, tz: string): NormalizeResult;
export function normalizeShortcut(payload: unknown, tz: string): NormalizeResult;
export type NormalizeResult = { samples: NormalizedSample[]; rejected: Array<{ index: number; reason: string }> };

// lib/health/replay.ts
export function withinReplayWindow(sentAt: string, now: Date, windowMs = 600_000): boolean;

// lib/health/daily.ts — the same rules the dashboard and Phase 6 read
export function rollUpDay(samples: NormalizedSample[], tz: string): DailyHealthRow;
export function localDateOf(iso: string, tz: string): string;

// lib/oura/map.ts
export function ouraSleepToSamples(doc: unknown): NormalizedSample[];
export function ouraActivityToSamples(doc: unknown): NormalizedSample[];
export function ouraReadinessToSamples(doc: unknown): NormalizedSample[];
```

Impure, server-only: `lib/oura/client.ts` (fetch with retry and backoff, 401 triggers one refresh then one retry),
`lib/server/crypto.ts` (`sealOauth`, `openOauth`), `lib/server/health-tokens.ts` (`issueSourceToken`, `hashToken`,
`resolveSourceByToken`). `scripts/issue-health-token.ts` is the CLI path for the same issue flow when the UI is not available.

The phone recipe is `docs/health-auto-export.md`: the HAE automation (REST API export, POST, JSON, daily at 06:30 local, the four
metric types, `Authorization: Bearer <token>`), plus the hand-built Shortcut fallback if Devin chooses that instead.

## 8. Security

Rows this phase adds to the §5 endpoint matrix. Nothing here restates §2.2 — the five boundary rules apply verbatim.

| Route | Identity | Body limit | Rate limit | Idempotency | Notes |
|---|---|---|---|---|---|
| `/api/health/ingest` | per-source token (hash in `health_sources`), revocable | 2 MB | 30/hour/source | `payload_hash` + `dedupe_key` | privileged boundary (§2.2); 10-minute timestamp replay window |
| `/api/health/oura/start` | Supabase JWT | 1 KB | 10/hour/user | — | `state` hash stored, 10-minute expiry |
| `/api/health/oura/callback` | OAuth2 `state`, confidential client | — | 20/hour/IP | `state` consumed once | tokens sealed before storage; refresh rotates in one transaction |
| `/api/health/oura/disconnect`, `/api/health/tokens*` | JWT | 1 KB | 20/hour/user | — | plaintext token shown once, never stored |
| `/api/jobs/oura-pull` | `Authorization: Bearer $CRON_SECRET` | — | — | `job_runs` lock per user and local date | Vercel cron |
| `/api/health/daily` | JWT | — | 60/min/user | — | RLS path (§2.1); `daily_health` is `security_invoker` |
| MCP `get_body_data` | per-user token in `api_tokens`, scope `read` | 64 KB | 60/min/token | — | privileged boundary (§2.2) |

Further: `client_secret` and `HEALTH_TOKEN_KEY` exist only in server env, never in a `NEXT_PUBLIC_` name. Ingest token comparison is
constant-time on the hash. An ingest payload is untrusted input and is zod-validated before any database call; `device_label` is
stored as text and never interpolated into SQL or rendered as HTML. `/api/health/oura/callback` never echoes the provider's `error`
or `error_description` back to the page; it maps them to a fixed reason code.

## 9. Test plan

**Unit files to add.** `lib/health/units.test.ts` (lb → kg, unknown unit rejected); `lib/health/dedupe.test.ts` (key matches the
generated column on both branches; `vendor_sample_id` wins when present); `lib/health/intervals.test.ts` (overlapping Watch and phone
step ranges, preferred wins; adjacent intervals do not double-count; empty input is 0); `lib/health/normalize.test.ts` (an HAE
fixture, a Shortcut fixture, one malformed sample lands in `rejected` and the rest still normalize); `lib/health/replay.test.ts`;
`lib/health/daily.test.ts` (a 23:30 sample lands on the right local date; a DST-change day rolls up once; a day with no weigh-in
yields `null`, not 0); `lib/oura/map.test.ts` (fixture per endpoint; one sleep session maps to one `sleep_asleep` sample);
`lib/server/crypto.test.ts` (seal/open round trip; a tampered ciphertext throws).

**Integration cases** (against a branch database, per §9 of the architecture). Same payload twice → second returns
`status:"duplicate"` and inserts nothing. A corrected sample with a newer `vendor_updated_at` updates; with an older one it is
skipped. A revoked token returns 401 and writes nothing. Source A's token cannot read or write source B's user rows — the cross-user
denial test from §9, extended to every route and the MCP tool. `sent_at` 30 minutes old returns 409. A 3 MB body returns 413. The
31st ingest in an hour returns 429. OAuth: unknown state, replayed state, and expired state each 400 and write nothing; a successful
callback stores a sealed token that `openOauth` round-trips. `oura-pull` run twice for the same day produces an identical row set
(compare a hash of `health_samples` for the window before and after). `daily_health` is `security_invoker` (the §9 view test, with
this view added to its list).

**Manual gate (Devin, on the phone).** Install the `docs/health-auto-export.md` recipe with a freshly issued token. Wear the ring and
carry the phone for seven days. Then: open `/body` and confirm steps, active energy, sleep and weight are present for all seven days;
confirm the weight on the app matches the scale reading that morning; trigger `oura-pull` a second time by hand and confirm the row
hash is unchanged; revoke the token in Settings and confirm the next HAE run fails with 401 and the screen shows the source as
revoked.

## 10. Acceptance criteria

1. A valid HAE payload posted with a live source token returns 200 and inserts one `ingest_events` row and one `health_samples` row
   per accepted sample.
2. Posting that identical payload again returns `status:"duplicate"`, `accepted: 0`, and leaves `health_samples` byte-identical.
3. A payload whose `sent_at` is more than 10 minutes from server time returns 409 and writes nothing.
4. A payload bearing a revoked or unknown token returns 401 before any database read of user data.
5. A payload carrying samples for two different types where one sample is malformed applies the valid samples and lists the
   malformed one in `rejected`.
6. `daily_health` reports steps, active energy, sleep and weight for each of seven consecutive local dates after the manual gate,
   with `null` only where no sample exists.
7. A second `oura-pull` for the same local date changes no row in `health_samples` (verified by a content hash over the window).
8. An Oura access token that has expired is refreshed inside the job, the refresh token is rotated, and the old refresh token is no
   longer present in the row.
9. No plaintext Oura token, and no plaintext ingest token, is readable in any table column.
10. A second user's JWT cannot read another user's `health_samples`, `health_sources`, `ingest_events`, `job_runs` or `daily_health`
    row, and an MCP token scoped to user A returns nothing for user B through `get_body_data`.
11. `/body` renders from cache with a "last synced" line when the device is offline, and shows a gap rather than a zero for a day
    with no observation.
12. `pnpm test`, `pnpm lint` and `pnpm build` pass, and the Phase 5 unit files above exist and are green.

## 11. Rollout and rollback

Rollout: migrations `0050` then `0051` to the Supabase branch first, verified by the integration cases, then to production. Ship the
routes behind `HEALTH_INGEST_ENABLED`; the dashboard renders an empty state until a source exists, so it is safe to deploy before
setup. Register the Vercel cron for `/api/jobs/oura-pull` only after one successful manual run. Issue the HAE token, install the
recipe, then connect Oura — one source at a time, so a failure names itself.

Rollback: set `HEALTH_INGEST_ENABLED=false` (ingest returns 503, the job no-ops, the dashboard hides). Revoke every
`health_sources` row rather than deleting it, so ingested samples keep their foreign key. The migrations are additive apart from
`health_samples_type_ck`; the down migration drops that constraint, the two indexes, the view and the two new tables, and leaves
sample data in place. Ingested observations are never deleted on rollback — seven days of a person's life cannot be re-collected.

## 12. Open questions

1. **Does Phase 0 actually ship the §3.5 tables?** This spec assumes yes. If not, the first migration grows by the three `create
   table` blocks. Confirm before writing `0050`.
2. **Health Auto Export or a hand-built Shortcut** — architecture §10 leaves this to Devin at this phase; the recipe doc covers both,
   but only one gets the manual gate. **Closed 2026-09-12: ruling 3** in `docs/decisions/2026-09-12-wave4-rulings.md` — Health Auto
   Export is the chosen, gated path; the Shortcut stays a documented fallback only.
3. **Oura PKCE canary** (§5.2). Run it during this phase and record the result in `docs/architecture.md` §5.2. The flow does not
   depend on it either way. **Closed 2026-09-12: ruling 2** — the canary is closed without a live run: Oura documents only the
   client-secret and implicit flows, so PKCE is not added.
4. **Oura membership and ring generation.** A Gen3-or-later ring with an active membership is required. Confirm before the OAuth app
   is registered, or the callback succeeds and every pull returns empty. **Closed 2026-09-12: ruling 2** — no app is registered in
   this wave; confirming the ring/membership and registering the app stay an owner step.
5. **Fifth tab or not.** **Resolved:** Body shipped as its own dock tab (`components/dock/TabCapsule.tsx:18-22`).
6. **Sleep granularity.** One `sleep_asleep` total per night is stored; Oura's stage breakdown is not. Decide now if Phase 7's coach
   will want it, because backfill is limited.
7. **`HEALTH_TOKEN_KEY` rotation.** No procedure is specified. Either write the re-seal script before the key reaches production, or
   accept a one-time reconnect when it changes.
8. **Weight unit shown to her.** Storage is kilograms; `targets.md` and the PRD share summary use pounds. The dashboard should show
   pounds. Confirm.

## Reference implementation
fud-ai (MIT): HealthKit / Health Connect samples are tagged with the app's own entry UUID and used to rebuild the local log after a reinstall — adopt beside our dedupe key (`lib/health/dedupe.ts`); its App Intents phrase design informs the iOS Shortcuts webhook payload. Full review with file paths and excerpts: `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`. Any ported code carries the MIT attribution line in `NOTICE.md`.
