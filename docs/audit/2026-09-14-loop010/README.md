# Loop 010 — full product evaluation, 2026-09-14

Run of ["The full product evaluation loop"](https://signals.forwardfuture.com/loop-library/loops/full-product-evaluation-loop/)
(loop 010, Forward Future Loop Library) against Sasha's Meal Companion.

**Terminal state: blocked handoff, not a clean pass.** The loop stops at "a clean full pass or an
explicit blocked handoff". Four open findings need a product ruling that is Devin's to make, so a
clean pass is not reachable from here. Everything else is either fixed or listed in `findings.md`.

## Step 1 — the environment

| | Production | Local (this run) |
|---|---|---|
| catalog_foods | 13,694 | 13,700 (6 extra seed rows) |
| catalog_synonyms | 67 | 67 |
| Flags | catalog search, scan, capture=text | same, plus coach / health / estimator on |
| Data | Sasha's real rows | local-only user, created through the app |

Isolation was verified, not assumed: local `auth.users.last_sign_in_at` moved on sign-in and the
dev-server log contains zero `supabase.co` references.

### Unavoidable differences, recorded per the loop

1. **Production env vars cannot be read** from here (the Vercel MCP fails auth and the API token
   has no team scope), and `.env.local` carries no `COACH_ENABLED`, `NEXT_PUBLIC_COACH_ENABLED`,
   `HEALTH_*` or `ESTIMATOR_*` at all. Flag values are a reconstruction from code defaults, not a
   verified mirror of production.
2. **Three production tables have no migration.** `foods`, `days` and `settings` exist in
   production (all empty) and are created by no migration in this repo, so a rebuilt environment —
   local, CI, a preview branch, a restore — cannot reproduce production. This is why the legacy MCP
   tools fail here and not in production. `scripts/check-migration-drift.ts` will not catch it: it
   compares migration ledgers, not schema.
3. **Sasha's own data is inherently small** (101 food_refs, 1 recipe), so "production scale" is met
   on the catalog, which is the only large table.
4. Service-worker registration fails on the dev server; treated as a dev artifact, not tested.

## Step 2 — the inventory

`docs/features.md` already carries 118 features, each with one testable Acceptance sentence, so it
is the inventory. Scope came from the AGENTS.md phase table (0-7 shipped, 8 not started) because
features.md's own Disposition column is stale — see the note now at the top of that file.

## Step 3 — exercise

197 surfaces across 12 areas, 22 blocked and reported as blocked. 20 findings, each adversarially
verified by an independent agent. The verifiers refuted none, which is itself a warning sign, so
all five criticals were re-checked by hand. One did not survive that check.

## Step 4 — fixes (landed)

| Defect | Evidence, before -> after |
|---|---|
| Padded allergen disabled the gluten floor | same food, same user: `"gluten "` allowed -> **blocked** |
| Every existing coach thread answered 500 | 500 -> **200** |
| Second device destroyed a decided merge | `open rev=1` -> **`merged rev=2`** |
| Outbox-only writes never synced | 8 s / 0 pushes -> **1 push, server 2 -> 3** |
| Water corrections silently discarded | reported "applied", stayed 4 -> **4 -> 2**, stale write still refused |
| Bringing a food back deleted its note | note gone -> **"hurt on 9/12" kept** |

Landed in #185 and #186. Suite 2,140 passing, lint and tsc clean.

## Needs a ruling before it can be fixed

1. **Should logging a dairy item be refused, or logged with a flag?** The server refuses it today.
   W3-10 (2026-09-11) says commit "refuses a blocked item ... closes the client-bypass gap". R6
   (2026-09-13, newer) says "Logging stays 'marking, never hiding'", and F-029's acceptance and
   AGENTS.md agree with R6. Three sources against one older one — but this is health behaviour, and
   an agent should not flip it quietly.
2. **Barcode-scanned foods are invisible to search.** `catalog_search` requires `v.is_active`;
   barcode scans deliberately write an inactive version. Making that version active would break
   `activeVersionLabel`, which picks the newest active version. Exempting `off`/`fdc_branded` in
   the search join is the likely fix, and it is a catalog design decision.
3. **`simple_sugars` is unenforceable on the bulk catalog.** The banned category is only ever
   derived for barcode imports; the 13,700 USDA rows carry USDA's own taxonomy ("Sweets"), which
   never equals `simple_sugars`. Enforcing it needs a category mapping someone has to author.
4. **AI-capture's 0.95 auto-resolve threshold is unreachable** given the real search scoring, so
   that path never auto-resolves. Lowering it is a confidence-vs-safety call.

## Two migrations are not yet in production

`20261016090000` (duplicate_groups rev regression) and `20261016090100` (water corrections) are in
the repo and applied locally. Until they are applied, production still corrupts a decided merge on
a second device's create, and still discards water corrections while reporting success.

    python3 scripts/apply-migrations.py            # dry run
    python3 scripts/apply-migrations.py --commit

## Everything else

`findings.md` carries all 20 findings with repro, observed and expected, each marked FIXED,
RECLASSIFIED or OPEN.
