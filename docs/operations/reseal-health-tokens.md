# Re-seal the health tokens under a new `HEALTH_TOKEN_KEY` (W080)

Oura token pairs in `health_sources.oauth` are sealed with AES-256-GCM under `HEALTH_TOKEN_KEY`
(`lib/server/crypto.ts`). To rotate the key, every stored pair must be re-sealed. This is a
Mac-session / owner step. A cloud thread never runs it, and never against production.

The script is `scripts/reseal-health-tokens.ts`. It is a dry run unless `--commit` is given, and
`--commit` on the production project also needs `--production` (the guard shared with
`scripts/food-membership-audit.ts`). It never prints a key or a token.

## Steps

1. Back up the database (`scripts/backup.sh`).
2. Generate the new key: `openssl rand -base64 32`. Store it in ZS Vault.
3. Rehearse on a branch database or the local stack:
   `OLD_HEALTH_TOKEN_KEY=… NEW_HEALTH_TOKEN_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx scripts/reseal-health-tokens.ts --commit`
4. Dry run on production (reads only): the same command without `--commit`. The tally must show
   `failed: 0`. A `failed` row opens under neither key; stop and look at it.
5. In Vercel, add `HEALTH_TOKEN_KEY_PREVIOUS` = the old key, set `HEALTH_TOKEN_KEY` = the new key,
   and redeploy. While `HEALTH_TOKEN_KEY_PREVIOUS` is set, a value the new key cannot open is tried
   under the old key, so nothing breaks between this step and the next. A pair the app rotates in
   the meantime is sealed under the new key.
6. Run on production: the same command with `--commit --production`. `raced` counts rows the app
   rotated during the run; repeat the command until `resealed` and `raced` are 0.
7. Check that an Oura pull still works for one account, then remove `HEALTH_TOKEN_KEY_PREVIOUS`
   from Vercel and redeploy.

The script is safe to repeat: a value already under the new key is skipped, and each write is a
compare-and-swap on the sealed value it read, so it never overwrites a newer pair.

## Rollback

Until step 7, set `HEALTH_TOKEN_KEY` back to the old key and `HEALTH_TOKEN_KEY_PREVIOUS` to the new
one, redeploy, and run the script with the keys swapped. After step 7, restore from the backup in
step 1 (tokens Oura rotated since then are lost; the account reconnects Oura).

Tests: `tests/health/reseal-health-tokens.test.ts`.
