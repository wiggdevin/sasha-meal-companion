# Recipe and Shopping QA pilot rollout

Date: 2026-09-27

## Scope

One approved QA account was enabled through the production
`RECIPE_PLANNING_USER_IDS` allowlist. The rollout did not enable every account and did not add a
price provider.

## Evidence

- PR #284 merged the integrated Foods, recipes and Shopping release as main commit `6be77a2`.
- The production seed script ran in read-only preflight mode against the confirmed project ref and
  reported 0 recipes to create and 12 existing.
- The existing Vercel production allowlist entry was changed from its disabled placeholder to the
  approved QA account. No other environment entry changed.
- PR #286 passed Quality, Build, Integration and Vercel before merge.
- PR #286 produced main commit `2dcceea`; Vercel deployment
  `dpl_8GJuGu99LTs85vLay6Qz1x5Dvn5N` reported `READY` for that exact SHA.
- An authenticated production browser session opened `/foods#shopping` for the approved account.
  At a 390 px viewport it rendered the Shopping tab, saved-list controls, period and meal choices,
  store notes, ingredient boundary, preview action and the honest unavailable-price fallback.

## Boundary

The pilot still has no connected real-price provider. Missing package sizes and prices remain
unknown, and the UI makes no checkout-cost or budget guarantee. A real multi-device production
mutation check remains a separate pilot exercise.
