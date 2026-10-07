# FNDDS inputs: local rehearsal and sizing (Phase 18 W4)

Rehearsal of migration 3 (`catalog_food_inputs`) and the FNDDS-inputs import on a local Supabase
stack, run 2026-10-06 on branch `feat/p18-w4-fndds-inputs`. Spec: `docs/specs/phase-18-open-world-foods.md`
§6 row 3 and §10 W4. Runbook: `docs/catalog/import.md` "FNDDS inputs". **Production is not
touched here; the production import is an owner step and is FROZEN until the owner runs it.**

## How the stack was built

1. An isolated local stack (its own project id and ports, so no other checkout's stack was reset):
   a copy of `supabase/` with `project_id = "mc-p18-w4"`, API 55421, DB 55422, then
   `pnpm exec supabase start --workdir <copy>`. Every migration on `origin/main` applied cleanly
   (through `20261213091200_evidence_clock_catalog.sql`).
2. The production catalog release, from the same zips production used (`~/Backups/usda/fdc/2026-09-12/`,
   sha256 in its `checksums.json`):
   `CATALOG_IMPORT_DB_URL=<local> .venv/bin/python scripts/import-fdc.py --version-label 2026-09-12`.
   Result: 13,694 active foods (Foundation 469, SR Legacy 7,793, FNDDS 5,432), the production counts.
3. Migration 3, one file per transaction: `20261214100000_catalog_food_inputs.sql`,
   `20261214100100_catalog_food_inputs_validate.sql`, then (round 2)
   `20261214100200_catalog_replace_food_inputs.sql`. All five constraints validated.
4. `pnpm exec tsx scripts/priors/fetch.ts` (adds the Foundation list to `~/Data/nhanes`; its zip
   sha256 `70457ee9…dbc655` equals the catalog's own Foundation zip), then
   `pnpm exec tsx scripts/import-fndds-inputs.ts --dry-run`, `--commit`, and `--commit` again.
   Round 2 (after Sol's W4 r1 review) emptied the table and repeated the three runs through the
   release check and the atomic writer: `release: catalog version 3 (fdc_fndds 2026-09-12, zip
   5ccc25ec2777…)`, 37 atomic dish batches, the same counts as below. The same `--commit` aimed at a
   non-local URL was refused before reading anything.
   Round 3 (Sol W4 r2) added the target-database fingerprint, the exact-host guard and the
   active-revision lock: the table was emptied again and the three runs repeated with the same
   counts. Changing one dish description in the local catalog made the commit refuse
   (`0 missing, 0 extra, 1 changed dish(es)`, nothing written); restoring it made it pass. A commit
   aimed at `https://fivatgdpuenszxxnijpc.attacker.example` was refused before any read.
   Round 4 (Sol W4 r3) added every stored nutrient amount and portion to both sides of the
   fingerprint. The real files and the local catalog matched (5,432 dishes, 22,045 portions).
   Changing one calcium amount (125 to 126) made the commit refuse with `1 changed dish(es)`;
   restoring it passed. Deleting one nutrient row refused the same way; restoring it passed. The
   rehearsal was repeated from an empty table with the same counts. (The stack moved to ports
   55621/55622 because another checkout's stack had taken 55421/55422 meanwhile; the data volume
   was kept.)

## Acceptance 1: every FNDDS food that lists inputs gets them, 0 unresolved codes

Source files (sha256):

| File | sha256 |
|---|---|
| `fndds/2021-2023/input_food.csv` | `8aeb63c33452a501d0af942a6c9da8a771ee929f5366d7462de037fee3f9acb8` |
| `fndds/2021-2023/survey_fndds_food.csv` | `c18efa0dc39d04b7e175be3f843521babbb3e8d68de3b6e43b49a1fbb0a6d5fe` |
| `fndds/2021-2023/food.csv` | `3d415f2a2c44e2dbb799a7b6a2a2b5fc05dce835dafee72fd54319b0ef6d9a28` |
| `sr_legacy/sr_legacy_food.csv` | `ff0fe85a469aa6d6702d68348850fc79dee35e9515324026964f1209a0e3544d` |
| `sr_legacy/food.csv` | `de8b0390058db4f102368c9fbdfde144790b480ff4cb0507c0e060ef99805dee` |
| `foundation/foundation_food.csv` | `5666629a4d06bf1d6a16114e1e3890cfa7d56523ec99134545a24ba216b521cb` |

`input_food.csv` is byte-identical to the one in the catalog's FNDDS zip (`fdc_fndds`, 2024-10-31).

| Measure | Count |
|---|---|
| FNDDS 2021-2023 foods | 5,432 |
| Foods that list inputs in the source | 5,431 (the one that lists none: 11000000 "Milk, human") |
| Foods with stored inputs | **5,431 (100 %)** |
| Source input rows | 18,584 |
| Stored rows | 18,376 |
| by kind: FNDDS sub-recipe / SR Legacy / Foundation / modified SR | 4,214 / 14,079 / 74 / 9 |
| Fortificant rows, not foods, not stored | 208 (codes 999001, 999291, 999301, 999303, 999328, 999401, 999418, 999431: "Vitamin D as ingredient" and the like) |
| **Unresolved codes** | **0** |
| Release findings (zip, zip members, import ledger, active catalog version, target fingerprint incl. nutrients and portions) | 0 |
| Catalog problems (missing food, dish revision outside the release's version) | 0 |

How codes resolve (`scripts/priors/fndds-inputs.ts`): an 8-digit FNDDS food code is a sub-recipe;
then an SR Legacy NDB number; then a Foundation NDB number (38 codes, all present in the catalog's
Foundation release); then FNDDS's modified SR items ("REDUCED SODIUM: …", code 9 + the SR number:
8 codes, each matched only because its SR base's description starts with the text after the
prefix). A nutrient added as an ingredient (999xxx) is not a food and is reported, never stored.
Any other code refuses the commit. Inputs come only from the documented recipes: no model, no Jev.

Database check after the commit: 5,431 active `fdc_fndds` revisions have inputs and 1 has none
("Milk, human"); input foods by source: `fdc_sr_legacy` 14,088, `fdc_fndds` 4,214,
`fdc_foundation` 74. A second `--commit` wrote nothing: `0 new or changed row(s), 0 stale row(s),
18376 unchanged; 0 atomic dish batch(es)`, then `verified: 18376 rows for 5431 dishes match the plan`.

## Acceptance 2: sizing against the architecture §7 headroom rule

`scripts/catalog-size-report.sql` after `vacuum analyze catalog_food_inputs`:

| Relation | Bytes | Size |
|---|---|---|
| `catalog_food_inputs` total (heap, TOAST, indexes) | 2,146,304 | 2,096 kB |
| `catalog_food_inputs_pkey` (food_revision_id, seq) | 598,016 | 584 kB |
| `catalog_food_inputs_input` (input_catalog_food_id) | 245,760 | 240 kB |
| heap | 1,302,528 | 1,272 kB |
| whole catalog, 12 `catalog_*` tables (72 MB of it without the new table) | | 74 MB |

Headroom against the 8 GiB Supabase Pro disk: catalog 74 MB = 0.9 % used, **99.1 % headroom**
(rule: at least 40 %). Each FNDDS release that is kept for rollback adds another ~2.1 MB until its
revisions drop (the cascade removes their inputs). The whole local database was 97 MB before the
import and 99 MB after. Production's whole-database size was not read for this report (no
production access in this slice); the catalog share is the quantity the §7 rule measures.

## Acceptance 3 on the rehearsal data (read path)

`readMixedDishInputs` (`lib/server/mixed-dish-inputs.ts`) over all 5,432 FNDDS foods on this stack,
in 258 ms with the service-role client:

| Measure | Value |
|---|---|
| Foods treated as mixed dishes (≥ 2 distinct leaf foods after sub-recipes) | 3,976 |
| Foods that count as themselves (one leaf input, or none) | 1,456 |
| Leaf inputs | 35,361 |
| named by a universe bundled id (judged by the W2b `universeVerdict`) | 8,838 (28.8 % of dish grams) |
| named by a catalog food ref | 0 on this stack (no account has minted one) |
| named by catalog id only (adds nothing until a catalog ref exists) | 26,523 |
| Leaf shares per dish | sum to 1 (min 0.9999999999999997, max 1.0000000000000004) |

The fail-closed rule is W3's: an input the resolver cannot vouch for adds nothing and never falls
back to a name. In production a catalog input counts once any account has minted its catalog ref
(a search, a log, a recipe match). The import does not mint refs: that would widen every
`set_food_membership` family's catalog ref set toward its 50-ref cap.

## Rehearsal tests on the stack

With the stack's `SUPABASE_TEST_*` values: `tests/migrations/catalog-food-inputs-db.test.ts`
(constraints validated, `fndds` only, cascade with the revision, authenticated read only, anon
nothing, down then up round trip; `catalog_replace_food_inputs` replaces a dish in one call, leaves
it fully old when a row fails mid-dish, refuses a row outside the batch, refuses a revision
deactivated after the preflight, and refuses authenticated) and `tests/catalog/grants.test.ts` (12 catalog tables, one read
policy each) pass.
