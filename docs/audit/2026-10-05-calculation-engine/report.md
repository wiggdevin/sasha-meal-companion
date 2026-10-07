# Calculation engine audit — nutrition math, food rules, recipe scaling (2026-10-05)

Owner: Devin ("look into how everything is being calculated … how updating allergens or food
sensitivities affect recipes or how scaling affects recipes", 2026-10-04). Backend lane.

**Method.** Three read-only mapping passes of `main` `f6eca47`: the numeric engine, food-rule
changes reaching saved content, and recipe scaling. GPT-6 Sol then audited every finding with
executable probes and found more. Each fix was built in its own branch and reviewed adversarially
by Grok 4.7 (subscription route) until it passed, then proven (type check, lint, focused suites)
and landed. Review packets and verdicts: `~/.claude/goal-state/sasha-backend-2026-10-05/reviews/`.

## What was already right

- The policy engine is fail-closed. `evaluatePolicy` ranks present > unknown > allowed. "No
  evidence" reads as "check the label". A model lookup is capped at `no_evidence`, so no model can
  clear an allergen. Recipes are judged ingredient by ingredient.
- Day totals are summed raw and rounded once (`lib/resolve.ts`).
- A calorie pin moves carbs, then fat, and never protein; `deriveTargets` refuses a target whose
  kcal does not match 4·P + 4·C + 9·F.
- Shopping quantities are aggregated in grams with fixed-point arithmetic, and packages round up.
- The new meal sizer (`lib/meals/size.ts`) never emits an out-of-band or zero portion.
- Barcode import keeps "not measured" (null) apart from 0.

## Findings and their fixes

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | A saved plan slot is never re-checked after a rule change | BLOCK | Uneaten saved slots are marked `blocked`/`unknown` under the current rules; eaten history is not re-judged. Rules-epoch invalidation. (fix/current-rule-marks) |
| F2 | An accepted or saved recipe is never re-checked | BLOCK | Recipes are judged by their ingredients against current Food status and the server verdict, never by title. The verdict carries its epoch and diet-flag key, and stays unknown until every check succeeds. |
| F3 | The phone's eligible set outlives a rule change | BLOCK (partial) | The set is stamped with a rules epoch and diet flags; any rule write, 409, or revision seen elsewhere cancels it. |
| F4 | Shopping lines and pantry carry no rule mark | BLOCK | `ruleMark` on every line and pantry item; manual lines are still accepted (#376). |
| S1 | A shopping replan overwrites a recipe the user accepted | BLOCK | Accepted slots are kept and still bought; the accept function refuses to overwrite (migration `20261209090300`). |
| 17–19 | Calculated energy dropped in coach day context, exports and TDEE intake | BLOCK | One per-item rule: reported if finite and ≥ 0, else calculated, else unknown (`lib/nutrients/energy.ts`, `daily_energy` view, migration `20261210090000`). |
| N2 | Account foods used a flat gram table (a banana was 100 g) | BLOCK | One unit-weight resolver with the curated starter weight first; real weights where known; foods of unknown weight unchanged until the log sheet moves to the serving helpers. |
| #20 | Unknown catalog nutrients became measured-looking zeros | BLOCK | `completeComponentFromCatalog` refuses incomplete rows; the coach refuses to log or plan them. |
| #16 | The phone applied today's target revision to every date | BLOCK | Revision in force on each date, by the server's rule (#377). |
| #23 | A malformed target row parsed as 0 kcal | NOTE | Strict parsing; a bad row means needs_profile (#377). |
| #15 | Bundled and account food logs never reached server totals | BLOCK | Commit path for every picked food (fix/persist-every-log, with UI wiring). |
| #21–22, F6, S3 | Partial recipe nutrition shown as a full serving; coverage mismatch; vegan badge trusted from tags; recipe fit ignores protein | BLOCK/WARN | Honest-nutrition follow-up (t1h). |
| N4 | Every ml counted as 1 g | WARN | Density table; an unknown liquid has no gram weight. |
| N1, N5 | Rounding a small portion to zero; a zero-quantity whole item forced to 1 | WARN | Serving-rounding cleanup (t1h). |
| — | Older meals export read the wrong snapshot keys (empty macro columns) | BLOCK | fix/export-meals-keys. |

## Incident found during the run

Migration version `20261209090300` was used by two files. Production recorded it under one name,
so the apply script skipped `food_role_only_sync`. The role-confirm route could have cleared a
food's status and note. No sync operation ran in the window, so no data was touched. The migration
is now `20261210090100`, it is applied, and `tests/migrations/unique-versions.test.ts` keeps every
version unique (#372).

## UI-lane follow-ups

- Render `ruleMark` on slots, recipe selections and shopping lines.
- Switch `LogFoodSheet` and `logFromLabel` to `logPortionsFor` / `loggedFoodFor`.
- Switch `EditSlotSheet` to `completeComponentFromCatalog`.
- Wire the commit path for every logged food.
