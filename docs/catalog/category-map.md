# The policy category map — 2026-09-17

`lib/catalog/category-map.ts` turns a catalog revision into zero or more of the five
`banned_categories` keys the "Off the plan" switches on Foods › Avoids name. This document says
what each rule matches and why it is written that way.

Revised after the panel's first labelled run (round 1). The ground truth each rule is measured
against is recorded per key below, because the rule table means nothing without it.

## Why the map exists

`constraint_profiles.banned_categories` holds controlled keys —
`raw_cruciferous`, `raw_leafy_greens`, `onion_garlic`, `beans`, `simple_sugars`.
`catalog_food_revisions.category` holds whatever the provider called it: SR Legacy and Foundation
group names ("Vegetables and Vegetable Products"), FNDDS WWEIA names, OFF category tags. The policy
compared the two verbatim, so a switch could only ever fire on a barcode import, where
`lib/catalog/off-map.ts` derived the literal string `simple_sugars`. On the 13,694 USDA rows it
fired never. That is audit ruling 3: four of the five switches were a promise the policy could not
keep, and the fifth kept it only on scanned products.

T1 adds `catalog_food_revisions.policy_categories text[]` — **nullable, no default** (migration
`20261018090000`). `scripts/annotate-policy-categories.ts` fills it from this map, the barcode
write path fills it at import time, `catalog_search` returns it together with the provider category
(`20261018090200`), and `evaluatePolicy` blocks when any element of the array is in her
`banned_categories`.

## The derive rule, stated once

`policyCategoriesOf` in `lib/server/catalog.ts` is the only place that decides what a revision's
categories are, and the column has three states:

| stored | means | what the reader does |
|---|---|---|
| `NULL` | never annotated | **derives** from the row, through this map |
| `'{}'` | annotated, nothing banned | trusts it |
| non-empty | the stored keys | trusts them |

Nullable is the whole point. A `not null default '{}'` collapses the first two rows of that table
into one value, and then a catalog that has never been annotated — a fresh import, a restored
branch, a script someone forgot — reads as "checked, nothing banned" while Foods › Avoids shows
five switches on. That is the promise T1 exists to stop breaking.

The write side keeps the same distinction. `catalog_write_provider_revision` stores the draft's
array only when the draft really carries one (`jsonb_typeof(...) = 'array'`) and NULL otherwise.
The mappers annotate every draft they build, so a draft WITH the key and an empty array is honestly
clean; a draft without the key came from a writer that predates T1 — which is what the old barcode
path sends in the window between the migrations landing in production and the app deploy — and must
stay derivable.

**Every read path that holds the revision row goes through it: the detail read, the barcode match,
and food search** — search included, because search is the path she uses most and it cannot be the
one place that reads an un-annotated row as clean. `catalog_search` returns `category` alongside
`policy_categories` so a hit can derive its own. Capture inherits the answer from the hit it grounds
to. The log commit is the exception, and deliberately: it pins no revision for an unpinned item, so
it has no row to derive from.

`source` is **not** an input to the map. It was one until round 2, when the branded carve-out for
`onion_garlic` turned out to be the wrong axis — a flavour name reads the same whoever published
it — and nothing has needed the provider since. A branded row and a USDA row with the same words
get the same answer.

## How to read the rule table

Each rule is a row in `RULES`: a key, the terms the description must contain, terms that
disqualify it, whether the row must name no preparation at all, and a provider category that
disqualifies it.

Three properties shape every rule:

- **Precision is the gate (≥ 0.95 per key), recall is only reported.** A row we flag and should not
  have is a food taken off her plan for no reason. A row we miss is the status quo — she already
  reads the list herself. So an exclusion is cheap: it can cost recall and can never cost precision.
- **An unrecognised food is not blocked.** No rule matching means `[]`, which is evidence of "no
  banned category", not of danger.
- **The provider category only ever excludes.** Round 1 proved a category *requirement* is too
  strict: FNDDS files "Jam", "Molasses" and "Corn syrup" under a WWEIA category that says neither
  "Sweets" nor "Sugars, Sweets", and the conjunction lost all of them.

## One exclusion that applies to every key

A **composed pickle** — a `Pickles,` prefix, or the word relish or chowchow — is a different food
from its ingredients and is negative for all five keys. "Pickles, chowchow, with cauliflower onion
mustard, sweet" was a false positive for `raw_cruciferous` in round 2 and for `onion_garlic` in
round 3; the onion and the cauliflower are in its ingredient list, not in its identity, and an
ingredient list is T3's work.

`pickle` and `pickled` on their own are **not** in that rule. "Pickled onions" is still onion, and
she reacts to the allium however it was kept. A pickled form only contradicts the two RAW keys, so
the word sits in their preparation list instead.

## The rules

### `raw_cruciferous` and `raw_leafy_greens`

**Ground truth:** the raw vegetable itself. A cooked, preserved or composed version is negative.

Cruciferous names: broccoli, broccolini, cauliflower, cabbage, kale, brussels sprouts, bok choy /
pak choi, arugula / rocket, radish, daikon, collards, kohlrabi, turnip greens, watercress, cress,
mustard greens, rutabaga.

Leafy names: lettuce, spinach, chard, endive, escarole, mesclun, salad greens, mixed greens,
romaine, iceberg, radicchio, frisée, arugula, rocket, watercress, cress, beet greens, dandelion
greens, spring mix. Arugula, cress and watercress are leaves *and* brassicas, so they carry both keys; the
panel labels them under both and both are banned by default, so nothing is lost either way. Kale
and collards stay cruciferous-only — the panel did not report them as leafy misses.

Both rules test for the **absence of a preparation**, not the presence of the word "raw". Round 1
showed why: `Spinach, baby`, `Spinach, mature`, `Radish` and `Caesar salad, with romaine, no
dressing` are raw rows that never use the word, and leafy recall sat at 0.556 because of it. A row
is rejected when it names any of: cooked, boiled, steamed, roasted, baked, braised, sautéed, fried,
grilled, blanched, pickle / pickled, fermented, salted, brine / brined,
cured, canned, frozen, dried, dehydrated, creamed, unprepared, prepared, soufflé, quiche, casserole,
lasagna, soup, stew, dip, pizza, omelet, chips, crisps, snacks, juice, powder, sauce — or any
`flavor` / `flavored` / `flavour` word.

The preservation half of that list is round 2's correction: "Cabbage, mustard, salted" was one of
the two false positives the relaxation let through, and a preserved form is the product, not the
vegetable. The other, "Pickles, chowchow, with cauliflower onion mustard, sweet", is now handled by
the rule below, which applies to every key rather than only these two.

A second, narrower net catches the composed product that names no cooking method at all: a protein,
a starch, a condiment or a seaweed in the description (beef, chicken, pork, turkey, lamb, shrimp,
steak, bacon, sausage, ham, noodles, pasta, spaghetti, macaroni, ravioli, dumplings, couscous, rice,
stir fry, gratin, curry, risotto, burrito, taco, quesadilla, wrap, sandwich, sub, burger, bread,
bowl, kimchi, sauerkraut, dressing, seaweed, kelp, nori, wakame, laver), or the phrase `with
lettuce`. Without it "Beef and broccoli" reads as raw broccoli, "Spaghetti, spinach, dry" as raw
spinach, and "SUBWAY, SUBWAY CLUB sub on white bread with lettuce and tomato" as a raw leaf — the
two sandwich rows were the only `raw_leafy_greens` false positives in the first production sample.
`with lettuce` costs a little recall on a row like "Salad, green, with lettuce"; that is the right
side of a precision gate. `slaw` is deliberately absent: a slaw is raw shredded vegetable, so
"Broccoli slaw" is a positive.

A row that says **both** ("Cauliflower, roasted, raw as purchased") is still rejected, which is
exactly what the old presence-test did.

`dressing` IS an exclusion, and "Caesar salad, with romaine, no dressing" is still a positive: a
`no <word>` phrase is dropped from the description before the two nets run. FNDDS writes a lot of
rows that way ("no added fat", "no salt"), and a negation must not disqualify the row it was
written to qualify. The strip applies only to the raw keys; `simple_sugars` reads `no sugar` off
the untouched text, where it means the opposite.

### `onion_garlic`

**Ground truth:** the allium itself, raw or cooked, **including** onion rings, garlic bread, onion
dip, French onion soup and garlic sauce. Negative: anything with `flavor`, `flavored` or `-flavor`
in the description, and onion or garlic powder. Note that "Onion flavored rings" is a negative
while "Onion rings" is a positive.

Matches onion, garlic, shallot, leek, scallion, chive or ramp. Rejected when the description
contains:

- `flavou?r` anywhere — this is the single rule that fixed round 1's precision (0.865). Every false
  positive was a snack or branded product tasting of onion: "Snacks, potato chips,
  sour-cream-and-onion-flavor", "HORMEL ALWAYS TENDER, Pork Loin Filets, Lemon Garlic-Flavored",
  "Snacks, FRITOLAY, SUNCHIPS, multigrain, French onion flavor". Whether such a product really
  contains the allium is a question about its ingredient list, which is T3's work.
- `powder`, `powdered`, `granulated`, `granules`, or an allium immediately followed by `salt`.
- the shared pickled-product rule above.

Round 1's rule excluded branded rows by product-shape words (`dip`, `soup`, `sauce`, `rings`,
`bread`). That was wrong in the other direction — those are positives — and it has been removed.
`dried` and `dehydrated` are no longer exclusions either: freeze-dried shallots, leeks and chives
are the allium, and they were reported as misses.

### `beans`

**Ground truth:** pulses — dried, canned, cooked or baked beans, lentils, chickpeas, split peas,
and dishes named after them. Negative: green, snap, string and wax beans, **"immature seeds"**
rows (a green shelled bean, eaten as a vegetable), green peas, snow and snap peas, bean sprouts,
and the look-alikes (coffee bean, cocoa bean, vanilla bean, jelly beans). Split peas stay positive. Per T1 §3 (the coach's call) tofu, tempeh, hummus and refried beans also stay
allowed — that is the spec's rule, not the panel's, and it costs recall only.

Matches bean, lentil, chickpea, garbanzo, pulse, edamame, soybean, cowpea, fava, lima, and the
named pulse peas: split, black-eyed, pigeon, field, crowder, dried. **Bare `pea` is deliberately
absent.** All four of round 1's false positives were green peas ("Green peas, raw", "Green peas,
cooked, from restaurant", …), and every pulse pea names itself, so dropping the bare noun removes
the whole class.

The provider category is no longer required: the name list plus the exclusions do the work, and
"Soup, bean with bacon" is a dish named after the pulse, which the ground truth calls positive.
Round 1 reported "Beans, pinto, immature seeds" as a miss and round 3 reversed that — an immature
seed is the green shelled bean, eaten as a vegetable, so `immature` is an exclusion. The
mixed-vegetables row listing lima beans IS a positive and the map returns it: `lima` and `bean` are
both matched nouns and nothing in the row excludes them.

**Edamame and green soybeans stay positive.** They are the immature soybean, which is the same
shape of question as "immature seeds", and the two are being answered differently here: `edamame`
and `soybean` are named nouns, `green soybeans` is not caught by the `green beans` exclusion, and
neither carries the word `immature`. That is a **ruling for the coach to confirm** — if she
tolerates edamame the way she tolerates a green bean, the two rows move to the exclusion list.

Rejected: tofu, tempeh, hummus, refried, bean sprouts, sprouted, vanilla, coffee, cocoa, cacao,
jelly / jellybeans, pea protein, immature, edible-podded, snap, snow peas, green beans,
"beans, green",
string beans, wax beans, haricots verts, green peas, "peas, green", and bean or soybean oil and
lecithin.

### `simple_sugars`

**Ground truth:** the sweetener or the sweet spread itself — honey, syrup, sugar, agave, molasses,
jam, jelly, marmalade, preserves. Negative: confectionery and baked goods that merely contain them
(candy, cookies, honey buns, jelly doughnuts), fruits named after them (honeycrisp, honeydew,
nectarine), fruit nectars and sweetened drinks, honey-mustard dressings, peanut butter, and
anything "no sugar", "sugar-free" or sweetened with a non-sugar sweetener.

### The sweetener noun has to be the HEAD of the row

The first production run over all 13,694 revisions got 21 of its 30 sampled `simple_sugars` rows
wrong, and every one of them had the same shape: the sweetener was a qualifier and the food was the
head. "Beans, kidney, dark red, canned, sodium added, sugar added, drained" is a bean. "Rhubarb,
frozen, cooked, with sugar" is rhubarb. "Raspberries, canned, red, heavy syrup pack" is a
raspberry. USDA writes the food first and its qualifiers after, so position is the fact that
separates the two cases.

So the `description` test for this key runs against the **head**: the first comma-separated segment,
plus the second when the first is only a container word (`Syrups`, `Sugars`, `Sweeteners`, `Jams`,
`Jellies`, `Preserves`, `Marmalades`) — `Sweetener` earns its place from "Sweetener, syrup, agave",
a round-9 recall miss. Everything else — `descriptionNot`, `categoryNot` — still reads the
whole row, because a disqualifier anywhere is still a disqualifier.

This is also what keeps "Jams, preserves, marmalade, reduced sugar" and "Jam or jelly, fruit juice
sweetened" positive while "Plums, dried (prunes), stewed, without added sugar" is negative. The
qualifier words themselves (`sweetened`, `reduced sugar`, `with added sugar`) are deliberately NOT
blunt exclusions: adding them would take out the two jam rows the panel requires as positives. The
noun decides, and its position says whether it is the noun.

Round 1 measured precision 0.688 and recall 0.524 — the worst of the five — and the two failures
had opposite causes, so both halves of the rule changed.

**The category requirement is gone.** It cost all ten reported misses: "Agave liquid sweetener",
"Jam or jelly, NFS", "Jam", "Jam or jelly, reduced sugar", "Jam or jelly, fruit juice sweetened",
"Marmalade", "Molasses", "Corn syrup", "Pancake syrup", "Pancake syrup, light". The category now
only excludes, and only for `beverage`, `baked product` and `snack`.

**Neither `nectar` nor bare `agave` is a matched noun.** A fruit nectar is a drink and a nectarine
is a fruit. Agave is a Southwest vegetable before it is a sweetener — "Agave, raw", "Agave, cooked"
and "Agave, dried" were three of round 2's four false positives — so the word only counts beside
its sweetener form: `agave syrup`, `agave nectar`, `agave liquid`, `agave sweetener`.

**A confectionery or baked-goods word is a negative regardless of the sweetener inside it.** That
is what fixed the false positives: "Candies, honey-combed, with peanut butter", "Candies, NESTLE,
BIT-O'-HONEY Candy Chews", "Candies, TOBLERONE, milk chocolate with honey and almond nougat",
"Candies, gumdrops, starch jelly pieces". The list is candy / candies, chews, nougat, gumdrops,
cookies, biscuits, crackers, cakes, pies, pastries, muffins, brownies, buns, doughnuts, rolls,
bread, cereal, granola, bars, sandwiches, ice cream, yogurt, milk, mustard, dressing, marinade,
peanut butter, peanuts, beverage, drink, soda, cola, lemonade, punch, tea, coffee, smoothie, shake,
snap, peas — plus `sugar-apple` / `sugar apple` / `sweetsop` (a fruit named after a sweetener, like
honeydew and honeycrisp), `syrup pack` / `in syrup` / `heavy syrup` / `light syrup` / `extra heavy
syrup` (the canned-fruit packing medium, belt-and-braces beside the head rule), and `roasted`,
`glazed`, `coated` and `candied`, because a food merely roasted or
coated with a sweetener is the food, not the sweetener ("Nuts, almonds, honey roasted, unblanched"
was round 2's fourth false positive; glazed carrots and candied yams are the same case).

Three corrections from the Grok review:

- The confectionery word is `cand(?:y|ies)`, not `candies?`. The plural of "candy" is "candies",
  so the old pattern never matched a row named "Candy, honey" at all.
- `jelly beans` / `jellybeans` is its own exclusion. A jelly bean is confectionery for this key and
  a look-alike for `beans`, so it is negative for both.
- `apple` and `beet` are NOT exclusions. "Apple jelly", "Apple jam" and "Beet sugar" are the spread
  and the sweetener; her apple floor is enforced by allergen tags on the ingredient rows, not by
  this key, so excluding the fruit word here would only lose real sweeteners.

**"no sugar" is a negative; "reduced sugar" is not.** "Jams and preserves, no sugar (with sodium
saccharin)" is a false positive the ground truth names, while "Jam or jelly, reduced sugar" and
"Jam or jelly, fruit juice sweetened" are positives — so `sweetened`, `fruit` and `juice` are not
exclusions. `sugar-free`, `sugar free`, `unsweetened` and `sugar substitute` are.

`honeydew` and `honeycrisp` need no rule: `\bhoney\b` does not match inside them.

## Changing a rule

Every rule change goes back through the panel's labelled sample. Re-run

```
pnpm exec tsx scripts/annotate-policy-categories.ts --out <dir>          # dry run, counts + samples
pnpm exec tsx scripts/annotate-policy-categories.ts --commit             # write
```

The script is idempotent: it computes the keys for every active revision, reports the count per key
and the number of rows that differ from what is stored, and writes only the rows that changed. The
`--out` samples are taken in revision-id order, so two runs over the same catalog produce the same
30 rows per key and a rule change reads as a diff.

`lib/catalog/category-map.test.ts` carries every row the panel named, as a positive or a negative
case. A rule change that re-breaks one of them fails there, before the sample is re-run.

## Where the keys are enforced

Food search, the food detail read, the barcode path, and the coach's `search_foods` (which reads
details) — see "The derive rule, stated once" above for what each of them does with an
un-annotated row. The log commit does not: it pins no revision for an unpinned item, so it has no
category evidence; an avoid-listed item is still flagged there, from her own list.
