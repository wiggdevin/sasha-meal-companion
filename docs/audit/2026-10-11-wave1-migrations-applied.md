# Wave-1 migrations — production receipt (2026-10-11)

Owner approval: Devin, 2026-10-11, in session (apply all four, then land #54, #61, #56).
Tool: `scripts/apply-migrations.py --commit` from each PR's own checkout, after a merge of
`origin/main` (each migration and its ledger row in one transaction). Management token from
the environment and the DB URL from ZS Vault, never printed. Project `fivatgdpuenszxxnijpc`.

Backup taken first: `~/Backups/supabase/meal-companion/2026-10-11T090331Z-ac102a76.sql`
(23,715,789 B, sha256 `7b7ef083392a69f54218315f04293a015035bb23f83da2b8603cc3d003eb9391`).

Ledger before: head `20261229090000`; none of the four below present.

| Migration | PR | Dry run named | sha256 of the applied file |
|---|---|---|---|
| `20261230091000_health_ingest_record` | #54 (W010) | only this file | `25c434056509779190ec958ce0469109c78473b051b8532133b76e003449dd04` |
| `20261230090400_recipe_energy_rule` | #61 (W004) | only this file | `7192116f69084f46bf3cf5dca9b04af0a278c45d38480e7bc87a20c9577ae265` |
| `20261230091900_media_owner_paths` | #56 (W019) | this and 091901 | `3c284920af86df7175a4c4a60df2ea0686da59d43427361b2d43f396aaf60229` |
| `20261230091901_media_owner_paths_validate` | #56 (W019) | — | `6ea8ef185d9ca0022d2d0e612cdc31174323dc90fc2fff339d174198cde5b004` |

## Verification (read-only queries after each apply)

- W010: `health_ingest_record`, `health_ingest_apply`, `health_ingest_event` and
  `health_ingest_time_zone_context` are executable by service_role only (not authenticated,
  not anon). `weigh_ins.source_kind` exists.
- W004: `_snapshot_energy_kcal` is service_role only; reported 0 → 0, calculated-only 80 → 80,
  empty → null (the one energy rule). `_sync_upsert` reads it.
- W019: pre-check before the apply returned 0 of 10 `media_objects` rows outside the owner-path
  shape. After: `media_objects_owner_path` is validated; `storage.objects` keeps only
  `media_own_read` and `media_own_delete` for authenticated (no direct insert or update).
- Ledger after: `20261230090400`, `20261230091000`, `20261230091900`, `20261230091901`.

## Still open

- W005 (owner): Foundation re-import and the energy backfill on production, once W004 is live.

## Wave 2, same day (owner approval: Devin, 2026-10-11, in session)

Backup taken first: `~/Backups/supabase/meal-companion/2026-10-11T154614Z-f4a6d579.sql`
(23,734,902 B, sha256 `981d49a9f8595455983aa4c8b906a5f638a95a52b54965439a2cd216a4133d13`).
Each PR's checkout had `origin/main` merged in; no migration on main redefines these functions.

| Migration | PR | sha256 of the applied file |
|---|---|---|
| `20261231100000_recipe_accept_unknown_need_stock` | #74 (W024) | `ccb2624a8d44009d570097399eed87584a9bebe685fb7a86a66cdceaa2832b73` |
| `20261231110000_food_membership_server_rev` | #78 (W029) | `ce9aedcbdd8e0bc71dfb53a2e668ce768384baabeee3d6b83c5190d11c24101b` |
| `20261231110100_favor_fill_missing_refs` | #78 (W029) | `7e637038a1e28f528f93d2de795f19da3f0738222a981ab6f8c22c22fa35aba9` |

Verification: `recipe_accept_preview` executable by authenticated, not anon.
`food_membership_ops` has RLS on and no authenticated select. The 6-argument
`set_food_membership` is executable by authenticated (it asserts the caller) and not anon.
`food_membership_revisions_owner_read` exists. `favor_food_families` stays service_role only.
Ledger after: `20261231100000`, `20261231110000`, `20261231110100`.
