# #117 and #111 migrations applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate", then approval to merge both PRs).

## #117: `20261231230000_delete_account`

### Order
The migration only adds `public.delete_account(uuid)`, which the #117 code calls, so it was applied
before the merge. PR #117 then merged as `527a4d28` at 07:07:13 UTC.

### Backup
`~/Backups/supabase/meal-companion/2026-10-17T070250Z-28805f4a.sql` (23,845,333 bytes,
sha256 `f31c6a2124785f9cccd90323c9b61477e61394b9f5a1e0d3d4116ea7ec9d491c`), taken by `scripts/backup.sh`.

### Applied
Dry run from the PR branch listed one pending file; `--commit` applied and recorded it. A second dry
run reported 172 of 172 recorded.

### Verified (read-only SQL)
- `delete_account` is `SECURITY DEFINER`.
- `service_role` can execute it; `authenticated` and `anon` cannot.

## #111: `20270102090000_voice_ears_cleanup`

### Order
PR #111 merged as `adc2a3cb` at 07:08:48 UTC. `GET /api/health` on production reported version
`adc2a3cb3a11…` at 07:11:00 UTC. The migration was applied after that, as its PR requires (the
deployed build no longer calls `voice_ears`).

### Backup
`~/Backups/supabase/meal-companion/2026-10-17T071105Z-91e4d74b.sql` (23,854,392 bytes,
sha256 `3100b21b19bb077b68f256572593c38ac40e7fac1cf45d8c580ea9d304d16d01`), taken by `scripts/backup.sh`.
Before the drop, `voice_ears` had 0 rows.

### Applied
Dry run on `main` listed one pending file; `--commit` applied and recorded it at 07:12:45 UTC. A
second dry run reported 173 of 173 recorded, nothing pending.

### Verified (read-only SQL)
- No `public.voice_ears` table.
- No `public.voice_ears_*` functions (`open`, `close` and `refuse` are gone).
