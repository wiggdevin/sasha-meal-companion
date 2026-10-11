# Device storage is account-scoped — October 11, 2026 (W056)

Backlog B159 asked whether any localStorage, sessionStorage or IndexedDB key on the phone is still
shared between accounts. The 2026-09-15 note (`docs/readiness/2026-09-15/plan-cache-follow-up.md`)
kept the release single-account until legacy storage was retired or scoped.

## Result

One key was unscoped on `main` at `b85632f2`. The fix moves it under the account. All other keys
were already scoped by Phase 9 (§0.4 account keys, §0.6 legacy adoption).

| Defect | Effect | Fix |
|---|---|---|
| `recipe-checks:<revisionId>` (sessionStorage, `components/RecipeDetails.tsx`) | A catalog recipe revision is shared by all accounts. Sign-out replaces the page but keeps the tab's sessionStorage, so the next account in that tab saw the previous account's ticked ingredients. | The key is now `smc:u:<id>:recipe-checks:<revisionId>` (`lib/recipes/session-checks.ts`). With no account bound, nothing is read or written. |

The legacy keys and the shared `smc` database stay as they were. Adoption moves the old keys under
`smc:legacy:`, where no account can read them, and never deletes `smc`, so unsynced ops are kept.
`tests/device/legacy-adoption.test.ts` covers this.

## Inventory

`tests/device/storage-keys.test.ts` lists every client file that uses browser storage and fails
when a new one appears. Its second check rejects any `smc:`/`meal-companion:` literal outside the
allow-list.

| Scope | Keys |
|---|---|
| Account, `smc:u:<id>:` prefix | `store`, `coach:<thread>`, `pending_scans`, `draft:*`, `coach-action:*`, `coach-undo:*`, `starter-suggestions-seeded-v1`, `onboarding-invite-dismissed-at`, `role-confirm:*`, `taste-chips:*`, `today-dismissed:*` (session), `recipe-checks:*` (session, new) |
| Account database | IndexedDB `smc-u-<id>` (rows, outbox, meta) |
| Account id in the key | `meal-companion:onboarding-disposition:<id>`, `smc:coach:current:<id>`, `shopping-location:<id>`, `shopping-stores:<id>`, `recipe-expanded:<id>:<block>` (session), `smc:device:writer[-wanted]:<id>` |
| Account id in the value | `meal-companion:food-pref-refs` (`{ <id>: … }`; every read indexes by the caller's id), IndexedDB `onboarding-draft-v2` (record key = account id) |
| Device-level, no account data | `smc:device:accounts` (ids and last-used times only), `smc:device:signal`, `smc:device:legacy-adopted:<id>`, `smc:body_capability` (session), `meal-companion:install-prompt-*`, `care:sound-muted` |
| Legacy, held | `smc:legacy:*`, IndexedDB `smc` |

The service worker caches only the app shell and static files. `/api/` responses are never cached,
and no page renders account data on the server.

## Runtime proof

`tests/device/two-account-storage.test.tsx` (jsdom, fake IndexedDB):

1. Account A ticks two ingredients of a shared recipe. The tab signs over to B: B sees no ticks.
   Back to A: A's ticks return. This test failed on `main` (B saw A's ticks).
2. A writes through every storage writer (store, capture draft, pending scan, onboarding invite,
   taste chips, coach thread, account database, recipe ticks). Every resulting localStorage and
   sessionStorage key and every IndexedDB name contains A's id or is device-level. This failed
   on `main` with `recipe-checks:shared-rev-1`. B then reads none of A's values.

Multi-account use of one browser no longer depends on this item.
