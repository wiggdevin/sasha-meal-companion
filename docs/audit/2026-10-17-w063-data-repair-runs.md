# W063 production data-repair runs, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("Run the Wave 3 Mac
steps W063, W087 and W122 here"). Every script ran read-only first. No run found anything to
repair, so no `--fix` or `--commit` ran and production was not written.

How the scripts were run, from the repo root with `.env.local` naming production:

```
node --conditions=react-server --env-file=.env.local --import tsx scripts/<script>.ts [flags]
```

`--conditions=react-server` is needed for scripts that import `lib/server/*` (`server-only` throws
without it); the `pnpm exec tsx` form in the script headers fails for `recompute-target`.

## Results

| Script | Run | Result |
|---|---|---|
| `food-role-audit` | report | 100 roles checked, 0 mismatched. No fix needed. |
| `food-membership-audit` | report | 0 Eats/Avoid contradictions. No fix needed. |
| `recompute-target` | `--user-id` for each of the 10 accounts | 3 accounts: active revision already matches the stored profile. 1: skipped, `pins_differ` (owner-pinned targets, by design). 6: no target yet (`no_settings`, `incomplete_profile` or `not_onboarded`). No fix needed. |
| `allergen-jev-holds` | report | 145 Jev-only holds (dairy 31, egg 8, fish 7, gluten 44, peanut 18, sesame 1, soy 21, tree-nut 15); 0 re-derivable from the food's own name, tags or text; 0 released by review. |
| `annotate-policy-categories` | `--production` (dry) | 13,695 active revisions read; 716 carry a key; 0 differ from what is stored. This covers barcode rows written by the old writer, so the second run the spec asks for is the same result. |

## Notes

- **User 40707946 (2104 vs 1960 kcal).** This came from B277, a local-preview note. No production
  account has an id starting `40707946`, so the check was run for every production account instead
  (above).
- **Allergen holds.** A hold reads as "Not verified", never as clear, so leaving them is safe.
  Releasing one is `--review --reviewer <name> --food-key <key> --allergen <key>`, which is a
  person's judgment about one food's allergen. That review stays an owner step; it is not done here.
- **Facet pass.** `annotate-policy-categories --commit` also starts a model facet pass: the dry
  run planned 2,698 batches of about 15.4k tokens each (about 41M tokens; 336,322 unknown
  answers). The category annotation it belongs to needs no writes, so the paid pass was not run.
  Running it is a separate spend decision.
- The audits report 0 contradictions, which meets the spec's "0 contradictions after the fix".
