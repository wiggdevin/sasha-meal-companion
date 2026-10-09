# Meal Companion — Architecture v2.1 (2026-09-10)

Status: **APPROVED WITH CHANGES applied.** Supersedes v2. Self-contained: an implementer needs only this file and the sources below.

| Reference | Location |
|---|---|
| Code base | This repository |
| Numbers authority | The sibling analysis targets document |
| PRD | The retained 2026-09-07 Meal Companion PRD |
| Audit of v1 | The retained 2026-09-10 GPT-5.6 v1 audit |
| Audit triage | The retained 2026-09-10 audit triage |
| Audit of v2 (answered here) | The retained 2026-09-10 GPT-5.6 v2 audit |
| Research B (adaptive TDEE) | The retained adaptive-TDEE research note |
| Architecture v2 (superseded) | The retained 2026-09-10 v2 architecture note |

Stack: Next.js 16.3.4, React 19, TypeScript, Tailwind 4, pnpm 11.25.0, Node 22, vitest 5, Vercel and Supabase.

## 0. Decisions (the reviewer, 2026-09-10)

| # | Question | Decision |
|---|---|---|
| 1 | Single- or multi-user | **Multi-user.** Supabase Auth from Phase 0. |
| 2 | Adaptive TDEE | **Advisory.** Burn-in, then weekly proposals approved with one tap. Never automatic. |
| 3 | Data leaving the app | **All needed data may go** to Google Gemini, under the §6 contract. **Nous Portal is rejected** (T4, 2026-09-12); its code was removed on 2026-10-01. |
| 4 | Health integrations now | **iOS Shortcuts / Health Auto Export + Oura Ring.** Deferred: Expo/HealthKit, Withings, Garmin, Google Health, Health Connect. |
| 5 | Offline-first across devices + MCP | **Yes, entity-level**, compare-and-swap (§3.7). |

Unchanged from v1: extend the existing app (no fork); USDA FDC bulk + Open Food Facts cache-on-miss; "LLM proposes → database grounds → user
confirms"; `zxing-wasm` for barcodes. Gemini is the only model provider the app calls (plus TypeSafe Jev for judgments): Nous Portal is rejected (T4, §6) and its code was removed on 2026-10-01.

## 1. Requirement → phase matrix

`Disposition` is the plan of record, not current product state. Nothing here exists yet.

| Brief item | Phase | Disposition |
|---|---|---|
| Food-database search with real USDA values | 1–2 | planned |
| Calories, macros, fiber, micronutrients | 2 | planned (micros informational, §3.1) |
| Water tracking; favorites (foods, recipes, meals); barcode scanner | 3 | planned |
| AI logging by typed description / voice / label scan / plate photo | 4a–4d | planned |
| Exportable meal, progress and exercise data | 0 (backup) + 2 (CSV) | planned |
| Apple Watch / Health (steps, energy, sleep, weight); scale weight via Apple Health | 5 | planned via Shortcuts / Health Auto Export |
| Oura ring (sleep, readiness, activity) | 5 | planned via Oura OAuth2 (§5.2) |
| TDEE like Carbon / MacroFactor | 6 | planned as an advisory energy-balance estimator |
| Macro goals by grams or % | 6 | planned (`mode`, §3.4) |
| AI nutrition coach | 7 | planned |
| Withings direct; Garmin; Health Connect; Expo/HealthKit shell | 8 | deferred (scale model unconfirmed; Garmin program on hold; the last two need a native shell) |
| Fitbit / Google Health | — | rejected (API retires 2026-09-30) |

## 2. Identity, tenancy and authority

Three access paths reach user data. Each has its own boundary. Only the first claims row-level security.

### 2.1 Browser path — RLS enforced

**Supabase Auth**, email OTP / magic link. Each user signs in once and the session lives in the PWA cookie store.
Every route handler builds a **request-local** client: `createServerClient` from `@supabase/ssr`, with the
**publishable key** and the caller's cookie-backed session. It is never cached in a module-level variable, because a cached client leaks one
user's JWT into another user's request. Identity is verified with **`getClaims()`** (or `getUser()`), never `getSession()` alone:
`getSession()` returns whatever the cookie holds and does not prove validity. `user_id` is always `auth.uid()`; the request body never
supplies it. Every user table has RLS enabled with `using (user_id = auth.uid())` and, for writes, `with check (user_id = auth.uid())`.

**Every view is created `with (security_invoker = true)`** and granted to `authenticated`. A Postgres view runs as its owner by default,
bypassing the RLS of its base tables. This binds `daily_totals`, `weigh_ins`, `daily_health`, and every later view.

```sql
alter table log_entries enable row level security;
create policy log_entries_rw on log_entries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create view weigh_ins with (security_invoker = true) as
  select user_id, id, start_time, (start_time at time zone tz)::date as local_date, value, unit
    from health_samples where type = 'body_mass';
grant select on weigh_ins to authenticated;
```

### 2.2 Privileged server boundary — RLS not claimed

MCP personal access tokens and health ingest tokens are opaque strings, not Supabase JWTs. They cannot produce `auth.uid()`, so calling them
RLS-scoped would be false. They run inside a **privileged server boundary**, and Phase 0 does not ship without all five rules:

1. The handler hashes the token (SHA-256) and looks it up in `api_tokens` or `health_sources`. A miss, revoked, or expired row returns 401
   before any data access.
2. The row yields exactly one `user_id` — the only tenant the request may touch, held in a request-scoped variable.
3. Every database call goes through a **user-scoped RPC** (a `security definer` function whose first argument is `p_user_id` and which
   filters on it) or an explicit `.eq('user_id', tokenUserId)`. `lib/server/privileged.ts` exports the only wrapper allowed to hold the
   service-role key and refuses a call without a `user_id`; a query with neither is a review-blocking defect.
4. The service-role key lives in one module (`lib/server/admin.ts`), used by this boundary, the import worker and cron jobs, and nothing else.
5. `api_tokens.scopes` narrows further (`read`, `log:write`); a missing scope is 403.

```sql
create table api_tokens (id uuid primary key default gen_random_uuid(), label text not null,
  user_id uuid not null references auth.users(id) on delete cascade, expires_at timestamptz,
  token_hash bytea not null unique, scopes text[] not null default '{read}', revoked_at timestamptz,
  created_at timestamptz not null default now(), last_used_at timestamptz);
```

### 2.3 Retired singleton path

The unowned `foods`, `days`, `settings` JSON tables and `/api/sync` route are retired. All active
sync uses account-owned v2 entities, a per-user change feed and RLS. Migration
`20261026090200_retire_legacy_store` removes the empty tables in the same release as the route.

## 3. Data model

Two namespaces: **`catalog_*`** (shared, read-only to users, written by two workers: the import worker for the food tables and `scripts/load-synonyms.ts` for `catalog_synonyms`) and user tables (RLS by `user_id`). DDL is executable PostgreSQL 17; extensions `pg_trgm`, `unaccent`, `pgcrypto`.

### 3.1 Catalog — stable identity, mutable revisions

A food's identity is `(source, source_id)` and never changes. Everything an import can alter lives on a revision. An import activates
revisions; it never replaces a food row, so user references never dangle.

```sql
create table catalog_versions (id bigserial primary key, source text not null check (source
    in ('fdc_foundation','fdc_sr_legacy','fdc_fndds','fdc_branded','off')),
  version_label text not null, imported_at timestamptz not null default now(),
  row_counts jsonb not null default '{}'::jsonb, is_active boolean not null default false,
  unique (source, version_label));
create table catalog_foods (id bigserial primary key, source text not null, source_id text not null,
  first_seen_at timestamptz not null default now(), unique (source, source_id));
create table catalog_food_revisions (id bigserial primary key, description text not null, brand text,
  catalog_food_id bigint not null references catalog_foods(id), category text,
  catalog_version_id bigint not null references catalog_versions(id),
  prep_state text check (prep_state in ('raw','cooked','boiled','roasted','fried','grilled',
    'canned','dried')),
  quality_class text not null check (quality_class in ('analytical','survey','label','crowd')),
  quality_flags text[] not null default '{}', search_doc tsvector, content_hash text not null,
  valid_from timestamptz not null default now(), valid_to timestamptz,
  is_active boolean not null default false, unique (catalog_food_id, catalog_version_id));
create unique index catalog_food_revisions_one_active
  on catalog_food_revisions (catalog_food_id) where is_active;
create index catalog_food_revisions_fts on catalog_food_revisions using gin (search_doc);
create index catalog_food_revisions_trgm on catalog_food_revisions using gin (description gin_trgm_ops);
create table catalog_nutrients (code text primary key, fdc_nutrient_id integer, name text not null,
  unit text not null, nutrient_group text,
  derivation text not null check (derivation in ('measured','calculated','label')));
create table catalog_food_nutrients (nutrient_code text not null references catalog_nutrients(code),
  food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
  amount_per_100g numeric,        -- null = not measured; 0 = measured zero
  primary key (food_revision_id, nutrient_code));
create table catalog_barcodes (gtin14 char(14) not null check (gtin14 ~ '^[0-9]{14}$'),
  catalog_food_id bigint not null references catalog_foods(id), source text not null,
  published_at timestamptz, primary key (gtin14, catalog_food_id, source));
```

Three further catalog tables take the same shape, keyed to `food_revision_id` with `on delete cascade`: `catalog_portions(id,
food_revision_id, description, gram_weight > 0, seq, is_default)`; `catalog_ingredients(food_revision_id, seq, name, allergen_tags text[],
raw_text)`, primary key `(food_revision_id, seq)`; and the version-independent `catalog_dri(id, nutrient_code, authority, ref_type ∈
RDA|AI|UL|EAR, sex, age_min, age_max, life_stage, value, unit, effective_date)`, which feeds the informational micronutrient display.

**Energy.** Source-reported kcal (`energy_kcal`) and computed Atwater (`energy_kcal_calc`) are separate nutrient codes. The computed value
uses 4/4/9 for protein, available carbohydrate and fat, plus 7 kcal/g alcohol, 2.4 kcal/g sugar alcohols and 3 kcal/g organic acids **when
the source reports them**; when it does not, the revision carries `atwater_incomplete` and is excluded from the mismatch check. Carbohydrate
means available carbohydrate (total minus fiber) where fiber is reported, otherwise total, flagged `carb_basis_total`. Compare values
rounded to 1 kcal per 100 g; a difference above 10 % adds `energy_mismatch`, which ranks the revision down in §4.1 but never hides it.
**Import scope (Phase 1):** Foundation + SR Legacy + FNDDS bulk; Branded and Open Food Facts are cache-on-miss rows with `version_label` =
fetch date; GTIN is normalised to GTIN-14 with check-digit validation. OFF data is ODbL: rows carry `source = 'off'`, the food detail screen
shows "Data from Open Food Facts (ODbL)", and any export of OFF-derived rows carries the same notice.

### 3.2 User food layer and the food registry

`log_items`, `recipe_items` and favorites need one foreign key that can point at either a catalog food or one of the user's own. A polymorphic
`(kind, id)` pair cannot carry a foreign key, so a UUID registry row stands in for both. A registry row is created on demand by
`get_or_create_food_ref(kind, id)` and is never deleted while a log references it; catalog registry rows are shared and carry no `user_id`,
user rows inherit their tenant from `user_foods`.

```sql
create table user_foods (id uuid primary key default gen_random_uuid(), name text not null, brand text,
  user_id uuid not null references auth.users(id) on delete cascade, ingredients_text text,
  catalog_food_id bigint references catalog_foods(id), rev integer not null default 1,
  kind text not null check (kind in ('custom','label_scan','recipe')), deleted_at timestamptz,
  per_100g jsonb not null default '{}'::jsonb,      -- {nutrient_code: amount|null}
  allergen_tags text[] not null default '{}', created_at timestamptz not null default now());
create table food_refs (id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('catalog','user')),
  catalog_food_id bigint references catalog_foods(id),
  user_food_id uuid references user_foods(id) on delete cascade,
  constraint food_refs_exactly_one check (
    (kind = 'catalog' and catalog_food_id is not null and user_food_id    is null) or
    (kind = 'user'    and user_food_id    is not null and catalog_food_id is null)));
create unique index food_refs_catalog_uniq on food_refs (catalog_food_id)
  where catalog_food_id is not null;
create unique index food_refs_user_uniq on food_refs (user_food_id) where user_food_id is not null;
create table user_food_prefs (user_id uuid not null references auth.users(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id), note text,   -- "hurt on 9/12"; never deleted
  status text not null check (status in ('eats','avoid')),
  role text check (role in ('protein','carb','fat')), no_cook boolean not null default false,
  rev integer not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id, food_ref_id));
create table recipe_items (seq integer not null, qty numeric not null, unit text not null,
  recipe_revision_id uuid not null references recipe_revisions(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id), grams numeric not null check (grams >= 0),
  food_revision_id bigint references catalog_food_revisions(id),
  state text not null default 'raw' check (state in ('raw','cooked')),
  primary key (recipe_revision_id, seq));
create table favorites_meal_items (seq integer not null,     -- typed, not jsonb
  meal_id uuid not null references favorites_meals(id) on delete cascade,
  food_ref_id uuid not null references food_refs(id),
  grams numeric not null check (grams > 0), primary key (meal_id, seq));
```

The owners of those two item tables are plain RLS tables, declared before them: `recipes(id uuid, user_id, name, rev, servings > 0,
yield_grams, deleted_at)`; `recipe_revisions(id uuid, recipe_id, rev, created_at, nutrients_per_serving jsonb)` with `unique (recipe_id,
rev)`, holding the nutrient calculation frozen at save time; `favorites_foods(user_id, food_ref_id, sort)` and `favorites_recipes(user_id,
recipe_id, sort)`, each with a composite primary key; and `favorites_meals(id uuid, user_id, name, rev, sort)`. Every `food_ref_id` and
`recipe_id` above is a real foreign key, and every `user_id` column carries the §2.1 policy pair.

### 3.3 Logging

```sql
create table log_entries (id uuid primary key,        -- client-generated
  user_id uuid not null references auth.users(id) on delete cascade, note text, media_ref text,
  eaten_at timestamptz not null, tz text not null, local_date date not null, slot text not null,
  method text not null check (method in ('search','barcode','label','photo','voice','text','plan')),
  rev integer not null default 1, deleted_at timestamptz);
create index log_entries_day on log_entries (user_id, local_date);
create table log_items (id uuid primary key, seq integer not null, qty numeric not null,
  entry_id uuid not null references log_entries(id) on delete cascade, unit text not null,
  food_ref_id uuid not null references food_refs(id), snapshot jsonb not null,
  food_revision_id bigint references catalog_food_revisions(id), was_edited boolean not null default false,
  portion_id bigint references catalog_portions(id), grams numeric not null check (grams >= 0),
  confidence numeric check (confidence between 0 and 1), unique (entry_id, seq));
create table water_log (user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null, cups integer not null default 0 check (cups >= 0),
  rev integer not null default 1, primary key (user_id, local_date));
```

`snapshot` is `{nutrient_code: {amount, unit, basis:'per_100g', source, source_version, revision_id}}`; `amount: null` means not measured,
`0` means a measured zero. The server computes it in `compute_item_snapshot(food_ref_id, grams)`, the client computes the same value from
its cached catalog row for offline display, and the server value wins on sync. Views (all `security_invoker`): `weigh_ins` over
`health_samples` where `type = 'body_mass'`, the single source of truth for weight; `daily_totals` per user and `local_date`, summing each
nutrient and reporting coverage (items with a value ÷ all items) so a partial day never reads as a complete one.

**Local-first commit (T0, 2026-09-17; `lib/log-commit-client.ts` sends, `lib/log-commit-settle.ts` settles).** `commitLogEntry` marks the entry pending and writes it into the IndexedDB mirror, built from the
request, **before** it posts — for every commit, not only one a caller opted into; it dispatches `meal-companion:log-queued` so Today repaints at
once. An unacknowledged row carries `rev: null` on purpose: `lib/log-note-client.ts` and the coach's undo both take their `base_rev` from
this row and already refuse one whose `rev` is not a number, so an entry the server has not answered for cannot be the base of an edit. The
caller's optional `optimistic` argument adds the Today card and nothing else — and every surface that commits passes one: the log sheet's
food and meal saves, the capture confirm, and the scan confirm (`lib/log/catalog-card.ts` builds the card for a single catalog food, so a scan
and a search pick put up the same thing).

The reply reconciles. When it carries items, it carries the truth — `ok()` reads them back out of `log_items`, so they belong to the
revision printed beside them — and the mirror stores **the server's items verbatim** with that revision. It does not merge them with the
request's own fields: an answer can name our item id for a food another device put there, and the merged row would be one the server never
held (our `food_ref_id`, their `rev`), which the next offline note edit would send back as fact. When the reply carries no items it cannot
vouch for ours, so ours stay exactly as written and take no revision: the row waits, unacknowledged, for the authoritative RLS read, which
is still preferred anyway, because it is the row itself.

`ok()` returns the stored items WHOLE — `id`, `entry_id`, `seq`, `food_ref_id`, `qty`, `unit`, `grams`, `portion_id`,
`food_revision_id`, `was_edited`, `confidence`, `snapshot` — precisely so the verbatim mirror is a row something can edit. A revision beside
items that name no food is not an edit base: a note edit built from one POSTs items the server calls invalid, and the refusal then rolls
back an entry the server still holds. `isCompleteItem` / `isCompleteEntryRow` (`lib/log/entry-row.ts`) ask that question in one place: the
note path and the coach's undo ask it before taking a row's `rev`, and the mirror asks it of a reply's own items before storing the revision
beside them. An answer whose items are too thin — an older deploy, a body a proxy trimmed — is treated exactly like an answer with no items:
ours stay, no revision goes on them, and the authoritative read settles the row.

**The pending record is a claim about the MIRROR, not about the POST**, and it is a durable, account-owned, three-state record in the `meta`
store of the outbox's own database (`lib/log/pending.ts`, shared by the commit path and the drain so neither imports the other) — the shape
the parked weigh-ins already use. `in_flight` is a commit still posting, which nothing but that commit may touch; `needs_reconcile` is an
entry the server has taken whose row is not on this phone yet, and is the only state the retry looks at. The record clears when the mirror
holds a row something can edit — complete items, and a revision — so a 2xx whose entry could not be read back stays marked, Today keeps the
pending treatment, and `retryPendingReconciles` (`lib/log/reconcile.ts`) reads it again after the next successful sync
(`lib/sync/post-sync.ts`). That retry posts nothing: the server already has these entries.

**The drain's stand-off is a different question, and a different answer.** A log-entry op is queued BEFORE the POST, so a drain can land while
`/api/log/commit` is still open and settle the same entry from the other side. The drain therefore skips an entry whose commit is posting
**right now, in any tab**: `lib/log/live-commits.ts` holds a Web Lock named for the entry for the life of the request, and the drain asks for
that name with `ifAvailable`.

The commit asks the same way, and awaits the answer BEFORE it writes or posts anything — a plain request QUEUES, and a commit that did not wait
posted while another tab was posting the same entry and was then granted a lock it held until the tab died. The ask is bounded at a second, and so is **every** Web Lock on the way to a save
(`lib/log/web-lock.ts` owns the budget; the pending records' own lock goes through it too). The card is budgeted at 100 ms from the tap, and a
browser whose lock service does not answer must not mean a Save that draws nothing — or, worse, one that draws the card and then never
enqueues or posts behind it. On a timeout the caller warns once, carries on without the lock, and releases a grant that turns up late; a
service that fails to answer is remembered as wedged for a few seconds, so one wedged manager cannot cost a second per record write — and that
memory covers only the records lock, which is taken on every write. The commit lock is asked EVERY time, and its `ifAvailable` answer of `null`
always means another tab owns that entry: a tab that skips the question is a tab believing it owns what it does not, which is two tabs
committing one meal. The records lock, by contrast, is a QUEUED request — `null` there would mean another document holds it, and carrying on
would be two tabs writing over each other's records. Not available means another tab owns the entry, so this one writes nothing,
queues nothing and returns `owned_elsewhere` — never `queued`, which would tell the sheet this tab had it in hand — and the sheet says
"Another tab is saving this. It will show after sync."  Within a tab the claim is synchronous, so a second tap JOINS
the first commit rather than running beside it, and the card's retry control does nothing while a commit for that entry is live. Every
optimistic mirror row carries the id of the attempt that wrote it, and a refusal or a failed queue may only take back the row IT wrote: a row
another attempt landed, or one a read-back replaced it with, is the server's own. That id — and any key prefixed `_` — is the client's own
bookkeeping and never a column: `serverFields` (`lib/log/entry-row.ts`) strips it the moment a row becomes the acknowledged one, and again
whenever a payload is built from a mirror row, so nothing POSTs a field `log_entries` does not have.

The durable record is NOT the lock — it says `in_flight` after a kill too, and standing off that would leave the write the user made a second before
the app died sitting in the outbox unsent. Two tabs share IndexedDB and no memory, so a module map alone would have restored the same race
across tabs; the pending records are written under a second lock (`mc-pending-records`) for the same reason. A lock dies with its tab, so
kill-recovery needs no timeout: a killed-mid-post entry drains on the next launch, and if its POST had in fact landed the server answers
`duplicate` and the reconcile settles it.

**On a browser with no Web Locks API the cross-tab stand-off does not exist at all** — the in-process map is the whole of it, which covers this
tab and nothing else. That is accepted rather than worked around: no browser this app targets lacks the API (Safari has had it since 15.4), and
the fallback keeps every single-tab guarantee.

A record that says `in_flight` while no live commit holds it belongs to a page that is gone, and every catch-up promotes those first: cleared
when the mirror holds a row something can edit AND that row is past the revision this commit was based on (a create counts on any revision) —
otherwise moved to `needs_reconcile` with its attempts intact. The `baseRev` on the record is what makes that distinction — taken from the request, the
only place that cannot lie about it, with 0 for a create: an edit whose mirror write never happened leaves the PREVIOUS commit's row sitting
there, and clearing on that would call a write settled that never went. The same rule governs the read-back: a row whose revision is not past
`baseRev` is a lagging replica answering about the write BEFORE this one, so it confirms nothing, replaces nothing and keeps the request the user
may still have to send again. Without that they were
black holes — the retry takes only `needs_reconcile`, so Today drew the pending dot for ever and the user logged the meal a second time. Both the card and the mirror row move **forward only**, and an EQUAL revision is not backwards: a row at the revision the card already
carries can still describe the entry more fully — an item another device added, a snapshot the 2xx had not filled in. A card with no revision
of its own is judged against the mirror's, which knows what the 2xx acknowledged. A row that may move the card REPLACES its items rather than
updating them one by one: each row keeps the card's own display fields where the card knows that item, and an item it has never seen — one
another device added — is rendered from what the row carries, so Today's rings equal the sum of the server's items. The mirror refuses a row older than the one it holds, because
`lib/log-note-client.ts` takes its `base_rev` from there, and a commit's own reply may not undo a fuller patch another pass has already made.

A row that comes back with `deleted_at` is the server's LAST word: the record is retired first and
the mirror row and the card go after it, best effort, so nothing that fails there leaves a record for the next sync to read — and the commit's
own settle honours that rather than re-marking an entry whose row is meant to be absent. It is bounded, but never at the cost of the truth: a read that finds no row is replica lag or a
lapsed JWT as often as it is a deletion, so it counts as an attempt and nothing more. Attempts are spaced — the first five are every sync,
then the gap doubles from a minute — and after twenty the record goes `stale` and is not read again. What the card says then turns on ONE
other field: `confirmed`, set the moment any path sees the server take the entry — a 2xx, a drain answering `applied` or `duplicate`, a row
read back. Confirmed and capped reads "Logged. Details are still catching up." Unconfirmed and capped — a write whose queued change never
landed and whose POST never went — reads "Not saved yet. Tap to try again.", and the tap posts the request the record kept for exactly this.
The kept requests are bounded (fifty, each at most the route's 8 KB; the oldest request is dropped with one warning while its record stays),
a delete the user makes themself is the last word on the entry (`lib/log/delete-entry.ts`): it drops the write queued before the POST so the drain
cannot create the meal again, deletes the mirror row so the next pull cannot re-render it, and puts the record into the `deleted` state —
durable, account-owned, written under the records lock. Every settle path reads that state before it draws, queues or re-queues anything: a
retryable answer does NOT write the create back into the outbox, no card is drawn, no row is mirrored, and any answer that proves the server
has the entry (a 2xx of any shape, a conflict, a drain's `applied` or `duplicate`) leaves the server delete owing. `finishDelete` ALWAYS reads the server — what this phone
managed to hear about the write decides nothing, because `confirmed` is false for an in-flight create — and queues the delete at the revision
that read names, never at a null one and never at one the server has passed. The record is retired only once that queue write has landed, and
a read it cannot make (or a queue write it cannot do) leaves the record `deleted` for the next successful sync's catch-up. A delete recorded in another
tab, or before a kill, is honoured for the same reason: the state is on disk, not in a heap. And a delete the server REFUSES because it has
moved on is re-aimed rather than merged — merging it wrote the server's row back into the mirror and re-queued the op carrying it, which is
the user's delete turning into the meal again; the drain's log-entry rules live together in `lib/sync/log-entry-ops.ts`. And and the retry refuses when the card is gone, when the mirror row carries
`deleted_at`, or while any commit for that entry is live. A record whose request was dropped no longer offers a retry it cannot honour: its
card reads "Not saved. Log it again." and has no tap at all.
A meal missing from the user's log is worse for this app than one logged twice, so nothing may say "Logged" over a write the server never took.
`logEntryStates()` (`lib/log/today-state.ts`) is what Today reads, and it keeps the three apart. Only a `deleted_at` row ends the matter. A record another account left on the device is dropped rather than read. Because the record is on disk,
an app killed between a 2xx and its read-back still reconciles on the next launch.

**One way to settle a log entry against the server**, `reconcileFromServer` (`lib/log-commit-settle.ts`): read the entry and its items back,
check it against the same `isCompleteEntryRow` the note path uses (with `snapshot` coalesced the way the wire coalesces it), and mirror THAT
— and bring the Today card up to it too, because a card left on the grams the user picked is what a later note save would post back as fact. The commit's own 2xx uses it, and so does the outbox — on `applied`, instead of writing `{...local, ...payload, rev}`,
which is the request's items under the server's revision; and on `duplicate`, which is what a commit whose fetch timed out after the server
had applied it drains as, and which used to drop the op and leave the mirror unacknowledged for good. A read that fails leaves the row
without a revision, which is the honest state, and the next pull settles it.

**The op is queued with the mirror, BEFORE the post.** The user taps Save and the app is killed while the request is in flight: without it there
is a card on Today, a row in the mirror and nothing anywhere that would ever send it, so the user sees a logged meal the server never got and
logs it again. The idempotent op id (`lib/log/op-id.ts`, shared with the server) is what makes writing it early safe — the same commit can
queue twice and still be one op. A 2xx drops it, every refusal drops it, and a transient failure (5xx, 401, 408, 429, or no connection)
leaves it exactly where it is, with the outbox owning the pending mark from then on — one op, and one drain clears it with no second op. **Only those answers queue.** Once the server has replied with a 2xx it holds the entry,
so nothing after that point may reach the outbox — a queued replay would be a second commit. Everything the reply triggers locally is
therefore allowed to fail: a body that is not contract-shaped, a mirror write that throws. A failure there is a `console.warn`, the mirror
row goes back to what it was, and the function still returns the server's own answer. A genuine refusal rolls the mirror back to whatever was there before, except a
`conflict`, which hands back the authoritative entity and is stored as such. The card, where there is one, is taken back out with it,
keeping the 2026-09-13 #6 ruling that a rejected commit never sits in the user's log as a phantom.

**`client_timings`** (T0, migration `20261019090100`). `{user_id, run_id, path, step, ms, at, device}` — one row per hop of one run, `ms`
always a duration. `path` and `step` are CHECK-constrained to the vocabulary `lib/timing.ts` exports. RLS: one policy, `for insert to
authenticated with check (user_id = auth.uid())`, and no select policy at all — the p50/p95 report is `scripts/timings.ts`, a service-role
script. See §4.7.

### 3.4 Targets and expenditure

```sql
create table target_profiles (id uuid primary key default gen_random_uuid(), notes text,
  user_id uuid not null references auth.users(id) on delete cascade, effective_from date not null,
  rev integer not null default 1, kcal_train integer not null, kcal_rest integer not null,
  authored_by text not null check (authored_by in ('coach','engine_proposal','user')),
  mode text not null check (mode in ('grams','percent')),
  protein_g numeric, fat_g numeric, carb_g numeric,
  protein_pct numeric, fat_pct numeric, carb_pct numeric,
  kcal_min integer not null default 1650, protein_g_min numeric not null,
  fat_g_min numeric not null default 50, carb_g_min numeric not null default 0,
  goal_rate_bp_week integer not null default 0,        -- -50 = lose 0.5 %/week
  max_weekly_kcal_step integer not null default 150,
  constraint targets_grams_complete check (mode <> 'grams'
    or (protein_g is not null and fat_g is not null and carb_g is not null)),
  constraint targets_percent_complete check (mode <> 'percent'
    or (protein_pct is not null and fat_pct is not null and carb_pct is not null
        and round(protein_pct + fat_pct + carb_pct, 2) = 100
        and protein_pct between 5 and 70 and fat_pct between 5 and 70
        and carb_pct between 5 and 70)));
create table expenditure_estimates (id uuid primary key default gen_random_uuid(), reason text,
  user_id uuid not null references auth.users(id) on delete cascade, local_date date not null,
  weight_trend_kg numeric, intake_avg_kcal numeric, intake_completeness numeric, tdee_kcal numeric,
  confidence numeric, engine_version text not null, unique (user_id, local_date),
  status text not null check (status in ('burn_in','held','estimating','blocked')));
create table target_proposals (id uuid primary key default gen_random_uuid(), proposed jsonb not null,
  user_id uuid not null references auth.users(id) on delete cascade, decided_by uuid,
  based_on_estimate_id uuid references expenditure_estimates(id), decided_at timestamptz,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')));
```

Authority order: **effective `target_profiles` revision > approved proposal > engine candidate**.
Floors and pins are fields on that effective revision. No numeric or ramp fallback is read from
source code; without a revision the account is `needs_profile`.

**Percent mode** stores `protein_pct`, `fat_pct`, `carb_pct`, summing to exactly 100 after rounding to two decimals. Conversion runs per day
type, so `kcal_train` and `kcal_rest` yield two gram sets: `grams(macro) = kcal_for_day × pct / 100 ÷ factor`, factor 4 protein, 9 fat, 4
carb. Protein and fat round to the nearest 1 g; carbs take the remainder, `(kcal_for_day − 4 × protein_g − 9 × fat_g) ÷ 4`, so the gram set
reconstructs the calorie target within ±10 kcal. Floors then apply **in grams, after conversion**: (1) `protein_g := max(protein_g,
protein_g_min)`; (2) `fat_g := max(fat_g, fat_g_min)`; (3) `carb_g := max(carb_g_min, (kcal − 4·protein_g − 9·fat_g) ÷ 4)`; (4)
`kcal_required := 4·protein_g + 9·fat_g + 4·carb_g`; (5) if `kcal_required > kcal_for_day`, **raise kcal to `kcal_required`** — never cut
protein or fat below its floor to fit a calorie number; (6) `kcal_for_day := max(kcal_for_day, kcal_min)`.

Validation rejects a percent profile when, at either `kcal_train` or `kcal_rest`, converted protein or fat falls below its floor; the error
names the minimum percentage that satisfies the floor. The UI shows the percentages the user entered and the grams they produce per day type.

### 3.5 Health

```sql
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
  -- extract(epoch …) on timestamptz is IMMUTABLE; to_char/at time zone are only STABLE and are
  -- rejected in a stored generated column.
  dedupe_key text generated always as (coalesce(vendor_sample_id,
    type || '|' || (extract(epoch from start_time))::bigint::text
         || '|' || (extract(epoch from end_time))::bigint::text)) stored);
create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);
```

The generated column is the dedupe key because `unique (…, coalesce(…))` is not valid as an inline table constraint. Both `to_char` calls
are immutable, which a generated column requires. A vendor may resend a corrected sample; the ingest handler accepts it only when it is
newer:

```sql
insert into health_samples (...) values (...)
on conflict (user_id, source_id, dedupe_key) do update
   set value = excluded.value, unit = excluded.unit, end_time = excluded.end_time,
       vendor_version = excluded.vendor_version, ingest_event_id = excluded.ingest_event_id,
       vendor_updated_at = excluded.vendor_updated_at
 where excluded.vendor_updated_at is not null and (health_samples.vendor_updated_at is null
        or excluded.vendor_updated_at > health_samples.vendor_updated_at);
```

`daily_health` (security_invoker view) applies per-metric rules: steps and active energy are the union of non-overlapping intervals,
preferring Watch-tagged samples on overlap; sleep is the Oura session when present, else Apple; `body_mass` is the latest INGEST sample of
the local day, and only when there is none, the user's manual one (T8 §2). `lib/health/daily.ts` — the roll-up every caller actually reads — applies
the same order, so the two halves of the number cannot disagree.

**Manual weigh-in.** The morning weight the user types in the FAB is a sample like any other: `type = 'body_mass'`, `unit = 'kg'`,
`start_time = end_time` at 07:00 local on the day the user named, `source_id` the user's `manual` source (created on first use), and
`vendor_sample_id = 'manual:<local_date>'` — which, through `dedupe_key`, is what makes a second number for the same day a correction rather
than a second row. `authenticated` may not write `health_samples`, so the path is the security-definer RPC `health_weigh_in(p_local_date,
p_tz, p_kg)`, scoped to `auth.uid()`, refusing a weight outside 20–400 kg, an unknown zone, and a day more than one ahead.
`POST /api/health/weigh-in` (JWT, zod, 8 KB, rate limited) converts the user's pounds and calls it with the caller's client, never the admin one.

The phone writes `weightLb` to the per-device store first, so the number is the user's offline; a POST that cannot land parks the day in the
`meta` store beside the outbox and `components/SyncBootstrap.tsx` drains it after every successful sync (`lib/health/weigh-in-client.ts`) —
the same shape as T1's pref backfill. A 422 is not retried; its message is what the FAB shows the user's.

**Pill precedence.** The header pill reads the VIEWED day, and one rule decides which number it shows: an ingest sample for that day wins
over the value typed on this device, which wins over the synced copy of the user's manual sample, and with none of the three there is no pill.
The middle step outranks the last because the synced manual sample IS a copy of something typed, and the copy can never be newer than the
original — the phone writes locally before it posts. `lib/health/daily.ts` holds the rule (`pillWeightLb`) and tells the two apart through
the `body_mass` provenance `/api/health/daily` already puts on the wire.

### 3.6 Constraints and coach

`coach_threads(id, user_id, title, created_at)`, `coach_messages(id, thread_id, role, content, tool_calls jsonb, policy_checks jsonb,
created_at)` and `ai_calls(id, user_id, purpose, provider, model_id, sdk_version, input_tokens, output_tokens, latency_ms, input_hash,
cost_estimate, created_at)` follow the same RLS pattern.

```sql
create table constraint_profiles (user_id uuid primary key references auth.users(id) on delete cascade,
  rev integer not null default 1, conditions text[] not null default '{}', notes text,
  avoid_allergens text[] not null default '{gluten,dairy,apple}',
  avoid_food_ref_ids uuid[] not null default '{}',
  banned_categories text[] not null default '{simple_sugars}');
```

### 3.7 Sync — compare-and-swap, one cursor, duplicate groups

**Client store.** IndexedDB (`idb`), mirroring the §3.2–3.6 user tables, plus an outbox: `{op_id uuid, entity, entity_id, kind ∈
create|update|delete|restore, base_rev, payload, client_ts}`. `POST /api/sync/ops` applies ops in order, idempotent on `op_id`.

`user_settings` selection and generation freeze happen in one IndexedDB transaction. The drain
samples its due-time after the preliminary outbox snapshot, so an edit that lands in that seam is
eligible when the atomic selector freezes it instead of waiting for an unrelated later sync.

**Compare-and-swap.** An op carries the `base_rev` the client last saw. When `base_rev = current_rev` the server applies it, sets `rev :=
rev + 1`, and appends to `change_log`. When `base_rev ≠ current_rev` the server **rejects** it and answers `{op_id, status:'conflict',
current_rev, entity}` carrying the **full current entity**, so the client merges without a second round trip; nothing is written and the
client never blind-retries. An unknown `entity_id` on an update answers `status:'gone'`.

**Per-entity merge rules**, applied by the client on a conflict:

| Entity | Rule |
|---|---|
| `log_entries` | Field-wise. `note` keeps both texts joined by a newline; `slot`, `eaten_at`, `local_date` take the newer `client_ts`; items merge per the row below. |
| `log_items` | Keyed by `id`. Same id on both sides → newer `client_ts` wins per field. An id on one side only is kept. |
| `user_food_prefs` | `status` and `role` take the newer `client_ts`. `note` keeps both — the user's notes are symptom evidence, and losing one loses a record. |
| `water_log` | `cups` takes the **larger** value. A cup the user drank is never un-drunk by a stale device. |
| `favorites_*`, `constraint_profiles` | Set union for membership; scalar fields take the newer `client_ts`. |
| `recipes` | Immutable revisions: a conflict creates a new `rev` on top of `current_rev`, with no field merge. |
| `target_profiles` | Never merged. Server wins; the client discards its op and shows "targets changed elsewhere". |

**Deletes dominate.** A tombstone (`deleted_at`) beats any concurrent update, whatever the revision. A stale update can never resurrect a
deleted entity; the server returns `status:'deleted'` with the tombstone. The only way back is an explicit `restore` op, raised from an undo
affordance, which clears `deleted_at` and bumps `rev`.

**One monotonic cursor per user.** A per-entity `rev` cannot order changes across rows, so pulls read an append-only log:

```sql
create table change_seq (user_id uuid primary key references auth.users(id) on delete cascade,
  next_seq bigint not null default 1);
create table change_log (user_id uuid not null references auth.users(id) on delete cascade,
  seq bigint not null, entity text not null, entity_key text not null, rev integer not null,
  op text not null check (op in ('create','update','delete','restore')), op_id uuid,
  current jsonb,          -- the row after the op (null for delete; tombstone fields for restore)
  at timestamptz not null default now(), primary key (user_id, seq));
create index change_log_entity on change_log (user_id, entity, entity_key);
create function next_change_seq(p_user_id uuid) returns bigint language sql as $$
  insert into change_seq (user_id, next_seq) values (p_user_id, 2)
    on conflict (user_id) do update set next_seq = change_seq.next_seq + 1
    returning next_seq - 1; $$;
```

**Entity keys.** `entity_key` is a text encoding of the row's primary key, not a UUID, because synced tables
have three key shapes: a UUID (`log_entries`, `recipes` → the UUID string), a date (`plan_days`, `water_log` →
`YYYY-MM-DD`), and a registry UUID (`user_food_prefs` → `food_ref_id`; it is unique across kinds). `lib/sync/keys.ts` owns the
encode/decode pair per entity and is the only place that knows the shapes. Child rows (`log_items`,
`recipe_items`) are never logged on their own; their parent entry is the sync unit and `current` carries the
children inline.

**`current` makes the feed self-sufficient.** A pull returns the row as it is after the change, so a second
device can write it straight into IndexedDB; there is no separate fetch-by-id endpoint. `next_change_seq`
inserts the counter row on first use, so a newly signed-in user's first mutation gets `seq = 1`.

`next_change_seq` runs **inside the same transaction** as the mutation. It takes a row lock on that user's counter, so numbers are
contiguous and become visible in order. A Postgres sequence is wrong here: it leaves gaps on rollback and lets a higher number commit first,
either of which makes a client skip changes. One user writes rarely enough that the row lock costs nothing. `GET
/api/sync/changes?since=<seq>&limit=500` returns rows with `seq > since` ascending plus `{next_cursor, has_more}`; the client stores
`next_cursor` only after the whole page is applied.

**Duplicate detection — groups, not pointers.** Arrival order does not establish which entry is "later", and two coffees ten minutes apart
are not duplicates. Detection keys on an event-time content fingerprint:

```
fingerprint = sha256(
  local_date || '|' || slot || '|' || floor(extract(epoch from eaten_at) / 900) || '|' ||
  ','-joined sorted( canonical_food_id || ':' || floor(grams / 5) * 5  for each item ))
```

Foods first normalise to a canonical id: a catalog food resolves to its `catalog_food_id`, and a user food derived from a catalog row
resolves to that same id, so equivalent foods grounded to different records collapse to one fingerprint. Grams floor to a 5 g bucket and the time
bucket is 15 minutes, both from event time, so the result does not depend on which device synced first.

```sql
create table duplicate_groups (id uuid primary key default gen_random_uuid(), local_date date not null,
  user_id uuid not null references auth.users(id) on delete cascade, fingerprint bytea not null,
  slot text not null, state text not null default 'open' check (state in ('open','dismissed','merged')),
  merged_into_entry_id uuid references log_entries(id), rev integer not null default 1,
  created_at timestamptz not null default now(), decided_at timestamptz, unique (user_id, fingerprint));
create table duplicate_group_members (
  group_id uuid not null references duplicate_groups(id) on delete cascade,
  entry_id uuid not null references log_entries(id) on delete cascade, primary key (group_id, entry_id));
```

Every entry stays a real entry and counts in the rings until the user acts. An open group shows one card — "Logged twice?" — with **Keep both**
(→ `dismissed`) or **Merge** (→ `merged`, the other entries tombstoned). Group state syncs like any other entity, so a decision on the phone
does not reappear on the laptop. Plan state — slot shifts and the per-slot eaten ticks in `eaten_slots` — lives in the account-owned
`plan_days` row; the single-tenant `days` jsonb table went with `/api/sync` (§2.3). Tests: two simulated clients plus MCP; concurrent add/edit/delete matrix; stale update
rejected; stale delete does not erase a newer edit; restore path; offline replay; idempotent retry; cursor continuity under interleaved writes.

## 4. Engines

### 4.1 Search and grounding

GTIN is a **separate deterministic path**, not a feature in the score. A valid GTIN-14 (check digit verified) looks up `catalog_barcodes`:
one match resolves directly, several open the confirm sheet ranked by `quality_class` then `published_at`, and none falls through to text
search using the brand and product name read off the package. Text search scores six features, each mapped explicitly to `[0,1]`, with
weights summing to 1.00, so the score is bounded in `[0,1]`:

| Feature | Weight | Mapping to [0,1] |
|---|---|---|
| `lexical` | 0.35 | `ts_rank(search_doc, tsq, 32)`. Flag 32 computes `rank/(rank+1)`, which bounds the value. Postgres documents this as cosmetic and not comparable across queries — which is why thresholds are calibrated per query class, not assumed. |
| `trigram` | 0.20 | `similarity(description, query)` from `pg_trgm`, already `[0,1]`. |
| `brand_match` | 0.15 | 1.0 exact normalised brand match; 0.6 when `similarity(brand, query_brand) ≥ 0.6`; else 0. A query with no brand token scores 0 for every row, so the term is constant and does not disturb ranking. |
| `prep_state_match` | 0.10 | 1.0 when the query prep token equals `prep_state`; 0.5 when the revision has none; 0 on conflict ("raw" against "fried"). |
| `user_prior` | 0.10 | `least(1, ln(1 + logs_90d) / ln(21))` — 20 logs or more saturates at 1. |
| `quality_class` | 0.05 | analytical 1.0, survey 0.75, label 0.5, crowd 0.25; minus 0.25 (floored at 0) when `quality_flags` holds `energy_mismatch`. |
| `eats_status` | 0.05 | eats 1.0, unknown 0.5, avoid 0.0. |

```sql
with q as (select websearch_to_tsquery('english', unaccent($1)) as tsq, unaccent(lower($1)) as raw,
  $2::text as query_brand, $3::text as query_prep, $4::uuid as p_user_id)
select r.catalog_food_id, r.id as revision_id, r.description, r.brand, round((
    0.35 * ts_rank(r.search_doc, q.tsq, 32)
  + 0.20 * similarity(r.description, q.raw)
  + 0.15 * case when q.query_brand is null then 0
                when lower(r.brand) = lower(q.query_brand) then 1.0
                when similarity(coalesce(r.brand,''), q.query_brand) >= 0.6 then 0.6 else 0 end
  + 0.10 * case when q.query_prep is null or r.prep_state is null then 0.5
                when r.prep_state = q.query_prep then 1.0 else 0 end
  + 0.10 * least(1, ln(1 + coalesce(p.logs_90d, 0)) / ln(21))
  + 0.05 * greatest(0, case r.quality_class when 'analytical' then 1.0 when 'survey' then 0.75
                                            when 'label' then 0.5 else 0.25 end
                     - case when 'energy_mismatch' = any(r.quality_flags) then 0.25 else 0 end)
  + 0.05 * case pref.status when 'eats' then 1.0 when 'avoid' then 0.0 else 0.5 end)::numeric, 4) as score
from catalog_food_revisions r cross join q
left join food_refs fr on fr.catalog_food_id = r.catalog_food_id
left join user_food_prefs pref on pref.food_ref_id = fr.id and pref.user_id = q.p_user_id
left join lateral (select count(*) as logs_90d from log_items li
  join log_entries le on le.id = li.entry_id where le.user_id = q.p_user_id
    and li.food_ref_id = fr.id and le.local_date > current_date - 90) p on true
where r.is_active and (r.search_doc @@ q.tsq or similarity(r.description, q.raw) > 0.25)
order by score desc limit 25;
```

Auto-resolve an AI candidate only when the top score ≥ 0.80 **and** the margin to #2 ≥ 0.15. Both numbers are provisional: they are
**calibrated on the labelled set** at Phase 1, separately for branded and generic queries, and the calibrated values replace them in
`lib/search/thresholds.ts`. Otherwise the confirm sheet shows the top three and asks. Phase 1 exit gate: a labelled set of at least 60 of
Meal Companion's real queries (the user's food list plus 30 days of logs) reaching **top-1 ≥ 82 %** (superseded by R1,
`docs/decisions/2026-09-12-session-rulings.md`), **top-3 ≥ 95 %**.

### 4.2 Media, propose → confirm

Images resize client-side to 1600 px on the long edge, JPEG q 0.8 (≈ 300–600 KB); audio is ≤ 30 s AAC; EXIF is stripped before upload. `POST
/api/media/sign` returns a 60-second signed URL into the private Storage bucket `media/<user_id>/<uuid>`, and the server validates MIME,
magic bytes, and dimensions or duration. `POST /api/log/propose` **re-checks that the object path's first segment equals `auth.uid()`**
before touching it; a `media_ref` from the body is never trusted as a capability. A private Storage URL is not readable by Gemini, so the
server downloads the object itself, re-validates size and type, then sends **inline bytes** when the payload is under 4 MB (the normal case
after client resize) or uploads to the **Gemini Files API** and deletes the provider file in a `finally` block after the call returns or
fails.

The zod schema is converted to the JSON-Schema subset Gemini's structured output supports (no `oneOf`, no `$ref`, no unbounded
`additionalProperties`), asserted by a build-time test. Structured output guarantees shape, not truth, so the response is **parsed and
re-validated against the zod schema after the call**; a failure opens the confirm sheet with no items rather than saving anything. Flow:
propose → grounding (§4.1) → constraint policy (§4.4) → a **draft** returned, never saved.
**Grounding runs concurrently (T0, 2026-09-17):** `Promise.all` across the model's items, and inside an item the portions, the ingredients
and the food refs together; the order the model gave is preserved, because the results are mapped back by position. One item's grounding
failing — a catalog statement timeout, a failed RPC — does not take the propose with it: that item comes back `foodRefId: null` and
`unverified`, the answer §4.1 already gives an item it could not resolve, the failure is logged, and the other items keep the model call
they have already paid for. A five-item plate used
to cost roughly twenty serialised round trips after the model had already answered. The response carries `timings: { model, ground }` — the
two hops only the server can time — which the client files into the same `client_timings` run as its own marks (§4.7). Each draft item carries
`catalog_food_revision_id`, and commit rejects a draft whose revision is no longer active. `POST /api/log/commit` is idempotent on
`entry_id`. Our media copy is deleted on commit or after 24 h by cron; the provider copy is deleted immediately. Delivery order inside Phase
4: text → voice → label → photo, one sheet for all four.

### 4.3 Expenditure — advisory energy-balance estimator

`lib/expenditure.ts`, pure functions, versioned via `engine_version`. Not a MacroFactor clone: its filter and coefficients are unpublished
(the retained adaptive-TDEE research note). `7700 kcal/kg` is an explicit modelling approximation, not a
physical constant. **Seed:** `prior = 2130 kcal`, the user's trained maintenance working number in `targets.md`; `BMR = 1372 kcal` (Katch-McArdle
from the InBody lean mass of 46.4 kg). The absolute bounds below use this measured BMR, not a Mifflin-St Jeor estimate.

```
qualified day         = a local date whose intake completeness is 'complete'
weight_trend          = 20-day EMA (α = 2/21 ≈ 0.0952), seeded with the mean of the first 3 weigh-ins;
                        gaps ≤ 3 days interpolate linearly; longer gaps leave the trend undefined there
outlier               = |Δ| > 2.5 % of trend in one day → that weigh-in is held out
intake_avg            = mean intake over qualified days in the last 14
intake_completeness   = qualified days in the last 14 ÷ 14
weigh_in_completeness = weigh-in days in the last 14 ÷ 14
tdee_raw              = intake_avg − (trend[t] − trend[t−14]) ÷ 14 × 7700
confidence            = 0.5 × intake_completeness + 0.3 × weigh_in_completeness
                      + 0.2 × min(qualified_days ÷ 21, 1)      -- each term already in [0,1]
status:
  burn_in    until ALL of: ≥ 21 qualified days, ≥ 12 weigh-ins, ≥ 15 complete intake days, and
             trend[t] and trend[t−14] both defined
  held       when trend[t] or trend[t−14] is undefined, or qualified days in the last 7 < 5, or
             weigh-ins in the last 7 < 3
  blocked    when a proposal would need a calorie rise above max_weekly_kcal_step to satisfy a floor
             (§3.4 step 5) — the reviewer decides, the engine does not
  estimating otherwise
```

**Clamp order**, applied exactly in this sequence: (1) reject outlier weigh-ins, then build the trend; (2) hold if either trend endpoint is
undefined — never extrapolate across a gap; (3) compute `tdee_raw`; (4) clamp it to `prior ± 10 %`; (5) blend, `tdee = prior + confidence ×
(clamped − prior)`; (6) clamp to `0.9 × BMR … 2.2 × BMR` = 1,235 … 3,018 kcal; (7) round to the nearest 10 kcal and store, and `prior` for
the next run is this value.

Elapsed calendar time never ends burn-in on its own: 21 days of **qualified observations** is the gate, which is how the reviewer's three-week
override is honoured. Weight trend stays hidden in the UI until status leaves `burn_in`. The weekly proposal runs Sunday 21:00 user tz,
idempotent and locked per user and week, only when `status = 'estimating'`:

```
kcal = tdee + goal_rate_bp_week ÷ 10000 × weight_trend_kg × 7700 ÷ 7
protein unchanged (authored, held across training and rest days)
fat ≥ fat_g_min (50 g) and ≥ the authored value unless the reviewer lowers it
carbs = the remainder; then the §3.4 floor sequence runs, including the
        "raise kcal, never cut protein or fat" rule
training / rest split preserved in the same ratio;  |Δkcal| ≤ max_weekly_kcal_step (150)
kcal ≥ kcal_min (1650) and ≥ 4·protein_g_min + 9·fat_g_min
```

A proposal needs a tap from the user or the reviewer before it becomes a `target_profile`. **Acceptance tests before Phase 6 ships** — claims 1a/1b
and 2/3, replacing v2's incorrect "training start must not move TDEE by more than 5 %":

1. **Artifacts stay bounded** — two claims, measured 2026-09-12 (`docs/estimator-backtest-2026-09-12.md`; ruling 10, contracts §7 "gates
   that are measured, never lowered"):
   - **1a.** A 1.5 kg water swing over 3 days moves reported TDEE by ≤ 5 %, measured against a matched control (same LCG seed, artefact
     only): 5.4 % unmatched vs. 3.3 % on the matched-control series. The bound holds on the matched control, which isolates the
     artefact's actual effect from cross-seed noise. Never changes the status.
   - **1b.** A menstrual-cycle fluid pattern of ±0.8 kg on a 28-day period moves reported TDEE by ≤ **21.4 %** (restated from ≤ 5 %). At
     `alpha = 2/21` the EMA's gain at a 28-day period is ≈ 0.41, and `trend[t] − trend[t−14]` is antiphase at that period, so 5 % is
     unreachable without a second smoother or a tighter prior clamp — both recorded as follow-up contract changes, not done in this
     pass. Never changes the status.
2. **Under-logging holds, it does not chase.** Dropping to 3 qualified days in a week produces `status = 'held'` and no proposal — not a
   lowered TDEE.
3. **Real change is detected, with a stated lag.** A genuine step of +250 kcal/day (the training start) is reflected to within ±100 kcal
   **within 21 days** of the step, and a ramp of +15 kcal/day/week is tracked with an error under 120 kcal. A detector that cannot move when
   expenditure really moves is not an estimator.

### 4.4 Constraint policy (deterministic, after every model output)

Input: item (`food_ref_id`, ingredients, or `unknown`). Output: `allowed | blocked(reason) | unverified`. It is `blocked` when an allergen
tag intersects `avoid_allergens`, the ref is in `avoid_food_ref_ids`, or the category is in `banned_categories` (simple sugars were removed
by the coach on 2026-09-09 and stay removed). It is `unverified` when the food has no ingredient evidence and is not on the user's Eats list; that
renders with an amber pill and is never auto-suggested by the coach. The policy applies to search results (badge), AI drafts (flag), recipe
saves and every coach suggestion, and runs server-side after the model and before render.

**Facet warming (2026-10-02).** Suggestion policy and the diet-flag/profile rules above judge a
food by its cached `food_facets` rows (`lib/foods/facet-warm.ts`'s `human_food` facet and friends,
Jev-judged, RUBRIC_VERSION-pinned), and nothing used to warm that cache for a user's own Eats list
— only ~46 catalog `human_food` rows existed in total, so a packaged or prepared Eats food could
never clear the `unverified` gate above even after the user marked it Eats. Two paths fill the gap,
both idempotent and charged to the account they warm: `app/api/jobs/facet-warm/route.ts` (daily
cron, 04:20 UTC, every settings owner, bounded per user and per run) and a debounced, best-effort
`POST /api/foods/facets/warm` fired right after a browser Eats mark (`lib/foods/prefs-client.ts`),
both funneling through `lib/server/eats-facet-warm.ts`'s `warmEatsFacets`, which skips whatever is
already cached before spending a Jev call on it.

### 4.5 Coach

Runtime (production enablement, 2026-09-13): `gemini-3.6-flash` for every Coach turn and for the weekly review, on the
**paid tier** — health-context turns require `HEALTH_CONTEXT_PROVIDER=gemini` **and**
`GEMINI_BILLING_ATTESTED=1` (R4); without both they return `503 nous_unconfirmed` instead of
calling a model. `lib/ai/models.ts` pins the coach model and its fallback, `lib/ai/attestation.ts`
owns the health-context gate, and `lib/server/coach.ts:coachProvider()` returns its client-visible answer (`"gemini"`), so the
stored `coach_messages.model_id` and the response's `model.provider` can never disagree with the
call that made them. `@google/genai` stays bundled in the Coach function. Its exact version is
embedded from `lib/ai/sdk-version.json`; the production build checks that pin against the installed
package and refuses an external SDK trace, so requests never resolve package-manager paths at
runtime. Nous Portal is rejected (ruling 1); its adapter code was removed on 2026-10-01 and
`NOUS_RETENTION_CONFIRMED` is gone. The orchestrator is three files since T6: `lib/server/coach-turn.ts` is the loop — since
2026-10-01 a short `runTurn` over one module per stage in `lib/server/coach-turn/`, each returning a
`TurnOutcome` that `finish()` saves —
`lib/server/coach-threads.ts` is `coach_threads` / `coach_messages` storage, and
`lib/server/coach-ports.ts` is the I/O each tool reaches; the post-model policy pass is
`lib/coach/reply-check.ts` and the grounding is `lib/coach/ground.ts`.

**The reply's shape (T6 §5).** `lib/coach/wire.ts` holds TWO schemas, and the difference between
them is what decides whether the coach produces cards at all. The one the provider is SENT
requires every key, with an empty value allowed; the one a reply is PARSED with stays lenient.
`lib/ai/gemini-config.ts` sends the first as `responseSchema` with
`responseMimeType: application/json`, which is constrained decoding: the model emits the keys the
schema requires and no others. While `actions`, `suggestions` and `memory` were optional the live
model omitted all three on every turn and wrote the action it wanted into the prose instead
(measured 2026-09-18); required-with-empty-allowed fixed it, and `turnStepCandidate` reads an
empty string or list as "not this variant". The same applies one level down, to an action object:
with `items` optional, `set_slot_meal` arrived with no items at all. The **coach tool registry** is
separate from MCP and read-only: `get_day`, `get_plan`, `get_entries`, `get_week_totals`, `get_targets`, `get_expenditure_status`, `search_foods`, `get_constraints`,
`get_recent_gut_log`. Two tools write nothing but produce something the user can act on: `draft_log_entry`, a draft the user confirms in the sheet, and `compose_meal`, a suggestion card (below). All retrieved content
(food names, the user's notes, label text) is passed in a `data` field marked untrusted; tool arguments are zod-validated server-side; no URLs and
no free-text destinations. The constraint policy runs on every suggested food before render, medical questions get a fixed deflection, and
the coach can neither see nor set targets below floors. Adversarial tests: prompt-injection strings planted in food names and notes must not
trigger a tool call outside the registry. **Memory (T6 §1).** Every turn sends, after the system prompt and before the user's message, the thread's
rolling summary (`coach_threads.summary`, at most 600 characters) and then the last twelve messages
verbatim, trimmed from the oldest until the window fits 6 000 estimated tokens
(`lib/coach/history.ts`, `lib/coach/tokens.ts`). An assistant turn's grounded actions render as one
line each — the action, not the prose, is what "make that 3 pieces" refers back to. The summary is
the model's own: the final envelope carries an optional `memory` field, the server clips it and
stores it on the thread, and there is no second model call and no background job. A reload restores
the messages through `getThread` and the summary rides with the thread, so a new device continues
with the same memory.

**Context (T6 §2).** Every turn also carries a block built for THE USER'S local date —
`now` and `tz` come from the POST body (zod; `DEFAULT_TZ` and the server clock only when the body
has neither), and every date the coach reasons about and every `at` it emits is in the user's timezone.
`lib/server/day-context.ts` builds the same `Store` the phone holds from the user's own synced tables — the
normalized `plan_days` row, which is now the only store and owns the per-slot `eaten` ticks in `eaten_slots` —
and hands it the same pure `resolveDay` the Today screen calls, so the slot the coach reads is the
slot the user sees. `lib/server/coach-context.ts` renders the day type, the targets, what the user has eaten
and what is still to eat, each slot in order with its items, planned time and state, every logged
entry with its id and the user's clock time, the user's Eats and Avoid names, and the user's recipes. It goes through
the SAME untrusted-data fence a tool result uses (`renderDataBlock`), so it is data and never
instruction, and it is capped at ~2 500 estimated tokens: over the cap the longest lists are
trimmed and the block says how many are not shown, with `get_plan` and `get_entries` reading the
rest or another date. A context read that fails is logged and dropped rather than charged to the user's
turn. `compose_meal` sizes its card against the same numbers.

**Capacity (T6 §5).** A model that answers 503 or 429 is abandoned on its FIRST answer rather than
after its retry budget (`abandonOnCapacity`, `lib/ai/failures.ts`), because the turn has a second
model to spend the rest of its time on; the response says which model answered and, when it moved,
whether the reason was capacity or a failure.

A turn's response carries `timings: { model, ground }` (T0): the time inside its generate calls,
and the time grounding its actions. `postTurn` owns the client's own run: `sent` is the start stamp and `first-text` and `reply-done` are
DURATIONS from it, because AC9 judges the wait the user feels rather than the instant the reply arrived. There is no streaming yet — that lands in
T6 — so the two carry the same number today, and the day they stop doing so only `first-text`'s own line changes.

**Voice (T7).** A mic sits left of Send on the composer and the coach has two ways to hear the user's,
tried in that order. On-device: `lib/coach/speech-api.ts` builds `SpeechRecognition`
(`webkitSpeechRecognition` on Safari) at PRESS time — never at load, because iOS is known to lose
it in a standalone PWA build — with `lang` from `navigator.language`, interim results and
`continuous`; `components/CoachMic.tsx` writes the live transcript into the composer's textarea,
and release sends it through the SAME `send()` the typed path uses. The wire body is byte-identical
to a typed turn: nothing on the server learns a turn was spoken, and `runTurn`, the prompt and the
schemas are untouched. What the gesture means — the 300 ms tap rule, the 800 ms finalise wait, the
empty hold — is `lib/coach/dictation.ts`, a pure state machine with injected clocks, and what a
hold DOES — the deferred 300 ms start, the composer lock that holds until the machine leaves
`finalising`, the pointer that took the button, the recogniser restart Safari needs — is
`lib/coach/hold.ts`, a controller driven through injected ports so both are testable in a repo
with no DOM. Ruling R1: a draft already in the composer is not thrown away; the turn is the user's draft,
one space, then the transcript.

The fallback is the server: with no `SpeechRecognition`, or after a `network`,
`service-not-allowed` or `audio-capture` error (which switches the session silently; a reload tries
on-device again), the same hold records with `MediaRecorder` under the FAB's own 30 s ceiling and
`pickAudioMimeType`; the microphone itself is `lib/capture-mic.ts`, which the FAB opens too.
`lib/coach-transcribe-client.ts` signs and uploads through
`lib/capture-client.ts`'s `signAndUpload` — the capture bucket, the same `media_objects` row and the
same 24 h sweep, not a second lifecycle — and posts `{ path }` to `POST /api/coach/transcribe`
(JWT, 8 KB, the pre-identity flood brake /api/coach uses). `lib/server/coach-transcribe.ts` reads
the object, re-runs `validateAudio` (415 for a non-audio object, 422 for a clip over 30 s), and
sends the bytes to the pinned capture model with a transcription-only prompt under purpose
`coach-transcribe`, so the call is one ordinary `ai_calls` row with the spend cap and circuit
breaker already on it. It answers `{ text, ms }` and stores the words nowhere: the transcript
exists in the textarea the user is looking at, and the user taps Send themself, because server transcription is
slower and less certain than the on-device path. The client budget is 8 s (`transcribe` in
`lib/fetch-with-deadline.ts`) with the model's own budget under it. The spoken hop is one more step
on the same run: `dictation` on path `coach-turn`, from the press to the final transcript.

### 4.6 Export

`GET /api/export?kind=meals|progress|exercise|recipes|favorites|water&format=csv|json`, user-scoped, paginated, carrying units, source, `tz`
and `local_date`. CSV cells beginning `= + - @` are prefixed with `'`. OFF-derived rows carry the ODbL notice.

### 4.7 Speed — measured, bounded, warm (T0, 2026-09-17)

**Measured.** `lib/timing.ts` marks the real hops of a run — `decode`, `lookup`, `sign`, `upload`, `propose`, `model`, `ground`,
`confirm-shown`, `commit`, `card-visible`, and the coach's `sent`, `first-text`, `reply-done`, `action-applied` — across the nine paths
`barcode`, `label`, `photo`, `voice`, `text`, `search-log`, `meal-log`, `coach-turn`, `coach-action`. A `mark` is the START of a hop and a
`measure` closes the run, so every row is a duration; `markMs` files a duration that is already known (the server's own `model`/`ground`)
into the run that is open. Whoever commits closes the run, which is why a scan's decode, lookup and commit share one `run_id` even though
three modules measured them. Marks are keyed by RUN, not by path: two runs of one path can overlap — a second barcode scanned while the
first is still resolving — and `beginRun(path)` hands back a handle that `mark`, `markMs` and `measure` all accept, so their steps and their
ids stay apart. Every commit carries its own run: the scanner, the capture sheet and the log sheet's two saves thread that handle end to end — `BarcodeScanSheet` opens a run with the camera and hands it over with the
answer, `captureMedia`/`propose` open one per capture and return it on the draft, and the confirm sheets pass it to `commitLogEntry`, which
closes THAT run — so two scans or two captures in flight together are two taps, never one row set. Rows batch into one `POST /api/timings` (JWT, 8 KB, 60/min) → `client_timings`. The posts run one
after another, but the queue cannot be pinned or broken: each post carries the `timings` deadline, so one that never answers is abandoned at
10 s rather than holding every later flush behind it, and each link chains on a settled promise, so a post that fails does not skip the next
one's callback. The user **inserts** and nothing
else: the table has no select policy, and `pnpm timings [--path X] [--days N]` reads it through the service-role admin client.
`ai_calls.latency_ms` stays the provider-side truth. **Only completed work is sampled**: `postTurn` measures a turn that
answered, an action card measures an apply that applied, and a commit measures a commit the server took — one that ends in the outbox (a
deadline, a 5xx, a lapsed session) happens later, when the drain sends it, so its `commit` step is dropped while its `card-visible` sample
stays, because §6 budgets tap-to-card on the server-down path as much as on the happy one; a failure or a timeout calls
`discardRun` instead, because a p95 the budgets are
judged on must not be pulled in whichever direction the failures happened to lie. A capture sheet dismissed without saving discards its run
the same way. The percentiles themselves interpolate between ranks (`PERCENTILE.INC`), so the p95 of the ten runs a budget is measured over
is not the slowest of the ten by construction.

**Bounded.** `lib/fetch-with-deadline.ts` exports `DEADLINES`, the budget per hop — sign 5 s, upload 20 s, propose 25 s, barcode 8 s, commit 10 s, coach
40 s, search 6 s, and timings 10 s for the measurement post itself — and enforces it with a race, so a server that ignores the abort still loses at the budget; the abort is still sent. A
A **keepalive** call — the timings post, the warm ping — is sent with no signal at all and bounded by the race alone: WebKit refuses or
drops a keepalive request that carries an `AbortSignal`, which on a phone-first PWA means it never lands. A
timeout is `DeadlineExceeded`, which each surface maps onto the copy it already had; a caller's own abort stays an `AbortError`, because a
superseded keystroke is not a slow server. After two seconds `components/WorkingLine.tsx` names the hop, and before two seconds it renders
nothing. Every save the user waits on mounts one: the capture sheet and its confirm, the meal save, and the catalog portion view.

**Warm.** `/api/log/propose`, `/api/foods/barcode`, `/api/coach`, `/api/log/commit` and `/api/foods/search` keep `runtime = "nodejs"`, pin
`preferredRegion = ["sfo1"]` (the Supabase project is in us-west-1; `vercel.json` sets `"regions": ["sfo1"]` for every function, and `tests/speed/region-pins.test.ts` fails on a route that pins any other region) and declare a `maxDuration` matching the client budget. `GET /api/warm`
is a no-op with no session, no read and no write — rate limited per IP all the same, because an unauthenticated route without a limit is an
invitation. `SyncBootstrap` pings on open and on every return to the foreground, because an installed PWA is not remounted between breakfast
and dinner.

**What the ping touches, so AC10 can judge it.** On Vercel each route is its own function, so warming `/api/warm` warms only `/api/warm`.
`pingWarm` therefore touches the warm route AND each of the five hot routes, all at once, each under the shortest
deadline in the table (5 s). `/api/warm` takes a `GET`, which is all it answers; the five hot routes take a **`HEAD`**, because a `GET` to
`/api/foods/search` IS a search — the catalog read and the rate-limit budget included — and a warm ping has no business running one. A HEAD
comes back 405 (POST-only) or 401 (no session), and either answer means the function and its region were loaded, which is the whole purpose. Nothing is read from any of the responses and no failure is reported: a
ping that does not land costs the next tap the cold start it would have paid anyway.

## 5. Endpoint security matrix

| Route | Identity | Body limit | Rate limit | Idempotency | Notes |
|---|---|---|---|---|---|
| `/api/sync/ops`, `/api/sync/changes` | Supabase JWT | 1 MB | 60/min/user | `op_id` | RLS (§2.1) |
| `/api/foods/search`, `/api/foods/barcode` | JWT | 8 KB | 120/min/user | — | OFF calls throttled and cached; identifying `User-Agent` |
| `/api/foods/[id]` | JWT | — | 120/min/user | — | catalog food detail read, `503` falls back to the offline cache |
| `/api/media/sign` | JWT | 1 KB | 30/min/user | — | signed URL 60 s |
| `/api/log/propose` | JWT | 8 KB (refs only) | 30/day soft, 100 hard | input hash | daily spend cap from `ai_calls` |
| `/api/log/commit` | JWT | 64 KB | 60/min/user | `entry_id` | rejects stale revisions |
| `/api/health/ingest` | per-source token (hash in `health_sources`), revocable | 2 MB | 30/hour/source | `payload_hash` + `dedupe_key` | privileged boundary (§2.2); Shortcuts cannot sign, so a 10-minute timestamp replay window applies |
| `/api/health/oura/callback` | OAuth2 `state`, confidential client | — | — | — | tokens encrypted at rest (§5.2) |
| `/api/coach`, `/api/export` | JWT | 16 KB | 60/day and 10/hour per user | — | user-scoped reads |
| `/api/mcp` | per-user token in `api_tokens` | 64 KB | 60/min/token | `op_id` | privileged boundary (§2.2); scopes enforced |
| `/api/timings` | JWT | 8 KB | 60/min/user | — | `user_id` from the session, never the body; insert-only, answers 202 whatever the insert does (§4.7) |
| `/api/foods/facets/warm` | JWT | — | 6/hour/user | — | answers 202 always; warms the caller's own Eats-list facets in `afterResponse` (§4.4) |
| `/api/warm` | none | — | — | — | no-op, reads and writes nothing; exists only so the function is already up (§4.7) |
| `/api/jobs/*` (cron) | `Authorization: Bearer $CRON_SECRET` | — | — | per user/week lock | Vercel cron |
| `/api/sync` | none | — | — | — | deleted; returns 404 (§2.3) |
| import worker | service role, on the Mac or GitHub Actions, **not** Vercel | — | — | version id | §7 |

### 5.2 Oura

Oura API v2 is the integration point; personal access tokens were removed in December 2025, so OAuth2 is the only path. An application
serves up to ten users before approval, and a Gen3-or-later ring needs an active membership and granted scopes.

- **Confidential authorization-code flow.** `client_id` and `client_secret` stay server-side, a random `state` is stored against the session
  and verified on callback, and **refresh tokens rotate** — each refresh stores the new token and discards the old one in one transaction.
- **PKCE canary closed 2026-09-12.** Oura documents only the client-secret and implicit flows (`cloud.ouraring.com/docs/authentication`); no
  `code_challenge`/`code_verifier` is documented, so PKCE is not added. The confidential authorization-code flow with `state` is final —
  see `docs/decisions/2026-09-12-wave4-rulings.md` ruling 2.
- **Ongoing data comes from an idempotent daily polling job**, not a webhook: `/api/jobs/oura-pull` runs at 06:00 user tz, requests the
  previous two local days per endpoint (sleep, readiness, activity), and upserts through the §3.5 dedupe key, so a re-run changes nothing.
  Oura webhooks are an optional later optimisation, not on the critical path.

## 6. AI runtime contract

| Task | Primary | Fallback |
|---|---|---|
| Text → items | `gemini-3.8-flash` | none — retried twice on Gemini, then the call fails |
| Voice → items | `gemini-3.8-flash`, audio input, one call | `gemini-3.8-pro` |
| Label photo → nutrients JSON | `gemini-3.8-flash`, structured output | `gemini-3.8-pro` |
| Plate photo → items + grams | `gemini-3.8-flash` | `gemini-3.8-pro` on low confidence |
| Coach | `gemini-3.6-flash`, paid tier | none — health-context turns without the R4 switch return `503 nous_unconfirmed` |
| Weekly review | `gemini-3.6-flash`, paid tier; enum-only model output rendered as application-owned prose | none |

**Pinned in code** in `lib/ai/models.ts` (re-exported from `lib/ai/adapter.ts`, T4): capture uses `gemini-3.8-flash` and Coach/weekly review use `gemini-3.6-flash`; both are stable and support structured output,
fallbacks pinned the same way, no "latest" aliases; SDK **`@google/genai` major version 2** (`package.json` carries `^2.21.0`; 2.21.x installed,
asserted by `assertPinnedSdk()` against the installed version, so a major upgrade is a deliberate change with its own canary); per-purpose `maxOutputTokens`,
temperature 0 for extraction. Model ID and SDK version are written to every `ai_calls` row. **Provider data handling** — required before any
of Meal Companion's real data is sent:

- **Routing and the recorded provider agree by construction (T4).** Callers pass one `{provider, modelId}` decision (`lib/ai/route.ts` until 2026-10-01; the pins now live in `lib/ai/models.ts`); the
  adapter takes it as a single `route` override and refuses a pair whose provider does not serve the model. Before T4 the coach's table
  entry pointed at a Nous model while the client reported Gemini, an inconsistency no test caught because every test stubbed `generate`
  itself. The adapter-level test now drives the real `generateStructured` and inspects the `ai_calls` row. The turn step is a discriminated
  union, and a union lowers to `oneOf`, which Gemini's `responseSchema` cannot express — so the coach sends the flat `turnStepWireSchema`,
  whose Zod transform rebuilds the union during the adapter's own `safeParse`: a reply that is wire-valid but union-invalid is a
  `schema_invalid` call and a circuit failure, never an `ok` row. Before that fix every real turn was refused by our own converter
  and answered `503 coach_unavailable` without a provider call.
- The Gemini project is on the **paid tier, attested in the console 2026-09-12** — the pinned dedicated project
  (`gen-lang-client-0354187532`), on a **prepay billing account**, with log storage for **GenerateContent and Interactions both OFF**
  (verified in the AI Studio console by the driver; the full record is the Attestation block in `docs/ai-data-handling.md`). This
  supersedes the earlier free-tier record: `pnpm exec tsx scripts/ai-canary.ts` had hit `RESOURCE_EXHAUSTED` naming the
  `generate_content_free_tier_requests` quota on 2026-09-12 (PR #40). **There is still no build-time check.** `scripts/ai-canary.ts`
  runs OUTSIDE CI and only refuses (exit 1) when a human runs it manually and it detects an unpaid signal; nothing invokes it from
  `pnpm build` or CI. Flags stay **unset in the repository** (`.env.example`) and are flipped in production by their own ops tickets —
  catalog in T8, coach in T9 — see `docs/decisions/2026-09-12-wave4-rulings.md` ruling 1.
- Provider-side storage and logging are **disabled wherever the API exposes the control** (prompt logging and data sharing off,
  zero-data-retention settings on where available for the pinned model). The settings in force are recorded in `docs/ai-data-handling.md`
  with the date they were verified.
- **Provider files are deleted after every call** that uses the Files API, in a `finally` block, with a daily sweep as a backstop. Our own
  media copy is deleted on commit or within 24 h.
- **Nous Portal retention and data-use terms were answered 2026-09-12: REJECT** (`docs/ai-data-handling.md`, ruling 1). The Phase 0 canary
  established server-to-server access; the record is written and human-maintained. Nothing routes to Nous — T4 removed both coach purposes
  from the adapter's Nous table — and `scripts/ai-canary.ts` neither probes Nous nor writes the record. The user's gut log and condition notes do
  not leave Gemini.
- Text food logs are retained by us; gut and condition notes go only to the coach path — and under R4, only to Gemini's paid tier once the
  switch and the attestation are both set.

Reliability: retry twice with backoff, circuit breaker at 5 failures in 10 minutes per model, daily spend cap per user from `ai_calls`.
Capture falls back to `gemini-3.6-flash` on the same key when `gemini-3.8-flash` is out of capacity or does not answer
(`lib/ai/capture.ts`; never on a key-quota 429). Before any
model or SDK change, a live canary of 20 items from Meal Companion's eval set, run outside CI.

## 7. Catalog import and capacity

1. **Dry run.** Import Foundation + SR Legacy + FNDDS into a local Postgres (Colima) on this schema; record `pg_total_relation_size` per
   table and index. Target: ≥ 40 % headroom on the Supabase Pro disk. If it does not fit, FNDDS drops to on-demand.
2. **Worker.** `scripts/import-fdc.py`, in the style of the existing `scripts/build-food-db.py`, run from the Mac or GitHub Actions. It
   downloads with a checksum, loads into `catalog_staging.*`, validates (row counts, energy-mismatch rate, nutrient-code coverage), then in
   one transaction inserts the new `catalog_versions` row and the new `catalog_food_revisions` and flips `is_active` per food. Food
   identities are never rewritten, so user references survive. The previous version's revisions are kept for rollback; older ones drop.
3. **Cadence.** Quarterly for the three bulk sources; Branded and OFF cache rows refresh on lookup when older than 90 days. OFF etiquette:
   one read at a time, cache first, identifying `User-Agent`; the published per-IP read limit is unverified and is confirmed at Phase 3.

## 8. Phases

Each phase: tests green → deploy → the reviewer's manual gate.

**This table stops at Phase 8.** Phases 9 onward are each scoped in their own file under
`docs/specs/` (`phase-9-tenancy-blank-slate.md` through `phase-19-day-rebalance.md`); see that
directory for the full phase list and current scope.

| Phase | Scope | Exit gate |
|---|---|---|
| **0 Foundations** | Supabase Auth + request-local server client; privileged server boundary; v2.1 user schema; entity sync with CAS + `change_log`; export and backup; endpoint matrix; pinned AI adapter | Cross-user denial tests pass on every table, view, function and route; two-client CAS conflict tests pass; retired route gone |
| **1 Catalog** | Dry-run sizing; import worker; `catalog_*`; search per §4.1 | Relevance ≥ 82 % top-1 (superseded by R1, `docs/decisions/2026-09-12-session-rulings.md`), ≥ 95 % top-3 on the labelled set; thresholds calibrated and committed |
| **2 Real logging** | Grams + snapshot; Today shows kcal, macros, fiber and micro coverage; CSV export | the reviewer checks 5 logged meals against fdc.nal.usda.gov |
| **3 Fast capture** | `zxing-wasm` barcode → OFF/FDC cache; versioned recipes; favorites; water | Three packaged foods logged in under 5 s each |
| **4 AI capture** | Media pipeline + `ai_calls` + propose/confirm; text → voice → label → photo | Each method: 10-item eval; grounding auto-resolve precision ≥ 90 % |
| **5 Body data** | `/api/health/ingest` + Health Auto Export recipe; Oura OAuth + daily polling job; observation dashboard | 7 days of steps, energy, sleep and weight in `daily_health`; a re-run of the poll changes no row |
| **6 Estimator** | Advisory engine, burn-in, the three §4.3 acceptance tests, weekly proposals with one-tap approve; percent target mode | Acceptance tests pass; first proposal reviewed by the reviewer |
| **7 Coach** | Tool registry, constraint policy, injection tests | Adversarial set passes |
| **8 Deferred** | Expo/HealthKit shell, Withings, Garmin, Health Connect | — |

## 9. Verification

Migration rollback test. Two-client plus MCP conflict matrix, including a rejected stale update, a stale delete that must not erase a newer
edit, and the restore path. Cursor continuity under interleaved writes. Commit and ingest idempotency. RLS cross-user tests on every table,
view, function, route and export, plus a test that each view is `security_invoker`. Privileged-boundary tests: an MCP token may not read
another user's row through any tool. Import failure and size tests. Labelled search metrics and threshold calibration. Nutrient
null-versus-zero and rounding tests. Percent-to-gram conversion tests including the floor-conflict case. Media limit and path-authorization
tests. Estimator acceptance tests (§4.3). Coach adversarial set. Timezone boundary tests (a 23:30 meal, a DST change). Live-model canary
outside CI for every model or SDK version. Pre-PR gates stay targeted: `pnpm test <file>`, `pnpm lint`, `pnpm build`.

## 10. Open items (do not block approval)

- ~~Nous Portal retention and data-use terms~~ — **closed 2026-09-12: REJECT**, recorded in `docs/ai-data-handling.md` (§6). Nous is inert
  (T4). ~~R4~~ — **answered YES 2026-09-12**: health-context coach turns may reach Gemini on the paid tier, and the driver attested
  billing and prompt logging in the console the same day. The switch ships **unset in `.env.example`**; both R4 variables
  (`HEALTH_CONTEXT_PROVIDER=gemini`, `GEMINI_BILLING_ATTESTED=1`) **are set in Vercel production**. Turning the coach on for the user is
  still T9's ops step (`COACH_ENABLED` / `NEXT_PUBLIC_COACH_ENABLED`).
- ~~`components/TabBar.tsx` hydration mismatch~~ — **closed by PR #141** (`4e642d8`): the Body tab's capability
  reads `"unknown"` on the server and on the client's own pre-effect render alike, and the warm cache is applied in a
  layout effect afterwards; `tests/tabbar/body-capability-first-paint.test.tsx` is the regression test. The residual
  cold-cache shift, where the Body tab appears one paint after the first, is a **known and accepted layout shift** — not
  a mismatch, and not tracked further (T9 §6).
- Oura PKCE support — canary at Phase 5 (§5.2); the flow does not depend on it.
- OFF product read rate limit — confirmed at Phase 3 when the cache is built.
- Whether the user owns a Withings or other connected scale (decides the Phase 8 order).
- Health Auto Export versus a hand-built Shortcut — the reviewer decides at Phase 5; the recommendation is Health Auto Export.

## 11. Changelog — v2 → v2.1

Each entry names the finding it answers in the retained 2026-09-10 GPT-5.6 v2 audit.

| # | Change | Answers |
|---:|---|---|
| 1 | §2.1 specifies a request-local `createServerClient` with the publishable key and the caller's session, `getClaims()`/`getUser()` for identity, and per-operation `using`/`with check` policies. Every view is created `with (security_invoker = true)` and granted to `authenticated`, asserted by a test for `daily_totals`, `weigh_ins` and `daily_health`. | §3 "`@supabase/ssr` and RLS" and both its qualifications; v1 finding 3 |
| 2 | §2.2 defines a **privileged server boundary** for MCP and health tokens. It no longer claims RLS: the handler resolves `user_id` from the token row and hard-binds every query to it via a user-scoped RPC or explicit filter, through the single wrapper holding the service-role key. | BLOCK §2/§3.7/§8 |
| 3 | §2.3 records removal of the legacy `foods`/`days`/`settings` tables and `/api/sync` in one release. | BLOCK §2/§3.7/§8 |
| 4 | §3.1 splits catalog identity from content: `catalog_foods(id, source, source_id)` with `unique (source, source_id)`, all mutable data plus `catalog_version_id` on `catalog_food_revisions`. Imports activate revisions; food rows are never replaced. | BLOCK §3.1/§7 |
| 5 | §3.2 adds the `food_refs` UUID registry — `kind ∈ catalog\|user`, nullable `catalog_food_id`/`user_food_id`, a check constraint allowing exactly one — so `log_items`, `recipe_items` and every favorites table carry a real foreign key. `favorites_meal_items` replaces the jsonb item list. | BLOCK §3.2/§3.3; v1 finding 16 |
| 6 | §3.5 replaces the invalid inline `unique (…, coalesce(…))` with a stored generated `dedupe_key` column (immutable `to_char`) plus a unique index, adds `vendor_version` and `vendor_updated_at`, and specifies the correction upsert that accepts only newer vendor data. | WARN §3.5 |
| 7 | §3.7 replaces blind-apply with **compare-and-swap**: a stale op is rejected and the current entity returned. Per-entity merge rules are tabulated. Deletes dominate; only an explicit `restore` op revives a tombstone. | BLOCK §3.7 (stale updates) |
| 8 | §3.7 adds append-only `change_log(user_id, seq, entity, entity_key, rev, op, current, at)` with `seq` assigned transactionally from a locked per-user counter (insert-on-conflict on first use), used as the only pull cursor; `entity_key` is a text key encoding so date- and composite-keyed rows sync, and `current` carries the row so the feed is self-sufficient. The note explains why a Postgres sequence would let clients skip changes. (Revised 2026-09-10 after the prep review.) | BLOCK §3.7 (cursor) |
| 9 | §3.7 replaces `possible_duplicate_of` with `duplicate_groups` + `duplicate_group_members`, keyed by an event-time content fingerprint (local_date, slot, 15-minute bucket, canonical food ids, grams rounded to 5 g) and carrying dismiss/merge state. | WARN §3.7 (duplicates) |
| 10 | §6 pins `gemini-3.8-flash` and `@google/genai` major 2, requires a billing-enabled Gemini project, provider storage and logging disabled where exposed, provider file deletion after every call, and a recorded Nous retention decision before the user's data is sent. | BLOCK §0/§6 |
| 11 | §4.2 re-checks that the media object path belongs to `auth.uid()`, fetches bytes server-side, and sends bounded inline bytes (< 4 MB) or a Gemini Files API upload with explicit deletion. The zod schema converts to the supported JSON-Schema subset and the response is re-validated after the call. | WARN §4.2/§6; §3 "Gemini audio and structured output" |
| 12 | §4.1 gives the exact SQL, uses `ts_rank` normalization flag 32, maps all features explicitly to [0,1] with weights summing to 1.00, makes GTIN a separate deterministic path, and marks the 0.80/0.15 thresholds as calibrated on the labelled set. | §3 "Normalised search score"; v1 finding 11 |
| 13 | §4.3 seeds `prior = 2130 kcal` from `targets.md` maintenance and bounds on the measured BMR of 1,372 kcal; burn-in ends only on ≥ 21 qualified days, ≥ 12 weigh-ins, ≥ 15 complete intake days **and** a defined `t−14` trend point; status holds when either trend endpoint is missing; the clamp order is numbered. | WARN §4.3 |
| 14 | §4.3 and §3.4 apply `kcal_min` and `protein_g_min` and define the floor-conflict rule: raise calories, never cut protein or fat below its floor; a raise above the weekly step cap sets status `blocked` for the reviewer. | v1 finding 6 |
| 15 | §4.3 replaces "training start must not move TDEE by more than 5 %" with three separate claims: artifacts bounded, under-logging holds, real sustained change detected within a stated lag and error. | §3 "Estimator" |
| 16 | §3.4 gives percent mode a full contract: stored `protein_pct`/`fat_pct`/`carb_pct` summing to 100, conversion at kcal × pct ÷ 4\|9\|4 per day type, carbs as the remainder, floors applied in grams afterwards, check constraints and rejection rules. | v1 finding 20 |
| 17 | §5.2 specifies Oura's confidential authorization-code flow with `state` and rotating refresh tokens, marks PKCE unverified and not depended on, and adds the idempotent daily polling job with webhooks optional. | WARN §5/Phase 5 |
| 18 | §1's column is renamed **Disposition** with `planned`/`deferred`/`rejected`, prefaced by a statement that nothing in the table exists yet; Fitbit/Google Health moves to `rejected`. | NIT §1 |
| 19 | The header identifies every retained source artifact, including research B. | v1 finding 23 |
| 20 | §3.1 states the Atwater treatment explicitly (alcohol, sugar alcohols and organic acids when reported, available versus total carbohydrate, the rounding basis, an `atwater_incomplete` flag) and records the ODbL decision: OFF rows are marked, attributed on the food detail screen, and carry the notice into exports. | v1 findings 12 and 14 |
| 21 | All schema in §3 is executable PostgreSQL 17 DDL rather than sketch notation. | BLOCK §3.2/§3.3; verdict item 2 |

## 12. Recipe and shopping pilot boundary (bounded production pilot)

This section describes the implementation on `main`. Production enabled the workflow for one
approved QA account on 2026-09-27; every other account remains off. The feature is account-gated
by `RECIPE_PLANNING_USER_IDS`; production defaults off when the allowlist is unset.
`lib/server/recipe-access.ts` checks the signed-in account before app workflows. The flag is not a
content entitlement: authenticated publication RLS can read shared original catalog content.
Private favorites, accepted selections, pantry and shopping rows are account scoped. The full
pilot recipe and nutrition provenance lives in [the source and rights manifest](recipes/pilot-source-rights.md).

`lib/recipe-catalog/repository.ts` hydrates the bounded published catalog, and
`lib/server/recipe-candidates.ts` applies current dietary rules and Avoid evidence for discovery,
Coach and planning. Search refuses a catalog above 64 reviewed candidates. Unknown evidence is
not an eligible recommendation. Explicit catalog Favorites are stored separately from legacy
Eats; no migration infers that an Eats row is a favorite. `GET /api/recipes` returns up to three
eligible cards and limitations; `GET /api/recipes/:id` returns current published detail, including
its policy status. `GET /api/recipes/favorites` and `GET`/`PUT /api/recipes/:id/favorite` manage
account bookmarks with a revision and request ID. The app uses `GET /api/recipes/access` to
show or hide its pilot UI.

`POST /api/recipes/:id/preview` accepts a local date, meal slot and optional serving fraction. It
returns a server-owned proof ID, scaled ingredient and nutrition snapshots, macro gaps, evidence
issues and target/rules authority. `POST /api/recipes/:id/plan` accepts that proof ID, an idempotent
request ID and explicit acceptance of approximate evidence; it never trusts client-supplied recipe
or nutrition content. `GET /api/recipes/plan` reads up to 31 days of account selections.
`lib/recipes/accepted-overlay.ts` projects the accepted selection into Today without rewriting
legacy plan rows. The accepted serving stays separate from the amount actually consumed.
`POST /api/recipes/consumed` accepts a request ID, local date, meal slot, accepted selection ID,
plan revision and actual servings (positive, at most 20). The C4 `recipe_log_consumed` RPC checks
the account's current selection while holding the recipe state lock, computes the consumed
snapshot from its pinned nutrition and writes the day in one transaction. A changed selection or
already eaten slot returns 409; a matching request ID can replay its result. The caller projects
the returned server row locally only after the online response. Focused local database tests
covered stale selection and replay. This closes the earlier C3 read/write race at the server
boundary, but the independent whole-branch review found two further history gaps in C4.

The source migration `20261201090000_recipe_consumed_sync` adds a `plan_days` change-feed row in
the same transaction as recipe logging, including first-row creation. It introduces private
`recipe_consumed_slot_state` and an epoch on each consumed mark. A trigger guards generic
`plan_days` writes so an offline timestamp-only replay cannot create, erase or resurrect a
consumed snapshot. `lib/sync/merge.ts` also prefers the server mark across a consumed/epoch
conflict. `DELETE /api/recipes/consumed` accepts a request ID, local date, meal slot and expected
mark timestamp; `recipe_undo_consumed` writes an online tombstone with a new epoch and feed event.
Only this validated online undo can retire consumed history. The client retains the request ID
across an uncertain retry. These C5 paths are on `main`. Focused loopback two-client feed and
offline-replay tests passed, the migrations are recorded in the production ledger, and the route
is deployed. A real multi-device production mutation check remains a separate pilot exercise.

`POST /api/shopping/preview` produces an account-owned plan proof with choices, proposed lines,
weekly replenishment windows, unmet pins, unfilled slots, compromises and price limitations.
`POST /api/shopping/accept` rechecks current target, rules, catalog revision, pantry, list and
plan authority before committing selections and derived lines in one transaction. A changed
proof returns `409 stale_preview`; an infeasible plan returns `422 infeasible_plan`.
`GET`/`POST /api/shopping/periods` and `GET`/`PATCH /api/shopping/periods/:id` manage dated
periods. Nested line routes manage manual lines and checked/notes; purchase-window `PATCH`
accepts checked/note only, never derived need, stock or Buy amounts. `GET`/`PUT
/api/shopping/pantry` and pantry item `DELETE` manage confirmed stock. These routes require an
authenticated account and online revision-aware writes. The period detail returns its lines and
purchase windows. Unknown conversion or package size stays null in Buy, and unknown price is not
a budget promise. Weekly windows preserve prior checked/note state on replan when the relevant
need and Buy do not rise. See [pilot release](recipes/pilot-release.md) for deployment order.
