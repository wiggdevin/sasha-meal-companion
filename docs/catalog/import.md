# Catalog import — runbook

The worker is `scripts/import-fdc.py`. It runs on the Mac or in GitHub Actions with the service
role, and **never on Vercel** (architecture §5, §7.2). It is the sole writer to the `catalog_*`
tables the import owns; `scripts/load-synonyms.ts` is the dedicated writer of `catalog_synonyms`
(see "Load the synonym table" below), `scripts/import-fndds-inputs.ts` is the dedicated writer of
`catalog_food_inputs` (see "FNDDS inputs" below), and no other script writes a `catalog_*` table.

## Setup, once

    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements.txt

`CATALOG_IMPORT_DB_URL` is a direct Postgres URL for the target database. It is a worker
secret: it lives in `.env.local` or the shell, never in Vercel, and no script prints it. If the
connection fails, the worker prints only the exception's class name — never the URL, and never
`str(exc)`, because psycopg's connection errors often echo the DSN (host, user, sometimes a
password) verbatim.

`.venv` is not git-ignored in this repo. Nothing creates it for you — `catalog-dry-run.sh` uses
it only when it already exists (falling back to `python3` otherwise); you make it by hand with
the two commands above.

## Dry run first (architecture §7.1)

    ./scripts/catalog-dry-run.sh 2026-09-12

Brings up docker `postgres:17` on port 5433 (Colima), creates the `anon` / `authenticated` /
`service_role` roles Supabase provides in production but a bare image does not, applies the
Phase 0 catalog shell plus the three Phase 1 migrations, runs `import-fdc.py --dry-run` for all
three sources, and rewrites `docs/catalog/sizing.md` — per-table and per-index sizes,
`headroom_pct` against the 8 GiB Supabase Pro disk, and each source's `row_counts` (including
any warnings). It uses `.venv/bin/python` if `.venv` exists, else `python3` — either way,
`psycopg` and `requests` must be importable, or it exits with the pip-install line above.
Headroom must be at least 40 %; if it is not, FNDDS moves to on-demand and the decision is
recorded in `sizing.md`. The container is removed on exit unless `KEEP=1`. Nothing here touches
Supabase.

## Import

    .venv/bin/python scripts/import-fdc.py --version-label 2026-09-12

One `version_label` covers all three sources, so `catalog_versions` gains three rows and
`catalog_activate_version('2026-09-12')` activates them together, in one transaction. Use one
label per run — never reuse a label a dry run already claimed for the real, activating run.
Each source (`fdc_foundation`, `fdc_sr_legacy`, `fdc_fndds`) imports only its own primary
`food.csv` `data_type` out of its zip, on purpose:

| Source | `data_type` kept | Foods |
|---|---|---|
| Foundation | `foundation_food` | 469 |
| SR Legacy | `sr_legacy_food` | 7,793 |
| FNDDS | `survey_fndds_food` | 5,432 |

Foundation's zip also carries `sub_sample_food`, `market_acquisition_food` and
`agricultural_acquisition_food` rows under the same `food.csv` — those are excluded; they are
not foods this catalog should carry.

The run, per source:

1. downloads the zip into `~/Backups/usda/fdc/<label>/` (skipped if already on disk) and records
   its sha256 in `checksums.json` beside it — a digest that changes under an existing label is a
   hard failure, because the source moved and the label must move with it. FDC's real zips run
   about 3–6 MB each, not gigabytes;
2. asserts every mapped FDC nutrient id in `NUTRIENT_MAP` appears in that dataset's
   `nutrient.csv` — a renumbered nutrient stops the import rather than silently dropping data;
3. COPYs `food`, `food_nutrient`, `food_portion`, `measure_unit` and `food_category` into
   `catalog_staging.*` (stage), then writes `catalog_foods`, `catalog_food_revisions` and
   `catalog_food_nutrients` (build), then `catalog_portions` (portions) — `catalog_staging.*`
   tables are dropped and rebuilt on every call, so they never carry a shape a previous worker
   version left behind;
4. FNDDS's `food_nutrient.csv` references nutrients by `nutrient_nbr`, not the `nutrient_id` the
   other two sources use directly — the worker translates through that dataset's own
   `nutrient.csv` before filtering to the 19 tracked nutrient ids;
5. `energy_kcal_calc` comes from `catalog_atwater_kcal`, computed once in SQL, never a second
   time in TypeScript. `search_doc` is written by the worker itself, through the immutable
   `catalog_search_doc(description, brand, category)` helper — it is not a generated column;
6. Foundation's `food_portion.csv` carries rows with a blank `fdc_id`; those are skipped and
   counted (`portions_skipped_no_fdc_id`), since they cannot join to any food. Kept portions are
   numbered deterministically; `is_default` marks the first household measure in that order, and
   a generic gram unit (`g` / `gram` / `grams` / `gm`) is never marked default even when it
   sorts first;
7. validates row counts, macro coverage and the energy-mismatch rate, and stores the report in
   `catalog_versions.row_counts`;
8. calls `catalog_activate_version(label)` in the same transaction, unless `--dry-run` was
   passed — a dry run loads and validates everything above but never activates.

`catalog_activate_version` activates every source under the label together, in one transaction.
A food absent from the new release keeps its previous active revision rather than going dark; a
label whose versions carry zero `catalog_food_revisions` is refused outright. Re-running the
same label after a successful import prints `<label> is already active; nothing to do` and exits
0.

### FDC URLs move

`SOURCES` in `import-fdc.py` pins the live release for each dataset as of 2026-09-11:
Foundation 2026-04-30, SR Legacy 2018-04, FNDDS (survey) 2024-10-31. FDC retires old zip links
without warning. A 404 means: check https://fdc.nal.usda.gov/download-datasets for the current
one, pass `--url fdc_foundation=<new URL>` (repeatable, one per source) to override without
editing the script, and pick a new `--version-label` — the URL is part of what a label pins.

## Load the synonym table (after the import, before any measurement)

`catalog_activate_version` activates the foods; it does not touch `catalog_synonyms`.
`scripts/load-synonyms.ts` is the dedicated writer of `catalog_synonyms` — the worker never loads
the synonym sheet — so a freshly imported database ships with `catalog_synonyms` **empty**. That is
not a search regression, but it measures like one: production on 2026-09-12 read top-1 42.6 % /
top-3 77.0 % with the table empty, then 83.6 % / 100.0 % once it was loaded. Both figures were
measured by the driver on 2026-09-12, not by the builder (the T8 builder did not re-measure); receipts
[`receipts/2026-09-12-search-eval-production-run1.txt`](receipts/2026-09-12-search-eval-production-run1.txt)
and
[`receipts/2026-09-12-search-eval-production-run2.txt`](receipts/2026-09-12-search-eval-production-run2.txt)
(see [`receipts/README.md`](receipts/README.md)). Load it in the same session, after the import
activates the version and before any relevance measurement:

    pnpm exec tsx scripts/load-synonyms.ts

Service-role env (`SUPABASE_URL` plus the key) comes from `.env.local` for production, or from the
`SUPABASE_TEST_*` values `scripts/db-branch.sh env` prints for a branch — the script header has the
names. The script upserts every row of `docs/catalog/synonyms.csv` on `term` and deletes every term
the file no longer names, so the table equals the file; `tests/search/recall.test.ts` measures recall
against the file, and a table that had drifted from it would make that measurement a lie.

### Production evaluation environment

`scripts/search-eval.ts` does **not** read the service-role variables above — it signs in as a real
user and calls `catalog_search` over the API. Before the production run, put these four in the shell,
and only these four:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_TEST_URL` | the target project's URL; for production, `https://fivatgdpuenszxxnijpc.supabase.co`. The name says "test", the value is production's — that is why this block exists. |
| `SUPABASE_TEST_ANON_KEY` | the same project's **anon / publishable** key, from the Supabase dashboard → Project Settings → API keys. Never the service-role key. |
| `SEARCH_EVAL_EMAIL` | the **existing production eval account** (`devs@example.com`) — it is already a user there; do not create a new one. |
| `SEARCH_EVAL_PASSWORD` | that account's password, from ZS Vault (`zsvault get <id>`); never in argv or a committed file. |

**`--dry-run` is mandatory against production.** Then measure:

    pnpm exec tsx scripts/search-eval.ts --dry-run

Against production `--dry-run` is not a preference: without it the run rewrites
`lib/search/thresholds.ts` from whatever the production measurement says, and that is a source-tree
change nobody signed off on. The gate it applies is `TOP1_GATE` / `TOP3_GATE` in `lib/search/eval.ts`
(top-1 ≥ 82 %, top-3 ≥ 95 % — ruling R1, 2026-09-12,
`docs/decisions/2026-09-12-session-rulings.md`).

## FNDDS inputs (Phase 18 W4)

`catalog_food_inputs` holds the documented FNDDS 2021-2023 recipe inputs of each `fdc_fndds`
revision (spec `docs/specs/phase-18-open-world-foods.md` §6 row 3). The taste history counts a
logged mixed dish through them, at half weight and marked estimated (`lib/server/mixed-dish-inputs.ts`).
Inputs come only from the FNDDS files; there is no `jev` source. Rehearsal and sizing:
[`fndds-inputs-sizing.md`](fndds-inputs-sizing.md).

**Production import: FROZEN, owner-run only.** No agent runs the production steps below; the owner
runs them, with a backup, after reading the sizing report.

1. Apply the three migrations to production in order, each in its own transaction, **before** the
   W4 code merges (the taste read selects from the table): `20261214100000_catalog_food_inputs.sql`,
   `20261214100100_catalog_food_inputs_validate.sql`, `20261214100200_catalog_replace_food_inputs.sql`.
2. Put the source files in the offline workspace (public files; nothing enters the repo):

       pnpm exec tsx scripts/priors/fetch.ts

3. With production's `SUPABASE_URL` and service-role key in the shell (`.env.local`), the dry run.
   It reads the files and the catalog and writes nothing; it must print `unresolved codes 0`,
   `release: catalog version <id> (fdc_fndds 2026-09-12, …)` and `0 problem(s)`:

       pnpm exec tsx scripts/import-fndds-inputs.ts --dry-run

4. The import, one command:

       pnpm exec tsx scripts/import-fndds-inputs.ts --commit --production --project-ref fivatgdpuenszxxnijpc

What the import refuses, writing nothing at all:
- `--commit` to any host other than 127.0.0.1, localhost or ::1, unless `--production` is passed,
  `--project-ref` is given, and `SUPABASE_URL` is exactly `https://<that ref>.supabase.co` (no other
  domain or suffix, user info, port, path or scheme; a Supabase branch needs the same two flags with
  the branch's ref);
- any input code it cannot resolve, or an input food missing from the catalog;
- any break in the release chain (`scripts/priors/fndds-release.ts`): the workspace zip must hash to
  the pinned `FNDDS_RELEASE.zipSha256` (`scripts/priors/input-sources.ts`), the FNDDS files read must
  be the files inside it, `~/Backups/usda/fdc/2026-09-12/checksums.json` (written by `import-fdc.py`)
  must record the same zip for `fdc_fndds`, the catalog must hold that `fdc_fndds` version as the
  active one, a content fingerprint of that version's revisions **in the target database** (FoodData
  Central id, description, `content_hash`, every stored nutrient amount and every stored portion, in
  id order; `energy_kcal_calc` is left out because the catalog derives it in SQL from those
  nutrients) must equal the one computed from the zip's CSVs by
  `scripts/priors/fndds_release_rows.py`, which reads them with `import-fdc.py`'s own helpers
  (needs `python3`, standard library only), and every dish revision must belong to that version.

Writes go through `catalog_replace_food_inputs`, which replaces whole dishes (up to 500 rows a
call) in one transaction: a failure leaves every dish fully old or fully new, never a mix. It locks
the named revisions `FOR SHARE` and refuses the call if any is no longer active, and after the last
call the import proves the release again.

**A catalog activation during the run.** Each batch checks its own dishes at write time, but an
activation that lands between two batches can leave the earlier batches written to the old
revisions while the later ones are refused. The post-write check then reports the failure
(`verify failed: the catalog changed during the import`). Every dish is still fully old or fully
new. The fix is to let the activation settle and run the dry run and the import again: the import
is idempotent, attaches the inputs to the new revisions, and the old revisions' inputs go with
those revisions when they drop. The run
ends by re-reading the table and printing `verified: <rows> rows for <dishes> dishes match the
plan`; a re-run converges and writes nothing.

On a local stack the same command runs as `--commit` alone.

**After every FNDDS activation** (a new `import-fdc.py` label), run steps 3 and 4 again: inputs are
keyed to the dish revision, so the new revisions start without inputs (their dishes count as
themselves) until the import attaches them; the previous version's inputs go with its revisions
when they drop. A new FNDDS label first moves the `FNDDS_RELEASE` pin (label and zip sha256) in
`scripts/priors/input-sources.ts`; until then the import refuses.

**Rollback:** `supabase/migrations/down/20261214100200_catalog_replace_food_inputs.down.sql`, then
`supabase/migrations/down/20261214100100_catalog_food_inputs_validate.down.sql` (a no-op), then `supabase/migrations/down/20261214100000_catalog_food_inputs.down.sql` (drops the
table and its rows, which a re-import restores), after the app deploy that reads it is reverted.

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

`atwater_incomplete` and `energy_mismatch` are written per row, into `catalog_food_revisions
.quality_flags` — they never abort anything on their own.

Fallback nutrient ids (W004, audit 2026-10-10 A019/A022): Foundation publishes most energy as
Atwater General (2047) or Specific (2048) factors and most sugars as 1063, not 1008 and 2000.
`NUTRIENT_PRIORITY` in `scripts/import-fdc.py` stores, per food and code, the first id with a value:
`energy_kcal` 1008 → 2047 → 2048, `sugars_total` 2000 → 1063. A food with 1008 or 2000 is unchanged.
Re-importing Foundation (W005, an owner step) fills `energy_kcal` for the foods that had only the
fiber-subtracted `energy_kcal_calc`; expect more `energy_mismatch` flags there, because the published
Atwater figure counts fiber energy and `catalog_atwater_kcal` does not.

### Gates

`MIN_ROWS` (300 / 7,000 / 5,000 for Foundation / SR Legacy / FNDDS) is the only hard gate: a
count below its floor raises `SystemExit` and the import stops. Macro coverage below 90 % and an
energy-mismatch rate above 10 % are soft — each breach prints a `warning:` line to stderr and is
appended to `catalog_versions.row_counts.warnings`, but the import proceeds. Real USDA data trips
all three today: Foundation macro coverage lands around 0.80 (many Foundation foods report no
macro at all), and both SR Legacy and FNDDS land an energy-mismatch rate around 0.12–0.13 (driven
by low-calorie foods, where a small absolute gap is a large percentage one). Check
`docs/catalog/sizing.md`'s per-source report for the exact figures from the last dry run.

`catalog_ingredients` and `catalog_barcodes` stay empty this phase. Branded and Open Food Facts
rows, which is where ingredient lists and GTINs come from, arrive in Phase 3.

## Rollback

    .venv/bin/python scripts/import-fdc.py --rollback-to 2026-06-01

Reactivates that label's revisions in one transaction, through the same
`catalog_activate_version` path. The previous version is kept for exactly this; only older ones
are dropped (§7.2). Food identities never move, so `food_refs` and `user_foods.catalog_food_id`
are unaffected either way.

## Rollout order

Dry run, to size the catalog and see the real warning rates → apply the four migrations → a real
import on a Supabase branch first → production only after the reviewer reads `docs/catalog/sizing.md`
and signs off. Every `catalog_*` table is RLS-on: `select` only for
`authenticated`, all table-level writes revoked, `service_role` full — writes go through
`service_role` only: the import worker, plus `scripts/load-synonyms.ts` for `catalog_synonyms`. The
rollback for those grants lives at
`supabase/migrations/down/20260912090200_catalog_grants.down.sql` and is held unapplied; it
exists so the grants can be reverted deliberately, not as a step in this runbook.

## Cadence

Quarterly for the three bulk sources (§7.3). Each run gets its own `version_label`; keep the
previous one for rollback and drop the ones before it.

### Quarterly refresh script

`./scripts/catalog-refresh.sh <version-label> <branch-db-url>` runs the sizing dry run
(`catalog-dry-run.sh`), then `import-fdc.py --version-label` against the given Supabase branch, then
stops. The sizing sign-off is the gate before the production import, which stays a manual owner
step. The script fails closed: set `BRANCH_PROJECT_REF` to the branch's ref (or use a local URL); it
refuses a URL that names the project in `SUPABASE_URL`.
`.github/workflows/catalog-refresh-reminder.yml` opens a reminder issue on the first of January,
April, July and October; it imports nothing.

## AI canary

`scripts/ai-canary.ts` probes each pinned Gemini model with one structured call and reports whether
the key is on a billing-enabled project. `.github/workflows/ai-canary.yml` runs it every Monday and
on manual dispatch, never on push. It uses the `GEMINI_API_KEY` repo secret and skips cleanly when
that secret is not set; it fails when the verdict is UNPAID or a structured call fails. The owner
confirms the secret is set.
