# Pair holdout: labelling instructions (Phase 18 W1c, acceptance 1)

This task gives the Jev pair labels their independent check. Jev answers "is X with Y a normal
pairing at this meal?" for food pairs. Before any Jev answer can affect a meal, its answers are
compared with **your** answers on 432 pairs. A model must never fill this file. The loader refuses
any row whose labeller names a model (Jev, GPT, Claude, Gemini, "AI", "model", "auto", and similar).

## The file

`docs/pairing/holdout-pairs.csv`: 432 pairs, 36 for each of 12 cuisines. Open it in a spreadsheet
app and keep it as CSV.

| column | what it is | you edit it? |
|---|---|---|
| `pair_id` | the pair's fixed id | no |
| `cuisine` | the cuisine pack the pair was drawn for | no |
| `occasion` | the stated meal: `breakfast`, `lunch or dinner` or `snack` | no |
| `anchor` | the main food of the plate (catalog name) | no |
| `side` | the side food (catalog name) | no |
| `label` | your answer: `yes`, `no` or `unsure` | **yes** |
| `labeller` | your initials, the same on every row you label | **yes** |
| `note` | optional: anything that made the pair hard | optional |

Do not add, remove, reorder or rename columns. Do not edit the names. The loader refuses a file
with a changed header or an edited pair.

## The question

For each row, ask: **would people commonly serve the side with the anchor, on one plate or in one
meal, at the stated occasion, in at least one widely eaten cuisine?**

- `yes`: people commonly eat these together at this meal in some widely eaten cuisine, and nothing
  about the combination would seem odd to someone who eats that way. Examples: roasted chicken with
  white rice at lunch or dinner; a hard-boiled egg with buttered toast at breakfast; dal with
  basmati rice at lunch or dinner; tofu with bok choy at lunch or dinner.
- `no`: the combination is unusual, clashing, or not eaten together at this meal in any widely
  eaten cuisine. Examples: tuna with banana at lunch or dinner; salmon with granola as a snack.
- `unsure`: you cannot tell, or you do not know one of the foods. Unsure rows are not scored.

Judge the combination, not the foods alone. Do not judge health, calories, portion size, cost or
taste preference. The cooking method in the name ("roasted", "cooked") is the catalog form; judge
the foods as normally prepared. A pair can be `yes` for one cuisine and still be `yes` overall: the
test is "in at least one widely eaten cuisine".

Work without help from any model or search engine that suggests an answer. Looking up what an
unfamiliar food is, is fine.

## How much

The gate needs at least **400** `yes`/`no` answers, and at least **25** in each cuisine. 432 rows
give room for about 30 `unsure`. One sitting of about 90 minutes is typical; you can stop and come
back, because blank rows are simply unlabelled.

## When you are done

Commit the filled CSV on a branch (or send it to the backend lane). Then the lane runs:

```
pnpm exec tsx scripts/pairing/jev-labels.ts --items holdout --max-usd 0.05   # Jev's raw labels for the same pairs (about $0.003)
pnpm exec tsx scripts/pairing/calibrate.ts                                  # report and the stored calibration
pnpm exec tsx scripts/pairing/build.ts                                      # table and manifest
```

`docs/pairing/w1c-calibration-report.md` then shows the Brier score, ECE and reliability curve of
the raw and calibrated Jev labels, and whether the §5 gate passes (Brier ≤ 0.18, ECE ≤ 0.05, and
at least 0.01 better than raw). Even on a pass, the Jev weight stays 0 until the replay lift of §5
also passes (W8).
