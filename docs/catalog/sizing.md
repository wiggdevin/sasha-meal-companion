# Catalog sizing — dry run 2026-09-12

Local Postgres 17 (docker `postgres:17` on Colima), Foundation + SR Legacy + FNDDS
loaded by `scripts/import-fdc.py --dry-run`. Regenerate with:

```
./scripts/catalog-dry-run.sh 2026-09-12
```

Supabase Pro disk is 8 GiB. Acceptance criterion 1 needs headroom of at least 40 %.
If it does not clear 40 %, FNDDS moves to on-demand and that decision is recorded here.

## Tables
+------------------------+---------+---------+-------------+
|         table          | indexes |  total  | total_bytes |
+------------------------+---------+---------+-------------+
| catalog_food_nutrients |       2 | 29 MB   |    30597120 |
| catalog_food_revisions |       7 | 27 MB   |    27869184 |
| catalog_portions       |       2 | 4992 kB |     5111808 |
| catalog_foods          |       2 | 2008 kB |     2056192 |
| catalog_versions       |       3 | 56 kB   |       57344 |
| catalog_nutrients      |       1 | 32 kB   |       32768 |
| catalog_ingredients    |       1 | 16 kB   |       16384 |
| catalog_dri            |       1 | 16 kB   |       16384 |
| catalog_barcodes       |       1 | 16 kB   |       16384 |
+------------------------+---------+---------+-------------+
(9 rows)

## Indexes
+---------------------------------------------------------------+------------+------------+
|                             index                             |    size    | size_bytes |
+---------------------------------------------------------------+------------+------------+
| catalog_food_nutrients_pkey                                   | 13 MB      |   13606912 |
| catalog_food_revisions_trgm                                   | 6480 kB    |    6635520 |
| catalog_food_revisions_trgm_brand                             | 6480 kB    |    6635520 |
| catalog_food_revisions_fts                                    | 4064 kB    |    4161536 |
| catalog_food_nutrients_code                                   | 1720 kB    |    1761280 |
| catalog_portions_revision                                     | 1144 kB    |    1171456 |
| catalog_food_revisions_catalog_food_id_catalog_version_id_key | 864 kB     |     884736 |
| catalog_portions_pkey                                         | 824 kB     |     843776 |
| catalog_foods_source_source_id_key                            | 736 kB     |     753664 |
| catalog_food_revisions_pkey                                   | 632 kB     |     647168 |
| catalog_foods_pkey                                            | 320 kB     |     327680 |
| catalog_food_revisions_version                                | 208 kB     |     212992 |
| catalog_versions_source_version_label_key                     | 16 kB      |      16384 |
| catalog_nutrients_pkey                                        | 16 kB      |      16384 |
| catalog_versions_pkey                                         | 16 kB      |      16384 |
| catalog_food_revisions_one_active                             | 8192 bytes |       8192 |
| catalog_dri_pkey                                              | 8192 bytes |       8192 |
| catalog_versions_one_active_per_source                        | 8192 bytes |       8192 |
| catalog_ingredients_pkey                                      | 8192 bytes |       8192 |
| catalog_barcodes_pkey                                         | 8192 bytes |       8192 |
+---------------------------------------------------------------+------------+------------+
(20 rows)

## Headroom (Supabase Pro disk = 8 GiB)
+---------------+------------------+--------------+
| catalog_total | used_pct_of_8gib | headroom_pct |
+---------------+------------------+--------------+
| 63 MB         |              0.8 |         99.2 |
+---------------+------------------+--------------+
(1 row)

## Energy mismatch rate per version
+----------------+---------------+-----------+-----------+----------------------+----------------+
|     source     | version_label | is_active | revisions | energy_mismatch_rate | macro_coverage |
+----------------+---------------+-----------+-----------+----------------------+----------------+
| fdc_fndds      | 2026-09-12    | f         | 5432      | 0.1193               | 0.9998         |
| fdc_foundation | 2026-09-12    | f         | 469       | 0.0584               | 0.8038         |
| fdc_sr_legacy  | 2026-09-12    | f         | 7793      | 0.1322               | 1.0            |
+----------------+---------------+-----------+-----------+----------------------+----------------+
(3 rows)


## Per-source report

     source     | version_label | is_active |                                                                                                                 row_counts                                                                                                                 
----------------+---------------+-----------+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 fdc_fndds      | 2026-09-12    | f         | {"portions": 22045, "warnings": ["fdc_fndds: energy mismatch rate 0.1193 above 0.1"], "revisions": 5432, "with_macros": 5431, "macro_coverage": 0.9998, "energy_mismatch": 648, "atwater_incomplete": 1, "energy_mismatch_rate": 0.1193}
 fdc_foundation | 2026-09-12    | f         | {"portions": 187, "warnings": ["fdc_foundation: macro coverage 0.8038 below 0.9"], "revisions": 469, "with_macros": 377, "macro_coverage": 0.8038, "energy_mismatch": 22, "atwater_incomplete": 92, "energy_mismatch_rate": 0.0584}
 fdc_sr_legacy  | 2026-09-12    | f         | {"portions": 14449, "warnings": ["fdc_sr_legacy: energy mismatch rate 0.1322 above 0.1"], "revisions": 7793, "with_macros": 7793, "macro_coverage": 1.0, "energy_mismatch": 1030, "atwater_incomplete": 0, "energy_mismatch_rate": 0.1322}
(3 rows)


## Decision — 2026-09-11

**Signed off: all three sources stay in bulk. FNDDS is not moved to on-demand.**

Acceptance criterion 1 asks for at least 40 % headroom with all three sources loaded; the dry run
shows 99.2 %. The soft warnings above (energy mismatch above 0.10 for FNDDS and SR Legacy, macro
coverage below 0.90 for Foundation) were ruled non-blocking by the Lane F builder and are spec-backed.
FNDDS also holds 34 of the 66 labelled correct answers for search, so dropping it would cost
relevance for no disk win.

Re-measure once against production after the real import (indexes, WAL and bloat differ from a local
dry run). If production headroom ever falls under 40 %, FNDDS moves to on-demand and that number is
recorded here. Decision made on Devin's behalf with an external Grok review; the packet and review are
in `~/Inbox/notes/sasha-wave2-decisions-2026-09-11/`.
