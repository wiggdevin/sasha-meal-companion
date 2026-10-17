# W145 migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
`20270105120000_care_items_mascots_widen` is one idempotent, widen-only `update` of seven
`care_items` rows. The server never reads the column (`care_equip` does not use it), so the order
did not matter. It was reviewed in session; no second-model round was run for a change this size.

## Order
Applied first, at 09:05:52 UTC. PR #165 then merged as `14bb5170` at 09:06:05 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T090532Z-94c3053b.sql` (23,903,654 bytes,
sha256 `1781eb76bedc5e5e06276d1e5006cd49a644e9dde20255c8ced87fcabbe08f4e`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR file added, listed only this file. `--commit` applied and
recorded it. A second dry run reported 181 of 181 recorded.

## Verified (read-only SQL)
- Companions now listed for each item:
  - All four (`sprout`, `blueberry`, `mushroom`, `peapod`): `leaf-pin`, `mittens`, `glasses`,
    `sunglasses`, `shorts`.
  - Three (`sprout`, `blueberry`, `mushroom`): `bucket-hat`, `knitted-hat`.
- `massage` is unchanged.
