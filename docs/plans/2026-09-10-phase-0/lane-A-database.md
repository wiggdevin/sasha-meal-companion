# Lane A — Database: Phase 0 schema, RLS and sync RPCs

**For agentic workers:** execute this plan with `superpowers:subagent-driven-development`. One task per
subagent, in order. Each task is red → green → commit. Do not start a task before the previous task's
commit exists.

## Goal

Ship the whole Phase 0 database surface on a Supabase preview branch off project `fivatgdpuenszxxnijpc`:
six migrations (catalog shell, user schema, sync log, privileged tables, RLS, RPCs), a branch script,
and integration tests that prove a second user reads nothing and that `apply_sync_op` implements the
compare-and-swap contract exactly. No application code in this lane. `lib/store.ts`, `lib/sync.ts`,
`lib/server/db.ts` and `app/api/sync/route.ts` stay untouched — the integration branch removes them at
cut-over.

## Architecture

Two namespaces. `catalog_*` is shared, read-only to users, written by the Phase 1 import worker; it
ships here as empty shells so foreign keys resolve. The user tables carry `user_id` and the §2.1 policy
pair. Three table shapes need three RLS patterns: owner tables, child tables reached through a parent
existence check, and shared reference tables that grant `select` with `using (true)`.

Writes from the client never touch a table directly. They go through `apply_sync_op`, one op per
transaction, which does compare-and-swap on `rev`, appends to `change_log` with a per-user contiguous
`seq` from `next_change_seq`, and returns an `OpResult`. Reads of the change feed go through
`sync_changes`. Both are `security definer` with `p_user_id` first and a caller guard that refuses a
`p_user_id` that is not `auth.uid()` when a JWT is present.

## Tech Stack

Next.js 16.3.4, React 19, TypeScript, Tailwind 4, pnpm 11.25.0, Node 22, vitest 5, Supabase Postgres 17
(project `fivatgdpuenszxxnijpc`, org Zerosumsolutions-Projects), Supabase CLI 2.116, Vercel.

## Spec path

`docs/specs/phase-0-foundations.md` (phase spec) · `docs/architecture.md` v2.1 §2.1–2.3, §3.1–3.7, §5
(authority) · `docs/plans/2026-09-10-phase-0/00-contracts.md` (frozen names).

## Global Constraints (contracts §8)

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full
  suite twice.

Lane-A additions to those constraints:

- Every SQL function in this lane is `security definer`, `set search_path = public`, with
  `revoke execute … from public, anon` immediately after `create`.
- The < 400-line rule binds the TypeScript files. Migrations are single-purpose SQL files and are
  allowed to run longer; no migration here exceeds 260 lines.
- Branch: `feat/p0-database`. Files outside the Lane A column of contracts §1 are not touched, and
  `package.json` is edited inside the `scripts` block only.

## File structure

| File | Responsibility |
|---|---|
| `supabase/config.toml` | Supabase CLI project config: Postgres 17, `public` API schema, auth settings for the branch, seeding disabled by default. |
| `scripts/db-branch.sh` | `create` / `env` / `reset` / `destroy` a preview branch off `fivatgdpuenszxxnijpc`; prints the `SUPABASE_TEST_*` env block the integration suite needs. |
| `supabase/migrations/20260911000100_catalog_shell.sql` | Extensions plus architecture §3.1 catalog DDL verbatim. No rows. |
| `supabase/migrations/20260911000200_user_schema.sql` | §3.2 food layer and recipe/favorite shells, §3.3 logging, §3.4 targets, §3.6 constraints and coach, plus `plan_days`, `user_settings`, `gut_log`. |
| `supabase/migrations/20260911000300_sync.sql` | `change_seq`, `change_log`, `next_change_seq`, `duplicate_groups`, `duplicate_group_members`. |
| `supabase/migrations/20260911000400_privileged.sql` | `api_tokens`, `health_sources` (with `'manual'`), `ingest_events`, `health_samples` with the IMMUTABLE dedupe key. |
| `supabase/migrations/20260911000500_rls.sql` | RLS on every table with the right pattern per shape, the `weigh_ins` security-invoker view, grants and anon revokes. |
| `supabase/migrations/20260911000600_rpc.sql` | `_sync_assert_caller`, `_sync_assert_key`, `_sync_current`, `_sync_upsert`, `_sync_tombstone`, `apply_sync_op`, `sync_changes`, `get_or_create_food_ref`, `revoke_api_token`, `lookup_api_token`. |
| `supabase/seed/test_helpers.sql` | Test-only `security definer` helpers: `test_view_options()`, `test_reset_user(uuid)`. Applied to the branch only, never to production. |
| `tests/helpers/supabase.ts` | Admin client, two test users created through the admin API, user-scoped clients via `signInWithPassword`, reset helper, skip flag. |
| `tests/rls/security-invoker.test.ts` | Every view in `public` reports `security_invoker=true`. |
| `tests/rls/cross-user.test.ts` | User B reads zero rows from every user table and the view; every RPC with the wrong `p_user_id` is refused and writes nothing. |
| `tests/rls/apply-sync-op.test.ts` | create, duplicate `op_id`, conflict with full current, gone, deleted, restore, seq contiguity, one entity-key shape per entity. |
| `package.json` | `scripts` block only: `db:branch`, `db:reset`, `db:push`, `test:integration`. |

### Entity-key encoding this lane must produce (contracts §4)

| Entity | `entity_key` (= `SyncOp.entity_id`) | Row PK |
|---|---|---|
| `user_foods`, `log_entries`, `gut_log`, `duplicate_groups` | lowercase UUID string | `id` |
| `plan_days`, `water_log` | `YYYY-MM-DD` | `(user_id, local_date)` |
| `user_settings` | `'settings'` | `user_id` |
| `user_food_prefs` | `food_ref_id` UUID string | `(user_id, food_ref_id)` |

Soft-deletable entities (they carry `deleted_at`): `user_foods`, `log_entries`, `gut_log`. For every
other entity a `delete` op removes the row and logs `current = null`; a `restore` on it returns
`{status:'gone'}`, because there is no tombstone to revive.

---

## Task 1 — Supabase project scaffold and the branch script

**Files**
- Create: `supabase/config.toml`
- Create: `scripts/db-branch.sh`
- Modify: `package.json` (`scripts` block only)
- Test: shell assertions in the steps below. `tests/` is reserved for branch-backed vitest suites.

**Interfaces**
- Consumes: nothing.
- Produces: `scripts/db-branch.sh {create|env|reset|destroy} [branch-name]`, and the env contract
  `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`,
  `SUPABASE_TEST_DB_URL`.

### Steps

- [ ] Failing test — run the script that does not exist yet:
  ```bash
  bash scripts/db-branch.sh 2>&1 | head -3; echo "exit=$?"
  ```
  Expected failure: `bash: scripts/db-branch.sh: No such file or directory`.

- [ ] Write `supabase/config.toml`:
  ```toml
  # Supabase CLI project config. Applied to preview branches by `supabase db push`.
  # Production auth settings are managed in the dashboard; this file governs branches and local runs.
  project_id = "meal-companion"

  [api]
  enabled = true
  port = 54321
  schemas = ["public"]
  extra_search_path = ["public", "extensions"]
  max_rows = 1000

  [db]
  port = 54322
  shadow_port = 54320
  major_version = 17

  [db.migrations]
  enabled = true

  [db.seed]
  # Test-only helpers live in supabase/seed/ and are applied explicitly by scripts/db-branch.sh.
  # Never seeded by default, so a stray `supabase db reset --linked` cannot install them.
  enabled = false

  [auth]
  enabled = true
  site_url = "http://127.0.0.1:3000"
  additional_redirect_urls = ["http://127.0.0.1:3000/auth/callback"]
  jwt_expiry = 3600
  enable_refresh_token_rotation = true
  refresh_token_reuse_interval = 10
  enable_signup = true
  enable_anonymous_sign_ins = false
  minimum_password_length = 12

  [auth.email]
  enable_signup = true
  enable_confirmations = false
  double_confirm_changes = true
  otp_length = 6
  otp_expiry = 3600

  [studio]
  enabled = false

  [storage]
  enabled = false

  [realtime]
  enabled = false
  ```

- [ ] Write `scripts/db-branch.sh`:
  ```bash
  #!/usr/bin/env bash
  # Create / inspect / reset / destroy a Supabase preview branch for the Phase 0 integration suite.
  #
  # Env the integration suite needs (print it with `env`, then export it in your shell):
  #   SUPABASE_TEST_URL                https://<branch-ref>.supabase.co
  #   SUPABASE_TEST_ANON_KEY           publishable key of the branch (user-scoped clients)
  #   SUPABASE_TEST_SERVICE_ROLE_KEY   secret key of the branch (admin client, raw-SQL helpers)
  #   SUPABASE_TEST_DB_URL             postgres:// connection string (migrations, psql assertions)
  # `pnpm test:integration` skips every suite when SUPABASE_TEST_URL is unset.
  set -euo pipefail

  PROJECT_REF="fivatgdpuenszxxnijpc"
  BRANCH="${2:-p0-database}"
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  usage() {
    cat >&2 <<'EOF'
  usage: scripts/db-branch.sh <create|env|reset|destroy> [branch-name]

    create    create the preview branch (default name: p0-database) and wait for it to go healthy
    env       print the SUPABASE_TEST_* export block for the branch
    reset     re-apply every migration from scratch, then apply supabase/seed/test_helpers.sql
    destroy   delete the preview branch

  Requires: supabase CLI >= 2.116 (logged in), jq, psql.
  EOF
    exit 2
  }

  need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }

  branch_json() {
    supabase branches get "$BRANCH" --project-ref "$PROJECT_REF" -o json
  }

  print_env() {
    local j ref host port user pass keys anon secret
    j="$(branch_json)"
    ref="$(jq -r '.ref' <<<"$j")"
    host="$(jq -r '.db_host' <<<"$j")"
    port="$(jq -r '.db_port // 5432' <<<"$j")"
    user="$(jq -r '.db_user // "postgres"' <<<"$j")"
    # percent-encoded: `supabase db push --db-url` and psql both require it.
    pass="$(jq -rn --arg p "$(jq -r '.db_password' <<<"$j")" '$p | @uri')"
    keys="$(supabase projects api-keys --project-ref "$ref" --reveal -o json)"
    anon="$(jq -r '[.[] | select(.name == "anon" or .type == "publishable")][0].api_key' <<<"$keys")"
    secret="$(jq -r '[.[] | select(.name == "service_role" or .type == "secret")][0].api_key' <<<"$keys")"
    cat <<EOF
  export SUPABASE_TEST_URL="https://${ref}.supabase.co"
  export SUPABASE_TEST_ANON_KEY="${anon}"
  export SUPABASE_TEST_SERVICE_ROLE_KEY="${secret}"
  export SUPABASE_TEST_DB_URL="postgresql://${user}:${pass}@${host}:${port}/postgres"
  EOF
  }

  db_url() { print_env | sed -n 's/^export SUPABASE_TEST_DB_URL="\(.*\)"$/\1/p'; }

  case "${1:-}" in
    create)
      need supabase; need jq
      supabase branches create "$BRANCH" --project-ref "$PROJECT_REF" --region us-east-1 --persistent --yes
      for _ in $(seq 1 60); do
        [ "$(branch_json | jq -r '.status')" = "FUNCTIONS_DEPLOYED" ] && break
        sleep 10
      done
      print_env
      ;;
    env)
      need supabase; need jq
      print_env
      ;;
    reset)
      need supabase; need jq; need psql
      url="$(db_url)"
      supabase db reset --db-url "$url" --workdir "$ROOT" --yes
      psql "$url" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/seed/test_helpers.sql"
      echo "branch $BRANCH reset: migrations + test helpers applied"
      ;;
    destroy)
      need supabase
      supabase branches delete "$BRANCH" --project-ref "$PROJECT_REF" --yes
      ;;
    *) usage ;;
  esac
  ```
  Then make it executable:
  ```bash
  chmod +x scripts/db-branch.sh
  ```

- [ ] Edit the `scripts` block of `package.json` — nothing else in the file changes:
  ```json
    "scripts": {
      "dev": "next dev",
      "build": "next build",
      "start": "next start",
      "lint": "eslint",
      "test": "vitest run",
      "test:watch": "vitest",
      "db:branch": "bash scripts/db-branch.sh create",
      "db:reset": "bash scripts/db-branch.sh reset",
      "db:push": "bash -c 'supabase db push --db-url \"$SUPABASE_TEST_DB_URL\"'",
      "test:integration": "vitest run tests/"
    },
  ```

- [ ] Run — expect PASS:
  ```bash
  bash scripts/db-branch.sh; echo "exit=$?"
  ```
  Expected: the usage text above on stderr, then `exit=2`.
  ```bash
  node -e "const s=require('./package.json').scripts; for (const k of ['db:branch','db:reset','db:push','test:integration']) if(!s[k]) throw new Error('missing '+k); console.log('scripts ok')"
  ```
  Expected: `scripts ok`.

- [ ] **[needs network]** Create the branch once (skip in CI — the CI job never runs this):
  ```bash
  pnpm db:branch
  ```
  Expected: the four `export SUPABASE_TEST_*` lines. Paste them into your shell.

- [ ] Commit:
  ```bash
  git add supabase/config.toml scripts/db-branch.sh package.json && git commit -m "chore(db): add supabase config, branch script and db scripts"
  ```

---

## Task 2 — Migration 000100: catalog shell

**Files**
- Create: `supabase/migrations/20260911000100_catalog_shell.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: nothing.
- Produces: `catalog_versions`, `catalog_foods`, `catalog_food_revisions`, `catalog_nutrients`,
  `catalog_food_nutrients`, `catalog_barcodes`, `catalog_portions`, `catalog_ingredients`,
  `catalog_dri`, all empty.

### Steps

- [ ] Failing test — **[needs branch]**, skip when `SUPABASE_TEST_DB_URL` is unset:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -c "select count(*) from catalog_foods;"
  ```
  Expected failure: `ERROR:  relation "catalog_foods" does not exist`.

- [ ] Write `supabase/migrations/20260911000100_catalog_shell.sql` — architecture §3.1 DDL, verbatim:
  ```sql
  -- Phase 0: architecture v2.1 §3.1 catalog DDL. Shipped empty so user foreign keys resolve.
  -- Phase 1's import worker fills it. Do not add rows here.
  create extension if not exists pg_trgm;
  create extension if not exists unaccent;
  create extension if not exists pgcrypto;

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

  -- §3.1 prose, same shape, keyed to food_revision_id with on delete cascade.
  create table catalog_portions (id bigserial primary key,
    food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
    description text, gram_weight numeric not null check (gram_weight > 0), seq integer not null,
    is_default boolean not null default false);
  create table catalog_ingredients (
    food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
    seq integer not null, name text not null, allergen_tags text[] not null default '{}',
    raw_text text, primary key (food_revision_id, seq));
  create table catalog_dri (id bigserial primary key,
    nutrient_code text not null references catalog_nutrients(code), authority text not null,
    ref_type text not null check (ref_type in ('RDA','AI','UL','EAR')), sex text,
    age_min numeric, age_max numeric, life_stage text, value numeric not null, unit text not null,
    effective_date date);
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_tables where schemaname='public' and tablename like 'catalog_%';"
  ```
  Expected: `9`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000100_catalog_shell.sql && git commit -m "feat(db): add catalog shell tables"
  ```

---

## Task 3 — Migration 000200 part 1: user food layer and recipe/favorite shells

**Files**
- Create: `supabase/migrations/20260911000200_user_schema.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `catalog_foods`, `catalog_food_revisions`, `catalog_portions` (Task 2).
- Produces: `user_foods`, `food_refs`, `user_food_prefs`, `recipes`, `recipe_revisions`,
  `recipe_items`, `favorites_foods`, `favorites_recipes`, `favorites_meals`, `favorites_meal_items`.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -c "select count(*) from user_food_prefs;"
  ```
  Expected failure: `ERROR:  relation "user_food_prefs" does not exist`.

- [ ] Create `supabase/migrations/20260911000200_user_schema.sql` with the §3.2 block:
  ```sql
  -- Phase 0: architecture v2.1 §3.2 user food layer, §3.3 logging, §3.4 targets, §3.6 constraints
  -- and coach, plus the three tables the phase spec adds (plan_days, user_settings, gut_log).
  -- RLS is enabled in 20260911000500_rls.sql, not here.

  -- ---------- §3.2 user food layer and the food registry -----------------------------
  create table user_foods (id uuid primary key default gen_random_uuid(), name text not null, brand text,
    user_id uuid not null references auth.users(id) on delete cascade, ingredients_text text,
    catalog_food_id bigint references catalog_foods(id), rev integer not null default 1,
    kind text not null check (kind in ('custom','label_scan','recipe')), deleted_at timestamptz,
    per_100g jsonb not null default '{}'::jsonb,      -- {nutrient_code: amount|null}
    allergen_tags text[] not null default '{}', created_at timestamptz not null default now());
  create index user_foods_owner on user_foods (user_id);
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

  -- Owners of the item tables (§3.2 prose). Phase 3 builds the UI; the shells ship now so every
  -- food_ref_id foreign key resolves.
  create table recipes (id uuid primary key default gen_random_uuid(), name text not null,
    user_id uuid not null references auth.users(id) on delete cascade, rev integer not null default 1,
    servings numeric not null check (servings > 0), yield_grams numeric, deleted_at timestamptz);
  create table recipe_revisions (id uuid primary key default gen_random_uuid(),
    recipe_id uuid not null references recipes(id) on delete cascade, rev integer not null,
    created_at timestamptz not null default now(),
    nutrients_per_serving jsonb not null default '{}'::jsonb, unique (recipe_id, rev));
  create table recipe_items (seq integer not null, qty numeric not null, unit text not null,
    recipe_revision_id uuid not null references recipe_revisions(id) on delete cascade,
    food_ref_id uuid not null references food_refs(id), grams numeric not null check (grams >= 0),
    food_revision_id bigint references catalog_food_revisions(id),
    state text not null default 'raw' check (state in ('raw','cooked')),
    primary key (recipe_revision_id, seq));
  create table favorites_foods (user_id uuid not null references auth.users(id) on delete cascade,
    food_ref_id uuid not null references food_refs(id), sort integer not null default 0,
    primary key (user_id, food_ref_id));
  create table favorites_recipes (user_id uuid not null references auth.users(id) on delete cascade,
    recipe_id uuid not null references recipes(id) on delete cascade, sort integer not null default 0,
    primary key (user_id, recipe_id));
  create table favorites_meals (id uuid primary key default gen_random_uuid(), name text not null,
    user_id uuid not null references auth.users(id) on delete cascade, rev integer not null default 1,
    sort integer not null default 0);
  create table favorites_meal_items (seq integer not null,     -- typed, not jsonb
    meal_id uuid not null references favorites_meals(id) on delete cascade,
    food_ref_id uuid not null references food_refs(id),
    grams numeric not null check (grams > 0), primary key (meal_id, seq));
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from user_food_prefs;" -c "select count(*) from favorites_meal_items;"
  ```
  Expected: `0` then `0`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000200_user_schema.sql && git commit -m "feat(db): add user food layer and food_refs registry"
  ```

---

## Task 4 — Migration 000200 part 2: logging, plan_days, user_settings, gut_log

**Files**
- Modify: `supabase/migrations/20260911000200_user_schema.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `food_refs`, `catalog_food_revisions`, `catalog_portions`.
- Produces: `log_entries`, `log_items`, `water_log`, `plan_days`, `user_settings`, `gut_log`.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -c "select count(*) from plan_days;"
  ```
  Expected failure: `ERROR:  relation "plan_days" does not exist`.

- [ ] Append to `supabase/migrations/20260911000200_user_schema.sql`:
  ```sql
  -- ---------- §3.3 logging ------------------------------------------------------------
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

  -- ---------- phase-0-foundations.md: the three tables v2.1 does not define ------------
  create table plan_days (
    user_id uuid not null references auth.users(id) on delete cascade,
    local_date date not null,
    day_type_override text check (day_type_override in ('training-10','training-7-fasted','rest')),
    floor_day boolean not null default false,
    swaps jsonb not null default '{}'::jsonb,          -- {slot_id: meal_id}
    slot_notes jsonb not null default '{}'::jsonb,     -- {slot_id: text}
    rev integer not null default 1,
    updated_at timestamptz not null default now(),
    primary key (user_id, local_date));

  create table user_settings (
    user_id uuid primary key references auth.users(id) on delete cascade,
    first_opened_at timestamptz not null,
    scale_warning_dismissed boolean not null default false,
    training_kcal integer, rest_kcal integer, protein_g numeric,   -- null = follow the ramp
    protein_locked boolean not null default true,
    ramp_override smallint check (ramp_override between 1 and 3),
    slot_times jsonb not null default '{}'::jsonb,
    shift_minutes integer not null default 0,
    changed_at timestamptz, rev integer not null default 1);

  create table gut_log (
    id uuid primary key,                               -- client-generated
    user_id uuid not null references auth.users(id) on delete cascade,
    local_date date not null, tz text not null,
    state text not null check (state in ('good','iffy','flare')),
    note text, rev integer not null default 1, deleted_at timestamptz,
    unique (user_id, local_date));
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from plan_days;" -c "select count(*) from gut_log;" -c "select count(*) from log_items;"
  ```
  Expected: `0`, `0`, `0`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000200_user_schema.sql && git commit -m "feat(db): add logging, plan_days, user_settings and gut_log"
  ```

---

## Task 5 — Migration 000200 part 3: targets, expenditure, constraints and coach

**Files**
- Modify: `supabase/migrations/20260911000200_user_schema.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `auth.users`.
- Produces: `target_profiles`, `expenditure_estimates`, `target_proposals`, `constraint_profiles`,
  `coach_threads`, `coach_messages`, `ai_calls`.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -c "select count(*) from ai_calls;"
  ```
  Expected failure: `ERROR:  relation "ai_calls" does not exist`.

- [ ] Append to `supabase/migrations/20260911000200_user_schema.sql`:
  ```sql
  -- ---------- §3.4 targets and expenditure ---------------------------------------------
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

  -- ---------- §3.6 constraints and coach ------------------------------------------------
  create table constraint_profiles (user_id uuid primary key references auth.users(id) on delete cascade,
    rev integer not null default 1, conditions text[] not null default '{}', notes text,
    avoid_allergens text[] not null default '{gluten,dairy,apple}',
    avoid_food_ref_ids uuid[] not null default '{}',
    banned_categories text[] not null default '{simple_sugars}');
  create table coach_threads (id uuid primary key default gen_random_uuid(), title text,
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now());
  create table coach_messages (id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references coach_threads(id) on delete cascade,
    role text not null check (role in ('user','assistant','tool')), content text,
    tool_calls jsonb, policy_checks jsonb, created_at timestamptz not null default now());
  create table ai_calls (id uuid primary key default gen_random_uuid(), purpose text not null,
    user_id uuid not null references auth.users(id) on delete cascade, provider text not null,
    model_id text not null, sdk_version text not null, input_tokens integer, output_tokens integer,
    latency_ms integer, input_hash bytea, cost_estimate numeric,
    created_at timestamptz not null default now());
  create index ai_calls_user_day on ai_calls (user_id, created_at);
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from ai_calls;" -c "select count(*) from target_profiles;"
  ```
  Expected: `0` then `0`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000200_user_schema.sql && git commit -m "feat(db): add target, expenditure, constraint and coach tables"
  ```

---

## Task 6 — Migration 000300: change log, cursor and duplicate groups

**Files**
- Create: `supabase/migrations/20260911000300_sync.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `log_entries`.
- Produces: `change_seq`, `change_log`, `next_change_seq(p_user_id uuid) returns bigint`,
  `duplicate_groups`, `duplicate_group_members`.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select next_change_seq('00000000-0000-0000-0000-000000000001'::uuid);"
  ```
  Expected failure: `ERROR:  function next_change_seq(uuid) does not exist`.

- [ ] Write `supabase/migrations/20260911000300_sync.sql`:
  ```sql
  -- Phase 0: architecture v2.1 §3.7. One monotonic cursor per user, an append-only change feed,
  -- and the duplicate-group tables. The group card ships with Phase 2; the tables ship now.
  create table change_seq (user_id uuid primary key references auth.users(id) on delete cascade,
    next_seq bigint not null default 1);
  create table change_log (user_id uuid not null references auth.users(id) on delete cascade,
    seq bigint not null, entity text not null, entity_key text not null, rev integer not null,
    op text not null check (op in ('create','update','delete','restore')), op_id uuid,
    current jsonb,          -- the row after the op (null for delete; tombstone fields for restore)
    at timestamptz not null default now(), primary key (user_id, seq));
  create index change_log_entity on change_log (user_id, entity, entity_key);
  -- Idempotency: apply_sync_op answers 'duplicate' from this index, so a retried push never
  -- re-applies. Not in the §3.7 DDL block; required by the §2 op_id contract.
  create unique index change_log_op_id on change_log (op_id) where op_id is not null;

  create function next_change_seq(p_user_id uuid) returns bigint language sql
    security definer set search_path = public as $$
    insert into change_seq (user_id, next_seq) values (p_user_id, 2)
      on conflict (user_id) do update set next_seq = change_seq.next_seq + 1
      returning next_seq - 1; $$;
  revoke execute on function next_change_seq(uuid) from public, anon, authenticated;
  grant execute on function next_change_seq(uuid) to service_role;

  create table duplicate_groups (id uuid primary key default gen_random_uuid(), local_date date not null,
    user_id uuid not null references auth.users(id) on delete cascade, fingerprint bytea not null,
    slot text not null, state text not null default 'open' check (state in ('open','dismissed','merged')),
    merged_into_entry_id uuid references log_entries(id), rev integer not null default 1,
    created_at timestamptz not null default now(), decided_at timestamptz, unique (user_id, fingerprint));
  create table duplicate_group_members (
    group_id uuid not null references duplicate_groups(id) on delete cascade,
    entry_id uuid not null references log_entries(id) on delete cascade, primary key (group_id, entry_id));
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from change_log;" \
    -c "select count(*) from pg_proc where proname = 'next_change_seq';"
  ```
  Expected: `0` then `1`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000300_sync.sql && git commit -m "feat(db): add change log, per-user cursor and duplicate groups"
  ```

---

## Task 7 — Migration 000400: privileged tables and the health dedupe key

**Files**
- Create: `supabase/migrations/20260911000400_privileged.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `auth.users`.
- Produces: `api_tokens`, `health_sources` (kind includes `'manual'`), `ingest_events`,
  `health_samples` with the stored `dedupe_key` generated column and
  `health_samples_dedupe` unique index.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At -c "select count(*) from api_tokens;"
  ```
  Expected failure: `ERROR:  relation "api_tokens" does not exist`.

- [ ] Write `supabase/migrations/20260911000400_privileged.sql`:
  ```sql
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
    -- extract(epoch …) on timestamptz is IMMUTABLE; to_char/at time zone are only STABLE and are
    -- rejected in a stored generated column.
    dedupe_key text generated always as (coalesce(vendor_sample_id,
      type || '|' || (extract(epoch from start_time))::bigint::text
           || '|' || (extract(epoch from end_time))::bigint::text)) stored);
  create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select pg_get_constraintdef(oid) like '%manual%' from pg_constraint where conname = 'health_sources_kind_check';" \
    -c "select count(*) from pg_attribute where attrelid = 'health_samples'::regclass and attname = 'dedupe_key' and attgenerated = 's';"
  ```
  Expected: `t` then `1`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000400_privileged.sql && git commit -m "feat(db): add api_tokens and health ingest tables"
  ```

---

## Task 8 — Migration 000500: RLS, the weigh_ins view and grants

**Files**
- Create: `supabase/migrations/20260911000500_rls.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: every table from Tasks 2–7.
- Produces: RLS on every table; view `weigh_ins (user_id, id, start_time, local_date, value, unit)`
  with `security_invoker = true`.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_tables where schemaname='public' and not rowsecurity;"
  ```
  Expected failure: prints a non-zero count (every table is currently unprotected).

- [ ] Write `supabase/migrations/20260911000500_rls.sql`:
  ```sql
  -- Phase 0: architecture v2.1 §2.1. Three shapes, three patterns, written out per table rather
  -- than looped, so a reader sees exactly which policy guards which table.

  -- ---------- pattern 1: owner tables (user_id column) ---------------------------------
  do $$
  declare t text;
  begin
    foreach t in array array[
      'user_foods','user_food_prefs','log_entries','water_log','plan_days','user_settings','gut_log',
      'recipes','favorites_foods','favorites_recipes','favorites_meals',
      'target_profiles','expenditure_estimates','target_proposals',
      'constraint_profiles','coach_threads','ai_calls',
      'api_tokens','health_sources','ingest_events','health_samples',
      'change_seq','change_log','duplicate_groups']
    loop
      execute format('alter table %I enable row level security', t);
      execute format($f$create policy %I on %I for all to authenticated
        using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))$f$,
        t || '_rw', t);
      execute format('revoke all on table %I from anon', t);
      execute format('grant select, insert, update, delete on table %I to authenticated', t);
    end loop;
  end $$;

  -- ---------- pattern 2: child tables reached through their parent ----------------------
  alter table log_items enable row level security;
  create policy log_items_rw on log_items for all to authenticated
    using  (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())))
    with check (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())));

  alter table duplicate_group_members enable row level security;
  create policy duplicate_group_members_rw on duplicate_group_members for all to authenticated
    using  (exists (select 1 from duplicate_groups g where g.id = duplicate_group_members.group_id and g.user_id = (select auth.uid())))
    with check (exists (select 1 from duplicate_groups g where g.id = duplicate_group_members.group_id and g.user_id = (select auth.uid())));

  alter table recipe_revisions enable row level security;
  create policy recipe_revisions_rw on recipe_revisions for all to authenticated
    using  (exists (select 1 from recipes r where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())))
    with check (exists (select 1 from recipes r where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())));

  alter table recipe_items enable row level security;
  create policy recipe_items_rw on recipe_items for all to authenticated
    using  (exists (select 1 from recipe_revisions v join recipes r on r.id = v.recipe_id
                     where v.id = recipe_items.recipe_revision_id and r.user_id = (select auth.uid())))
    with check (exists (select 1 from recipe_revisions v join recipes r on r.id = v.recipe_id
                     where v.id = recipe_items.recipe_revision_id and r.user_id = (select auth.uid())));

  alter table favorites_meal_items enable row level security;
  create policy favorites_meal_items_rw on favorites_meal_items for all to authenticated
    using  (exists (select 1 from favorites_meals m where m.id = favorites_meal_items.meal_id and m.user_id = (select auth.uid())))
    with check (exists (select 1 from favorites_meals m where m.id = favorites_meal_items.meal_id and m.user_id = (select auth.uid())));

  do $$
  declare t text;
  begin
    foreach t in array array['log_items','duplicate_group_members','recipe_revisions',
                             'recipe_items','favorites_meal_items']
    loop
      execute format('revoke all on table %I from anon', t);
      execute format('grant select, insert, update, delete on table %I to authenticated', t);
    end loop;
  end $$;

  -- ---------- pattern 3: shared reference tables ----------------------------------------
  -- Read-only to users, written by the import worker with the admin client. food_refs rows of
  -- kind='user' are additionally filtered through the join to user_foods.user_id, so another
  -- user's custom food never appears in search.
  alter table food_refs enable row level security;
  create policy food_refs_read on food_refs for select to authenticated
    using (kind = 'catalog'
           or exists (select 1 from user_foods f
                       where f.id = food_refs.user_food_id and f.user_id = (select auth.uid())));
  revoke all on table food_refs from anon;
  grant select on table food_refs to authenticated;

  do $$
  declare t text;
  begin
    foreach t in array array['catalog_versions','catalog_foods','catalog_food_revisions',
      'catalog_nutrients','catalog_food_nutrients','catalog_barcodes','catalog_portions',
      'catalog_ingredients','catalog_dri']
    loop
      execute format('alter table %I enable row level security', t);
      execute format('create policy %I on %I for select to authenticated using (true)',
                     t || '_read', t);
      execute format('revoke all on table %I from anon', t);
      execute format('grant select on table %I to authenticated', t);
    end loop;
  end $$;

  -- ---------- views ---------------------------------------------------------------------
  -- A Postgres view runs as its owner by default and would bypass the RLS of its base tables.
  create view weigh_ins with (security_invoker = true) as
    select user_id, id, start_time, (start_time at time zone tz)::date as local_date, value, unit
      from health_samples where type = 'body_mass';
  revoke all on weigh_ins from anon;
  grant select on weigh_ins to authenticated;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_tables where schemaname='public' and not rowsecurity;" \
    -c "select 'security_invoker=true' = any (reloptions) from pg_class where relname='weigh_ins';"
  ```
  Expected: `0` then `t`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000500_rls.sql && git commit -m "feat(db): enable RLS on every table and add the weigh_ins view"
  ```

---

## Task 9 — Test helpers: seed functions and two test users

**Files**
- Create: `supabase/seed/test_helpers.sql`
- Create: `tests/helpers/supabase.ts`
- Test: `tests/rls/security-invoker.test.ts` is written in Task 14; this task's green is a temporary
  smoke assertion run with `node --experimental-strip-types`, then deleted in the same step. Keep the
  helper file itself free of tests.

**Interfaces**
- Consumes: `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`.
- Produces:
  ```ts
  export const HAS_BRANCH: boolean;
  export type TestUser = { id: string; email: string; password: string };
  export function adminClient(): SupabaseClient;
  export function anonClient(): SupabaseClient;
  export async function ensureUser(slot: 'a' | 'b'): Promise<TestUser>;
  export async function userClient(user: TestUser): Promise<SupabaseClient>;
  export async function resetUser(userId: string): Promise<void>;
  export async function createTestUsers(): Promise<{
    a: { client: SupabaseClient; userId: string };
    b: { client: SupabaseClient; userId: string };
    admin: SupabaseClient;
  }>;
  ```
  `createTestUsers` is the signature Lane C and Lane D's cross-user route tests import —
  `tests/sync/cross-user-http.test.ts` and `tests/export/cross-user.test.ts` — so both slots must
  come back already signed in, not just as `TestUser` records the caller has to sign in itself.

### Steps

- [ ] Failing test — create `tests/helpers/smoke.mjs` as a throwaway:
  ```js
  import { HAS_BRANCH, ensureUser, userClient, resetUser } from "./supabase.ts";
  if (!HAS_BRANCH) { console.log("skipped: no branch"); process.exit(0); }
  const a = await ensureUser("a");
  const b = await ensureUser("b");
  if (a.id === b.id) throw new Error("two users expected");
  await resetUser(a.id);
  const c = await userClient(a);
  const { data } = await c.auth.getUser();
  if (data.user?.id !== a.id) throw new Error("user client is not user a");
  console.log("helpers ok");
  ```
  Run it:
  ```bash
  node --experimental-strip-types tests/helpers/smoke.mjs
  ```
  Expected failure: `Cannot find module '.../tests/helpers/supabase.ts'`.

- [ ] Write `supabase/seed/test_helpers.sql`:
  ```sql
  -- TEST-ONLY helpers. Applied by scripts/db-branch.sh to a preview branch, never to production.
  -- [db.seed] enabled = false in config.toml keeps `supabase db reset --linked` from installing them.

  -- Raw catalog read for tests/rls/security-invoker.test.ts. PostgREST cannot reach pg_class.
  create or replace function test_view_options()
    returns table (view_name text, options text[])
    language sql stable security definer set search_path = public, pg_catalog as $$
    select c.relname::text, coalesce(c.reloptions, '{}'::text[])
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'; $$;
  revoke execute on function test_view_options() from public, anon, authenticated;
  grant execute on function test_view_options() to service_role;

  -- Clear one user's rows between tests, children first.
  create or replace function test_reset_user(p_user_id uuid) returns void
    language plpgsql security definer set search_path = public as $$
  begin
    delete from change_log     where user_id = p_user_id;
    delete from change_seq     where user_id = p_user_id;
    delete from duplicate_groups where user_id = p_user_id;
    delete from log_entries    where user_id = p_user_id;
    delete from water_log      where user_id = p_user_id;
    delete from plan_days      where user_id = p_user_id;
    delete from gut_log        where user_id = p_user_id;
    delete from user_settings  where user_id = p_user_id;
    delete from user_food_prefs where user_id = p_user_id;
    delete from user_foods     where user_id = p_user_id;   -- cascades to food_refs
    delete from health_samples where user_id = p_user_id;
    delete from ingest_events  where user_id = p_user_id;
    delete from health_sources where user_id = p_user_id;
    delete from api_tokens     where user_id = p_user_id;
    delete from target_proposals where user_id = p_user_id;
    delete from expenditure_estimates where user_id = p_user_id;
    delete from target_profiles where user_id = p_user_id;
    delete from constraint_profiles where user_id = p_user_id;
    delete from ai_calls       where user_id = p_user_id;
  end; $$;
  revoke execute on function test_reset_user(uuid) from public, anon, authenticated;
  grant execute on function test_reset_user(uuid) to service_role;
  ```

- [ ] Write `tests/helpers/supabase.ts`:
  ```ts
  /**
   * Integration-test harness for the Phase 0 Supabase branch.
   *
   * Env (printed by `bash scripts/db-branch.sh env`):
   *   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
   * Every suite in tests/ skips itself when SUPABASE_TEST_URL is unset, so CI stays green
   * without a branch.
   */
  import { createClient, type SupabaseClient } from "@supabase/supabase-js";

  const URL = process.env.SUPABASE_TEST_URL ?? "";
  const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? "";
  const SECRET = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";

  export const HAS_BRANCH = URL.length > 0 && ANON.length > 0 && SECRET.length > 0;

  export type TestUser = { id: string; email: string; password: string };

  const CREDENTIALS: Record<"a" | "b", { email: string; password: string }> = {
    a: { email: "p0-user-a@meal-companion.test", password: "p0-user-a-password-1" },
    b: { email: "p0-user-b@meal-companion.test", password: "p0-user-b-password-1" },
  };

  export function adminClient(): SupabaseClient {
    return createClient(URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  export function anonClient(): SupabaseClient {
    return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async function findByEmail(email: string): Promise<string | null> {
    const admin = adminClient();
    for (let page = 1; page <= 10; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const hit = data.users.find((u) => u.email === email);
      if (hit) return hit.id;
      if (data.users.length < 200) return null;
    }
    return null;
  }

  export async function ensureUser(slot: "a" | "b"): Promise<TestUser> {
    const { email, password } = CREDENTIALS[slot];
    const existing = await findByEmail(email);
    if (existing) return { id: existing, email, password };
    const { data, error } = await adminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error(`could not create ${email}`);
    return { id: data.user.id, email, password };
  }

  export async function userClient(user: TestUser): Promise<SupabaseClient> {
    const client = anonClient();
    const { error } = await client.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    if (error) throw error;
    return client;
  }

  export async function resetUser(userId: string): Promise<void> {
    const { error } = await adminClient().rpc("test_reset_user", { p_user_id: userId });
    if (error) throw error;
  }

  /**
   * Convenience wrapper for cross-user route tests (Lane C's
   * tests/sync/cross-user-http.test.ts, Lane D's tests/export/cross-user.test.ts): both users
   * signed in and ready to authorize a Request, plus the admin client for seeding rows.
   */
  export async function createTestUsers(): Promise<{
    a: { client: SupabaseClient; userId: string };
    b: { client: SupabaseClient; userId: string };
    admin: SupabaseClient;
  }> {
    const [userA, userB] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    const [clientA, clientB] = await Promise.all([userClient(userA), userClient(userB)]);
    return {
      a: { client: clientA, userId: userA.id },
      b: { client: clientB, userId: userB.id },
      admin: adminClient(),
    };
  }
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && node --experimental-strip-types tests/helpers/smoke.mjs
  ```
  Expected: `helpers ok` (or `skipped: no branch` when `SUPABASE_TEST_URL` is unset).
  Then delete the throwaway:
  ```bash
  rm tests/helpers/smoke.mjs
  ```

- [ ] Commit:
  ```bash
  git add supabase/seed/test_helpers.sql tests/helpers/supabase.ts && git commit -m "test(db): add branch test helpers and two test users"
  ```

---

## Task 10 — Migration 000600 part 1: caller guard and the three non-sync RPCs

**Files**
- Create: `supabase/migrations/20260911000600_rpc.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `food_refs`, `user_foods`, `api_tokens`.
- Produces:
  ```sql
  create function _sync_assert_caller(p_user_id uuid) returns void;
  create function get_or_create_food_ref(p_user_id uuid, p_kind text, p_catalog_food_id bigint, p_user_food_id uuid) returns uuid;
  create function revoke_api_token(p_user_id uuid, p_token_id uuid) returns boolean;
  create function lookup_api_token(p_token_hash bytea) returns table (id uuid, user_id uuid, scopes text[]);
  ```

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select get_or_create_food_ref(null::uuid,'catalog',null::bigint,null::uuid);"
  ```
  Expected failure: `ERROR:  function get_or_create_food_ref(uuid, unknown, bigint, uuid) does not exist`.

- [ ] Write `supabase/migrations/20260911000600_rpc.sql`:
  ```sql
  -- Phase 0 RPCs. Every function: security definer, search_path pinned to public, execute revoked
  -- from public and anon. The first argument is always p_user_id (except lookup_api_token, which
  -- resolves the tenant from the token hash and is service_role only).

  -- A definer function called over PostgREST still sees the caller's JWT claims, so a signed-in
  -- user cannot pass someone else's p_user_id. The privileged boundary calls as service_role,
  -- where auth.uid() is null and p_user_id is authoritative.
  create function _sync_assert_caller(p_user_id uuid) returns void
    language plpgsql stable security definer set search_path = public as $$
  declare v_caller uuid := auth.uid();
  begin
    if p_user_id is null then
      raise exception 'user_required' using errcode = '22023';
    end if;
    if v_caller is not null and v_caller <> p_user_id then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end; $$;
  revoke execute on function _sync_assert_caller(uuid) from public, anon;

  create function get_or_create_food_ref(p_user_id uuid, p_kind text,
                                         p_catalog_food_id bigint, p_user_food_id uuid)
    returns uuid language plpgsql security definer set search_path = public as $$
  declare v_id uuid;
  begin
    perform _sync_assert_caller(p_user_id);
    if p_kind = 'catalog' then
      if p_catalog_food_id is null then raise exception 'catalog_food_id_required' using errcode = '22023'; end if;
      select id into v_id from food_refs where catalog_food_id = p_catalog_food_id;
      if v_id is null then
        insert into food_refs (kind, catalog_food_id) values ('catalog', p_catalog_food_id)
          on conflict (catalog_food_id) where catalog_food_id is not null do nothing
          returning id into v_id;
        if v_id is null then select id into v_id from food_refs where catalog_food_id = p_catalog_food_id; end if;
      end if;
    elsif p_kind = 'user' then
      if p_user_food_id is null then raise exception 'user_food_id_required' using errcode = '22023'; end if;
      if not exists (select 1 from user_foods f where f.id = p_user_food_id and f.user_id = p_user_id) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      select id into v_id from food_refs where user_food_id = p_user_food_id;
      if v_id is null then
        insert into food_refs (kind, user_food_id) values ('user', p_user_food_id)
          on conflict (user_food_id) where user_food_id is not null do nothing
          returning id into v_id;
        if v_id is null then select id into v_id from food_refs where user_food_id = p_user_food_id; end if;
      end if;
    else
      raise exception 'bad_kind' using errcode = '22023';
    end if;
    return v_id;
  end; $$;
  revoke execute on function get_or_create_food_ref(uuid, text, bigint, uuid) from public, anon;
  grant execute on function get_or_create_food_ref(uuid, text, bigint, uuid) to authenticated, service_role;

  create function revoke_api_token(p_user_id uuid, p_token_id uuid) returns boolean
    language plpgsql security definer set search_path = public as $$
  begin
    perform _sync_assert_caller(p_user_id);
    update api_tokens set revoked_at = now()
      where id = p_token_id and user_id = p_user_id and revoked_at is null;
    return found;
  end; $$;
  revoke execute on function revoke_api_token(uuid, uuid) from public, anon;
  grant execute on function revoke_api_token(uuid, uuid) to authenticated, service_role;

  -- Not granted to `authenticated`: it maps a token hash to a tenant, which is the privileged
  -- boundary's business only. Contracts §2's blanket grant is deliberately narrowed here.
  create function lookup_api_token(p_token_hash bytea)
    returns table (id uuid, user_id uuid, scopes text[])
    language plpgsql security definer set search_path = public as $$
  begin
    -- RETURN QUERY takes a SELECT, so the update is wrapped in a CTE.
    return query
      with touched as (
        update api_tokens t set last_used_at = now()
          where t.token_hash = p_token_hash
            and t.revoked_at is null
            and (t.expires_at is null or t.expires_at > now())
          returning t.id, t.user_id, t.scopes)
      select touched.id, touched.user_id, touched.scopes from touched;
  end; $$;
  revoke execute on function lookup_api_token(bytea) from public, anon, authenticated;
  grant execute on function lookup_api_token(bytea) to service_role;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_proc where proname in ('get_or_create_food_ref','revoke_api_token','lookup_api_token','_sync_assert_caller');"
  ```
  Expected: `4`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000600_rpc.sql && git commit -m "feat(db): add caller guard, food_ref and api_token RPCs"
  ```

---

## Task 11 — Migration 000600 part 2: entity-key validation and `_sync_current`

**Files**
- Modify: `supabase/migrations/20260911000600_rpc.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: the eight synced tables.
- Produces:
  ```sql
  create function _sync_assert_key(p_entity text, p_key text) returns void;
  create function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb;
  ```
  `_sync_current` returns the row as `jsonb` (log_entries carries `items` inline, ordered by `seq`),
  or `null` when the row is absent.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select _sync_assert_key('user_settings','settings');"
  ```
  Expected failure: `ERROR:  function _sync_assert_key(unknown, unknown) does not exist`.

- [ ] Append to `supabase/migrations/20260911000600_rpc.sql`:
  ```sql
  -- entity_key encoding, contracts §4. These strings must match lib/sync/keys.ts exactly.
  --   user_foods | log_entries | gut_log | duplicate_groups | user_food_prefs -> lowercase uuid
  --   plan_days | water_log                                                   -> YYYY-MM-DD
  --   user_settings                                                           -> 'settings'
  create function _sync_assert_key(p_entity text, p_key text) returns void
    language plpgsql immutable as $$
  begin
    if p_key is null then raise exception 'entity_key_required' using errcode = '22023'; end if;
    if p_entity in ('user_foods','log_entries','gut_log','duplicate_groups','user_food_prefs') then
      if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'bad_entity_key' using errcode = '22023';
      end if;
    elsif p_entity in ('plan_days','water_log') then
      if p_key !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'bad_entity_key' using errcode = '22023';
      end if;
    elsif p_entity = 'user_settings' then
      if p_key <> 'settings' then
        raise exception 'bad_entity_key' using errcode = '22023';
      end if;
    else
      raise exception 'unknown_entity' using errcode = '22023';
    end if;
  end; $$;
  revoke execute on function _sync_assert_key(text, text) from public, anon;

  create function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
    language plpgsql stable security definer set search_path = public as $$
  declare v jsonb;
  begin
    perform _sync_assert_key(p_entity, p_key);
    if p_entity = 'user_foods' then
      select to_jsonb(t) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
    elsif p_entity = 'user_food_prefs' then
      select to_jsonb(t) into v from user_food_prefs t
        where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
    elsif p_entity = 'log_entries' then
      select to_jsonb(e) || jsonb_build_object('items', coalesce(
               (select jsonb_agg(to_jsonb(i) order by i.seq) from log_items i where i.entry_id = e.id),
               '[]'::jsonb))
        into v from log_entries e where e.user_id = p_user_id and e.id = p_key::uuid;
    elsif p_entity = 'water_log' then
      select to_jsonb(t) into v from water_log t
        where t.user_id = p_user_id and t.local_date = p_key::date;
    elsif p_entity = 'plan_days' then
      select to_jsonb(t) into v from plan_days t
        where t.user_id = p_user_id and t.local_date = p_key::date;
    elsif p_entity = 'user_settings' then
      select to_jsonb(t) into v from user_settings t where t.user_id = p_user_id;
    elsif p_entity = 'gut_log' then
      select to_jsonb(t) into v from gut_log t where t.user_id = p_user_id and t.id = p_key::uuid;
    elsif p_entity = 'duplicate_groups' then
      select to_jsonb(t) || jsonb_build_object('fingerprint', encode(t.fingerprint, 'hex'))
        into v from duplicate_groups t where t.user_id = p_user_id and t.id = p_key::uuid;
    end if;
    return v;
  end; $$;
  revoke execute on function _sync_current(uuid, text, text) from public, anon;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select _sync_assert_key('user_settings','settings') is null;" \
    -c "select _sync_current('00000000-0000-0000-0000-000000000001'::uuid,'water_log','2026-09-11') is null;"
  ```
  Expected: `t` then `t`. Then confirm the guard bites:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -At -c "select _sync_assert_key('water_log','not-a-date');"
  ```
  Expected: `ERROR:  bad_entity_key`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000600_rpc.sql && git commit -m "feat(db): add entity key validation and current-row reader"
  ```

---

## Task 12 — Migration 000600 part 3: `_sync_upsert` and `_sync_tombstone`

**Files**
- Modify: `supabase/migrations/20260911000600_rpc.sql`
- Test: psql assertion in the steps ([needs branch]).

**Interfaces**
- Consumes: `_sync_assert_key`, `_sync_current`.
- Produces:
  ```sql
  create function _sync_upsert(p_user_id uuid, p_entity text, p_key text, p_payload jsonb, p_rev integer) returns jsonb;
  create function _sync_tombstone(p_user_id uuid, p_entity text, p_key text, p_kind text, p_rev integer) returns jsonb;
  ```
  Both return the row after the write (`jsonb`), or `null` when a hard delete removed it.

Payload fields per entity, which Lane C's ops must carry:

| Entity | Payload keys |
|---|---|
| `user_foods` | `name`, `brand`, `ingredients_text`, `catalog_food_id`, `kind`, `per_100g`, `allergen_tags` |
| `user_food_prefs` | `status`, `role`, `no_cook`, `note` |
| `log_entries` | `note`, `media_ref`, `eaten_at`, `tz`, `local_date`, `slot`, `method`, `items[]` |
| `water_log` | `cups` |
| `plan_days` | `day_type_override`, `floor_day`, `swaps`, `slot_notes` |
| `user_settings` | `first_opened_at`, `scale_warning_dismissed`, `training_kcal`, `rest_kcal`, `protein_g`, `protein_locked`, `ramp_override`, `slot_times`, `shift_minutes`, `changed_at` |
| `gut_log` | `local_date`, `tz`, `state`, `note` |
| `duplicate_groups` | `local_date`, `fingerprint` (hex), `slot`, `state`, `merged_into_entry_id`, `decided_at` |

`log_entries.items[]` carries `id`, `seq`, `qty`, `unit`, `food_ref_id`, `grams`, `snapshot`,
`food_revision_id`, `portion_id`, `was_edited`, `confidence`, and is replaced wholesale on update.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select _sync_upsert('00000000-0000-0000-0000-000000000001'::uuid,'water_log','2026-09-11','{\"cups\":2}'::jsonb,1);"
  ```
  Expected failure: `ERROR:  function _sync_upsert(uuid, unknown, unknown, jsonb, integer) does not exist`.

- [ ] Append to `supabase/migrations/20260911000600_rpc.sql`:
  ```sql
  -- Insert-or-update one synced row. apply_sync_op has already decided create vs update, so a
  -- single upsert per entity keeps the write path to one statement.
  create function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                               p_payload jsonb, p_rev integer) returns jsonb
    language plpgsql security definer set search_path = public as $$
  begin
    perform _sync_assert_key(p_entity, p_key);
    if p_entity = 'user_foods' then
      insert into user_foods (id, user_id, name, brand, ingredients_text, catalog_food_id, kind,
                              per_100g, allergen_tags, rev, deleted_at)
      values (p_key::uuid, p_user_id, p_payload->>'name', p_payload->>'brand',
              p_payload->>'ingredients_text', (p_payload->>'catalog_food_id')::bigint,
              coalesce(p_payload->>'kind', 'custom'),
              coalesce(p_payload->'per_100g', '{}'::jsonb),
              coalesce(array(select jsonb_array_elements_text(p_payload->'allergen_tags')), '{}'::text[]),
              p_rev, null)
      on conflict (id) do update set name = excluded.name, brand = excluded.brand,
        ingredients_text = excluded.ingredients_text, catalog_food_id = excluded.catalog_food_id,
        kind = excluded.kind, per_100g = excluded.per_100g, allergen_tags = excluded.allergen_tags,
        rev = excluded.rev;
    elsif p_entity = 'user_food_prefs' then
      insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, rev, updated_at)
      values (p_user_id, p_key::uuid, p_payload->>'status', p_payload->>'role',
              coalesce((p_payload->>'no_cook')::boolean, false), p_payload->>'note', p_rev, now())
      on conflict (user_id, food_ref_id) do update set status = excluded.status,
        role = excluded.role, no_cook = excluded.no_cook, note = excluded.note,
        rev = excluded.rev, updated_at = now();
    elsif p_entity = 'log_entries' then
      insert into log_entries (id, user_id, note, media_ref, eaten_at, tz, local_date, slot, method,
                               rev, deleted_at)
      values (p_key::uuid, p_user_id, p_payload->>'note', p_payload->>'media_ref',
              (p_payload->>'eaten_at')::timestamptz, p_payload->>'tz',
              (p_payload->>'local_date')::date, p_payload->>'slot', p_payload->>'method', p_rev, null)
      on conflict (id) do update set note = excluded.note, media_ref = excluded.media_ref,
        eaten_at = excluded.eaten_at, tz = excluded.tz, local_date = excluded.local_date,
        slot = excluded.slot, method = excluded.method, rev = excluded.rev;
      delete from log_items where entry_id = p_key::uuid;
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot,
                             food_revision_id, portion_id, was_edited, confidence)
      select coalesce(i.id, gen_random_uuid()), p_key::uuid, i.seq, i.qty, i.unit, i.food_ref_id,
             i.grams, coalesce(i.snapshot, '{}'::jsonb), i.food_revision_id, i.portion_id,
             coalesce(i.was_edited, false), i.confidence
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);
    elsif p_entity = 'water_log' then
      insert into water_log (user_id, local_date, cups, rev)
      values (p_user_id, p_key::date, coalesce((p_payload->>'cups')::integer, 0), p_rev)
      on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
    elsif p_entity = 'plan_days' then
      insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                             rev, updated_at)
      values (p_user_id, p_key::date, p_payload->>'day_type_override',
              coalesce((p_payload->>'floor_day')::boolean, false),
              coalesce(p_payload->'swaps', '{}'::jsonb),
              coalesce(p_payload->'slot_notes', '{}'::jsonb), p_rev, now())
      on conflict (user_id, local_date) do update set day_type_override = excluded.day_type_override,
        floor_day = excluded.floor_day, swaps = excluded.swaps, slot_notes = excluded.slot_notes,
        rev = excluded.rev, updated_at = now();
    elsif p_entity = 'user_settings' then
      insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                                 rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                                 shift_minutes, changed_at, rev)
      values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
              coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
              (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
              (p_payload->>'protein_g')::numeric,
              coalesce((p_payload->>'protein_locked')::boolean, true),
              (p_payload->>'ramp_override')::smallint,
              coalesce(p_payload->'slot_times', '{}'::jsonb),
              coalesce((p_payload->>'shift_minutes')::integer, 0),
              (p_payload->>'changed_at')::timestamptz, p_rev)
      on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
        scale_warning_dismissed = excluded.scale_warning_dismissed,
        training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
        protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
        ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
        shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at, rev = excluded.rev;
    elsif p_entity = 'gut_log' then
      insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
      values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
              p_payload->>'state', p_payload->>'note', p_rev, null)
      on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
        state = excluded.state, note = excluded.note, rev = excluded.rev;
    elsif p_entity = 'duplicate_groups' then
      insert into duplicate_groups (id, user_id, local_date, fingerprint, slot, state,
                                    merged_into_entry_id, decided_at, rev)
      values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date,
              decode(p_payload->>'fingerprint', 'hex'), p_payload->>'slot',
              coalesce(p_payload->>'state', 'open'),
              (p_payload->>'merged_into_entry_id')::uuid,
              (p_payload->>'decided_at')::timestamptz, p_rev)
      on conflict (id) do update set local_date = excluded.local_date,
        fingerprint = excluded.fingerprint, slot = excluded.slot, state = excluded.state,
        merged_into_entry_id = excluded.merged_into_entry_id, decided_at = excluded.decided_at,
        rev = excluded.rev;
    end if;
    return _sync_current(p_user_id, p_entity, p_key);
  end; $$;
  revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;

  -- Delete and restore, for the three tombstone-capable entities only (contracts §2:
  -- user_foods, log_entries, gut_log). apply_sync_op answers every other delete/restore shape
  -- itself — 'unsupported' for an entity without deleted_at, an idempotent 'applied' no-op for a
  -- restore of a row that was never tombstoned — so this function is never asked to guess, and
  -- never raises.
  create function _sync_tombstone(p_user_id uuid, p_entity text, p_key text,
                                  p_kind text, p_rev integer) returns jsonb
    language plpgsql security definer set search_path = public as $$
  declare v_deleted_at timestamptz := case when p_kind = 'delete' then now() else null end;
  begin
    perform _sync_assert_key(p_entity, p_key);
    if p_entity = 'user_foods' then
      update user_foods set deleted_at = v_deleted_at, rev = p_rev
        where user_id = p_user_id and id = p_key::uuid;
    elsif p_entity = 'log_entries' then
      update log_entries set deleted_at = v_deleted_at, rev = p_rev
        where user_id = p_user_id and id = p_key::uuid;
    elsif p_entity = 'gut_log' then
      update gut_log set deleted_at = v_deleted_at, rev = p_rev
        where user_id = p_user_id and id = p_key::uuid;
    end if;
    return _sync_current(p_user_id, p_entity, p_key);
  end; $$;
  revoke execute on function _sync_tombstone(uuid, text, text, text, integer) from public, anon;
  ```

- [ ] Run — **[needs branch]**, expect PASS. Use the real user A id from the branch:
  ```bash
  pnpm db:reset
  # db:reset recreates auth.users too, so mint user A again before touching a user table.
  UID=$(node --experimental-strip-types --input-type=module \
    -e "import {ensureUser} from './tests/helpers/supabase.ts'; console.log((await ensureUser('a')).id)")
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select _sync_upsert('$UID'::uuid,'water_log','2026-09-11','{\"cups\":2}'::jsonb,1)->>'cups';" \
    -c "select _sync_upsert('$UID'::uuid,'gut_log','11111111-1111-4111-8111-111111111111','{\"local_date\":\"2026-09-11\",\"tz\":\"America/Los_Angeles\",\"state\":\"good\"}'::jsonb,1)->>'state';" \
    -c "select _sync_tombstone('$UID'::uuid,'gut_log','11111111-1111-4111-8111-111111111111','delete',2)->>'deleted_at' is not null;"
  ```
  Expected: `2`, then `good`, then `t`. (`_sync_tombstone` is exercised on a tombstone-capable entity —
  `gut_log` carries `deleted_at`; `water_log` does not, and `apply_sync_op` never calls
  `_sync_tombstone` for it — see Task 13's `unsupported` guard.)

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000600_rpc.sql && git commit -m "feat(db): add sync upsert and tombstone writers"
  ```

---

## Task 13 — Migration 000600 part 4: `apply_sync_op` and `sync_changes`

**Files**
- Modify: `supabase/migrations/20260911000600_rpc.sql`
- Test: psql assertion in the steps ([needs branch]); the behaviour matrix lands in Task 16.

**Interfaces**
- Consumes: `_sync_assert_caller`, `_sync_current`, `_sync_upsert`, `_sync_tombstone`,
  `next_change_seq`.
- Produces:
  ```sql
  create function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb;
  create function sync_changes(p_user_id uuid, p_since bigint, p_limit integer)
    returns table (seq bigint, entity text, entity_key text, rev integer, op text,
                   at timestamptz, current jsonb);
  ```
  `apply_sync_op` returns exactly one of:
  `{op_id,status:'applied',rev,seq}` · `{op_id,status:'conflict',entity,current_rev,current}` ·
  `{op_id,status:'deleted',entity,deleted_at}` · `{op_id,status:'gone'}` · `{op_id,status:'duplicate'}` ·
  `{op_id,status:'unsupported'}`. It never raises for a client-shaped op — a bad `entity`/`kind`
  combination the RPC's own JSON contract cannot represent still raises (`bad_op_kind`,
  `op_id_required`), but a `delete`/`restore` on an entity without `deleted_at` is `'unsupported'`,
  not an exception.

### Steps

- [ ] Failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select apply_sync_op('00000000-0000-0000-0000-000000000001'::uuid,'{}'::jsonb);"
  ```
  Expected failure: `ERROR:  function apply_sync_op(uuid, jsonb) does not exist`.

- [ ] Append to `supabase/migrations/20260911000600_rpc.sql`:
  ```sql
  -- One op, one transaction, contracts §2. The caller (app/api/sync/ops/route.ts) issues one RPC
  -- per op in array order; PostgREST wraps each call in its own transaction.
  create function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
    language plpgsql security definer set search_path = public as $$
  declare
    v_op_id   uuid    := (p_op->>'op_id')::uuid;
    v_entity  text    := p_op->>'entity';
    v_key     text    := p_op->>'entity_id';
    v_kind    text    := p_op->>'kind';
    v_base    integer := (p_op->>'base_rev')::integer;
    v_current jsonb;
    v_rev     integer;
    v_seq     bigint;
    v_after   jsonb;
  begin
    perform _sync_assert_caller(p_user_id);
    if v_op_id is null then raise exception 'op_id_required' using errcode = '22023'; end if;
    if v_kind not in ('create','update','delete','restore') then
      raise exception 'bad_op_kind' using errcode = '22023';
    end if;
    perform _sync_assert_key(v_entity, v_key);

    if exists (select 1 from change_log where op_id = v_op_id) then
      return jsonb_build_object('op_id', v_op_id, 'status', 'duplicate');
    end if;

    -- contracts §2: only user_foods, log_entries and gut_log carry deleted_at. A delete or restore
    -- on any other entity is a client-shaped op this server cannot express. apply_sync_op NEVER
    -- raises for that — it answers 'unsupported' and writes nothing.
    if v_kind in ('delete', 'restore') and v_entity not in ('user_foods', 'log_entries', 'gut_log') then
      return jsonb_build_object('op_id', v_op_id, 'status', 'unsupported');
    end if;

    v_current := _sync_current(p_user_id, v_entity, v_key);

    if v_kind = 'create' then
      if v_current is not null then
        return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                  'current_rev', (v_current->>'rev')::integer, 'current', v_current);
      end if;
      v_rev := 1;
    else
      if v_current is null then
        return jsonb_build_object('op_id', v_op_id, 'status', 'gone');
      end if;
      if v_current->>'deleted_at' is not null and v_kind <> 'restore' then
        return jsonb_build_object('op_id', v_op_id, 'status', 'deleted', 'entity', v_entity,
                                  'deleted_at', v_current->>'deleted_at');
      end if;
      -- A restore on a row that was never tombstoned already satisfies the client's intent (this
      -- row is not deleted) — idempotent no-op, no change_log row, and NOT a new seq.
      if v_kind = 'restore' and v_current->>'deleted_at' is null then
        return jsonb_build_object('op_id', v_op_id, 'status', 'applied',
          'rev', (v_current->>'rev')::integer,
          'seq', coalesce((select max(seq) from change_log
                             where user_id = p_user_id and entity = v_entity and entity_key = v_key), 0));
      end if;
      if v_base is null or v_base <> (v_current->>'rev')::integer then
        return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                  'current_rev', (v_current->>'rev')::integer, 'current', v_current);
      end if;
      v_rev := (v_current->>'rev')::integer + 1;
    end if;

    if v_kind in ('create','update') then
      v_after := _sync_upsert(p_user_id, v_entity, v_key, coalesce(p_op->'payload', '{}'::jsonb), v_rev);
    else
      v_after := _sync_tombstone(p_user_id, v_entity, v_key, v_kind, v_rev);
    end if;

    v_seq := next_change_seq(p_user_id);
    insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
    values (p_user_id, v_seq, v_entity, v_key, v_rev, v_kind, v_op_id,
            case when v_kind = 'delete' then null else v_after end);

    return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'rev', v_rev, 'seq', v_seq);
  end; $$;
  revoke execute on function apply_sync_op(uuid, jsonb) from public, anon;
  grant execute on function apply_sync_op(uuid, jsonb) to authenticated, service_role;

  create function sync_changes(p_user_id uuid, p_since bigint, p_limit integer)
    returns table (seq bigint, entity text, entity_key text, rev integer, op text,
                   at timestamptz, current jsonb)
    language plpgsql stable security definer set search_path = public as $$
  begin
    perform _sync_assert_caller(p_user_id);
    return query
      select c.seq, c.entity, c.entity_key, c.rev, c.op, c.at, c.current
        from change_log c
       where c.user_id = p_user_id and c.seq > coalesce(p_since, 0)
       order by c.seq asc
       limit least(greatest(coalesce(p_limit, 500), 1), 500);
  end; $$;
  revoke execute on function sync_changes(uuid, bigint, integer) from public, anon;
  grant execute on function sync_changes(uuid, bigint, integer) to authenticated, service_role;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset
  UID=$(node --experimental-strip-types --input-type=module \
    -e "import {ensureUser} from './tests/helpers/supabase.ts'; console.log((await ensureUser('a')).id)")
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select apply_sync_op('$UID'::uuid, jsonb_build_object('op_id', gen_random_uuid(), 'entity','water_log','entity_id','2026-09-11','kind','create','base_rev',null,'payload',jsonb_build_object('cups',2),'client_ts',now()))->>'status';" \
    -c "select count(*) from sync_changes('$UID'::uuid, 0, 500);"
  ```
  Expected: `applied` then `1`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260911000600_rpc.sql && git commit -m "feat(db): add apply_sync_op compare-and-swap and sync_changes feed"
  ```

---

## Task 14 — `tests/rls/security-invoker.test.ts`

**Files**
- Create: `tests/rls/security-invoker.test.ts`
- Test path: `tests/rls/security-invoker.test.ts`

**Interfaces**
- Consumes: `adminClient()`, `HAS_BRANCH` from `tests/helpers/supabase.ts`; `test_view_options()`.
- Produces: nothing.

### Steps

- [ ] Write the failing test:
  ```ts
  import { describe, expect, it } from "vitest";
  import { HAS_BRANCH, adminClient } from "../helpers/supabase";

  describe.skipIf(!HAS_BRANCH)("views are security_invoker", () => {
    it("every view in public reports security_invoker=true", async () => {
      const { data, error } = await adminClient().rpc("test_view_options");
      expect(error).toBeNull();
      const views = (data ?? []) as { view_name: string; options: string[] }[];
      expect(views.length).toBeGreaterThan(0);
      for (const v of views) {
        expect(v.options, `${v.view_name} is not security_invoker`).toContain("security_invoker=true");
      }
    });

    it("weigh_ins is one of them", async () => {
      const { data } = await adminClient().rpc("test_view_options");
      const names = ((data ?? []) as { view_name: string }[]).map((v) => v.view_name);
      expect(names).toContain("weigh_ins");
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL before `pnpm db:reset` has installed the seed helpers:
  ```bash
  pnpm exec vitest run tests/rls/security-invoker.test.ts
  ```
  Expected failure while the seed file is not applied: `expected null to be … Could not find the
  function public.test_view_options`. With `SUPABASE_TEST_URL` unset the suite reports
  `2 skipped`, which is the CI condition.

- [ ] Minimal implementation: nothing new to write — the seed helper from Task 9 and the view from
  Task 8 already exist. Apply them:
  ```bash
  pnpm db:reset
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm exec vitest run tests/rls/security-invoker.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  2 passed`.

- [ ] Commit:
  ```bash
  git add tests/rls/security-invoker.test.ts && git commit -m "test(db): assert every view is security_invoker"
  ```

---

## Task 15 — `tests/rls/cross-user.test.ts`

**Files**
- Create: `tests/rls/cross-user.test.ts`
- Test path: `tests/rls/cross-user.test.ts`

**Interfaces**
- Consumes: `ensureUser`, `userClient`, `adminClient`, `resetUser`, `HAS_BRANCH`;
  `apply_sync_op`, `get_or_create_food_ref`, `revoke_api_token`, `sync_changes`.
- Produces: nothing.

### Steps

- [ ] Write the failing test:
  ```ts
  import { beforeAll, describe, expect, it } from "vitest";
  import {
    HAS_BRANCH, adminClient, ensureUser, resetUser, userClient, type TestUser,
  } from "../helpers/supabase";
  import type { SupabaseClient } from "@supabase/supabase-js";

  const USER_TABLES = [
    "user_foods", "user_food_prefs", "log_entries", "water_log", "plan_days", "user_settings",
    "gut_log", "recipes", "favorites_foods", "favorites_recipes", "favorites_meals",
    "target_profiles", "expenditure_estimates", "target_proposals", "constraint_profiles",
    "coach_threads", "ai_calls", "api_tokens", "health_sources", "ingest_events", "health_samples",
    "change_seq", "change_log", "duplicate_groups", "log_items", "duplicate_group_members",
    "weigh_ins",
  ] as const;

  describe.skipIf(!HAS_BRANCH)("cross-user denial", () => {
    let a: TestUser;
    let b: TestUser;
    let bClient: SupabaseClient;
    let foodId: string;
    let tokenId: string;

    beforeAll(async () => {
      a = await ensureUser("a");
      b = await ensureUser("b");
      await resetUser(a.id);
      await resetUser(b.id);
      const admin = adminClient();

      foodId = "11111111-1111-4111-8111-111111111111";
      const ops = [
        { entity: "user_foods", entity_id: foodId, payload: { name: "Chicken", kind: "custom" } },
        { entity: "water_log", entity_id: "2026-09-11", payload: { cups: 3 } },
        { entity: "plan_days", entity_id: "2026-09-11", payload: { floor_day: true } },
        { entity: "gut_log", entity_id: "22222222-2222-4222-8222-222222222222",
          payload: { local_date: "2026-09-11", tz: "America/New_York", state: "good" } },
        { entity: "user_settings", entity_id: "settings",
          payload: { first_opened_at: new Date().toISOString() } },
      ];
      for (const op of ops) {
        const { data, error } = await admin.rpc("apply_sync_op", {
          p_user_id: a.id,
          p_op: { op_id: crypto.randomUUID(), kind: "create", base_rev: null,
                  client_ts: new Date().toISOString(), ...op },
        });
        expect(error).toBeNull();
        expect((data as { status: string }).status).toBe("applied");
      }

      const source = await admin.from("health_sources")
        .insert({ user_id: a.id, kind: "manual", device_label: "typed" }).select("id").single();
      expect(source.error).toBeNull();
      const sample = await admin.from("health_samples").insert({
        user_id: a.id, source_id: source.data!.id, type: "body_mass", value: 140, unit: "lb",
        start_time: "2026-09-11T12:00:00Z", end_time: "2026-09-11T12:00:00Z", tz: "America/New_York",
      });
      expect(sample.error).toBeNull();

      const token = await admin.from("api_tokens").insert({
        user_id: a.id, label: "codex", token_hash: Buffer.from("a".repeat(32)),
      }).select("id").single();
      expect(token.error).toBeNull();
      tokenId = token.data!.id;

      bClient = await userClient(b);
    });

    it.each(USER_TABLES)("user B reads zero rows from %s", async (table) => {
      const { data, error } = await bClient.from(table).select("*");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("user B cannot apply a sync op as user A", async () => {
      const { data, error } = await bClient.rpc("apply_sync_op", {
        p_user_id: a.id,
        p_op: { op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-11",
                kind: "update", base_rev: 1, payload: { cups: 99 },
                client_ts: new Date().toISOString() },
      });
      expect(data).toBeNull();
      expect(error?.message).toContain("forbidden");
      const check = await adminClient().from("water_log")
        .select("cups").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
      expect(check.data?.cups).toBe(3);
    });

    it("user B cannot read user A's change feed", async () => {
      const { data, error } = await bClient.rpc("sync_changes", {
        p_user_id: a.id, p_since: 0, p_limit: 500,
      });
      expect(data).toBeNull();
      expect(error?.message).toContain("forbidden");
    });

    it("user B cannot register a food_ref for user A's food", async () => {
      const { data, error } = await bClient.rpc("get_or_create_food_ref", {
        p_user_id: a.id, p_kind: "user", p_catalog_food_id: null, p_user_food_id: foodId,
      });
      expect(data).toBeNull();
      expect(error?.message).toContain("forbidden");
    });

    it("user B cannot revoke user A's token", async () => {
      const { data, error } = await bClient.rpc("revoke_api_token", {
        p_user_id: a.id, p_token_id: tokenId,
      });
      expect(data).toBeNull();
      expect(error?.message).toContain("forbidden");
      const check = await adminClient().from("api_tokens")
        .select("revoked_at").eq("id", tokenId).single();
      expect(check.data?.revoked_at).toBeNull();
    });

    it("user B cannot look up a token hash at all", async () => {
      const { error } = await bClient.rpc("lookup_api_token", {
        p_token_hash: `\\x${Buffer.from("a".repeat(32)).toString("hex")}`,
      });
      expect(error).not.toBeNull();
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL on the first run because user B still has no session
  isolation bug to catch; the run that must fail is the one before Task 8's RLS migration is applied.
  Reproduce it deliberately:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -c "alter table water_log disable row level security;"
  pnpm exec vitest run tests/rls/cross-user.test.ts
  ```
  Expected failure: `user B reads zero rows from water_log` — `expected [ { … cups: 3 … } ] to
  deeply equal []`.

- [ ] Minimal implementation: restore the policy that Task 8 already wrote.
  ```bash
  pnpm db:reset
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm exec vitest run tests/rls/cross-user.test.ts
  ```
  Expected: `Tests  32 passed` (27 table cases plus 5 RPC cases).

- [ ] Commit:
  ```bash
  git add tests/rls/cross-user.test.ts && git commit -m "test(db): assert cross-user denial on every table, view and RPC"
  ```

---

## Task 16 — `tests/rls/apply-sync-op.test.ts`

**Files**
- Create: `tests/rls/apply-sync-op.test.ts`
- Test path: `tests/rls/apply-sync-op.test.ts`

**Interfaces**
- Consumes: `ensureUser`, `userClient`, `adminClient`, `resetUser`, `HAS_BRANCH`; `apply_sync_op`,
  `sync_changes`.
- Produces: nothing.

### Steps

- [ ] Write the failing test:
  ```ts
  import { beforeEach, describe, expect, it } from "vitest";
  import {
    HAS_BRANCH, adminClient, ensureUser, resetUser, userClient, type TestUser,
  } from "../helpers/supabase";
  import type { SupabaseClient } from "@supabase/supabase-js";

  type Kind = "create" | "update" | "delete" | "restore";
  type Result = Record<string, unknown> & { status: string };

  const FOOD = "33333333-3333-4333-8333-333333333333";
  const GUT = "44444444-4444-4444-8444-444444444444";
  const ENTRY = "55555555-5555-4555-8555-555555555555";
  const GROUP = "66666666-6666-4666-8666-666666666666";
  const REF = "77777777-7777-4777-8777-777777777777";

  describe.skipIf(!HAS_BRANCH)("apply_sync_op", () => {
    let a: TestUser;
    let client: SupabaseClient;

    async function op(
      entity: string, entityId: string, kind: Kind,
      baseRev: number | null, payload: Record<string, unknown> = {},
      opId: string = crypto.randomUUID(),
    ): Promise<Result> {
      const { data, error } = await client.rpc("apply_sync_op", {
        p_user_id: a.id,
        p_op: { op_id: opId, entity, entity_id: entityId, kind, base_rev: baseRev,
                payload, client_ts: new Date().toISOString() },
      });
      if (error) throw error;
      return data as Result;
    }

    beforeEach(async () => {
      a = await ensureUser("a");
      await resetUser(a.id);
      client = await userClient(a);
    });

    it("create applies at rev 1 and seq 1", async () => {
      const r = await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
      expect(r).toMatchObject({ status: "applied", rev: 1, seq: 1 });
    });

    it("a repeated op_id is a duplicate and does not re-apply", async () => {
      const opId = crypto.randomUUID();
      await op("water_log", "2026-09-11", "create", null, { cups: 2 }, opId);
      const again = await op("water_log", "2026-09-11", "update", 1, { cups: 9 }, opId);
      expect(again).toEqual({ op_id: opId, status: "duplicate" });
      const row = await adminClient().from("water_log")
        .select("cups, rev").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
      expect(row.data).toMatchObject({ cups: 2, rev: 1 });
    });

    it("a stale update conflicts and returns the full current entity", async () => {
      await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
      await op("user_foods", FOOD, "update", 1, { name: "Chicken thigh", kind: "custom" });
      const stale = await op("user_foods", FOOD, "update", 1, { name: "Nope", kind: "custom" });
      expect(stale).toMatchObject({ status: "conflict", entity: "user_foods", current_rev: 2 });
      expect((stale.current as { name: string }).name).toBe("Chicken thigh");
      const row = await adminClient().from("user_foods").select("name").eq("id", FOOD).single();
      expect(row.data?.name).toBe("Chicken thigh");
    });

    it("a create on an existing row is a conflict, not a second row", async () => {
      await op("gut_log", GUT, "create", null,
        { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
      const second = await op("gut_log", GUT, "create", null,
        { local_date: "2026-09-11", tz: "America/New_York", state: "flare" });
      expect(second).toMatchObject({ status: "conflict", current_rev: 1 });
    });

    it("an update on an unknown key is gone", async () => {
      const r = await op("user_foods", FOOD, "update", 1, { name: "Ghost", kind: "custom" });
      expect(r).toMatchObject({ status: "gone" });
    });

    it("a stale update on a tombstone returns deleted and never resurrects it", async () => {
      await op("log_entries", ENTRY, "create", null, {
        eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
        slot: "meal-1", method: "plan", items: [],
      });
      const gone = await op("log_entries", ENTRY, "delete", 1);
      expect(gone).toMatchObject({ status: "applied", rev: 2 });
      const stale = await op("log_entries", ENTRY, "update", 1, {
        eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
        slot: "meal-2", method: "plan", items: [],
      });
      expect(stale.status).toBe("deleted");
      expect(stale.deleted_at).toBeTruthy();
      const row = await adminClient().from("log_entries").select("slot, deleted_at")
        .eq("id", ENTRY).single();
      expect(row.data?.slot).toBe("meal-1");
      expect(row.data?.deleted_at).not.toBeNull();
    });

    it("restore clears the tombstone and bumps rev", async () => {
      await op("gut_log", GUT, "create", null,
        { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
      await op("gut_log", GUT, "delete", 1);
      const back = await op("gut_log", GUT, "restore", 2);
      expect(back).toMatchObject({ status: "applied", rev: 3 });
      const row = await adminClient().from("gut_log").select("deleted_at").eq("id", GUT).single();
      expect(row.data?.deleted_at).toBeNull();
    });

    it("delete on a non-tombstone entity is 'unsupported' and writes nothing", async () => {
      await op("water_log", "2026-09-11", "create", null, { cups: 2 });
      const result = await op("water_log", "2026-09-11", "delete", 1);
      expect(result).toEqual({ op_id: (result as { op_id: string }).op_id, status: "unsupported" });
      const row = await adminClient().from("water_log")
        .select("cups, rev").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
      expect(row.data).toMatchObject({ cups: 2, rev: 1 }); // untouched — no hard delete, no raise
    });

    it("restore on a non-tombstone entity is also 'unsupported'", async () => {
      await op("plan_days", "2026-09-11", "create", null, { floor_day: false });
      const result = await op("plan_days", "2026-09-11", "restore", 1);
      expect(result.status).toBe("unsupported");
    });

    it("restore on a row that was never tombstoned is an idempotent no-op", async () => {
      await op("gut_log", GUT, "create", null,
        { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
      const before = await adminClient().from("change_log")
        .select("*", { count: "exact", head: true }).eq("user_id", a.id);
      const result = await op("gut_log", GUT, "restore", 1);
      expect(result).toMatchObject({ status: "applied", rev: 1 }); // rev unchanged, not bumped
      const after = await adminClient().from("change_log")
        .select("*", { count: "exact", head: true }).eq("user_id", a.id);
      expect(after.count).toBe(before.count); // no new change_log row for the no-op
      const row = await adminClient().from("gut_log").select("deleted_at").eq("id", GUT).single();
      expect(row.data?.deleted_at).toBeNull();
    });

    it("seq is contiguous and ascending across entities", async () => {
      await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
      await op("water_log", "2026-09-11", "create", null, { cups: 1 });
      await op("plan_days", "2026-09-11", "create", null, { floor_day: true });
      await op("water_log", "2026-09-11", "update", 1, { cups: 2 });
      const { data, error } = await client.rpc("sync_changes", {
        p_user_id: a.id, p_since: 0, p_limit: 500,
      });
      expect(error).toBeNull();
      const rows = data as { seq: number }[];
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    });

    it("sync_changes pages from a cursor", async () => {
      await op("water_log", "2026-09-11", "create", null, { cups: 1 });
      await op("water_log", "2026-09-12", "create", null, { cups: 1 });
      const { data } = await client.rpc("sync_changes", { p_user_id: a.id, p_since: 1, p_limit: 500 });
      expect((data as { seq: number }[]).map((r) => r.seq)).toEqual([2]);
    });

    it("log_items are replaced wholesale and returned inline", async () => {
      const admin = adminClient();
      const food = await admin.from("user_foods")
        .insert({ id: FOOD, user_id: a.id, name: "Rice", kind: "custom" }).select("id").single();
      expect(food.error).toBeNull();
      const ref = await admin.from("food_refs")
        .insert({ id: REF, kind: "user", user_food_id: FOOD }).select("id").single();
      expect(ref.error).toBeNull();
      await op("log_entries", ENTRY, "create", null, {
        eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
        slot: "meal-1", method: "text",
        items: [
          { seq: 1, qty: 1, unit: "cup", food_ref_id: REF, grams: 150, snapshot: {} },
          { seq: 2, qty: 2, unit: "cup", food_ref_id: REF, grams: 300, snapshot: {} },
        ],
      });
      await op("log_entries", ENTRY, "update", 1, {
        eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
        slot: "meal-1", method: "text",
        items: [{ seq: 1, qty: 3, unit: "cup", food_ref_id: REF, grams: 450, snapshot: {} }],
      });
      const feed = await admin.from("change_log")
        .select("current").eq("user_id", a.id).order("seq", { ascending: false }).limit(1).single();
      const items = (feed.data?.current as { items: { grams: number }[] }).items;
      expect(items).toHaveLength(1);
      expect(items[0].grams).toBe(450);
    });

    it.each([
      ["user_foods", FOOD, { name: "X", kind: "custom" }],
      ["log_entries", ENTRY, { eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York",
        local_date: "2026-09-11", slot: "meal-1", method: "plan", items: [] }],
      ["gut_log", GUT, { local_date: "2026-09-11", tz: "America/New_York", state: "good" }],
      ["duplicate_groups", GROUP, { local_date: "2026-09-11", slot: "meal-1",
        fingerprint: "deadbeef", state: "open" }],
      ["water_log", "2026-09-11", { cups: 1 }],
      ["plan_days", "2026-09-11", { floor_day: false }],
      ["user_settings", "settings", { first_opened_at: "2026-09-11T12:00:00Z" }],
    ] as const)("entity_key %s round-trips into change_log", async (entity, key, payload) => {
      const r = await op(entity, key, "create", null, payload as Record<string, unknown>);
      expect(r.status).toBe("applied");
      const feed = await adminClient().from("change_log")
        .select("entity, entity_key").eq("user_id", a.id).order("seq", { ascending: false })
        .limit(1).single();
      expect(feed.data).toEqual({ entity, entity_key: key });
    });

    it("user_food_prefs keys on the food_ref_id uuid", async () => {
      const admin = adminClient();
      await admin.from("user_foods").insert({ id: FOOD, user_id: a.id, name: "Rice", kind: "custom" });
      await admin.from("food_refs").insert({ id: REF, kind: "user", user_food_id: FOOD });
      const r = await op("user_food_prefs", REF, "create", null, { status: "eats", role: "carb" });
      expect(r.status).toBe("applied");
      const row = await admin.from("user_food_prefs")
        .select("status").eq("user_id", a.id).eq("food_ref_id", REF).single();
      expect(row.data?.status).toBe("eats");
    });

    it("a malformed entity_key is rejected", async () => {
      const { error } = await client.rpc("apply_sync_op", {
        p_user_id: a.id,
        p_op: { op_id: crypto.randomUUID(), entity: "water_log", entity_id: "11 September",
                kind: "create", base_rev: null, payload: {}, client_ts: new Date().toISOString() },
      });
      expect(error?.message).toContain("bad_entity_key");
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL before the RPC migration is applied. Reproduce it by
  resetting only to the 000500 migration:
  ```bash
  supabase db reset --db-url "$SUPABASE_TEST_DB_URL" --version 20260911000500 --yes
  psql "$SUPABASE_TEST_DB_URL" -f supabase/seed/test_helpers.sql
  pnpm exec vitest run tests/rls/apply-sync-op.test.ts
  ```
  Expected failure: `Could not find the function public.apply_sync_op(p_op, p_user_id)`.

- [ ] Minimal implementation: nothing new — Task 13's migration is the implementation. Apply it:
  ```bash
  pnpm db:reset
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm exec vitest run tests/rls/apply-sync-op.test.ts
  ```
  Expected: `Tests  22 passed` (15 named cases plus the 7 entity-key cases).

- [ ] Commit:
  ```bash
  git add tests/rls/apply-sync-op.test.ts && git commit -m "test(db): cover apply_sync_op compare-and-swap semantics"
  ```

---

## Lane exit gate

Run in order from the repo root, with the branch env exported.

```bash
pnpm lint
```
Expected: exit 0, no findings.

```bash
pnpm exec tsc --noEmit
```
Expected: exit 0, no output.

```bash
pnpm db:reset
```
Expected: `Finished supabase db reset`, then `branch p0-database reset: migrations + test helpers applied`.

```bash
pnpm test:integration
```
Expected: `Test Files  3 passed`, `Tests  56 passed`, `0 failed`. With `SUPABASE_TEST_URL` unset
(the CI condition) the same command must print `Test Files  3 skipped` and exit 0.

```bash
psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
  -c "select count(*) from pg_tables where schemaname='public' and not rowsecurity;" \
  -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.prosecdef and p.proconfig is null;" \
  -c "select count(*) from pg_class where relkind='v' and relnamespace='public'::regnamespace
       and not ('security_invoker=true' = any (coalesce(reloptions,'{}')));"
```
Expected: `0`, `0`, `0` — every table has RLS, every security-definer function pins `search_path`,
every view is security-invoker.

```bash
pnpm test lib/
```
Expected: the existing unit suites still pass, unchanged by this lane.

Manual check before the PR: `git diff main --stat` lists only the files in this plan's File structure
table, and the `package.json` diff touches the `scripts` block only.

## Hand-off to integration

1. **Order.** Lane A merges first. Lanes B, C and D need `supabase/migrations/*` applied to the
   branch before their own integration tests can run; the integration branch applies them with
   `pnpm db:reset` against its own branch.
2. **Lane B** wires `lib/server/privileged.ts` to `lookup_api_token(p_token_hash bytea)` and
   `scripts/mint-token.ts` to `api_tokens`. `lookup_api_token` is granted to `service_role` only, so
   it must be called through `adminClient()`. `revoke_api_token(p_user_id, p_token_id)` is granted to
   `authenticated`, so a signed-in user revokes her own token through the request-local client.
3. **Lane C** calls `apply_sync_op(p_user_id, p_op)` once per op, in array order, one RPC per
   transaction, and maps the returned JSON straight onto `OpResult`; the field names already match.
   `sync_changes(p_user_id, p_since, p_limit)` returns the `ChangeRow` columns in order, and clamps
   `p_limit` to 500 itself. `lib/sync/keys.ts` must produce exactly the strings in the entity-key
   table above — `_sync_assert_key` rejects anything else with `bad_entity_key`, and the
   `user_food_prefs` key is the bare `food_ref_id` UUID, not `<kind>:<uuid>` — contracts §4 confirms
   this (2026-09-10 update), so the SQL above matches it and there is no longer an open question here.
4. **Lane D** runs `20260911000700_legacy_backfill.sql` after these six. Its `health_samples` rows
   need a `health_sources` row of `kind='manual'`, which 000400 permits. Its `user_foods` inserts
   should go through `get_or_create_food_ref(p_user_id,'user',null,<user_food_id>)` so every
   `food_ref` exists before `user_food_prefs`.
5. **Not this lane's job.** `lib/store.ts`, `lib/sync.ts`, `lib/server/db.ts` and
   `app/api/sync/route.ts` are untouched here and are deleted in the cut-over release.
6. **`supabase/seed/test_helpers.sql` never reaches production.** `[db.seed] enabled = false` in
   `config.toml` and `scripts/db-branch.sh reset` applying it explicitly are the two guards. The
   integration branch must not add it to `[db.seed] sql_paths`.
7. **New env for CI and local runs:** `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`,
   `SUPABASE_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_DB_URL`. They belong in `.env.example` under a
   `# --- Integration tests ---` heading; `.env.example` is not a Lane A file, so the integration
   branch adds them.

## Open questions

The `user_food_prefs` entity key, `lookup_api_token`'s grants, and delete/restore semantics for the
five entities without `deleted_at` are no longer open — the 2026-09-10 contract update settles all
three: contracts §4 confirms the bare `food_ref_id` key, contracts §2 now says `lookup_api_token` is
`service_role` only (gap 8), and contracts §2 spells out `'unsupported'` for a delete/restore on a
non-tombstone entity (Task 13's `apply_sync_op`, never a raise).

1. **`base_rev` on create.** `apply_sync_op` ignores `base_rev` for a `create` and always writes
   `rev = 1`. If Lane C ever replays a create with a higher `base_rev`, it gets a conflict carrying
   the current row, which is the right answer — confirm no client path depends on a create
   preserving a client-chosen `rev`.
2. **Branch region and size.** `scripts/db-branch.sh create` passes `--region us-east-1 --persistent`.
   Confirm the region matches production `fivatgdpuenszxxnijpc`, and whether a persistent branch is
   wanted (it survives between sessions and bills continuously) or an ephemeral one is enough.
3. **Test-user creation and `enable_signup`.** `tests/helpers/supabase.ts` creates two users through
   the admin API with passwords. Production auth is email OTP with no passwords. Confirm that leaving
   `[auth] enable_signup = true` in `config.toml` for the branch is acceptable, given the config is
   also what a future `supabase db push --linked` would carry to production.
4. **`pnpm test` picks up `tests/`.** `vitest.config.ts` includes `**/*.test.ts`, so the plain
   `pnpm test` run also collects the three integration suites — they self-skip without
   `SUPABASE_TEST_URL`, so CI stays green. Narrowing `include` belongs to whoever owns
   `vitest.config.ts`; this lane does not touch it.
