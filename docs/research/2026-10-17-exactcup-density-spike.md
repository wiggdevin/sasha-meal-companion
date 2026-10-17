# ExactCup density spike (W160)

Status: desk research, no code. Written 2026-10-17 from the repository only.

## What could not be done

The sandbox this was written in cannot reach `exactcup.com` (the egress proxy refuses the host and DNS does not resolve), and a web search found no page naming ExactCup or its terms. So the ExactCup columns the brief asked for are **not filled in**, and nothing below states ExactCup's licence or terms as fact. A person with a browser must do those two steps before any bundling decision (see "Owner steps").

## What the app already has

`scripts/build-food-db.py` reads USDA SR Legacy `food_portion.csv` and writes `lib/food-db.json` (523 foods, never hand-edited). Each food carries a gram weight per household portion, so cup, tbsp and tsp weights already come from USDA data, not from a third-party density table. 281 of the 523 foods have a `1 cup` portion. The table below is 40 of them, read from the file as it is on main; `n/a` means the food has no portion with that unit.

| Food | USDA cup label | g per cup | g per tbsp | g per tsp |
|---|---|---|---|---|
| Whole milk | 1 cup | 244 | 15 | n/a |
| Skim milk | 1 cup | 245 | n/a | n/a |
| Butter | 1 cup | 227 | 14.2 | n/a |
| Heavy cream | 1 cup, whipped | 120 | 15 | n/a |
| Sour cream | 1 cup | 230 | 12 | n/a |
| Parmesan cheese | 1 cup | 100 | 5 | n/a |
| Cream cheese | 1 cup | 232 | 14.5 | n/a |
| Mozzarella cheese | 1 cup, shredded | 112 | n/a | n/a |
| Feta cheese | 1 cup, crumbled | 150 | n/a | n/a |
| Ricotta, whole milk | 1 cup | 246 | n/a | n/a |
| Cottage cheese, 2% | 1 cup (not packed) | 226 | n/a | n/a |
| Yogurt, plain whole milk | 1 cup (8 fl oz) | 245 | n/a | n/a |
| Almond milk, unsweetened | 1 cup | 262 | n/a | n/a |
| Soy milk, unsweetened | 1 cup | 243 | n/a | n/a |
| Coconut milk, canned | 1 cup | 226 | 15 | n/a |
| White rice, cooked | 1 cup | 158 | n/a | n/a |
| Brown rice, cooked | 1 cup | 202 | n/a | n/a |
| Quinoa, cooked | 1 cup | 185 | n/a | n/a |
| Rolled oats, dry | 1 cup | 81 | n/a | n/a |
| Oatmeal, cooked | 1 cup | 234 | 14.6 | n/a |
| Corn flakes | 1 cup (1 NLEA serving) | 28 | n/a | n/a |
| Granola | 1 cup | 122 | n/a | n/a |
| Egg noodles, cooked | 1 cup | 160 | n/a | n/a |
| Spaghetti, cooked | 1 cup spaghetti not packed | 124 | n/a | n/a |
| Couscous, cooked | 1 cup, cooked | 157 | n/a | n/a |
| Barley, cooked | 1 cup | 157 | n/a | n/a |
| Broccoli, raw | 1 cup chopped | 91 | n/a | n/a |
| Spinach, raw | 1 cup | 30 | n/a | n/a |
| Spinach, cooked | 1 cup | 180 | n/a | n/a |
| Kale, raw | 1 cup | 21 | n/a | n/a |
| Carrot, raw | 1 cup chopped | 128 | n/a | n/a |
| Tomato sauce | 1 cup | 245 | n/a | n/a |
| Salsa | 1 cup | 259 | n/a | n/a |
| Tomato paste | 1 cup | 262 | 16 | n/a |
| Edamame, cooked | 1 cup | 155 | n/a | n/a |
| Tempeh | 1 cup | 166 | n/a | n/a |
| Egg white | 1 cup | 243 | n/a | n/a |
| Egg, scrambled | 1 cup | 220 | 13.7 | n/a |
| Tuna, canned in oil, light | 1 cup, solid or chunks | 146 | n/a | n/a |
| Mashed potatoes | 1 cup | 210 | n/a | n/a |

## Findings from the data

- **Dry baking staples are absent.** There is no flour, sugar, cocoa, baking powder, salt, honey or oil row in `lib/food-db.json`. Those are the ingredients where a cup is the usual recipe unit and a density table matters most. Cooked grains, dairy, and chopped vegetables are covered.
- **Cup weights depend on the preparation** ("1 cup, shredded", "1 cup, whipped", "1 cup, chopped", "not packed"). A single g/cup value per ingredient would erase that, so any external table must be matched on the preparation as well as the name.
- **tbsp and tsp coverage is thin**: most rows have only a cup, so a tbsp or tsp amount is today derived by volume ratio (1 cup = 16 tbsp = 48 tsp) at best.

## Recommendation

1. Do not add a runtime call to any external density site. The app is offline-first and the proxy shows such hosts are not reliably reachable.
2. If ExactCup's terms allow it, take a one-off, hand-checked subset limited to the missing dry staples (about 15 ingredients: flours, sugars, cocoa, salt, baking powder, honey, oils, nut butters) and bundle it as a reviewed JSON next to the build script, with the source and retrieval date recorded per row. Do not scrape the site.
3. If the terms do not allow it or are unclear, use the USDA SR Legacy rows for those staples instead; they are public domain and already flow through `food_portion.csv`, so the existing build can take them with a keyword list and no new source.
4. Either way, keep the preparation in the label and keep USDA as the source of truth where both exist.

## Owner steps

- Read ExactCup's terms of use and record whether copying gram-per-cup figures into a shipped file is permitted.
- Hand-record grams per cup, tbsp and tsp for the 40 foods above (or the staples list) and add them as extra columns here.
- Decide between recommendation 2 and 3. Recommendation 3 needs no external licence.
