# Logging marks, it never refuses — 2026-09-14

## The decision

`POST /api/log/commit` no longer refuses an item because the constraint policy blocks it. It
records the entry and returns the blocked items as `flagged`, so the app can mark them.

The constraint profile itself is unchanged: `PUT /api/constraints` still refuses to let gluten,
dairy or apple leave the floor, and `evaluatePolicy` still runs on every item, server-side, on
every commit. What changes is only what the server does with a `blocked` verdict on the LOG path.

## Why, given two rulings said different things

Four documents, and only one of them said refuse.

| Source | Date | Says |
|---|---|---|
| W3-10, `docs/decisions/2026-09-11-wave-3-4-rulings.md` | 2026-09-11 | commit "refuses a `blocked` item (closes the client-bypass gap)" |
| R6, `docs/decisions/2026-09-12-session-rulings.md` | 2026-09-13 | "Logging stays 'marking, never hiding'" |
| F-029 acceptance, `docs/features.md` | shipped | "Logging a dairy item shows a visible flag on that entry without preventing the log." |
| `AGENTS.md` | current | "Off-plan foods (gluten/dairy/apple) are flagged, not hidden." |

R6 is the later ruling and speaks to logging directly, while drawing the line the other way for
recipes: a recipe is a meal she PLANS, so it rejects an off-plan ingredient; a log is a record of
what already happened, so it marks. That distinction is the whole reason both can be true.

## The reason that decided it

She has ulcerative colitis, and the diary exists to connect what she ate to how she felt. If she
eats gluten by accident and the app refuses to record it, the record is wrong precisely where it
matters most — the flare it would have explained now has no cause in the data. Refusing to write
something down does not stop it having been eaten.

W3-10's concern was a modified client skipping the check. That concern is met: the check still
runs server-side on every item and its verdict is now returned and stored-adjacent as `flagged`,
rather than discarded. The constraint is enforced as information, which is what a diary can
enforce. It was never able to enforce it as prevention.

## What this does not change

- Recipes still reject an off-plan ingredient (R6).
- The gluten / dairy / apple floor on the constraint profile is still un-removable, and whitespace
  can no longer pad past it (Loop 010, 2026-09-14).
- The plan card still flags rather than hides, which is what it already did — this removes the
  disagreement between the two paths, it does not introduce the behaviour.

## If this is wrong

Devin reverses it by saying so. The change is one branch in `checkLabelAndPolicy` plus the
`flagged` field on `LogCommitResponse`; the evaluation, the evidence gathering and the tests for
each allergen all stay where they are.
