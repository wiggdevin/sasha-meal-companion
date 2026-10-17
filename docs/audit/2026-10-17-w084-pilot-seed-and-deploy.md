# W084 recipe and shopping pilot — production seed proof and deploy receipt (2026-10-17)

Project `fivatgdpuenszxxnijpc`. Covers the first two W084 done-when items. The enablement steps stay with the owner (below).

## Seed proof (all 24 recipes)

Command, run read-only from the Mac at 14:09:06Z. The service key was loaded from the Supabase Management API into the process environment. It was never printed or stored.

```
pnpm exec tsx --conditions=react-server scripts/seed-recipe-catalog.ts --production --preflight --confirm-project-ref=fivatgdpuenszxxnijpc
```

Output:

```
Original pilot manifest: 24 recipes, 119 ingredient lines, 30 FoodDB IDs, 72 steps; original rights, source revision and estimated nutrition checked.
Read-only production preflight: 0 to create, 24 existing; no writes.
```

This replaces the 2026-09-27 proof, which covered only the first 12 recipes. No seed write was needed.

## Production deploy

- `/api/health` reports `ok: true` on main `6d91ba6c77b22b074bdc1b066810b32ae8e5298e`. That is the current main, with the full pilot source and every recipe migration.
- Migration ledger: 191 of 191 recorded (see `2026-10-17-w054-w126-applied.md`).

## Left for the owner (not done here)

- Each enablement step needs a Vercel env change to `RECIPE_PLANNING_USER_IDS`. Add only the accounts named in that step's receipt, and write one receipt per step in `docs/recipes/pilot-release.md`.
- The live two-device mutation check needs two signed-in real devices on an allowlisted account.
