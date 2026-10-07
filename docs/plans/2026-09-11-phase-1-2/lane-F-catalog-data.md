# Lane F — Catalog data (Phase 1)

**For agentic workers:** execute this plan with the `superpowers:subagent-driven-development` skill. One task
per subagent, in order, each ending at a green run and a commit. Do not batch tasks; do not skip a failing-test
step because the code "obviously works".

## Goal

Put real USDA food data behind the app. Ship the three Lane F migrations that finish the Phase 0 `catalog_*`
shell (search columns, invariants, activation and energy functions, read-only grants), the Python import worker
that downloads Foundation / SR Legacy / FNDDS and activates a version in one transaction, the local dry-run and
sizing report, and the mapping proposal that lets Devin bind her 53 seed and preset foods to catalog rows.

Lane F produces rows and functions. Lane G (search RPC and routes), Lane H (snapshots and totals) and Lane I
(client) consume them. Nothing in this lane renders UI, so `DESIGN.md` constrains nothing here beyond "do not
add a screen".

## Architecture

`docs/architecture.md` v2.1, §3.1 (catalog identity vs revisions, energy and Atwater, import scope), §3.3
(`log_items.food_revision_id` and `portion_id` point at rows this lane writes), §4.1 (the six search features
read `search_doc`, `description`, `brand`, `prep_state`, `quality_class`, `quality_flags`), §4.6 (export carries
the source and version this lane stamps), §5 (the import worker is a service-role writer, never Vercel), §7
(dry run → worker → quarterly cadence).

Identity is `(source, source_id)` and never changes. Everything mutable lives on a revision. An import writes a
new `catalog_versions` row per source under one shared `version_label`, writes new revisions against it, and
then `catalog_activate_version(label)` flips activity in one transaction. `food_refs` and
`user_foods.catalog_food_id` point at `catalog_foods.id`, never at a revision, so they survive every import.

## Tech Stack

Next.js 16.3.4, React 19, TypeScript 5, Tailwind 4, pnpm 11.25.0, Node 22, vitest 5, Supabase Postgres 17,
Vercel. Lane F adds Python 3.12 with `psycopg[binary]` and `requests`, declared in `scripts/requirements.txt`
and installed into a worker-local `.venv` (no npm dependency is added — Phase 1–2 contracts §7).

## Spec paths

- `docs/plans/2026-09-11-phase-1-2/00-contracts.md` — frozen; §1 file ownership, §2 catalog contracts.
- `docs/plans/2026-09-10-phase-0/00-contracts.md` — §2 `get_or_create_food_ref` / `apply_sync_op`, §5 auth
  helpers (`requireUser`, `enforceRateLimit`, `readJson`, `jsonError`, `adminClient`, `withTokenUser`), §8.
- `docs/specs/phase-1-catalog.md` — Data changes, Engines and scripts, Test plan, Acceptance criteria.
- `docs/specs/phase-2-real-logging.md` — nutrient codes and the DRI seed (Lane H owns both; read only so the
  codes this lane writes match).
- `docs/architecture.md` §3.1, §3.3, §4.1, §4.6, §5, §7.
- `AGENTS.md`, `DESIGN.md`.

**Phase 0 is assumed landed on `main`.** This checkout has no `supabase/`, no `tests/` and no `lib/server/auth.ts`
yet. Lane F codes against the Phase 0 contract signatures as written, and the first task asserts the shell
migration `20260911000100_catalog_shell.sql` is present before doing anything else.

## Global Constraints

From Phase 0 contracts §8, in force here:

- TDD per task: failing test → run it → minimal code → run it → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` is never read from a request body. Errors are `{ error, message }` and never echo the body.
- Every route: `enforceRateLimit` first, then identity, then `readJson`. (Lane F ships no route.)
- Files under 400 lines; functions under 50 lines. `scripts/import-fdc.py` is the one deliberate exception —
  it is a worker in the style of `scripts/build-food-db.py`, and is allowed to reach ~500 lines; every function
  inside it still stays under 50.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`. Never the full suite twice.

From Phase 1–2 contracts §8, added:

- Every SQL function that reads user rows is either `security invoker` (browser path) or `security definer`
  with `p_user_id` first and execute revoked from `authenticated` (privileged path) — never both, never
  neither. `catalog_atwater_kcal` reads no user rows and is plain invoker; `catalog_activate_version` is
  `security definer`, service-role only, and takes no user argument because it touches no user row.

Lane-local rules:

- Lane F only creates or modifies the files listed under "File structure".
  `supabase/migrations/20260912090100_catalog_search.sql` belongs to Lane G — never write it here.
- Downloads land in `~/Backups/usda/fdc/<version_label>/` and are never committed (house rule: backups and
  snapshots go to `~/Backups/<service>/`, never `~/Inbox/`).
- The service-role key and `CATALOG_IMPORT_DB_URL` stay in the worker's environment. No script prints either.
- Steps marked **[needs branch]** are skipped when `SUPABASE_TEST_URL` is unset. Steps marked **[needs network]**
  hit `fdc.nal.usda.gov` and are skipped offline.

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260912090000_catalog_tables.sql` | Create — extensions, `prep_state`, generated `search_doc` + GIN, trigram GINs, partial unique indexes, `catalog_staging` schema |
| `supabase/migrations/20260912090050_catalog_activate.sql` | Create — `catalog_atwater_kcal`, `catalog_activate_version` and their grants |
| `supabase/migrations/20260912090200_catalog_grants.sql` | Create — RLS on, select-only policy for `authenticated`, writes revoked, `service_role` granted |
| `supabase/migrations/20260912090200_catalog_grants.down.sql` | Create — tested, held unapplied; drops the policies and grants |
| `scripts/requirements.txt` | Create — `psycopg[binary]`, `requests` |
| `scripts/import-fdc.py` | Create — the §7.2 worker: download → stage → build → validate → activate |
| `scripts/catalog-size-report.sql` | Create — per-table and per-index size, plus headroom against 8 GiB |
| `scripts/catalog-dry-run.sh` | Create — local Postgres 17, migrations, `--dry-run` import, size report, writes `docs/catalog/sizing.md` |
| `scripts/export-seed-foods.ts` | Create — prints `SEED_FOODS` + `PRESET_FOODS` as JSON for the mapper |
| `scripts/map-her-foods.py` | Create — proposes a catalog row per food, writes the review CSV |
| `docs/catalog/import.md` | Create — the runbook |
| `docs/catalog/sizing.md` | Create — written by the dry run, committed |
| `docs/catalog/her-foods-mapping.csv` | Create — written by the mapper, reviewed by Devin |
| `tests/catalog/helpers.ts` | Create — `hasBranch`, `psql`, `psqlExpectError`, fixture reset |
| `tests/catalog/schema.test.ts` | Create — generated `search_doc`, indexes, staging schema |
| `tests/catalog/atwater.test.ts` | Create — complete, incomplete, mismatch ratio |
| `tests/catalog/activation.test.ts` | Create — one active revision per food, identity stable, `food_refs` intact |
| `tests/catalog/grants.test.ts` | Create — `authenticated` selects and cannot write; `anon` reads nothing |
| `tests/catalog/export-seed-foods.test.ts` | Create — 53 rows, unique ids, role vocabulary |
| `tests/catalog/test_import_fdc.py` | Create — Python unittest: nutrient-id map and portion normalisation |

---

## Task 1 — Migration 090000: search columns, invariants, staging schema

**Files**
- Create: `supabase/migrations/20260912090000_catalog_tables.sql`
- Create: `tests/catalog/helpers.ts`
- Test: `tests/catalog/schema.test.ts`

**Interfaces**
- Consumes: the Phase 0 shell `supabase/migrations/20260911000100_catalog_shell.sql` — tables
  `catalog_versions`, `catalog_foods`, `catalog_food_revisions`, `catalog_nutrients`,
  `catalog_food_nutrients`, `catalog_barcodes`, `catalog_portions`, `catalog_ingredients`, `catalog_dri`.
- Produces: `catalog_food_revisions.search_doc` as `generated always as … stored`; indexes
  `catalog_food_revisions_fts`, `catalog_food_revisions_trgm`, `catalog_food_revisions_trgm_brand`,
  `catalog_food_revisions_one_active`, `catalog_versions_one_active_per_source`; schema `catalog_staging`.

### Steps

- [ ] Write `tests/catalog/helpers.ts` (no test of its own; the next step exercises it):
  ```ts
  import { execFileSync } from "node:child_process";

  /** A Supabase branch for integration work. Both URLs come from the branch db-branch.sh creates. */
  export const BRANCH_URL = process.env.SUPABASE_TEST_URL ?? "";
  export const BRANCH_DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";
  export const hasBranch = Boolean(BRANCH_URL && BRANCH_DB_URL);

  function run(sql: string): string {
    return execFileSync("psql", [BRANCH_DB_URL, "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Runs SQL as the branch owner and returns stdout, trimmed. Throws on a SQL error. */
  export function psql(sql: string): string {
    if (!hasBranch) throw new Error("psql() needs SUPABASE_TEST_URL and SUPABASE_TEST_DB_URL");
    return run(sql).trim();
  }

  /** Runs SQL that must fail and returns the server's message. Throws when it succeeds. */
  export function psqlExpectError(sql: string): string {
    try {
      run(sql);
    } catch (e) {
      return String((e as { stderr?: Buffer | string }).stderr ?? "");
    }
    throw new Error(`expected this SQL to fail: ${sql}`);
  }

  /**
   * Fixtures use source 'off' and labels prefixed 'test-'. Phase 1 imports no 'off' rows,
   * so a test run never disturbs an imported catalog on the same branch.
   */
  export function resetCatalogFixtures(): void {
    psql(`
      delete from food_refs where catalog_food_id in (select id from catalog_foods where source = 'off');
      delete from catalog_portions where food_revision_id in (
        select r.id from catalog_food_revisions r
        join catalog_foods f on f.id = r.catalog_food_id where f.source = 'off');
      delete from catalog_food_nutrients where food_revision_id in (
        select r.id from catalog_food_revisions r
        join catalog_foods f on f.id = r.catalog_food_id where f.source = 'off');
      delete from catalog_food_revisions where catalog_food_id in (
        select id from catalog_foods where source = 'off');
      delete from catalog_foods where source = 'off';
      delete from catalog_versions where source = 'off' and version_label like 'test-%';`);
  }
  ```

- [ ] Write the failing test `tests/catalog/schema.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { hasBranch, psql, resetCatalogFixtures } from "./helpers";

  describe.skipIf(!hasBranch)("catalog schema", () => {
    it("stores search_doc as a generated column", () => {
      expect(
        psql(`select attgenerated from pg_attribute
                where attrelid = 'catalog_food_revisions'::regclass and attname = 'search_doc';`)
      ).toBe("s");
    });

    it("generates search_doc from description, brand and category", () => {
      resetCatalogFixtures();
      psql(`
        insert into catalog_versions (source, version_label) values ('off', 'test-schema');
        insert into catalog_foods (source, source_id) values ('off', 'test-schema-1');
        insert into catalog_food_revisions
          (description, brand, category, catalog_food_id, catalog_version_id, quality_class, content_hash)
        select 'Chicken thigh, roasted', 'Bell and Evans', 'Poultry Products', f.id, v.id, 'analytical', 'h1'
          from catalog_foods f, catalog_versions v
         where f.source_id = 'test-schema-1' and v.version_label = 'test-schema';`);
      const doc = psql(`select search_doc::text from catalog_food_revisions r
                          join catalog_foods f on f.id = r.catalog_food_id
                         where f.source_id = 'test-schema-1';`);
      expect(doc).toContain("chicken");
      expect(doc).toContain("evan");
      expect(doc).toContain("poultri");
      resetCatalogFixtures();
    });

    it("carries the indexes and staging schema the import needs", () => {
      const names = psql(`select indexname from pg_indexes
                           where schemaname = 'public' and tablename like 'catalog\\_%' order by 1;`);
      for (const idx of [
        "catalog_food_revisions_fts",
        "catalog_food_revisions_one_active",
        "catalog_food_revisions_trgm",
        "catalog_food_revisions_trgm_brand",
        "catalog_versions_one_active_per_source",
      ]) {
        expect(names).toContain(idx);
      }
      expect(psql(`select count(*) from pg_namespace where nspname = 'catalog_staging';`)).toBe("1");
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL:
  ```bash
  pnpm test tests/catalog/schema.test.ts
  ```
  Expected failure: the first case reports `expected '' to be 's'` — `search_doc` is the shell's plain
  `tsvector` column, not generated.

- [ ] Write `supabase/migrations/20260912090000_catalog_tables.sql`:
  ```sql
  -- Phase 1, Lane F. Finishes the Phase 0 catalog shell (20260911000100_catalog_shell.sql):
  -- the search columns and indexes §4.1 ranks on, the invariants activation rests on, and the
  -- staging schema the import worker loads into. Every statement guards, so re-applying is a no-op.

  create extension if not exists pg_trgm;
  create extension if not exists unaccent;

  -- Phase 0 ships prep_state; a checkout without it gets it here. The vocabulary is contracts §3's
  -- frozen PrepState union exactly — not architecture §3.1's list, which carries 'canned'/'dried'
  -- (not in PrepState: a stored value the API's TS type could not represent) and is missing
  -- 'baked'/'unknown' (in PrepState but never storable). Lane G's Open question 2 names this
  -- mismatch; this is its resolution, made without a contract change because contracts' union is
  -- the narrower, already-frozen one — the DDL moves to match it, not the reverse.
  alter table catalog_food_revisions add column if not exists prep_state text;
  do $$
  begin
    if not exists (select 1 from pg_constraint
                    where conname = 'catalog_food_revisions_prep_state_check') then
      alter table catalog_food_revisions add constraint catalog_food_revisions_prep_state_check
        check (prep_state in ('raw','cooked','boiled','roasted','fried','grilled','baked','unknown'));
    end if;
  end $$;

  -- search_doc becomes a generated column so no worker can forget to write it. Postgres 17 cannot
  -- convert a plain column in place, so the shell's column is dropped and re-added; the table is
  -- empty until the first import. 'english' is a literal regconfig and to_tsvector/setweight are
  -- immutable, so the expression is legal here. unaccent() is NOT immutable and is deliberately
  -- left out: accent folding belongs to the query text, not the stored document.
  drop index if exists catalog_food_revisions_fts;
  alter table catalog_food_revisions drop column if exists search_doc;
  alter table catalog_food_revisions add column search_doc tsvector
    generated always as (
        setweight(to_tsvector('english', coalesce(description, '')), 'A')
     || setweight(to_tsvector('english', coalesce(brand, '')), 'B')
     || setweight(to_tsvector('english', coalesce(category, '')), 'C')) stored;
  create index catalog_food_revisions_fts on catalog_food_revisions using gin (search_doc);

  -- §4.1 measures similarity(description, q); the mapper and branded queries also want the brand
  -- in the trigram document, so both indexes exist and the planner picks per predicate.
  create index if not exists catalog_food_revisions_trgm
    on catalog_food_revisions using gin (description gin_trgm_ops);
  create index if not exists catalog_food_revisions_trgm_brand
    on catalog_food_revisions using gin ((description || ' ' || coalesce(brand, '')) gin_trgm_ops);

  -- The two invariants the design rests on.
  create unique index if not exists catalog_food_revisions_one_active
    on catalog_food_revisions (catalog_food_id) where is_active;
  create unique index if not exists catalog_versions_one_active_per_source
    on catalog_versions (source) where is_active;

  -- Join support for the import and for §4.1's nutrient and portion reads.
  create index if not exists catalog_food_revisions_version
    on catalog_food_revisions (catalog_version_id);
  create index if not exists catalog_food_nutrients_code
    on catalog_food_nutrients (nutrient_code);
  create index if not exists catalog_portions_revision
    on catalog_portions (food_revision_id, seq);

  -- The import worker's landing zone. Service role only; no user and no route ever reads it.
  create schema if not exists catalog_staging;
  revoke all on schema catalog_staging from public;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && pnpm test tests/catalog/schema.test.ts
  ```
  Expected: 3 passed.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260912090000_catalog_tables.sql tests/catalog/helpers.ts tests/catalog/schema.test.ts && \
  git commit -m "feat(catalog): add search columns, invariants and staging schema"
  ```

---

## Task 2 — `catalog_atwater_kcal`

**Files**
- Create: `supabase/migrations/20260912090050_catalog_activate.sql`
- Test: `tests/catalog/atwater.test.ts`

**Interfaces**
- Consumes: `catalog_food_nutrients(food_revision_id, nutrient_code, amount_per_100g)`; nutrient codes
  `protein`, `carbohydrate`, `fat_total`, `fiber_total`.
- Produces: `catalog_atwater_kcal(p_revision_id bigint) returns table (kcal numeric, complete boolean)`
  (Phase 1–2 contracts §2, verbatim).

### Steps

- [ ] Write the failing test `tests/catalog/atwater.test.ts`:
  ```ts
  import { beforeAll, describe, expect, it } from "vitest";
  import { hasBranch, psql, resetCatalogFixtures } from "./helpers";

  /** Inserts one 'off' fixture revision and returns its id. */
  function fixtureRevision(sourceId: string, nutrients: Record<string, number | null>): string {
    psql(`
      insert into catalog_versions (source, version_label) values ('off', 'test-atwater')
        on conflict (source, version_label) do nothing;
      insert into catalog_foods (source, source_id) values ('off', '${sourceId}');
      insert into catalog_nutrients (code, name, unit, derivation) values
        ('protein','Protein','g','measured'), ('carbohydrate','Carbohydrate','g','measured'),
        ('fat_total','Total lipid (fat)','g','measured'), ('fiber_total','Fiber','g','measured'),
        ('energy_kcal','Energy','kcal','measured')
        on conflict (code) do nothing;
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash)
      select '${sourceId}', f.id, v.id, 'analytical', 'h-${sourceId}'
        from catalog_foods f, catalog_versions v
       where f.source_id = '${sourceId}' and v.version_label = 'test-atwater';`);
    const id = psql(`select r.id from catalog_food_revisions r
                       join catalog_foods f on f.id = r.catalog_food_id
                      where f.source_id = '${sourceId}';`);
    for (const [code, amount] of Object.entries(nutrients)) {
      psql(`insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
              values (${id}, '${code}', ${amount === null ? "null" : amount});`);
    }
    return id;
  }

  describe.skipIf(!hasBranch)("catalog_atwater_kcal", () => {
    beforeAll(() => resetCatalogFixtures());

    it("computes 4P + 4 available carb + 9F and reports complete", () => {
      const id = fixtureRevision("test-atw-complete", {
        protein: 20, carbohydrate: 10, fiber_total: 2, fat_total: 5,
      });
      // 4*20 + 4*(10-2) + 9*5 = 80 + 32 + 45 = 157
      expect(psql(`select kcal || '|' || complete from catalog_atwater_kcal(${id});`)).toBe("157.0|t");
    });

    it("falls back to total carbohydrate when fiber is not reported", () => {
      const id = fixtureRevision("test-atw-nofiber", {
        protein: 20, carbohydrate: 10, fat_total: 5,
      });
      // 4*20 + 4*10 + 9*5 = 165
      expect(psql(`select kcal from catalog_atwater_kcal(${id});`)).toBe("165.0");
    });

    it("reports complete = false when any macro is missing", () => {
      const id = fixtureRevision("test-atw-incomplete", {
        protein: 20, carbohydrate: 10, fat_total: null,
      });
      expect(psql(`select complete from catalog_atwater_kcal(${id});`)).toBe("f");
    });

    it("supports the 10 % mismatch test the worker runs", () => {
      const id = fixtureRevision("test-atw-mismatch", {
        protein: 20, carbohydrate: 10, fiber_total: 2, fat_total: 5, energy_kcal: 300,
      });
      const mismatch = psql(`
        select abs(n.amount_per_100g - a.kcal) / n.amount_per_100g > 0.10
          from catalog_food_nutrients n, catalog_atwater_kcal(${id}) a
         where n.food_revision_id = ${id} and n.nutrient_code = 'energy_kcal';`);
      expect(mismatch).toBe("t");
      resetCatalogFixtures();
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL:
  ```bash
  pnpm test tests/catalog/atwater.test.ts
  ```
  Expected failure: every case errors with `function catalog_atwater_kcal(bigint) does not exist`.

- [ ] Write `supabase/migrations/20260912090050_catalog_activate.sql` (first half — the second half lands in
  Task 3, in this same file):
  ```sql
  -- Phase 1, Lane F. The two catalog functions the import worker calls.
  -- Filename sorts after 20260912090000 (tables) and before Lane G's 20260912090100 (search RPC),
  -- so Supabase's filename ordering matches the dependency order.

  -- Energy, one implementation, in SQL (§3.1). Nothing recomputes Atwater in TypeScript.
  -- Carbohydrate means available carbohydrate — total minus fiber where fiber is reported,
  -- otherwise total, which the worker flags 'carb_basis_total'.
  -- `complete` is false when any of protein, carbohydrate or fat_total is null; the worker turns
  -- that into 'atwater_incomplete' and drops the revision from the energy-mismatch check.
  create or replace function catalog_atwater_kcal(p_revision_id bigint)
  returns table (kcal numeric, complete boolean)
  language sql stable
  set search_path = public
  as $$
    with n as (
      select max(amount_per_100g) filter (where nutrient_code = 'protein')      as protein,
             max(amount_per_100g) filter (where nutrient_code = 'carbohydrate') as carbohydrate,
             max(amount_per_100g) filter (where nutrient_code = 'fat_total')    as fat,
             max(amount_per_100g) filter (where nutrient_code = 'fiber_total')  as fiber
        from catalog_food_nutrients
       where food_revision_id = p_revision_id)
    select round(  4 * coalesce(n.protein, 0)
                 + 4 * greatest(coalesce(n.carbohydrate, 0) - coalesce(n.fiber, 0), 0)
                 + 9 * coalesce(n.fat, 0), 1) as kcal,
           (n.protein is not null and n.carbohydrate is not null and n.fat is not null) as complete
      from n;
  $$;

  -- Reads catalog rows only, never a user row, so it stays invoker (Phase 1–2 contracts §8).
  grant execute on function catalog_atwater_kcal(bigint) to authenticated, service_role;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && pnpm test tests/catalog/atwater.test.ts
  ```
  Expected: 4 passed.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260912090050_catalog_activate.sql tests/catalog/atwater.test.ts && \
  git commit -m "feat(catalog): compute Atwater energy in SQL"
  ```

---

## Task 3 — `catalog_activate_version`

**Files**
- Modify: `supabase/migrations/20260912090050_catalog_activate.sql` (append)
- Test: `tests/catalog/activation.test.ts`

**Interfaces**
- Consumes: `catalog_versions(id, source, version_label, is_active)`,
  `catalog_food_revisions(id, catalog_food_id, catalog_version_id, is_active, valid_to)`, and the partial
  unique indexes from Task 1.
- Produces: `catalog_activate_version(p_version_label text) returns void`, `security definer`, execute
  granted to `service_role` only (Phase 1–2 contracts §2).

### Steps

- [ ] Write the failing test `tests/catalog/activation.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it } from "vitest";
  import { hasBranch, psql, psqlExpectError, resetCatalogFixtures } from "./helpers";

  /** One 'off' food with a revision in each of two labelled versions. */
  function twoVersionFixture(): void {
    psql(`
      insert into catalog_versions (source, version_label) values ('off', 'test-v1'), ('off', 'test-v2');
      insert into catalog_foods (source, source_id) values ('off', 'test-act-1');
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
      select 'Sirloin steak, broiled (v1)', f.id, v.id, 'analytical', 'h-v1', false
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-act-1' and v.version_label = 'test-v1';
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
      select 'Sirloin steak, broiled (v2)', f.id, v.id, 'analytical', 'h-v2', false
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-act-1' and v.version_label = 'test-v2';`);
  }

  describe.skipIf(!hasBranch)("catalog_activate_version", () => {
    beforeEach(() => {
      resetCatalogFixtures();
      twoVersionFixture();
    });

    it("leaves exactly one active revision per food", () => {
      psql(`select catalog_activate_version('test-v1');`);
      psql(`select catalog_activate_version('test-v2');`);
      expect(
        psql(`select count(*) from catalog_food_revisions r
                join catalog_foods f on f.id = r.catalog_food_id
               where f.source_id = 'test-act-1' and r.is_active;`)
      ).toBe("1");
      expect(
        psql(`select r.description from catalog_food_revisions r
                join catalog_foods f on f.id = r.catalog_food_id
               where f.source_id = 'test-act-1' and r.is_active;`)
      ).toBe("Sirloin steak, broiled (v2)");
    });

    it("stamps valid_to on the revision it replaces and keeps it for rollback", () => {
      psql(`select catalog_activate_version('test-v1');`);
      psql(`select catalog_activate_version('test-v2');`);
      expect(
        psql(`select count(*) from catalog_food_revisions r
                join catalog_foods f on f.id = r.catalog_food_id
               where f.source_id = 'test-act-1' and not r.is_active and r.valid_to is not null;`)
      ).toBe("1");
    });

    it("keeps catalog_food_id stable and food_refs intact across an activation", () => {
      psql(`select catalog_activate_version('test-v1');`);
      const foodId = psql(`select id from catalog_foods where source_id = 'test-act-1';`);
      psql(`insert into food_refs (kind, catalog_food_id) values ('catalog', ${foodId});`);
      psql(`select catalog_activate_version('test-v2');`);
      expect(psql(`select id from catalog_foods where source_id = 'test-act-1';`)).toBe(foodId);
      expect(psql(`select count(*) from food_refs where catalog_food_id = ${foodId};`)).toBe("1");
    });

    it("leaves exactly one active catalog_versions row per source", () => {
      psql(`select catalog_activate_version('test-v1');`);
      psql(`select catalog_activate_version('test-v2');`);
      expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
        .toBe("test-v2");
    });

    it("refuses a label that does not exist and changes nothing", () => {
      psql(`select catalog_activate_version('test-v1');`);
      const err = psqlExpectError(`select catalog_activate_version('test-missing');`);
      expect(err).toContain("no catalog_versions row for label");
      expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
        .toBe("test-v1");
    });

    it("is execute-revoked from authenticated", () => {
      const err = psqlExpectError(
        `set local role authenticated; select catalog_activate_version('test-v1');`
      );
      expect(err).toContain("permission denied for function catalog_activate_version");
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL:
  ```bash
  pnpm test tests/catalog/activation.test.ts
  ```
  Expected failure: every case errors with `function catalog_activate_version(unknown) does not exist`.

- [ ] Append to `supabase/migrations/20260912090050_catalog_activate.sql`:
  ```sql
  -- Activation is one transaction (§3.1 / §7.2). An import writes one catalog_versions row per
  -- source under one shared version_label; this function stands the outgoing versions down before
  -- it brings the new ones up, so catalog_food_revisions_one_active never sees two active rows,
  -- then asserts the invariant before it returns. Food identities are never rewritten, so
  -- food_refs and user_foods.catalog_food_id survive every import.
  create or replace function catalog_activate_version(p_version_label text)
  returns void
  language plpgsql security definer
  set search_path = public
  as $$
  declare
    v_ids     bigint[];
    v_sources text[];
    v_bad     bigint;
  begin
    select array_agg(id order by id), array_agg(distinct source)
      into v_ids, v_sources
      from catalog_versions
     where version_label = p_version_label;

    if v_ids is null then
      raise exception 'catalog_activate_version: no catalog_versions row for label %', p_version_label;
    end if;

    -- 1. stand the outgoing versions down, revisions first.
    update catalog_food_revisions r
       set is_active = false, valid_to = now()
     where r.is_active
       and r.catalog_version_id in (select v.id from catalog_versions v
                                     where v.source = any (v_sources)
                                       and v.is_active
                                       and not (v.id = any (v_ids)));

    update catalog_versions v
       set is_active = false
     where v.source = any (v_sources) and v.is_active and not (v.id = any (v_ids));

    -- 2. bring the new version up.
    update catalog_versions v set is_active = true where v.id = any (v_ids) and not v.is_active;

    update catalog_food_revisions r
       set is_active = true, valid_to = null
     where r.catalog_version_id = any (v_ids) and not r.is_active;

    -- 3. assert the invariant inside the same transaction, so a bad import rolls back whole.
    v_bad := null;
    select r.catalog_food_id into v_bad
      from catalog_food_revisions r
     where r.is_active
     group by r.catalog_food_id
    having count(*) > 1
     limit 1;
    if v_bad is not null then
      raise exception 'catalog_activate_version: food % has more than one active revision', v_bad;
    end if;

    v_bad := null;
    select r.catalog_food_id into v_bad
      from catalog_food_revisions r
     where r.catalog_version_id = any (v_ids)
     group by r.catalog_food_id
    having count(*) filter (where r.is_active) = 0
     limit 1;
    if v_bad is not null then
      raise exception 'catalog_activate_version: food % has no active revision after activation', v_bad;
    end if;
  end;
  $$;

  -- Privileged path: the import worker runs as service_role and nothing else may call this.
  revoke all on function catalog_activate_version(text) from public;
  revoke all on function catalog_activate_version(text) from anon, authenticated;
  grant execute on function catalog_activate_version(text) to service_role;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && pnpm test tests/catalog/activation.test.ts
  ```
  Expected: 6 passed.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260912090050_catalog_activate.sql tests/catalog/activation.test.ts && \
  git commit -m "feat(catalog): activate a catalog version in one transaction"
  ```

---

## Task 4 — Migration 090200: RLS, read policies and grants

**Files**
- Create: `supabase/migrations/20260912090200_catalog_grants.sql`
- Create: `supabase/migrations/20260912090200_catalog_grants.down.sql`
- Test: `tests/catalog/grants.test.ts`

**Interfaces**
- Consumes: the nine `catalog_*` tables.
- Produces: RLS enabled on all nine with one `select` policy each for `authenticated`; `insert`, `update`
  and `delete` revoked from `authenticated` and `anon`; all privileges granted to `service_role`.

### Steps

- [ ] Write the failing test `tests/catalog/grants.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { hasBranch, psql, psqlExpectError, resetCatalogFixtures } from "./helpers";

  const TABLES = [
    "catalog_versions", "catalog_foods", "catalog_food_revisions", "catalog_nutrients",
    "catalog_food_nutrients", "catalog_barcodes", "catalog_portions", "catalog_ingredients",
    "catalog_dri",
  ];

  describe.skipIf(!hasBranch)("catalog grants", () => {
    it("has row level security on every catalog table", () => {
      const off = psql(`select coalesce(string_agg(relname, ','), '') from pg_class
                          where relname = any (array[${TABLES.map((t) => `'${t}'`).join(",")}])
                            and not relrowsecurity;`);
      expect(off).toBe("");
    });

    it("gives authenticated exactly one select policy per table and no write policy", () => {
      expect(
        psql(`select count(*) from pg_policies where schemaname = 'public'
                and tablename like 'catalog\\_%' and cmd = 'SELECT';`)
      ).toBe(String(TABLES.length));
      expect(
        psql(`select count(*) from pg_policies where schemaname = 'public'
                and tablename like 'catalog\\_%' and cmd <> 'SELECT';`)
      ).toBe("0");
    });

    it("lets authenticated read the catalog", () => {
      resetCatalogFixtures();
      psql(`insert into catalog_versions (source, version_label) values ('off', 'test-grants');`);
      expect(
        psql(`set local role authenticated;
              select count(*) from catalog_versions where version_label = 'test-grants';`)
      ).toBe("1");
    });

    it("refuses every write from authenticated", () => {
      expect(
        psqlExpectError(`set local role authenticated;
          insert into catalog_foods (source, source_id) values ('off', 'test-grants-write');`)
      ).toContain("permission denied for table catalog_foods");
      expect(
        psqlExpectError(`set local role authenticated;
          update catalog_versions set is_active = true where version_label = 'test-grants';`)
      ).toContain("permission denied for table catalog_versions");
      expect(
        psqlExpectError(`set local role authenticated;
          delete from catalog_versions where version_label = 'test-grants';`)
      ).toContain("permission denied for table catalog_versions");
    });

    it("gives anon nothing at all", () => {
      expect(
        psqlExpectError(`set local role anon; select count(*) from catalog_foods;`)
      ).toContain("permission denied for table catalog_foods");
      resetCatalogFixtures();
    });
  });
  ```

- [ ] Run — **[needs branch]**, expect FAIL:
  ```bash
  pnpm test tests/catalog/grants.test.ts
  ```
  Expected failure: the first case reports the nine table names joined by commas instead of `''` — the shell
  ships the tables with RLS off.

- [ ] Write `supabase/migrations/20260912090200_catalog_grants.sql`:
  ```sql
  -- Phase 1, Lane F. catalog_* is shared and read-only to users (§2.2 rule 4).
  -- RLS is on so the publishable key cannot write; the service role bypasses RLS and is the
  -- only writer. No insert, update or delete policy exists on any table, and the table-level
  -- grants are revoked as well, so a leaked publishable key can never poison food data.
  do $$
  declare t text;
  begin
    foreach t in array array[
      'catalog_versions','catalog_foods','catalog_food_revisions','catalog_nutrients',
      'catalog_food_nutrients','catalog_barcodes','catalog_portions','catalog_ingredients',
      'catalog_dri'
    ] loop
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force row level security', t);
      execute format('drop policy if exists %I on %I', t || '_read', t);
      execute format('create policy %I on %I for select to authenticated using (true)',
                     t || '_read', t);
      execute format('revoke all on table %I from public, anon, authenticated', t);
      execute format('grant select on table %I to authenticated', t);
      execute format('grant all on table %I to service_role', t);
    end loop;
  end $$;

  -- Sequences move with their tables: the worker owns them, users never touch them.
  do $$
  declare s text;
  begin
    for s in select sequencename from pg_sequences
              where schemaname = 'public' and sequencename like 'catalog\_%' loop
      execute format('revoke all on sequence %I from public, anon, authenticated', s);
      execute format('grant all on sequence %I to service_role', s);
    end loop;
  end $$;
  ```

  > `force row level security` matters: the migration runs as the table owner, and without it the owner
  > would bypass its own policies, so a later owner-run query could not be trusted to behave like the
  > app. `service_role` carries `bypassrls`, so the worker is unaffected.

- [ ] Write `supabase/migrations/20260912090200_catalog_grants.down.sql` — tested, held unapplied:
  ```sql
  -- Down for 20260912090200_catalog_grants.sql. Tested on a branch, never applied to production.
  do $$
  declare t text;
  begin
    foreach t in array array[
      'catalog_versions','catalog_foods','catalog_food_revisions','catalog_nutrients',
      'catalog_food_nutrients','catalog_barcodes','catalog_portions','catalog_ingredients',
      'catalog_dri'
    ] loop
      execute format('drop policy if exists %I on %I', t || '_read', t);
      execute format('alter table %I no force row level security', t);
      execute format('alter table %I disable row level security', t);
      execute format('revoke all on table %I from authenticated', t);
    end loop;
  end $$;
  ```

- [ ] Run — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset && pnpm test tests/catalog/grants.test.ts
  ```
  Expected: 5 passed.

- [ ] Run the down migration once on the branch and confirm it is reversible — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260912090200_catalog_grants.down.sql && \
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_policies where tablename like 'catalog\_%';" && \
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260912090200_catalog_grants.sql && \
  pnpm test tests/catalog/grants.test.ts
  ```
  Expected: `0` after the down file, then 5 passed after re-applying.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260912090200_catalog_grants.sql \
          supabase/migrations/20260912090200_catalog_grants.down.sql \
          tests/catalog/grants.test.ts && \
  git commit -m "feat(catalog): make the catalog read-only to users"
  ```

---

## Task 5 — Worker skeleton: requirements, source registry, download with checksum

**Files**
- Create: `scripts/requirements.txt`
- Create: `scripts/import-fdc.py`
- Test: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: `CATALOG_IMPORT_DB_URL` (Phase 1–2 contracts §6, already in `.env.example`).
- Produces: `SOURCES: dict[str, Source]`, `download(source, version_label, root) -> Path`,
  `extract(zip_path, dest) -> Path`, `sha256_file(path) -> str`, `parse_args(argv=None)`.

### Steps

- [ ] Write `scripts/requirements.txt`:
  ```
  # Lane F import worker. Install into a worker-local venv, never globally:
  #   python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
  psycopg[binary]==3.2.9
  requests==2.32.4
  ```

- [ ] Write the failing test `tests/catalog/test_import_fdc.py`:
  ```python
  """Unit tests for the pure parts of scripts/import-fdc.py.

  Run either way:
      python3 -m pytest tests/catalog/test_import_fdc.py
      python3 -m unittest tests.catalog.test_import_fdc
  """

  import hashlib
  import importlib.util
  import pathlib
  import tempfile
  import unittest

  ROOT = pathlib.Path(__file__).resolve().parents[2]


  def load_worker():
      spec = importlib.util.spec_from_file_location("import_fdc", ROOT / "scripts" / "import-fdc.py")
      module = importlib.util.module_from_spec(spec)
      spec.loader.exec_module(module)
      return module


  fdc = load_worker()


  class SourceRegistry(unittest.TestCase):
      def test_three_bulk_sources_with_catalog_source_keys(self):
          self.assertEqual(sorted(fdc.SOURCES), ["fdc_fndds", "fdc_foundation", "fdc_sr_legacy"])

      def test_quality_class_matches_the_spec(self):
          self.assertEqual(fdc.SOURCES["fdc_foundation"].quality_class, "analytical")
          self.assertEqual(fdc.SOURCES["fdc_sr_legacy"].quality_class, "analytical")
          self.assertEqual(fdc.SOURCES["fdc_fndds"].quality_class, "survey")


  class Checksums(unittest.TestCase):
      def test_sha256_file_matches_hashlib(self):
          with tempfile.NamedTemporaryFile(delete=False) as fh:
              fh.write(b"chicken thigh, roasted")
              path = pathlib.Path(fh.name)
          self.assertEqual(
              fdc.sha256_file(path), hashlib.sha256(b"chicken thigh, roasted").hexdigest()
          )
          path.unlink()


  if __name__ == "__main__":
      unittest.main()
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `FileNotFoundError: .../scripts/import-fdc.py`.

- [ ] Write `scripts/import-fdc.py` — header, registry and download:
  ```python
  #!/usr/bin/env python3
  """
  Import USDA FoodData Central bulk CSVs into the catalog_* tables (architecture §7.2).

  download (checksum) -> catalog_staging.* (COPY) -> build revisions -> validate
    -> catalog_activate_version(version_label), all three sources under one label.

  The worker runs on the Mac or in GitHub Actions with the service role, never on Vercel.

  Usage:
    python3 scripts/import-fdc.py --version-label 2026-09-12
    python3 scripts/import-fdc.py --version-label 2026-09-12 --dry-run \
        --db-url postgres://postgres:postgres@localhost:5433/postgres
    python3 scripts/import-fdc.py --rollback-to 2026-06-01
  """

  import argparse
  import csv
  import hashlib
  import json
  import os
  import re
  import shutil
  import sys
  import zipfile
  from collections import defaultdict
  from dataclasses import dataclass
  from pathlib import Path

  DOWNLOAD_ROOT = Path(os.path.expanduser("~/Backups/usda/fdc"))
  USER_AGENT = "sasha-meal-companion/1.0 (catalog import)"


  @dataclass(frozen=True)
  class Source:
      key: str            # catalog_versions.source
      url: str
      quality_class: str  # architecture §4.1 quality_class vocabulary


  # VERIFY AT FIRST RUN: FDC publishes one dated zip per dataset and retires old links.
  # Check https://fdc.nal.usda.gov/download-datasets and override with --url key=URL.
  SOURCES = {
      "fdc_foundation": Source(
          "fdc_foundation",
          "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-04.zip",
          "analytical",
      ),
      "fdc_sr_legacy": Source(
          "fdc_sr_legacy",
          "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
          "analytical",
      ),
      "fdc_fndds": Source(
          "fdc_fndds",
          "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10.zip",
          "survey",
      ),
  }


  def sha256_file(path: Path) -> str:
      digest = hashlib.sha256()
      with open(path, "rb") as fh:
          for chunk in iter(lambda: fh.read(1 << 20), b""):
              digest.update(chunk)
      return digest.hexdigest()


  def download(source: Source, version_label: str, root: Path = DOWNLOAD_ROOT) -> Path:
      """Fetch the zip into ~/Backups/usda/fdc/<version_label>/ and record its sha256.

      A file already on disk is reused. A recorded digest that no longer matches is a hard
      failure: the source changed underneath a label, and the label must change with it.
      """
      import requests  # local import so the pure helpers load without the dependency

      target_dir = root / version_label
      target_dir.mkdir(parents=True, exist_ok=True)
      zip_path = target_dir / f"{source.key}.zip"
      if not zip_path.exists():
          print(f"downloading {source.key} from {source.url}", file=sys.stderr)
          with requests.get(source.url, stream=True, timeout=300,
                            headers={"User-Agent": USER_AGENT}) as resp:
              resp.raise_for_status()
              with open(zip_path, "wb") as fh:
                  shutil.copyfileobj(resp.raw, fh)
      digest = sha256_file(zip_path)
      record = target_dir / "checksums.json"
      known = json.loads(record.read_text()) if record.exists() else {}
      if known.get(source.key) not in (None, digest):
          raise SystemExit(
              f"{source.key}: sha256 changed under label {version_label}; use a new label"
          )
      known[source.key] = digest
      record.write_text(json.dumps(known, indent=2, sort_keys=True) + "\n")
      print(f"{source.key} sha256 {digest}", file=sys.stderr)
      return zip_path


  def extract(zip_path: Path, dest: Path) -> Path:
      """Unpack the zip flat into dest; FDC nests the CSVs one directory deep."""
      dest.mkdir(parents=True, exist_ok=True)
      with zipfile.ZipFile(zip_path) as zf:
          for member in zf.namelist():
              name = Path(member).name
              if not name.endswith(".csv"):
                  continue
              with zf.open(member) as src, open(dest / name, "wb") as out:
                  shutil.copyfileobj(src, out)
      return dest


  def parse_args(argv=None):
      p = argparse.ArgumentParser(description="Import FDC bulk CSVs into catalog_*")
      p.add_argument("--db-url", default=os.environ.get("CATALOG_IMPORT_DB_URL"),
                     help="Postgres URL; defaults to $CATALOG_IMPORT_DB_URL")
      p.add_argument("--version-label", help="one label for all three sources, e.g. 2026-09-12")
      p.add_argument("--sources", default=",".join(SOURCES),
                     help="comma-separated subset of " + ",".join(SOURCES))
      p.add_argument("--url", action="append", default=[], metavar="KEY=URL",
                     help="override a source URL (repeatable)")
      p.add_argument("--download-root", default=str(DOWNLOAD_ROOT))
      p.add_argument("--dry-run", action="store_true",
                     help="load and validate but do not call catalog_activate_version")
      p.add_argument("--rollback-to", metavar="LABEL",
                     help="reactivate a previous version_label and exit")
      args = p.parse_args(argv)
      if not args.db_url:
          p.error("set --db-url or CATALOG_IMPORT_DB_URL")
      if not args.rollback_to and not args.version_label:
          p.error("--version-label is required unless --rollback-to is given")
      return args
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 3 passed.

- [ ] Commit:
  ```bash
  git add scripts/requirements.txt scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): add the FDC import worker skeleton"
  ```

---

## Task 6 — Nutrient map and the nutrient.csv assertion

**Files**
- Modify: `scripts/import-fdc.py`
- Modify: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: `nutrient.csv` from any extracted FDC zip (`id`, `name`, `unit_name`).
- Produces: `NUTRIENT_MAP: dict[int, Nutrient]`, `CALC_NUTRIENT: Nutrient`,
  `catalog_nutrient_rows() -> list[tuple]`, `assert_nutrient_ids(csv_dir: Path) -> None`.
- The 20 codes match Phase 1–2 contracts §2 and Lane H's `lib/nutrients/codes.ts` exactly.

### Steps

- [ ] Append the failing cases to `tests/catalog/test_import_fdc.py`:
  ```python
  CONTRACT_CODES = {
      "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
      "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc",
      "vitamin_c", "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae",
      "saturated_fat", "cholesterol",
  }


  class NutrientMap(unittest.TestCase):
      def test_covers_every_contract_code_exactly_once(self):
          codes = [n.code for n in fdc.NUTRIENT_MAP.values()] + [fdc.CALC_NUTRIENT.code]
          self.assertEqual(len(codes), len(set(codes)))
          self.assertEqual(set(codes), CONTRACT_CODES)

      def test_binds_the_fdc_nutrient_numbers_the_spec_names(self):
          expected = {
              1008: "energy_kcal", 1003: "protein", 1005: "carbohydrate", 1004: "fat_total",
              1079: "fiber_total", 2000: "sugars_total", 1093: "sodium", 1092: "potassium",
              1087: "calcium", 1089: "iron", 1090: "magnesium", 1095: "zinc",
              1162: "vitamin_c", 1114: "vitamin_d", 1178: "vitamin_b12", 1190: "folate_dfe",
              1106: "vitamin_a_rae", 1258: "saturated_fat", 1253: "cholesterol",
          }
          self.assertEqual({k: v.code for k, v in fdc.NUTRIENT_MAP.items()}, expected)

      def test_units_are_the_four_the_contract_allows(self):
          units = {n.unit for n in fdc.NUTRIENT_MAP.values()} | {fdc.CALC_NUTRIENT.unit}
          self.assertEqual(units, {"kcal", "g", "mg", "µg"})

      def test_energy_kcal_calc_is_derivation_calculated(self):
          self.assertEqual(fdc.CALC_NUTRIENT.derivation, "calculated")

      def test_assert_nutrient_ids_rejects_a_missing_id(self):
          with tempfile.TemporaryDirectory() as tmp:
              path = pathlib.Path(tmp) / "nutrient.csv"
              path.write_text("id,name,unit_name,nutrient_nbr,rank\n1008,Energy,KCAL,208,300\n")
              with self.assertRaises(SystemExit) as caught:
                  fdc.assert_nutrient_ids(pathlib.Path(tmp))
              self.assertIn("1003", str(caught.exception))

      def test_assert_nutrient_ids_passes_when_every_id_is_present(self):
          with tempfile.TemporaryDirectory() as tmp:
              path = pathlib.Path(tmp) / "nutrient.csv"
              rows = ["id,name,unit_name,nutrient_nbr,rank"]
              rows += [f"{i},x,G,0,0" for i in fdc.NUTRIENT_MAP]
              path.write_text("\n".join(rows) + "\n")
              fdc.assert_nutrient_ids(pathlib.Path(tmp))  # must not raise

      def test_catalog_nutrient_rows_carry_fdc_ids_and_a_null_for_the_calculated_code(self):
          rows = {r[0]: r for r in fdc.catalog_nutrient_rows()}
          self.assertEqual(rows["protein"][1], 1003)
          self.assertIsNone(rows["energy_kcal_calc"][1])
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `AttributeError: module 'import_fdc' has no attribute 'NUTRIENT_MAP'`.

- [ ] Append to `scripts/import-fdc.py`, after `SOURCES`:
  ```python
  @dataclass(frozen=True)
  class Nutrient:
      code: str          # catalog_nutrients.code — Phase 1-2 contracts §2
      name: str
      unit: str          # kcal | g | mg | µg
      group: str
      derivation: str    # measured | calculated | label


  # FDC nutrient ids (nutrient.csv `id`, which food_nutrient.nutrient_id references).
  # VERIFY AGAINST nutrient.csv AT FIRST RUN — assert_nutrient_ids() below does exactly that
  # and fails the import rather than silently dropping a nutrient.
  NUTRIENT_MAP = {
      1008: Nutrient("energy_kcal", "Energy", "kcal", "energy", "measured"),
      1003: Nutrient("protein", "Protein", "g", "macro", "measured"),
      1005: Nutrient("carbohydrate", "Carbohydrate, by difference", "g", "macro", "measured"),
      1004: Nutrient("fat_total", "Total lipid (fat)", "g", "macro", "measured"),
      1079: Nutrient("fiber_total", "Fiber, total dietary", "g", "macro", "measured"),
      2000: Nutrient("sugars_total", "Sugars, total including NLEA", "g", "macro", "measured"),
      1093: Nutrient("sodium", "Sodium, Na", "mg", "mineral", "measured"),
      1092: Nutrient("potassium", "Potassium, K", "mg", "mineral", "measured"),
      1087: Nutrient("calcium", "Calcium, Ca", "mg", "mineral", "measured"),
      1089: Nutrient("iron", "Iron, Fe", "mg", "mineral", "measured"),
      1090: Nutrient("magnesium", "Magnesium, Mg", "mg", "mineral", "measured"),
      1095: Nutrient("zinc", "Zinc, Zn", "mg", "mineral", "measured"),
      1162: Nutrient("vitamin_c", "Vitamin C, total ascorbic acid", "mg", "vitamin", "measured"),
      1114: Nutrient("vitamin_d", "Vitamin D (D2 + D3)", "µg", "vitamin", "measured"),
      1178: Nutrient("vitamin_b12", "Vitamin B-12", "µg", "vitamin", "measured"),
      1190: Nutrient("folate_dfe", "Folate, DFE", "µg", "vitamin", "measured"),
      1106: Nutrient("vitamin_a_rae", "Vitamin A, RAE", "µg", "vitamin", "measured"),
      1258: Nutrient("saturated_fat", "Fatty acids, total saturated", "g", "lipid", "measured"),
      1253: Nutrient("cholesterol", "Cholesterol", "mg", "lipid", "measured"),
  }

  # Not an FDC nutrient: catalog_atwater_kcal writes it (§3.1).
  CALC_NUTRIENT = Nutrient(
      "energy_kcal_calc", "Energy, Atwater calculated", "kcal", "energy", "calculated"
  )


  def catalog_nutrient_rows():
      """Rows for catalog_nutrients(code, fdc_nutrient_id, name, unit, nutrient_group, derivation)."""
      rows = [(n.code, fdc_id, n.name, n.unit, n.group, n.derivation)
              for fdc_id, n in NUTRIENT_MAP.items()]
      rows.append((CALC_NUTRIENT.code, None, CALC_NUTRIENT.name, CALC_NUTRIENT.unit,
                   CALC_NUTRIENT.group, CALC_NUTRIENT.derivation))
      return rows


  def assert_nutrient_ids(csv_dir: Path) -> None:
      """Every mapped FDC id must exist in this dataset's nutrient.csv, or the import stops."""
      path = csv_dir / "nutrient.csv"
      if not path.exists():
          raise SystemExit(f"{path} is missing; the zip layout changed")
      with open(path, newline="", encoding="utf-8-sig") as fh:
          present = {int(row["id"]) for row in csv.DictReader(fh) if row["id"].strip().isdigit()}
      missing = sorted(set(NUTRIENT_MAP) - present)
      if missing:
          raise SystemExit(
              f"nutrient.csv in {csv_dir} does not carry these mapped ids: {missing}. "
              "FDC renumbered a nutrient; fix NUTRIENT_MAP before importing."
          )
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 10 passed.

- [ ] Commit:
  ```bash
  git add scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): map FDC nutrient ids to the canonical codes"
  ```

---

## Task 7 — Staging schema and COPY load

**Files**
- Modify: `scripts/import-fdc.py`
- Modify: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: the extracted CSVs `food.csv`, `food_nutrient.csv`, `food_portion.csv`, `measure_unit.csv`,
  `food_category.csv`; schema `catalog_staging` from Task 1.
- Produces: `STAGING_DDL: str`, `STAGING_LOADS: list[tuple]`, `_numeric_or_none(value)`,
  `stage_source(conn, source_key, csv_dir) -> dict`.

### Steps

- [ ] Append the failing cases to `tests/catalog/test_import_fdc.py`:
  ```python
  class Staging(unittest.TestCase):
      def test_ddl_creates_every_table_the_loader_writes(self):
          for table in ("food", "food_nutrient", "food_portion", "measure_unit", "food_category"):
              self.assertIn(f"catalog_staging.{table}", fdc.STAGING_DDL)

      def test_ddl_is_idempotent(self):
          self.assertEqual(fdc.STAGING_DDL.count("create table if not exists"), 5)

      def test_numeric_or_none_reads_blanks_and_junk_as_none(self):
          self.assertIsNone(fdc._numeric_or_none(""))
          self.assertIsNone(fdc._numeric_or_none(None))
          self.assertIsNone(fdc._numeric_or_none("n/a"))
          self.assertEqual(fdc._numeric_or_none(" 28.35 "), 28.35)
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `AttributeError: module 'import_fdc' has no attribute 'STAGING_DDL'`.

- [ ] Append to `scripts/import-fdc.py`:
  ```python
  STAGING_DDL = """
  create schema if not exists catalog_staging;
  create table if not exists catalog_staging.food (
    source text not null, fdc_id text not null, data_type text, description text,
    food_category_id text, primary key (source, fdc_id));
  create table if not exists catalog_staging.food_nutrient (
    source text not null, fdc_id text not null, nutrient_id integer not null, amount numeric);
  create table if not exists catalog_staging.food_portion (
    source text not null, fdc_id text not null, seq_num integer, amount text,
    measure_unit_id text, portion_description text, modifier text, gram_weight numeric);
  create table if not exists catalog_staging.measure_unit (
    source text not null, id text not null, name text, primary key (source, id));
  create table if not exists catalog_staging.food_category (
    source text not null, id text not null, description text, primary key (source, id));
  create index if not exists staging_food_nutrient_key
    on catalog_staging.food_nutrient (source, fdc_id);
  create index if not exists staging_food_portion_key
    on catalog_staging.food_portion (source, fdc_id);
  """

  # (csv file, staging table, staging columns, csv columns, required). A missing optional file is
  # skipped with a warning: not every FDC zip carries measure_unit.csv or food_category.csv.
  STAGING_LOADS = [
      ("food.csv", "food",
       ["fdc_id", "data_type", "description", "food_category_id"],
       ["fdc_id", "data_type", "description", "food_category_id"], True),
      ("food_nutrient.csv", "food_nutrient",
       ["fdc_id", "nutrient_id", "amount"],
       ["fdc_id", "nutrient_id", "amount"], True),
      ("food_portion.csv", "food_portion",
       ["fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description",
        "modifier", "gram_weight"],
       ["fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description",
        "modifier", "gram_weight"], False),
      ("measure_unit.csv", "measure_unit", ["id", "name"], ["id", "name"], False),
      ("food_category.csv", "food_category", ["id", "description"], ["id", "description"], False),
  ]

  NUMERIC_COLUMNS = {"gram_weight"}
  INTEGER_COLUMNS = {"nutrient_id", "seq_num"}


  def _numeric_or_none(value):
      value = (value or "").strip()
      if not value:
          return None
      try:
          return float(value)
      except ValueError:
          return None


  def _staging_value(table, column, raw):
      """One CSV cell -> one staging column value. amount is text in food_portion, numeric elsewhere."""
      if column in INTEGER_COLUMNS:
          number = _numeric_or_none(raw)
          return int(number) if number is not None else None
      if column in NUMERIC_COLUMNS or (column == "amount" and table != "food_portion"):
          return _numeric_or_none(raw)
      return raw or None


  def stage_source(conn, source_key: str, csv_dir: Path) -> dict:
      """COPY one dataset's CSVs into catalog_staging, replacing anything already there."""
      counts = {}
      with conn.cursor() as cur:
          cur.execute(STAGING_DDL)
          for _, table, _, _, _ in STAGING_LOADS:
              cur.execute(f"delete from catalog_staging.{table} where source = %s", (source_key,))
          for filename, table, columns, csv_columns, required in STAGING_LOADS:
              path = csv_dir / filename
              if not path.exists():
                  if required:
                      raise SystemExit(f"{path} is missing; the zip layout changed")
                  print(f"  {filename}: absent, skipped", file=sys.stderr)
                  counts[table] = 0
                  continue
              target = ", ".join(["source"] + columns)
              copy_sql = f"copy catalog_staging.{table} ({target}) from stdin"
              written = 0
              with open(path, newline="", encoding="utf-8-sig") as fh, cur.copy(copy_sql) as cp:
                  for row in csv.DictReader(fh):
                      values = [source_key] + [
                          _staging_value(table, col, (row.get(col) or "").strip())
                          for col in csv_columns
                      ]
                      # 98 % of food_nutrient.csv is nutrients this app does not track.
                      if table == "food_nutrient" and values[2] not in NUTRIENT_MAP:
                          continue
                      cp.write_row(values)
                      written += 1
              counts[table] = written
              print(f"  {filename}: {written} rows", file=sys.stderr)
      return counts
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 13 passed.

- [ ] Commit:
  ```bash
  git add scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): stage FDC CSVs with COPY"
  ```

---

## Task 8 — Build foods, revisions, nutrients and quality flags

**Files**
- Modify: `scripts/import-fdc.py`
- Modify: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: `catalog_staging.*` (Task 7), `catalog_atwater_kcal` (Task 2), `SOURCES`, `NUTRIENT_MAP`.
- Produces: `PREP_STATE_CASE: str`, `build_source(conn, source, version_label) -> int` (returns the
  `catalog_versions.id` it wrote against).

### Steps

- [ ] Append the failing cases to `tests/catalog/test_import_fdc.py`:
  ```python
  class PrepState(unittest.TestCase):
      def test_case_expression_covers_the_mapped_vocabulary(self):
          for state in ("raw", "cooked", "boiled", "roasted", "fried", "grilled"):
              self.assertIn(f"'{state}'", fdc.PREP_STATE_CASE)

      def test_case_expression_never_emits_a_value_outside_the_ddl_check(self):
          # 'canned' and 'dried' are not in contracts §3's PrepState union (Lane G Open question 2);
          # the DDL check no longer accepts them, so the mapper must never try to write them either.
          self.assertNotIn("'canned'", fdc.PREP_STATE_CASE)
          self.assertNotIn("'dried'", fdc.PREP_STATE_CASE)

      def test_case_expression_defaults_to_null_not_a_guess(self):
          self.assertTrue(fdc.PREP_STATE_CASE.rstrip().endswith("else null end"))
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `AttributeError: module 'import_fdc' has no attribute 'PREP_STATE_CASE'`.

- [ ] Append to `scripts/import-fdc.py`:
  ```python
  # §4.1 scores prep_state_match at 0.5 when the revision has none, so an unreadable description
  # must fall through to null rather than guess. Order matters: the first match wins.
  # 'canned' and 'dried' descriptions fall through to null (scored 0.5, neutral) rather than a value
  # the DDL check no longer accepts — contracts §3's PrepState has no member for either (Lane G Open
  # question 2). 'baked' is not a distinct branch either: it already folds into 'roasted' below and
  # was never a literal output.
  PREP_STATE_CASE = r"""
  case
    when lower(s.description) ~ '\braw\b'                          then 'raw'
    when lower(s.description) ~ '\b(roasted|baked)\b'              then 'roasted'
    when lower(s.description) ~ '\bgrilled\b'                      then 'grilled'
    when lower(s.description) ~ '\b(fried|pan-fried|deep fried)\b' then 'fried'
    when lower(s.description) ~ '\b(boiled|simmered|poached)\b'    then 'boiled'
    when lower(s.description) ~ '\b(cooked|braised|steamed|broiled|stewed)\b' then 'cooked'
    else null end"""


  def _write_version_and_foods(cur, source: Source, version_label: str) -> int:
      cur.execute(
          """insert into catalog_versions (source, version_label) values (%s, %s)
             on conflict (source, version_label) do nothing""",
          (source.key, version_label))
      cur.execute("select id from catalog_versions where source = %s and version_label = %s",
                  (source.key, version_label))
      version_id = cur.fetchone()[0]
      cur.executemany(
          """insert into catalog_nutrients
               (code, fdc_nutrient_id, name, unit, nutrient_group, derivation)
             values (%s, %s, %s, %s, %s, %s) on conflict (code) do nothing""",
          catalog_nutrient_rows())
      # Identity is (source, source_id) and is never rewritten (§3.1).
      cur.execute(
          """insert into catalog_foods (source, source_id)
             select %s, s.fdc_id from catalog_staging.food s where s.source = %s
             on conflict (source, source_id) do nothing""",
          (source.key, source.key))
      return version_id


  def _write_revisions(cur, source: Source, version_id: int) -> None:
      cur.execute(
          f"""insert into catalog_food_revisions
                (catalog_food_id, catalog_version_id, description, brand, category,
                 prep_state, quality_class, quality_flags, content_hash, is_active)
              select f.id, %s, s.description, null, c.description,
                     {PREP_STATE_CASE}, %s, '{{}}'::text[],
                     md5(coalesce(s.description, '') || '|' || coalesce(c.description, '')),
                     false
                from catalog_staging.food s
                join catalog_foods f on f.source = %s and f.source_id = s.fdc_id
                left join catalog_staging.food_category c
                       on c.source = s.source and c.id = s.food_category_id
               where s.source = %s and s.description is not null
              on conflict (catalog_food_id, catalog_version_id) do nothing""",
          (version_id, source.quality_class, source.key, source.key))


  def _write_nutrients(cur, source: Source, version_id: int) -> None:
      # FDC bulk amounts are already per 100 g. A duplicate row (rare, FNDDS) keeps the max.
      cur.executemany(
          """insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
             select r.id, %s, max(s.amount)
               from catalog_staging.food_nutrient s
               join catalog_foods f on f.source = %s and f.source_id = s.fdc_id
               join catalog_food_revisions r
                 on r.catalog_food_id = f.id and r.catalog_version_id = %s
              where s.source = %s and s.nutrient_id = %s
              group by r.id
             on conflict (food_revision_id, nutrient_code) do update
               set amount_per_100g = excluded.amount_per_100g""",
          [(n.code, source.key, version_id, source.key, fdc_id)
           for fdc_id, n in NUTRIENT_MAP.items()])
      # Energy, once, in SQL (§3.1). One call per revision is deliberate: the spec forbids a
      # second Atwater implementation, and the import is a quarterly job.
      cur.execute(
          """insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
             select r.id, 'energy_kcal_calc', a.kcal
               from catalog_food_revisions r, lateral catalog_atwater_kcal(r.id) a
              where r.catalog_version_id = %s and a.complete
             on conflict (food_revision_id, nutrient_code) do update
               set amount_per_100g = excluded.amount_per_100g""",
          (version_id,))


  def _write_quality_flags(cur, version_id: int) -> None:
      # §3.1: atwater_incomplete (a macro is missing), carb_basis_total (no fiber reported, so
      # carbohydrate is total not available), energy_mismatch (reported vs computed above 10 %).
      cur.execute(
          """with vals as (
               select r.id,
                      max(n.amount_per_100g) filter (where n.nutrient_code = 'energy_kcal') as rep,
                      max(n.amount_per_100g) filter (where n.nutrient_code = 'energy_kcal_calc') as calc,
                      bool_or(n.nutrient_code = 'fiber_total'
                              and n.amount_per_100g is not null) as has_fiber,
                      bool_or(n.nutrient_code = 'carbohydrate'
                              and n.amount_per_100g is not null) as has_carb
                 from catalog_food_revisions r
                 left join catalog_food_nutrients n on n.food_revision_id = r.id
                where r.catalog_version_id = %s
                group by r.id)
             update catalog_food_revisions r
                set quality_flags = (
                      case when v.calc is null then array['atwater_incomplete'] else '{}' end
                   || case when v.has_carb and not coalesce(v.has_fiber, false)
                           then array['carb_basis_total'] else '{}' end
                   || case when v.calc is not null and v.rep is not null and v.rep > 0
                            and abs(v.rep - v.calc) / v.rep > 0.10
                           then array['energy_mismatch'] else '{}' end)::text[]
               from vals v where v.id = r.id""",
          (version_id,))


  def build_source(conn, source: Source, version_label: str) -> int:
      """Write the version, foods, revisions, nutrients and flags for one dataset. Never activates."""
      with conn.cursor() as cur:
          version_id = _write_version_and_foods(cur, source, version_label)
          _write_revisions(cur, source, version_id)
          _write_nutrients(cur, source, version_id)
          _write_quality_flags(cur, version_id)
      return version_id
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 15 passed.

- [ ] Commit:
  ```bash
  git add scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): build revisions, nutrients and quality flags"
  ```

---

## Task 9 — Portion normalisation

**Files**
- Modify: `scripts/import-fdc.py`
- Modify: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: `catalog_staging.food_portion`, `catalog_staging.measure_unit`.
- Produces: `portion_label(amount, unit, description, modifier) -> str`,
  `normalise_portions(rows) -> list[dict]`, `load_portions(conn, source, version_id) -> int`.

### Steps

- [ ] Append the failing cases to `tests/catalog/test_import_fdc.py`:
  ```python
  class Portions(unittest.TestCase):
      def test_label_joins_amount_unit_description_and_modifier(self):
          self.assertEqual(fdc.portion_label("1.000", "cup", "", "chopped"), "1 cup chopped")

      def test_label_drops_the_undetermined_unit(self):
          self.assertEqual(fdc.portion_label("1", "undetermined", "1 thigh", ""), "1 1 thigh")

      def test_label_collapses_whitespace(self):
          self.assertEqual(fdc.portion_label(" 2 ", " oz ", "  ", " raw "), "2 oz raw")

      def test_normalise_keeps_only_gram_weighted_measures(self):
          rows = [
              {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
               "modifier": "", "gram_weight": "158"},
              {"seq_num": "2", "amount": "1", "unit_name": "cup", "portion_description": "",
               "modifier": "", "gram_weight": "0"},
              {"seq_num": "3", "amount": "", "unit_name": "", "portion_description": "",
               "modifier": "", "gram_weight": "40"},
          ]
          out = fdc.normalise_portions(rows)
          self.assertEqual(len(out), 1)
          self.assertEqual(out[0]["description"], "1 cup")
          self.assertEqual(out[0]["gram_weight"], 158.0)

      def test_normalise_marks_the_first_measure_default_and_numbers_from_one(self):
          rows = [
              {"seq_num": "2", "amount": "1", "unit_name": "oz", "portion_description": "",
               "modifier": "", "gram_weight": "28.35"},
              {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
               "modifier": "", "gram_weight": "158"},
          ]
          out = fdc.normalise_portions(rows)
          self.assertEqual([r["seq"] for r in out], [1, 2])
          self.assertEqual([r["is_default"] for r in out], [True, False])
          self.assertEqual(out[0]["description"], "1 cup")

      def test_normalise_puts_rows_without_a_seq_num_last(self):
          rows = [
              {"seq_num": "", "amount": "1", "unit_name": "oz", "portion_description": "",
               "modifier": "", "gram_weight": "28.35"},
              {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
               "modifier": "", "gram_weight": "158"},
          ]
          self.assertEqual(
              [r["description"] for r in fdc.normalise_portions(rows)], ["1 cup", "1 oz"]
          )

      def test_normalise_returns_nothing_for_a_food_with_no_measures(self):
          self.assertEqual(fdc.normalise_portions([]), [])
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `AttributeError: module 'import_fdc' has no attribute 'portion_label'`.

- [ ] Append to `scripts/import-fdc.py`:
  ```python
  UNITLESS = {"", "undetermined", "na", "none"}


  def portion_label(amount: str, unit: str, description: str, modifier: str) -> str:
      """One household measure, the way build-food-db.py already reads FDC portion columns."""
      amount = (amount or "").strip()
      if "." in amount:
          amount = amount.rstrip("0").rstrip(".")
      unit = (unit or "").strip()
      if unit.lower() in UNITLESS:
          unit = ""
      parts = [amount, unit, (description or "").strip(), (modifier or "").strip()]
      return re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()


  def normalise_portions(rows):
      """FDC food_portion rows for one food -> catalog_portions rows.

      Keeps gram-weighted household measures only, orders them by the source seq_num (rows
      without one sort last), numbers them from 1 and marks the FIRST one default, which is
      the rule the spec sets: is_default is the first gram-weighted household measure.
      """
      kept = []
      for row in rows:
          grams = _numeric_or_none(row.get("gram_weight"))
          if grams is None or grams <= 0:
              continue
          label = portion_label(row.get("amount", ""), row.get("unit_name", ""),
                                row.get("portion_description", ""), row.get("modifier", ""))
          if not label:
              continue
          seq_num = _numeric_or_none(row.get("seq_num"))
          kept.append({"order": int(seq_num) if seq_num else 10 ** 6,
                       "description": label, "gram_weight": round(grams, 2)})
      kept.sort(key=lambda r: (r["order"], r["description"]))
      return [{"seq": i, "description": r["description"], "gram_weight": r["gram_weight"],
               "is_default": i == 1}
              for i, r in enumerate(kept, start=1)]


  def load_portions(conn, source: Source, version_id: int) -> int:
      """Read this version's portions out of staging, normalise in Python, COPY them back."""
      written = 0
      with conn.cursor() as read_cur, conn.cursor() as write_cur:
          read_cur.execute(
              """select r.id, p.seq_num, p.amount, coalesce(u.name, ''), p.portion_description,
                        p.modifier, p.gram_weight
                   from catalog_staging.food_portion p
                   join catalog_foods f on f.source = %s and f.source_id = p.fdc_id
                   join catalog_food_revisions r
                     on r.catalog_food_id = f.id and r.catalog_version_id = %s
                   left join catalog_staging.measure_unit u
                          on u.source = p.source and u.id = p.measure_unit_id
                  where p.source = %s
                  order by r.id""",
              (source.key, version_id, source.key))
          by_revision = defaultdict(list)
          for rev_id, seq_num, amount, unit, desc, modifier, grams in read_cur:
              by_revision[rev_id].append({
                  "seq_num": "" if seq_num is None else str(seq_num),
                  "amount": amount or "", "unit_name": unit or "",
                  "portion_description": desc or "", "modifier": modifier or "",
                  "gram_weight": "" if grams is None else str(grams)})
          write_cur.execute(
              """delete from catalog_portions where food_revision_id in
                   (select id from catalog_food_revisions where catalog_version_id = %s)""",
              (version_id,))
          copy_sql = ("copy catalog_portions "
                      "(food_revision_id, description, gram_weight, seq, is_default) from stdin")
          with write_cur.copy(copy_sql) as cp:
              for rev_id, rows in by_revision.items():
                  for row in normalise_portions(rows):
                      cp.write_row([rev_id, row["description"], row["gram_weight"],
                                    row["seq"], row["is_default"]])
                      written += 1
      print(f"  portions: {written} rows", file=sys.stderr)
      return written
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 22 passed.

- [ ] Commit:
  ```bash
  git add scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): normalise FDC portions into catalog_portions"
  ```

---

## Task 10 — Validation, activation, idempotency and rollback

**Files**
- Modify: `scripts/import-fdc.py`
- Modify: `tests/catalog/test_import_fdc.py`

**Interfaces**
- Consumes: `catalog_activate_version(p_version_label text)` (Task 3), everything from Tasks 5–9.
- Produces: `MIN_ROWS: dict[str, int]`, `MIN_MACRO_COVERAGE: float`, `MAX_MISMATCH_RATE: float`,
  `validate(conn, version_id) -> dict`, `assert_gates(source, report) -> None`,
  `already_active(conn, label, source_keys) -> bool`, `rollback(conn, label) -> None`,
  `main(argv=None) -> int`.

### Steps

- [ ] Append the failing cases to `tests/catalog/test_import_fdc.py`:
  ```python
  class Gates(unittest.TestCase):
      def test_row_floors_exist_for_all_three_sources(self):
          self.assertEqual(sorted(fdc.MIN_ROWS), ["fdc_fndds", "fdc_foundation", "fdc_sr_legacy"])
          self.assertTrue(all(v > 0 for v in fdc.MIN_ROWS.values()))

      def test_macro_coverage_and_mismatch_gates_match_the_spec(self):
          self.assertEqual(fdc.MAX_MISMATCH_RATE, 0.10)
          self.assertGreaterEqual(fdc.MIN_MACRO_COVERAGE, 0.90)

      def test_assert_gates_rejects_a_truncated_dataset(self):
          report = {"revisions": 10, "macro_coverage": 1.0, "energy_mismatch_rate": 0.0}
          with self.assertRaises(SystemExit):
              fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)

      def test_assert_gates_accepts_a_healthy_dataset(self):
          report = {"revisions": 7500, "macro_coverage": 0.97, "energy_mismatch_rate": 0.02}
          fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)  # must not raise


  class Cli(unittest.TestCase):
      def test_version_label_is_required_without_rollback(self):
          with self.assertRaises(SystemExit):
              fdc.parse_args(["--db-url", "postgres://x"])

      def test_rollback_alone_is_enough(self):
          args = fdc.parse_args(["--db-url", "postgres://x", "--rollback-to", "2026-06-01"])
          self.assertEqual(args.rollback_to, "2026-06-01")
          self.assertIsNone(args.version_label)

      def test_dry_run_defaults_off(self):
          args = fdc.parse_args(["--db-url", "postgres://x", "--version-label", "2026-09-12"])
          self.assertFalse(args.dry_run)
  ```

- [ ] Run, expect FAIL:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected failure: `AttributeError: module 'import_fdc' has no attribute 'MIN_ROWS'`.

- [ ] Append to `scripts/import-fdc.py`:
  ```python
  # Floors, not targets: a dataset that shrinks past these has been truncated on the way in.
  MIN_ROWS = {"fdc_foundation": 300, "fdc_sr_legacy": 7000, "fdc_fndds": 5000}
  MIN_MACRO_COVERAGE = 0.90   # revisions carrying protein, carbohydrate and fat_total
  MAX_MISMATCH_RATE = 0.10    # §3.1: a gap above 10 % is a flag, not a failure — this caps how many


  def validate(conn, version_id: int) -> dict:
      """Row counts, macro coverage and the energy-mismatch rate for one version."""
      with conn.cursor() as cur:
          cur.execute(
              """select count(*),
                        count(*) filter (where 'energy_mismatch' = any(quality_flags)),
                        count(*) filter (where 'atwater_incomplete' = any(quality_flags))
                   from catalog_food_revisions where catalog_version_id = %s""",
              (version_id,))
          revisions, mismatched, incomplete = cur.fetchone()
          cur.execute(
              """select count(*) from (
                   select r.id from catalog_food_revisions r
                     join catalog_food_nutrients n on n.food_revision_id = r.id
                    where r.catalog_version_id = %s and n.amount_per_100g is not null
                      and n.nutrient_code in ('protein','carbohydrate','fat_total')
                    group by r.id having count(*) = 3) x""",
              (version_id,))
          with_macros = cur.fetchone()[0]
          cur.execute(
              """select count(*) from catalog_portions
                  where food_revision_id in
                        (select id from catalog_food_revisions where catalog_version_id = %s)""",
              (version_id,))
          portions = cur.fetchone()[0]
      complete = max(revisions - incomplete, 1)
      return {
          "revisions": revisions,
          "portions": portions,
          "with_macros": with_macros,
          "macro_coverage": round(with_macros / max(revisions, 1), 4),
          "atwater_incomplete": incomplete,
          "energy_mismatch": mismatched,
          "energy_mismatch_rate": round(mismatched / complete, 4),
      }


  def assert_gates(source: Source, report: dict) -> None:
      floor = MIN_ROWS[source.key]
      if report["revisions"] < floor:
          raise SystemExit(f"{source.key}: {report['revisions']} revisions, floor is {floor}")
      if report["macro_coverage"] < MIN_MACRO_COVERAGE:
          raise SystemExit(
              f"{source.key}: macro coverage {report['macro_coverage']} below {MIN_MACRO_COVERAGE}")
      if report["energy_mismatch_rate"] > MAX_MISMATCH_RATE:
          raise SystemExit(
              f"{source.key}: energy mismatch rate {report['energy_mismatch_rate']} "
              f"above {MAX_MISMATCH_RATE}")


  def already_active(conn, label: str, source_keys) -> bool:
      """A second run of the same label is a no-op (acceptance criterion 3)."""
      keys = list(source_keys)
      with conn.cursor() as cur:
          cur.execute(
              """select count(*) from catalog_versions
                  where version_label = %s and is_active and source = any(%s)""",
              (label, keys))
          return cur.fetchone()[0] == len(keys)


  def rollback(conn, label: str) -> None:
      with conn.cursor() as cur:
          cur.execute("select count(*) from catalog_versions where version_label = %s", (label,))
          if cur.fetchone()[0] == 0:
              raise SystemExit(f"no catalog_versions row carries label {label}")
          cur.execute("select catalog_activate_version(%s)", (label,))
      conn.commit()
      print(f"rolled back to {label}", file=sys.stderr)


  def import_one(conn, args, key: str, overrides: dict) -> dict:
      base = SOURCES[key]
      source = Source(base.key, overrides.get(key, base.url), base.quality_class)
      print(f"== {key}", file=sys.stderr)
      zip_path = download(source, args.version_label, Path(args.download_root))
      csv_dir = extract(zip_path, Path(args.download_root) / args.version_label / key)
      assert_nutrient_ids(csv_dir)
      stage_source(conn, key, csv_dir)
      version_id = build_source(conn, source, args.version_label)
      load_portions(conn, source, version_id)
      report = validate(conn, version_id)
      assert_gates(source, report)
      with conn.cursor() as cur:
          cur.execute("update catalog_versions set row_counts = %s where id = %s",
                      (json.dumps(report), version_id))
      print(f"  {json.dumps(report)}", file=sys.stderr)
      return report


  def main(argv=None) -> int:
      import psycopg

      args = parse_args(argv)
      overrides = dict(pair.split("=", 1) for pair in args.url)
      keys = [k.strip() for k in args.sources.split(",") if k.strip()]
      for key in keys:
          if key not in SOURCES:
              raise SystemExit(f"unknown source {key}; choose from {', '.join(SOURCES)}")

      with psycopg.connect(args.db_url, autocommit=False) as conn:
          if args.rollback_to:
              rollback(conn, args.rollback_to)
              return 0
          if already_active(conn, args.version_label, keys):
              print(f"{args.version_label} is already active; nothing to do", file=sys.stderr)
              return 0

          reports = {key: import_one(conn, args, key, overrides) for key in keys}

          if args.dry_run:
              conn.commit()
              print("dry run: rows loaded, version NOT activated", file=sys.stderr)
          else:
              with conn.cursor() as cur:
                  cur.execute("select catalog_activate_version(%s)", (args.version_label,))
              conn.commit()
              print(f"activated {args.version_label}", file=sys.stderr)
          print(json.dumps(reports, indent=2))
      return 0


  if __name__ == "__main__":
      sys.exit(main())
  ```

- [ ] Run, expect PASS:
  ```bash
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: 29 passed.

- [ ] Commit:
  ```bash
  git add scripts/import-fdc.py tests/catalog/test_import_fdc.py && \
  git commit -m "feat(catalog): validate and activate an FDC import"
  ```

---

## Task 11 — Dry run on local Postgres and the sizing report

**Files**
- Create: `scripts/catalog-size-report.sql`
- Create: `scripts/catalog-dry-run.sh`
- Create: `docs/catalog/sizing.md` (written by the run, then committed)

**Interfaces**
- Consumes: the three migrations, `scripts/import-fdc.py --dry-run`.
- Produces: `docs/catalog/sizing.md` with per-table and per-index sizes and the headroom percentage
  against the 8 GiB Supabase Pro disk (acceptance criterion 1).

### Steps

- [ ] Write `scripts/catalog-size-report.sql`:
  ```sql
  -- Per-table and per-index size for the catalog, plus headroom against the Supabase Pro disk.
  -- pg_total_relation_size on a table already counts its indexes and TOAST, so the total sums
  -- tables only; indexes are listed separately with pg_relation_size to show where the bytes went.
  \pset border 2

  \echo '## Tables'
  select c.relname as table,
         (select count(*) from pg_class i
           join pg_index x on x.indexrelid = i.oid where x.indrelid = c.oid) as indexes,
         pg_size_pretty(pg_total_relation_size(c.oid)) as total,
         pg_total_relation_size(c.oid) as total_bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'catalog\_%'
   order by pg_total_relation_size(c.oid) desc;

  \echo '## Indexes'
  select c.relname as index,
         pg_size_pretty(pg_relation_size(c.oid)) as size,
         pg_relation_size(c.oid) as size_bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'i' and c.relname like 'catalog\_%'
   order by pg_relation_size(c.oid) desc;

  \echo '## Headroom (Supabase Pro disk = 8 GiB)'
  select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as catalog_total,
         round(100.0 * sum(pg_total_relation_size(c.oid)) / (8 * 1024 ^ 3), 1) as used_pct_of_8gib,
         round(100.0 - 100.0 * sum(pg_total_relation_size(c.oid)) / (8 * 1024 ^ 3), 1) as headroom_pct
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'catalog\_%';

  \echo '## Energy mismatch rate per version'
  select v.source, v.version_label, v.is_active, v.row_counts ->> 'revisions' as revisions,
         v.row_counts ->> 'energy_mismatch_rate' as energy_mismatch_rate,
         v.row_counts ->> 'macro_coverage' as macro_coverage
    from catalog_versions v order by v.source, v.version_label;
  ```

- [ ] Write `scripts/catalog-dry-run.sh`:
  ```bash
  #!/usr/bin/env bash
  # Dry-run sizing (architecture §7.1). Brings up a throwaway Postgres 17 on Colima/Docker,
  # applies the Phase 0 catalog shell and the three Phase 1 migrations, imports all three FDC
  # sources WITHOUT activating, runs the size report and writes docs/catalog/sizing.md.
  #
  #   ./scripts/catalog-dry-run.sh 2026-09-12
  #
  # Nothing here touches Supabase. The container is removed at the end unless KEEP=1.
  set -euo pipefail

  LABEL="${1:?usage: catalog-dry-run.sh <version-label>}"
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  CONTAINER=smc-catalog-dryrun
  PORT=5433
  URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"

  command -v docker >/dev/null || { echo "docker is not on PATH; start Colima first" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "docker daemon is not running; run: colima start" >&2; exit 1; }

  cleanup() { [ "${KEEP:-0}" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres \
    -p "${PORT}:5432" postgres:17 >/dev/null

  echo "waiting for postgres 17" >&2
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done

  # The roles the grants migration references exist on Supabase, not in a bare image.
  psql "$URL" -v ON_ERROR_STOP=1 -c \
    "do \$\$ begin
       if not exists (select 1 from pg_roles where rolname = 'anon') then
         create role anon nologin; end if;
       if not exists (select 1 from pg_roles where rolname = 'authenticated') then
         create role authenticated nologin; end if;
       if not exists (select 1 from pg_roles where rolname = 'service_role') then
         create role service_role nologin bypassrls; end if;
     end \$\$;"

  for m in \
    "$ROOT/supabase/migrations/20260911000100_catalog_shell.sql" \
    "$ROOT/supabase/migrations/20260912090000_catalog_tables.sql" \
    "$ROOT/supabase/migrations/20260912090050_catalog_activate.sql" \
    "$ROOT/supabase/migrations/20260912090200_catalog_grants.sql"; do
    echo "applying $(basename "$m")" >&2
    psql "$URL" -v ON_ERROR_STOP=1 -f "$m"
  done

  VENV="$ROOT/.venv"
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$ROOT/scripts/requirements.txt"
  "$VENV/bin/python" "$ROOT/scripts/import-fdc.py" \
    --db-url "$URL" --version-label "$LABEL" --dry-run

  mkdir -p "$ROOT/docs/catalog"
  {
    echo "# Catalog sizing — dry run ${LABEL}"
    echo
    echo "Local Postgres 17 (docker \`postgres:17\` on Colima), Foundation + SR Legacy + FNDDS"
    echo "loaded by \`scripts/import-fdc.py --dry-run\`. Regenerate with:"
    echo
    echo '```'
    echo "./scripts/catalog-dry-run.sh ${LABEL}"
    echo '```'
    echo
    echo "Supabase Pro disk is 8 GiB. Acceptance criterion 1 needs headroom of at least 40 %."
    echo "If it does not clear 40 %, FNDDS moves to on-demand and that decision is recorded here."
    echo
    psql "$URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/catalog-size-report.sql"
  } > "$ROOT/docs/catalog/sizing.md"

  echo "wrote docs/catalog/sizing.md" >&2
  ```

- [ ] Make it executable and run it — **[needs network]** (downloads three FDC zips into
  `~/Backups/usda/fdc/<label>/`, roughly 1.2 GB), expect PASS:
  ```bash
  chmod +x scripts/catalog-dry-run.sh && ./scripts/catalog-dry-run.sh 2026-09-12
  ```
  Expected: the three `== fdc_*` blocks each print a JSON report, then
  `dry run: rows loaded, version NOT activated`, then `wrote docs/catalog/sizing.md`.

- [ ] Read `docs/catalog/sizing.md` and check `headroom_pct` is at least 40. If it is below 40, append a
  short "FNDDS moves to on-demand" paragraph naming the number that forced it, and rerun with
  `--sources fdc_foundation,fdc_sr_legacy`.

- [ ] Commit:
  ```bash
  git add scripts/catalog-size-report.sql scripts/catalog-dry-run.sh docs/catalog/sizing.md && \
  git commit -m "feat(catalog): add the dry-run sizing report"
  ```

---

## Task 12 — Export her seed and preset foods as JSON

**Files**
- Create: `scripts/export-seed-foods.ts`
- Test: `tests/catalog/export-seed-foods.test.ts`

**Interfaces**
- Consumes: `SEED_FOODS`, `PRESET_FOODS`, `Food`, `FoodRole`, `FoodUnit` from `@/lib/foods` (read-only;
  Lane F never edits that file).
- Produces: `export type SeedFoodRow = { food_id: string; name: string; role: FoodRole; unit: FoodUnit;
  origin: 'seed' | 'preset' }` and `export function seedFoodRows(): SeedFoodRow[]`; the script prints
  `JSON.stringify(seedFoodRows(), null, 2)` on stdout.

### Steps

- [ ] Write the failing test `tests/catalog/export-seed-foods.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { seedFoodRows } from "@/scripts/export-seed-foods";

  describe("seedFoodRows", () => {
    it("exports all 53 seed and preset foods", () => {
      expect(seedFoodRows()).toHaveLength(53);
    });

    it("gives every row a unique food_id", () => {
      const ids = seedFoodRows().map((r) => r.food_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("labels where each row came from", () => {
      const rows = seedFoodRows();
      expect(rows.filter((r) => r.origin === "seed")).toHaveLength(18);
      expect(rows.filter((r) => r.origin === "preset")).toHaveLength(35);
    });

    it("carries the role vocabulary the mapping CSV needs", () => {
      const roles = new Set(seedFoodRows().map((r) => r.role));
      expect([...roles].sort()).toEqual(["carb", "fat", "protein"]);
    });

    it("keeps the name the mapper matches on", () => {
      const chicken = seedFoodRows().find((r) => r.food_id === "chicken-breast");
      expect(chicken?.name).toBe("Chicken breast, cooked");
    });
  });
  ```

- [ ] Run, expect FAIL:
  ```bash
  pnpm test tests/catalog/export-seed-foods.test.ts
  ```
  Expected failure: `Failed to resolve import "@/scripts/export-seed-foods"`.

- [ ] Write `scripts/export-seed-foods.ts`:
  ```ts
  /**
   * Prints her seed and preset foods as JSON, for scripts/map-her-foods.py.
   *
   *   pnpm exec tsx scripts/export-seed-foods.ts > /tmp/her-foods.json
   *
   * Read-only: lib/foods.ts stays the single authored list, and this file never writes to it.
   */
  import { PRESET_FOODS, SEED_FOODS, type Food, type FoodRole, type FoodUnit } from "@/lib/foods";

  export type SeedFoodRow = {
    food_id: string;
    name: string;
    role: FoodRole;
    unit: FoodUnit;
    origin: "seed" | "preset";
  };

  function row(food: Food, origin: SeedFoodRow["origin"]): SeedFoodRow {
    return { food_id: food.id, name: food.name, role: food.role, unit: food.unit, origin };
  }

  export function seedFoodRows(): SeedFoodRow[] {
    return [
      ...SEED_FOODS.map((f) => row(f, "seed")),
      ...PRESET_FOODS.map((f) => row(f, "preset")),
    ];
  }

  if (process.argv[1]?.endsWith("export-seed-foods.ts")) {
    process.stdout.write(`${JSON.stringify(seedFoodRows(), null, 2)}\n`);
  }
  ```

- [ ] Run, expect PASS:
  ```bash
  pnpm test tests/catalog/export-seed-foods.test.ts && \
  pnpm exec tsx scripts/export-seed-foods.ts | head -8
  ```
  Expected: 5 passed, then the first JSON object printing `"food_id": "chicken-breast"`.

- [ ] Commit:
  ```bash
  git add scripts/export-seed-foods.ts tests/catalog/export-seed-foods.test.ts && \
  git commit -m "feat(catalog): export her seed and preset foods as JSON"
  ```

---

## Task 13 — Propose a catalog row per food

**Files**
- Create: `scripts/map-her-foods.py`
- Create: `docs/catalog/her-foods-mapping.csv` (written by the run, then committed)

**Interfaces**
- Consumes: the JSON from `scripts/export-seed-foods.ts`; the active `catalog_food_revisions` and
  `catalog_foods` rows; `pg_trgm.similarity`.
- Produces: `docs/catalog/her-foods-mapping.csv` with the columns `food_id, name, role,
  proposed_catalog_food_id, proposed_description, source, similarity, decision, reason` — `decision`
  blank for Devin.

### Steps

- [ ] Write `scripts/map-her-foods.py`:
  ```python
  #!/usr/bin/env python3
  """
  Propose one catalog row per seed and preset food, for Devin to review.

    pnpm exec tsx scripts/export-seed-foods.ts > /tmp/her-foods.json
    .venv/bin/python scripts/map-her-foods.py --foods /tmp/her-foods.json \
        --out docs/catalog/her-foods-mapping.csv

  This script PROPOSES. It writes no user row and sets no catalog_food_id. Devin fills the
  `decision` column (the proposed id, a different id, or `skip`) and Lane G's
  scripts/apply-food-mapping.ts applies the reviewed file.

  Ranking: trigram similarity on the active revision's description, rounded to two decimals so
  near-ties fall through to the source rank Foundation > SR Legacy > FNDDS, then the shortest
  description — the "shortest description wins" rule scripts/build-food-db.py already uses.
  """

  import argparse
  import csv
  import json
  import os
  import sys

  MIN_SIMILARITY = 0.20
  SOURCE_RANK = {"fdc_foundation": 0, "fdc_sr_legacy": 1, "fdc_fndds": 2}

  COLUMNS = ["food_id", "name", "role", "proposed_catalog_food_id", "proposed_description",
             "source", "similarity", "decision", "reason"]

  QUERY = """
  select r.catalog_food_id, r.description, f.source,
         round(similarity(r.description, %(q)s)::numeric, 4) as sim
    from catalog_food_revisions r
    join catalog_foods f on f.id = r.catalog_food_id
   where r.is_active
     and similarity(r.description, %(q)s) > %(floor)s
   order by round(similarity(r.description, %(q)s)::numeric, 2) desc,
            case f.source when 'fdc_foundation' then 0
                          when 'fdc_sr_legacy' then 1 else 2 end,
            length(r.description)
   limit 1
  """


  def parse_args(argv=None):
      p = argparse.ArgumentParser(description="Propose catalog rows for her foods")
      p.add_argument("--db-url", default=os.environ.get("CATALOG_IMPORT_DB_URL"))
      p.add_argument("--foods", required=True, help="JSON from scripts/export-seed-foods.ts")
      p.add_argument("--out", default="docs/catalog/her-foods-mapping.csv")
      p.add_argument("--min-similarity", type=float, default=MIN_SIMILARITY)
      args = p.parse_args(argv)
      if not args.db_url:
          p.error("set --db-url or CATALOG_IMPORT_DB_URL")
      return args


  def search_term(name: str) -> str:
      """Her names carry a preparation clause the catalog spells differently; keep both halves."""
      return name.replace(",", " ").replace("&", " ").strip()


  def propose(cur, food, floor):
      cur.execute(QUERY, {"q": search_term(food["name"]), "floor": floor})
      hit = cur.fetchone()
      if hit is None:
          return {"food_id": food["food_id"], "name": food["name"], "role": food["role"],
                  "proposed_catalog_food_id": "", "proposed_description": "", "source": "",
                  "similarity": "", "decision": "",
                  "reason": f"no active revision above similarity {floor}"}
      catalog_food_id, description, source, sim = hit
      return {"food_id": food["food_id"], "name": food["name"], "role": food["role"],
              "proposed_catalog_food_id": catalog_food_id, "proposed_description": description,
              "source": source, "similarity": f"{float(sim):.4f}", "decision": "",
              "reason": f"top trigram match, source rank {SOURCE_RANK.get(source, 9)}"}


  def main(argv=None) -> int:
      import psycopg

      args = parse_args(argv)
      with open(args.foods, encoding="utf-8") as fh:
          foods = json.load(fh)
      rows = []
      with psycopg.connect(args.db_url) as conn, conn.cursor() as cur:
          cur.execute("select count(*) from catalog_versions where is_active")
          if cur.fetchone()[0] == 0:
              raise SystemExit("no active catalog version; run scripts/import-fdc.py first")
          for food in foods:
              rows.append(propose(cur, food, args.min_similarity))

      os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
      with open(args.out, "w", newline="", encoding="utf-8") as fh:
          writer = csv.DictWriter(fh, fieldnames=COLUMNS)
          writer.writeheader()
          writer.writerows(rows)

      unmatched = [r["food_id"] for r in rows if not r["proposed_catalog_food_id"]]
      print(f"{len(rows)} foods, {len(unmatched)} without a proposal", file=sys.stderr)
      for food_id in unmatched:
          print(f"  unmatched: {food_id}", file=sys.stderr)
      print(f"wrote {args.out}", file=sys.stderr)
      return 0


  if __name__ == "__main__":
      sys.exit(main())
  ```

- [ ] Run against an imported branch — **[needs branch]**, expect PASS:
  ```bash
  pnpm exec tsx scripts/export-seed-foods.ts > /tmp/her-foods.json && \
  .venv/bin/python scripts/map-her-foods.py --foods /tmp/her-foods.json \
    --db-url "$SUPABASE_TEST_DB_URL" --out docs/catalog/her-foods-mapping.csv && \
  head -3 docs/catalog/her-foods-mapping.csv && wc -l < docs/catalog/her-foods-mapping.csv
  ```
  Expected: the header row plus two proposals, then `54` (header + 53 foods).

- [ ] Commit:
  ```bash
  git add scripts/map-her-foods.py docs/catalog/her-foods-mapping.csv && \
  git commit -m "feat(catalog): propose a catalog row for each of her foods"
  ```

---

## Task 14 — The import runbook

**Files**
- Create: `docs/catalog/import.md`

**Interfaces**
- Consumes: everything Tasks 1–13 produced.
- Produces: the operator document the Phase 1 rollout order refers to.

### Steps

- [ ] Write `docs/catalog/import.md`:
  ```markdown
  # Catalog import — runbook

  The worker is `scripts/import-fdc.py`. It runs on the Mac or in GitHub Actions with the service
  role, and **never on Vercel** (architecture §5, §7.2). It is the only writer to `catalog_*`.

  ## Setup, once

      python3 -m venv .venv
      .venv/bin/pip install -r scripts/requirements.txt

  `CATALOG_IMPORT_DB_URL` is a direct Postgres URL for the target database. It is a worker
  secret: it lives in `.env.local` or the shell, never in Vercel, and no script prints it.

  ## Dry run first (architecture §7.1)

      ./scripts/catalog-dry-run.sh 2026-09-12

  Brings up `postgres:17` on Colima, applies the Phase 0 shell plus the three Phase 1 migrations,
  imports all three sources without activating, and rewrites `docs/catalog/sizing.md`. Headroom
  against the 8 GiB Pro disk must be at least 40 %; if it is not, FNDDS moves to on-demand and the
  decision is recorded in that file.

  ## Import

      .venv/bin/python scripts/import-fdc.py --version-label 2026-09-12

  One `version_label` covers all three sources, so `catalog_versions` gains three rows and
  `catalog_activate_version('2026-09-12')` activates them together. The run:

  1. downloads each zip into `~/Backups/usda/fdc/<label>/` and records its sha256 in
     `checksums.json` beside it — a digest that changes under an existing label is a hard failure,
     because the source moved and the label must move with it;
  2. asserts every mapped FDC nutrient id appears in that dataset's `nutrient.csv`;
  3. COPYs `food`, `food_nutrient`, `food_portion`, `measure_unit` and `food_category` into
     `catalog_staging`;
  4. writes `catalog_foods` (identity, never rewritten), `catalog_food_revisions`,
     `catalog_food_nutrients`, `energy_kcal_calc` from `catalog_atwater_kcal`, the quality flags
     and `catalog_portions`;
  5. validates row counts, macro coverage and the energy-mismatch rate, and stores the report in
     `catalog_versions.row_counts`;
  6. calls `catalog_activate_version(label)` in the same transaction.

  Re-running the same label after a successful import prints `already active; nothing to do` and
  exits 0.

  ## Quality classes and flags

  | Source | `quality_class` |
  |---|---|
  | Foundation | `analytical` |
  | SR Legacy | `analytical` |
  | FNDDS | `survey` |

  | Flag | Meaning |
  |---|---|
  | `atwater_incomplete` | a macro is missing, so `energy_kcal_calc` is absent and the mismatch check does not apply |
  | `carb_basis_total` | fiber is not reported, so carbohydrate is total, not available |
  | `energy_mismatch` | reported and computed energy differ by more than 10 %; §4.1 ranks the row down, never hides it |

  `catalog_ingredients` and `catalog_barcodes` stay empty this phase. Branded and Open Food Facts
  rows, which is where ingredient lists and GTINs come from, arrive in Phase 3.

  ## Rollback

      .venv/bin/python scripts/import-fdc.py --rollback-to 2026-06-01

  Reactivates that label's revisions in one transaction. The previous version is kept for exactly
  this; only older ones are dropped (§7.2). Food identities never move, so `food_refs` and
  `user_foods.catalog_food_id` are unaffected either way.

  ## Mapping her foods

      pnpm exec tsx scripts/export-seed-foods.ts > /tmp/her-foods.json
      .venv/bin/python scripts/map-her-foods.py --foods /tmp/her-foods.json \
          --out docs/catalog/her-foods-mapping.csv

  The script proposes; Devin decides. He fills `decision` with the proposed id, a different
  `catalog_food_id`, or `skip` plus a reason. Lane G's `scripts/apply-food-mapping.ts` applies the
  reviewed file — it sets `user_foods.catalog_food_id` and calls `get_or_create_food_ref`. No
  `user_foods` row is deleted and her authored `per_100g` is never overwritten, so a wrong mapping
  costs nothing.

  ## Cadence

  Quarterly for the three bulk sources (§7.3). Each run gets its own `version_label`; keep the
  previous one for rollback and drop the ones before it.
  ```

- [ ] Run — verify every path the runbook names exists:
  ```bash
  for f in scripts/import-fdc.py scripts/catalog-dry-run.sh scripts/catalog-size-report.sql \
           scripts/export-seed-foods.ts scripts/map-her-foods.py scripts/requirements.txt \
           docs/catalog/sizing.md docs/catalog/her-foods-mapping.csv; do
    test -f "$f" || echo "MISSING $f"; done; echo "runbook check done"
  ```
  Expected: `runbook check done` with no `MISSING` line.

- [ ] Commit:
  ```bash
  git add docs/catalog/import.md && git commit -m "docs(catalog): add the import runbook"
  ```

---

## Task 15 — Lane gates: lint, types, targeted tests, real import

**Files**
- Modify: none. This task verifies; any fix belongs to the task that owns the file, as a new commit.

**Interfaces**
- Consumes: every artifact of Tasks 1–14.
- Produces: the evidence the lane exit gate below needs.

### Steps

- [ ] Run the static gates, expect PASS:
  ```bash
  pnpm lint && pnpm exec tsc --noEmit
  ```
  Expected: no eslint output and no tsc output.

- [ ] Run this lane's tests only — never the full suite (AGENTS.md, Phase 0 contracts §8) — expect PASS:
  ```bash
  pnpm test tests/catalog && \
  python3 -m pytest tests/catalog/test_import_fdc.py -q || python3 -m unittest tests.catalog.test_import_fdc
  ```
  Expected: with `SUPABASE_TEST_URL` set, 23 vitest cases pass across five files; unset, the four
  `[needs branch]` files report `skipped` and `export-seed-foods.test.ts` still passes. Python: 29 passed.

- [ ] Run the real import against a Supabase branch — **[needs branch] [needs network]**, expect PASS:
  ```bash
  .venv/bin/python scripts/import-fdc.py --db-url "$SUPABASE_TEST_DB_URL" --version-label 2026-09-12 && \
  psql "$SUPABASE_TEST_DB_URL" -At -c \
    "select count(*) from catalog_versions where is_active;
     select count(*) from catalog_food_revisions where is_active;
     select count(*) from (select catalog_food_id from catalog_food_revisions
                            where is_active group by 1 having count(*) > 1) x;"
  ```
  Expected: `3` active version rows (one per source), a five-figure active revision count, and `0`
  foods with more than one active revision.

- [ ] Run it a second time with the same label and confirm it is a no-op — **[needs branch]**, expect PASS:
  ```bash
  .venv/bin/python scripts/import-fdc.py --db-url "$SUPABASE_TEST_DB_URL" --version-label 2026-09-12
  ```
  Expected: `2026-09-12 is already active; nothing to do`, exit 0, no row written.

- [ ] Commit nothing when every gate is green. When a gate fails, fix the file in the task that owns it
  and land the fix as a NEW commit — do not rewrite an earlier commit:
  ```bash
  git add <the file you fixed> && git commit -m "fix(catalog): <what the gate caught>"
  ```

---

## Lane exit gate

Lane F is done when every line below is true and evidenced by a command in this plan.

1. `pnpm lint` and `pnpm exec tsc --noEmit` are clean.
2. `pnpm test tests/catalog` passes on a branch and skips cleanly with `SUPABASE_TEST_URL` unset.
3. `python3 -m pytest tests/catalog/test_import_fdc.py` (or the `unittest` fallback) passes: 29 cases.
4. The three migrations apply in filename order on a clean branch, and
   `20260912090200_catalog_grants.down.sql` has been applied and reverted once on a branch.
5. `docs/catalog/sizing.md` is committed and reports headroom of at least 40 % against 8 GiB with all
   three sources loaded — or records the FNDDS on-demand decision and the number that forced it
   (spec acceptance criterion 1).
6. A real import leaves exactly one active `catalog_versions` row per source under one
   `version_label`, and zero foods with more than one active revision (criteria 2 and 3).
7. Re-running the same `version_label` writes nothing and exits 0 (criterion 3).
8. `energy_kcal_calc` exists on every revision whose source reports the macros;
   `atwater_incomplete` rows are excluded from the mismatch check; the mismatch rate is recorded in
   `catalog_versions.row_counts` and surfaced in `docs/catalog/sizing.md` (criterion 4).
9. Every `catalog_*` table has RLS on with a select-only policy, and `tests/catalog/grants.test.ts`
   proves an authenticated non-service client cannot write and `anon` reads nothing (criterion 6).
10. `docs/catalog/her-foods-mapping.csv` holds 53 proposal rows with `decision` blank, and
    `docs/catalog/import.md` tells Devin how to review it. Criterion 10 needs his signature, which is
    a gate on the phase, not on this lane.

## Hand-off to integration

- **Lane G** gets `search_doc` (generated, weights A/B/C), `catalog_food_revisions_fts`,
  `catalog_food_revisions_trgm`, `catalog_food_revisions_trgm_brand`, `prep_state`, `quality_class`
  and `quality_flags` — every column the §4.1 score reads. G writes
  `supabase/migrations/20260912090100_catalog_search.sql`; Lane F never touches that file. G's
  relevance gate (top-1 ≥ 85 %, top-3 ≥ 95 %) is measured only after this lane's import is active on
  the branch, so **F lands before G's eval runs**.
- **Lane G** also owns `scripts/apply-food-mapping.ts`, which consumes
  `docs/catalog/her-foods-mapping.csv` after Devin fills the `decision` column. The column names in
  that CSV are frozen by this plan; G reads them, it does not rename them.
- **Lane H** gets the 20 nutrient codes in `catalog_nutrients`, written by `catalog_nutrient_rows()`.
  `lib/nutrients/codes.ts` must agree exactly, including `energy_kcal_calc` and the 12
  `TRACKED_MICROS`. H's `20260918090300_phase2_catalog_dri_seed.sql` inserts into `catalog_dri`,
  which this lane leaves empty and grants correctly — H adds rows, never grants.
- **Lane I** gets `catalog_portions(id, description, gram_weight, seq, is_default)` for the log
  sheet's portion picker; `is_default` is the first gram-weighted household measure, so the sheet can
  preselect it without a rule of its own.
- **Integration branch.** `AGENTS.md` gains a `docs/catalog/import.md` row and the Phase status table
  flips Phase 1 to "in progress". Both files are shared, so those edits land on the integration
  branch, not here.

## Open questions

1. **Migration filename for the two functions.** The Phase 1 spec's Data-changes table puts
   `catalog_atwater_kcal` and `catalog_activate_version` in `20260912090100_catalog_search.sql`; the
   frozen Phase 1–2 contracts §1 give that file to Lane G and give Lane F
   `20260912090050_catalog_activate.sql`. This plan follows the contracts, because one file written
   by two lane branches is a guaranteed merge conflict. Recommendation: record it as a contract note,
   not a spec change — the SQL is identical either way.
2. **`complete` vs `incomplete` on `catalog_atwater_kcal` — resolved.** The spec wrote
   `returns table (kcal numeric, incomplete boolean)`; the frozen contracts §2 write
   `(kcal numeric, complete boolean)`. This plan ships the contract spelling, so `complete = false`
   is what the spec's old text called `incomplete = true`. `docs/specs/phase-1-catalog.md`'s Energy
   paragraph is corrected to `complete boolean` with the matching polarity, so the spec of record now
   agrees with what ships — no longer deferred to "when Phase 1 closes".
3. **One active version, or one per source — resolved.** Spec acceptance criterion 2 read "exactly
   one `catalog_versions` row with `is_active = true`", but `catalog_versions` is keyed
   `unique (source, version_label)` and its `source` check constraint has no combined value, so one
   import necessarily writes three rows. This plan enforces
   `catalog_versions_one_active_per_source` — exactly one active version per source, all three under
   one `version_label`. `docs/specs/phase-1-catalog.md` acceptance criterion 2 is reworded to say
   exactly that, so the reading above is the confirmed one, not merely flagged for Devin.
4. **`search_doc` generated vs worker-written.** The spec says a generated column is impossible
   because `unaccent` is not immutable, and specifies a worker-written column plus a
   `catalog_search_doc()` helper. The contracts say generated. Both are satisfiable at once by
   dropping `unaccent` from the stored document: `to_tsvector('english', …)` is immutable, so the
   column generates, and accent folding moves to the query side, which is where Lane G's
   `websearch_to_tsquery('english', unaccent($1))` already does it. Recommendation: confirm with
   Lane G that its RPC folds accents on the query text, since this lane no longer folds them in the
   document.
5. **FDC dataset URLs.** The three URLs in `SOURCES` are dated and FDC retires old links.
   `--url key=URL` overrides them and the checksum record catches a silent swap, but the first run of
   each quarter must check https://fdc.nal.usda.gov/download-datasets. Recommendation: leave the
   dated URLs in the file — they document which release was imported — and treat a 404 as "look up
   the new one, then choose a new `--version-label`".
6. **`catalog_ingredients` stays empty.** Bulk Foundation and SR Legacy carry no consumer ingredient
   statement, and FNDDS carries recipe inputs rather than a label. Recommendation: leave the table
   empty until Phase 3's Branded and OFF rows, and say so in `docs/catalog/import.md` (done).
7. **Where the real import runs.** The lane exit gate imports into a Supabase branch, not production.
   Recommendation: the production import happens once, from the Mac, in the rollout order the spec
   sets (dry run → migrations → import → mapping CSV → Devin's review), never from a lane branch.
8. **`prep_state` from a regex.** `PREP_STATE_CASE` reads a preparation word out of the FDC
   description. It is deliberately conservative and falls through to null, which §4.1 scores 0.5.
   Recommendation: measure how often it fires during Lane G's eval, and only then decide whether a
   richer vocabulary is worth the false positives.
