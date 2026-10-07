# Production data-integrity audit — 2026-09-19

Production run is read-only. Personal row contents and sample identifiers are omitted here.

| name | count | severity | sample ids (≤ 5) | fix path |
|---|---:|---|---|---|
| membership_contradictions | 0 | high | withheld (production counts only) | scripts/food-membership-audit.ts --fix (branch only) |
| prefs_orphans | 0 | medium | withheld (production counts only) | delete orphan prefs (--branch --fix only) |
| food_refs_dangling | 0 | medium | withheld (production counts only) | delete dangling ref (--branch --fix only; production requires owner step) |
| food_refs_unused | 147 | info | withheld (production counts only) | none; informational only |
| user_foods_without_ref | 0 | low | withheld (production counts only) | mint deterministic UUID v5 ref (--branch --fix only) |
| targets_consistency | 0 | high | withheld (production counts only) | recompute through the U1 target service (--branch --fix only) |
| profile_ranges | 0 | medium | withheld (production counts only) | owner step: correct the stored profile input |
| plan_slots_on_avoid | 0 | high | withheld (production counts only) | owner step: review the stored slot; rotation rules guard new days |
| health_ranges | 0 | low | withheld (production counts only) | owner step: review and correct the source record |
| rls_smoke | 0 | high | withheld (production counts only) | owner step: enable RLS and restore the table policy |

sha256: d1b6e08b09987e39b3c80e49387d4ad24fa14b2abd802d59e330c929aa342cd8

Two consecutive read-only runs produced the same finding-table checksum.
