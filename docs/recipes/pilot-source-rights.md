# Original pilot recipe source and rights manifest

This manifest covers `original-pilot-v1` in `lib/recipe-catalog/pilot.ts` and the seed in
`lib/server/recipe-catalog-seed.ts`. It records source and permission claims made by the app; it is
not a kitchen-test certificate or independent nutrition verification.

| Recipe slug | Display title |
| --- | --- |
| `beef-tomato-vegetable-stew` | Beef and tomato vegetable stew |
| `lentil-carrot-tomato-stew` | Lentil, carrot and tomato stew |
| `chickpea-spinach-stew` | Chickpea and spinach stew |
| `black-bean-pepper-rice-bowls` | Black bean and pepper rice bowls |
| `lemon-chicken-rice-broccoli` | Lemon chicken, rice and broccoli |
| `chicken-chickpea-spinach-salad` | Chicken, chickpea and spinach salad |
| `tuna-tomato-rice-bowls` | Tuna and tomato rice bowls |
| `salmon-quinoa-spinach-plates` | Salmon, quinoa and spinach plates |
| `tofu-broccoli-rice-bowls` | Tofu and broccoli rice bowls |
| `egg-spinach-toast-plates` | Egg and spinach toast plates |
| `banana-yogurt-overnight-oats` | Banana yogurt overnight oats |
| `tomato-pepper-pasta` | Tomato and red pepper pasta |

Coverage additions (2026-10-03). Meal Companion wrote these 12 recipes for this app, with no
source recipe. They are built only from plain whole foods. An account that avoids gluten and
dairy and bans beans, onion and garlic, raw cruciferous, raw leafy greens and simple sugars still
gets chicken, beef, salmon, egg, lunch and snack options:

| Recipe slug | Display title |
| --- | --- |
| `easy-lemon-chicken-quinoa-bowls` | Easy lemon chicken and quinoa bowls |
| `chicken-carrot-quinoa-skillet` | Chicken, carrot and quinoa skillet |
| `quick-chicken-tomato-quinoa-lunch-bowls` | Quick chicken, tomato and quinoa lunch bowls |
| `salmon-broccoli-lemon-quinoa-plates` | Easy salmon, broccoli and lemon quinoa plates |
| `quick-salmon-quinoa-lunch-bowls` | Quick salmon and quinoa lunch bowls |
| `sirloin-roast-carrot-quinoa-plates` | Sirloin steak with roast carrots and quinoa |
| `sirloin-tomato-broccoli-skillet` | Sirloin, tomato and broccoli skillet |
| `quick-sirloin-quinoa-lunch-bowls` | Quick sirloin and quinoa lunch bowls |
| `easy-egg-spinach-breakfast-plates` | Easy egg and spinach breakfast plates |
| `easy-egg-quinoa-breakfast-bowls` | Easy egg and quinoa breakfast bowls |
| `egg-carrot-tomato-snack-boxes` | Egg, carrot and tomato snack boxes |
| `chicken-tomato-carrot-snack-plates` | Chicken, tomato and carrot snack plates |

All 24 have `rightsKind: original`, `author: Meal Companion`, `sourceUrl: null`, and
`sourceRevision: original-pilot-v1`. The recorded rights text says the method was authored for
this app and permits in-app display and serving adaptation. It does not claim third-party recipe
rights. `kitchenTested` is false for every recipe. No recipe here is represented as tested for
flavor, food safety, or cooking yield.

The 119 ingredient lines reference 30 existing IDs in `lib/food-db.json`. The 30th,
`sirloin-steak-broiled` (SR Legacy FDC 168635), came with the 2026-10-03 additions. None uses a
`label:`-sourced FoodDB row. The bundle documents those rows as USDA SR Legacy-derived. Each
ingredient's `sourceKey` pins `food-db:<id>`, with numeric macros marked `estimated`. Per-serving
macros sum ingredient values from the bundle and divide by declared servings; they are also
`estimated`, with `sourceKey: original-pilot-v1:food-db.json`. This is an approximation, not a
verified prepared-dish analysis. Cooked ingredients whose raw-purchase conversion is not known
retain `purchaseGrams: null` and an `unknown` conversion status.

Seed publication is a separate database step. Preflight stops on an existing pilot draft and
reports its provenance and content counts for reviewed recovery. A rerun skips existing published,
withdrawn, or superseded slugs without changing them; it cannot resurrect withdrawn content.
Catalog rights corrections must use the recorded withdrawal path;
the original authored prose and current nutrition source should be reviewed before a wider
release or a new recipe revision.
