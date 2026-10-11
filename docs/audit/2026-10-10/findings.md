# Meal Companion audit 2026-10-10 — findings

See `README.md` for method, counts and how to read ids.

Severity shown is the final rating. For eight findings the Sol cross-check lowered the rating from high to medium; the original rating is in the verification line. A129 was refuted by Sol and is removed (see README).

# Confirmed findings

## High severity (3)

### High / nutrition accuracy (2)

#### A154 — Adding a catalog food to Eats/Favored stores unmeasured nutrients, including calc-only energy, as measured 0
- **Where:** `components/add-food/catalog-food.ts:17`
- **Area:** nutrition accuracy; **category:** null-as-zero
- **Defect:** `addCatalogFood` builds the account's `user_foods.per_100g` with `amount()`, which returns 0 for any missing or null nutrient. It also reads only `energy_kcal` and never `energy_kcal_calc`. Many FDC Foundation revisions carry no FDC 1008 energy row, only the importer's `energy_kcal_calc`, so the row is stored as `energy_kcal: 0`, a measured zero. Unmeasured protein, carbs and fat become 0 the same way. The coach grounds an Eats food by exact name from this row first: `searchExactUserFood` reads `kcalPer100g` from `per_100g.energy_kcal ?? energy_kcal_calc`, and 0 is a number, so the fallback never runs. `completeComponentFromCatalog` keeps a stored 0 as a measurement. A log written against this ref gets a `compute_item_snapshot` with `energy_kcal.amount = 0`, which the energy rule reads as reported 0 kcal.
- **Failure scenario:** A user adds a Foundation chicken breast (no 1008 row; energy_kcal_calc about 120) to Favored. The coach's suggest_options or log_meal resolves it through `eatsOwnFood` → `searchExactUserFood`. The plan line or log line for 150 g shows 34 g protein and 0 kcal. Once eaten or logged, the ring, the coach's day totals, `daily_energy` and the TDEE intake all count 0 kcal for it. A food whose label left protein unmeasured is likewise stored and counted as 0 g protein, not unknown.
- **Fix:** Write only the codes the revision actually measured (omit or null the rest), and store energy as `energy_kcal ?? energy_kcal_calc`, or copy `energy_kcal_calc` through under its own code. Backfill existing `kind='custom'` rows that have a catalog_food_id and `energy_kcal = 0` from their catalog revision.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A157 — Weekly proposal can never lower the training day, so downward TDEE corrections are suppressed for accounts with 3 or more training days
- **Where:** `lib/proposal.ts:137`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** buildProposal runs the training day through applyFloors with carbGMin = max(floor, authored.carbG). Every derived or percent revision stores the training-day gram set, and that set adds up to kcal_train (deriveTargets checks the identity; percentToGrams rebuilds kcal_train). So any lower kcalTrainRaw is raised straight back to the authored total, and deltaKcalTrain is about 0. Only the rest day moves, by at most cap x rest/train. The weekly-average move is then (7-T)/7 x restDelta. For T >= 4, and for T = 3 with the default 150 kcal step, that is under MIN_PROPOSAL_MOVE_KCAL (75), and the job answers 'Your current targets already fit your estimate'. This contradicts architecture section 4.3, which the file header copies: 'carbs = the remainder', 'training / rest split preserved in the same ratio'.
- **Failure scenario:** A derived revision for a 70 kg, 165 cm woman (moderate activity, maintain) gives train 2042 / rest 1818 at 4 training days, a 1946 kcal weekly average. The engine learns a TDEE of 1546 (400 kcal below) and is proposalEligible. buildProposal returns {kind:'none', reason:'Your current targets already fit your estimate'}. It does this every week, for any size of drop. At 5 days (train 2042 / rest 1706) it is the same. At 2 or 3 days a proposal appears, but deltaKcalTrain is 0 and raisedToFloor is true, so the training/rest ratio is broken. An upward move of the same size proposes +150/+134 normally. So the adaptive engine can only ever raise calories for most accounts. A cutter whose expenditure falls never gets a lower target.
- **Fix:** Compute training carbs as the remainder at kcalTrainRaw, floored only at the revision's carb_g_min (as the rest day already is), so the single factor moves both days. Or, if authored training carbs must be protected, say so in a ruling and lower the rest day further, so that the weekly average still reaches the target within the cap. Add a test with a derived revision whose grams add up to kcal_train and a downward TDEE.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### High / ops (1)

#### A009 — Failed apply permanently swallows the payload: a retry is answered 'duplicate'
- **Where:** `lib/server/health-ingest.ts:95`
- **Area:** ops; **category:** data-loss
- **Defect:** applyIngest records the ingest event (health_ingest_event, status 'applied', unique on source_id+payload_hash) BEFORE health_ingest_apply runs, in separate RPC calls with no compensation. If the apply RPC errors (timeout, transient 5xx, deploy window), the route returns 500 but the event row stays. The exporter's retry of the identical body hits ON CONFLICT, gets is_new=false and is returned as status 'duplicate' with 0 accepted, without applying.
- **Failure scenario:** Health Auto Export or a Shortcut posts a day of steps, weight and sleep. health_ingest_apply fails with a statement timeout, so the client gets 500 and retries the same body, as HAE does. The retry returns 200 {status:'duplicate', accepted:0}. The samples never reach health_samples, and every identical resend is dropped the same way. Weight, steps and sleep for that window are lost until the content changes.
- **Fix:** Make event creation and apply one transaction (a single RPC), or on apply failure delete the event row (or mark it 'failed'). Treat a duplicate as a skip only when the existing event completed. Oura's pullTwoDays already ignores is_new and re-applies, so apply is idempotent and a safe model.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: kept high; already known before this audit
- **Known before:** Partly: docs/audit/specs/2026-09-22-phase-10-r1-gpt6-sol.md item 8 notes the event-before-apply order and the duplicate-on-retry behaviour as a spec review finding. No fix or owner ruling found.

## Medium severity (67)

### Medium / nutrition accuracy (15)

#### A002 — Rest-day calorie pin can drop below the revision's own recorded floors (80 g carb floor vs 100 g)
- **Where:** `lib/profile/derive.ts:74`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** Pinned targets go through adjustCalories, which uses FLOORS.carbsRest = 80 g (lib/types.ts:377-381, lib/scaling.ts:29-31). The same revision stores carbGMin = 100 and kcalMin = 4*protein + 450 + 400 (lib/profile/derive.ts:164-170, lib/profile/energy.ts:59,203). A rest-day pin therefore produces a day under the revision's own recorded carb and calorie floors. Nothing re-checks the pinned result against those floors. Pins accepted by the settings schema (app/api/targets/route.ts:60-62) and the coach (min 1000) can be as low as 800 kcal.
- **Failure scenario:** Female, 1968, 170 cm, 72.6 kg, moderate, recomp, restKcal pin 900. I ran deriveTargetRevision and got rest = {protein 145, carbs 80, fat 50, kcal 1350}, while the stored floors say kcalMin 1430 and carbGMin 100. The account ends up 80 kcal under its own minimum and 20 g under its own carb floor. Later checks that read these floors, such as the weekly proposal's applyFloors, disagree with the day that was written.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A006 — gramsFor multiplies qty by a matched portion's gram weight and ignores the amount in the portion label
- **Where:** `lib/capture/quantity.ts:83`
- **Area:** nutrition accuracy; **category:** unit-conversion
- **Defect:** Catalog portion descriptions are built by import-fdc.py portion_label as '<amount> <unit> <description> <modifier>', for example '0.5 cup', '2 tbsp' or '3 oz'. matchPortion matches only on the unit word and returns the first portion containing it. gramsFor then returns qty * portion.gramWeight, treating every matched portion as 'one unit'. The gram_weight is the weight of the labelled amount, not of one unit.
- **Failure scenario:** A food whose first 'cup' portion is '0.5 cup' (gram_weight 120) is captured as '1 cup'. gramsFor returns 120 g instead of about 240 g, so the logged calories are halved. A first 'tbsp' portion of '2 tbsp' (30 g) makes '1 tbsp' log as 30 g instead of 15 g, double. Verified: gramsFor(1,'cup',[{description:'1/2 cup',gramWeight:120}],{a:1}) returns 120.
- **Fix:** Parse the leading amount from the portion description (digits, decimals and fractions, defaulting to 1) and return qty * gramWeight / amount. Alternatively prefer a portion whose amount is 1 when matching.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A007 — Capture invents 100 g per 'whole' or 'piece' for any matched catalog food, despite the module's refuse-to-guess contract
- **Where:** `lib/server/capture.ts:310`
- **Area:** nutrition accuracy; **category:** energy-accuracy
- **Defect:** quantity.ts says an amount with no gram weight must return null so the item goes to the stepper. gramsFor does return qty * DEFAULT_WHOLE_GRAMS for 'whole' or 'piece' when per100g has any key. capture.ts passes a dummy per100g of { energy_kcal: 0 }, so that guard is always true. Any catalog food with no matching portion gets a fabricated 100 g per count.
- **Failure scenario:** The user says 'two bananas' and the picked revision has no portion containing the word 'whole' or 'piece'. grams becomes 200 and is logged as a measured amount. A real banana weighs about 118 g, so the snapshot kcal and macros are about 15% too low. 'a pumpkin', 'a whole pizza' or 'a watermelon' land at 100 g, wrong by a factor of 10 or more, and look measured with no unknown mark.
- **Fix:** Pass the real per-100g map (or drop the default) and return null for a count with no portion, so the item falls to the stepper or the unknown-mass path. Or flag the invented weight as an estimate.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A013 — Name-substring portion bands cap oil-packed tuna and sardines at 15 g, so the plate has about 12 g protein
- **Where:** `lib/coach/portion-bands.ts:30`
- **Area:** nutrition accuracy; **category:** portion-bands
- **Defect:** portionBand picks the first RULES regex that matches anywhere in the food name. `\b(?:oil|ghee|lard)\b` (5-15 g) matches 'Tuna, canned in oil, light' and 'Sardines, canned in oil', which are protein anchors in the bundled food list. Their band is the cooking-oil band, not an anchor band.
- **Failure scenario:** An account has 'Tuna, canned in oil, light' (8.25 g protein per oz) in Eats. I ran sizePlate([tuna anchor, rice starch], {kcal:600, protein:45, carbs:60, fat:15}). It returned tuna 0.5 oz (the 15 g band hi) plus 1.75 cup rice. The plate totals 12 g protein and 382 kcal against a 45 g and 600 kcal target. Chicken breast on the same target gives 5 oz, 52 g protein and 587 kcal. The generated meal or swap row shows '0.5 oz tuna' as a full meal. The result is a wrong portion, and it breaks the protein-first rule.
- **Fix:** Anchor the rules to the food's head noun: test only the text before the first comma, or skip the oil and butter rules when the name contains 'canned', 'in oil' or 'packed'. Also let the part (anchor) override a fat-band rule when the food's role is protein.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A015 — Catalog log sheet with no portions: the 'How many' stepper changes the count but not the grams
- **Where:** `components/LogFoodSheet.tsx:260`
- **Area:** nutrition accuracy; **category:** log-portion-maths
- **Defect:** startCatalogPortion sets catPortion=null, typedPer=null, qty=1 and grams=100 when the revision has no portions. FoodDetail.portions is the legacy list without the 100 g tail. In setPortionQty, when !catPortion and typedPer===null, the function sets qty and returns without touching grams.
- **Failure scenario:** The user picks a catalog food with no household portions, taps '+' twice, and the sheet shows 'How many 1.5'. The grams box, the kcal strip and the 'Log it · 100 g' button stay at 100 g. The user believes 1.5 servings will be logged. The commit sends unit 'g' with grams 100, so only 100 g is logged, and the stepper did nothing.
- **Fix:** Hide the stepper when there is no portion and no typed grams, or seed typedPer = grams/qty at start (typedPer = 100) so the stepper scales grams, or add the 100 g tail portion.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A017 — Cheese substring rule gives mixed dishes (mac and cheese, pizza, burrito, omelet) a fat or cheese part and a 15-60 g band
- **Where:** `lib/coach/portion-bands.ts:38`
- **Area:** nutrition accuracy; **category:** portion-bands
- **Defect:** The `\bcheese\b` rule (15-60 g) and FAT_WORDS, which includes cheese (line 82), match any name containing 'cheese'. 'Macaroni and cheese', 'Pizza, cheese', 'Burrito, bean and cheese' and 'Enchilada, cheese' therefore resolve to part ['fat'] with a 15-60 g band. 'Omelet, cheese' resolves to anchor with a 15-60 g band.
- **Failure scenario:** The tsx run printed `Macaroni and cheese carb ['fat'] {min:15,max:60}`, and the same for Pizza, Burrito and Enchilada. Omelet, cheese came out as ['anchor'] 15-60 g, and a 30 g omelet is about 3 g protein. A pizza slice is about 107 g and mac and cheese is a cup (about 189 g). Plates would use these as a small fat topping, or as an anchor that can never reach the protein target. A user who eats these as a meal gets nonsense sizes, such as 30 g of omelet.
- **Fix:** Treat only names whose head noun (text before the first comma, minus 'and ...') is cheese as cheese. Let a mixed-dish food (many macros, or a meal-category food) use its role default band.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A019 — Foundation foods without reported energy fall back to a fiber-subtracted Atwater value, understating kcal by up to 140 per 100 g
- **Where:** `scripts/import-fdc.py:80`
- **Area:** nutrition accuracy; **category:** nutrient-mapping
- **Defect:** NUTRIENT_MAP maps only FDC id 1008 to energy_kcal. Foundation foods mostly publish energy as Atwater General (2047) or Specific (2048), and the importer ignores both. The catalog then reads energy_kcal ?? energy_kcal_calc, and energy_kcal_calc (catalog_atwater_kcal) is 4*protein + 4*max(carb - fiber, 0) + 9*fat. That fiber-subtracted number is not the published energy.
- **Failure scenario:** A user searches the online catalog for a Foundation food such as 'Flour, coconut', 'Flaxseed, ground', 'Nuts, almonds, whole, raw' or 'Bulgur'. The card and logged entry use energy_kcal_calc. I read the 2026-09-12 Foundation CSVs in ~/Backups/usda/fdc. Of 469 foundation_food rows, 334 have no 1008 row. Among the 242 of those that have all three macros plus a 2047/2048 value, the calc is below the published energy by 139.8 kcal/100 g for sorghum bran (263 vs 403), 137 for coconut flour (301 vs 438), 92.5 for ground flaxseed (453 vs 545) and 43 for raw almonds (583 vs 626). Every log of these foods is under-counted, and energy_mismatch can never fire because there is no reported value to compare.
- **Fix:** Map 2047 (preferring it, else 2048) to energy_kcal for the Foundation source in the importer, in the same way lib/catalog/fdc-map.ts handles duplicate ids. Re-import the Foundation source. Make catalog_atwater_kcal add fiber at 2 kcal/g, or flag foods whose energy comes only from the fallback.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A020 — Bundled-food default portion is whichever label is shortest, so many foods default to a whole cup, package or pizza
- **Where:** `lib/food-db.ts:82`
- **Area:** nutrition accuracy; **category:** portion-default
- **Defect:** realPortionsFor sorts by portionRank and marks index 0 as isDefault. portionRank gives '1 cup', '1 large', '1 oz', '1 slice' and similar the same score of -300, then breaks the tie by label length. 'cup' and 'package' labels therefore beat the real serving. The catalog importer instead defaults to the first non-gram portion by FDC seq_num, so the offline and online defaults disagree.
- **Failure scenario:** Offline (or bundled) search for 'egg yolk' defaults to '1 cup' (243 g, 782 kcal) instead of '1 large' (17 g, 55 kcal). I ran searchFoods over all 523 foods. Other defaults: almonds '1 cup, whole' 143 g = 828 kcal (a '1 oz' portion exists); M&M's '1 cup' = 1,023 kcal; flour tortilla '1 package' 484 g = 1,437 kcal; pepperoni pizza '1 pizza 12"' 532 g = 1,458 kcal; General Tso's chicken '1 order' = 1,578 kcal; milk-chocolate '1 cup chips' = 899 kcal. A one-tap log with the default portion and qty 1 records a 5-20x over-count in the rings.
- **Fix:** Key the default on the source order (the first non-gram household portion in food-db.json), or add an isDefault flag in build-food-db.py. Alternatively penalise 'package', 'order', 'pizza', 'cup' for dense foods, and 'chips', 'crushed' and similar in portionRank.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A030 — Label capture with 'Save as my food' (on by default) is always refused with 422
- **Where:** `lib/capture-client.ts:386`
- **Area:** nutrition accuracy; **category:** broken-feature
- **Defect:** commitDraft sets req.save_label_as_food = true for method 'label' when the toggle is on. The client never sends a label_food body and never uses the placeholder food_ref_id. The commit body is the plain LogCommitRequest. canSave also requires every kept item to have a non-null foodRefId. Server-side, labelFoodOrFailure returns invalid 'save_label_as_food needs one item with the placeholder ref' whenever save_label_as_food is set and no item carries LABEL_FOOD_PLACEHOLDER_REF. No client code references that placeholder.
- **Failure scenario:** User photographs a nutrition label. The draft item grounds to a catalog food, so Save is enabled. CaptureDraftEditor initialises saveLabel to true for method 'label', so the request carries save_label_as_food:true with a real ref. POST /api/log/commit answers 422 invalid, and the meal cannot be saved unless the user finds and turns off 'Saving as my food'. An ungrounded label item (the usual novel product) cannot be saved at all because canSave needs a foodRefId. The label-to-own-food path is unreachable end to end.
- **Fix:** When saving a label as a food, send label_food from draft.labelFood plus a placeholder ref on the label item, and drop the canSave foodRefId requirement for that item. Or do not set save_label_as_food when no placeholder or body is sent.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A034 — Capture sheet refuses to save blocked items, contradicting the logging-marks ruling
- **Where:** `lib/capture-client.ts:298`
- **Area:** nutrition accuracy; **category:** spec-mismatch
- **Defect:** canSave returns false when any kept item has policy.verdict 'blocked', and commitDraft returns invalid 'nothing to save' without any network call. The 2026-09-14 ruling says logging marks and never refuses, because the diary must record what was eaten, and changed only the server. The photo, voice, text and label capture path still prevents saving a blocked item.
- **Failure scenario:** User with gluten on her avoid list photographs a plate that includes bread and wants to record it. The bread item is blocked, so Save is disabled and commitDraft refuses. She must delete the bread to log the meal, so the diary lacks the item that explains a later flare. This is the exact case the ruling was made to prevent.
- **Fix:** Let blocked items be saved with a visible mark, with confirmation if wanted, and keep only the ungrounded (no foodRefId) condition as a hard stop.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** Partly known. docs/audit/2026-09-14-loop010/README.md raised the refuse-or-mark question and the 2026-09-14 ruling answered it for the server. No audit or ruling mentions the capture sheet's client-side canSave refusal.

#### A040 — An unreadable or over-long document amount silently becomes one household portion
- **Where:** `lib/plan/document-clean.ts:18`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** cleanAmount returns null both when no amount is written and when an amount is written but fails its screen (over 24 characters, over 4 words, or no digit). parseAmount(null) then returns {count:1} ('one household portion, the set_slot_meal default'). So an amount that was present but cut by the screen is placed as a default single portion, with no 'Couldn't read the amount' message.
- **Failure scenario:** A plan line '3 large eggs (about 150 g)' (6 words) or '1 1/2 cups (about 360 ml)' (25 characters) or '200 g cooked weight, drained' is cleaned to null, then parsed as {count:1}. The foods are grounded as one usual portion (one egg, 1 cup or similar) instead of 3 eggs or 200 g. The meal is shown and placed with confident but understated calories and protein. I reproduced this with tsx: all three inputs gave amount null and parseAmount {count:1}.
- **Fix:** Have cleanFoods keep whether the model gave an amount. Pass a distinct 'unreadable' state for a screened-out amount so groundFood leaves the food out ('Couldn't read the amount'). Or extract the leading quantity and unit from long amounts before applying the length cap.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A043 — Unicode fraction amounts in an uploaded meal plan are corrupted into wrong quantities
- **Where:** `lib/plan/document-clean.ts:16`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** cleanAmount runs NFKC normalization before its character whitelist. NFKC turns a vulgar fraction such as ½ into '1' + U+2044 (fraction slash). U+2044 is not in the whitelist, so it is replaced by a space. The amount then reads 'N 2' instead of 'N½'. parseAmount reads that as a count of 1 or 11 household portions. The whitelist even lists ½¼¾⅓⅔, but they never survive the NFKC step.
- **Failure scenario:** A dietitian PDF says '¾ lb chicken breast'. cleanAmount gives '3 4 lb', which parseAmount reads as 3 portions, not 340 g. '1½ cups rice' becomes '11 2 cups', which parseAmount reads as {count:11} (11 usual portions). '½ cup oats' becomes '1 2 cup', which reads as {count:1}. groundDocumentMeal then grounds these wrong gram weights, and 'Use for this meal' writes the wrong calories into the slot via set_slot_meal. I reproduced this with tsx: '½ cup' -> '1 2 cup' -> {count:1}, '1½ cups' -> '11 2 cups' -> {count:11}, '¾ lb' -> '3 4 lb' -> {count:3}. ASCII '1/2 cup' works, so only Unicode fractions are affected.
- **Fix:** Normalize vulgar fractions to ASCII before NFKC (½ -> 1/2, 1½ -> 1 1/2), or map U+2044 to '/', or skip NFKC for the amount and whitelist the characters directly.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A044 — Photo and voice capture replaces the model's total grams with qty x 100 g for 'whole' or 'piece' items that have no matching portion
- **Where:** `lib/capture/quantity.ts:88`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** gramsFor returns qty * 100 g for unit 'whole' or 'piece' whenever no catalog portion description contains that word. Most catalog portions are '1 large', '1 medium' or '1 nugget', so this default fires often. proposeDraft then uses `grams = gramsFor(...) ?? item.grams`, so the model's own visible-weight estimate is discarded. The photo prompt tells the model to give total grams and a piece count.
- **Failure scenario:** A plate photo has 8 shrimp or 6 chicken nuggets, read as qty 8 or 6, unit piece, grams about 120. The catalog portion is '1 nugget' or '1 large'. gramsFor returns 800 g or 600 g, a 5-6x calorie overstatement in the draft. Two eggs with a 'large' portion get 200 g instead of about 100 g. The user may not catch it before commit.
- **Fix:** For whole/piece with no matching portion, keep the model's item.grams (return null from gramsFor). Or use the default only when the model supplied no grams. At minimum, prefer the model estimate when it differs sharply from qty*100.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A155 — TDEE intake ignores ticked plan meals and eaten recipes, but those days still qualify as complete
- **Where:** `lib/server/expenditure.ts:58`
- **Area:** nutrition accuracy; **category:** wrong-number
- **Defect:** The expenditure engine reads a day's intake only from `daily_energy`, which sums `log_entries`/`log_items`. Ticking a planned meal eaten (`saveEatenSlot`, app/page.tsx:542) writes only `plan_days.eaten_slots` and the frozen override. Eating an accepted recipe (`recipe_log_consumed`) writes `plan_days` and the consumed-slot state, not a log entry. Both still count in the phone's ring (`resolveDay` adds eaten-slot macros) and in the coach's day context. The engine then qualifies the day on the logged part alone: at least 1,000 kcal plus item coverage of at least 0.95 before the first mark, or the user's mark after it. `DayCompleteControl.hasLoggedFood` treats a ticked meal as logged food and offers "I logged everything I ate today".
- **Failure scenario:** A user ticks breakfast and lunch from the plan (about 1,200 kcal on Today), logs dinner through search (1,050 kcal, every item measured), and taps "I logged everything I ate today". The ring shows 2,250 kcal. `daily_energy` holds 1,050 kcal with coverage 1.0, so `isQualifiedDay` counts the day at 1,050. This repeats over 14 to 28 days. `observedLong` then reads TDEE about 1,200 kcal/day too low, and `buildProposal` proposes cutting calories for someone who is maintaining. The same happens before any mark, through the coverage rule.
- **Fix:** Count eaten plan slots and consumed recipe snapshots in the server's intake, for example in a view over plan_days that uses the resolveDay counting rule. Otherwise, mark any day with an eaten slot that has no log under it as intake-unknown, so it never qualifies. Also stop offering the day-complete mark on tick-only days.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A156 — Account (Favored/Eats) foods log energy as 4/4/9 from macros, dropping alcohol and measured energy
- **Where:** `lib/log/picked-commit.ts:148`
- **Area:** nutrition accuracy; **category:** wrong-number
- **Defect:** An account food keeps only per-unit protein, carbs and fat; its kcal is "derived, never stored" (lib/foods.ts:15). Every path that logs or plans an account food recomputes energy as `macroKcal(perUnit)` = 4P + 4C + 9F on total carbohydrate. That covers `accountPer100g` and `accountPerUnit` in picked-commit, `perUnitTo100g` in lib/units.ts and the generated plates. This ignores the energy the source measured. Alcoholic drinks lose almost all their energy, and fibre-rich foods are overstated. The same food logged as a bundled pick uses its measured kcal (`per100gFromBundled`), so the number depends on which list the user picked it from.
- **Failure scenario:** A user adds the bundled "Red wine" (85 kcal/100 g measured; 0.07 g protein and 2.6 g carbs, so 4/4/9 gives about 11 kcal) or "Beer" (43 vs 16) to Favored and logs a 150 g glass from their own foods in the Log sheet. The snapshot stores about 16 kcal instead of 128. The ring, coach, export and TDEE intake undercount every such drink by about 85%. Picking the same wine from the bundled search logs 128 kcal.
- **Fix:** Carry the source's energy per unit on account foods (for example `perUnit.kcal`, or a kcal per 100 g kept from the catalog or bundled row) and use it ahead of Atwater in accountPer100g, accountPerUnit and perUnitTo100g. At minimum, keep the measured energy for foods that have a catalogFoodId or a bundled source.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Medium / feature accuracy (8)

#### A003 — Maintain/recomp account with an adaptive or proposal revision never switches to standard protein when kidney disease is added
- **Where:** `lib/server/target-recompute.ts:290`
- **Area:** feature accuracy; **category:** safety-rule
- **Defect:** The owner decision says kidney disease means standard protein (0.8 g/kg), and a conditions write re-derives at once. The re-derive only reaches a held account in two cases. Case one is the neutralise branch (lines 264-271), which needs hasPace(active) or a paced future revision. Case two is the normal derive branch, which first skips any active revision whose formula_name is not 'profile-energy-v1' (lines 290-293). Adaptive revisions are written as 'adaptive-expenditure-v1' by approve_target_proposal.
- **Failure scenario:** A recomp or maintain user (pace is always 0) approves a weekly proposal, so the active revision is formula 'adaptive-expenditure-v1' with 2.0 g/kg protein. She then adds 'kidney disease' in Foods > Avoids. recomputeAfterHoldChange runs, hasPace(active) is false, and the formula check returns 'authoritative_formula'. The protein target stays at the high-protein number. buildProposal keeps the authored protein (lib/proposal.ts:129), so every later proposal keeps it too.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A031 — Offline barcode match replays a stale cached policy verdict for up to 30 days
- **Where:** `lib/barcode/client.ts:171`
- **Area:** feature accuracy; **category:** safety-rule
- **Defect:** offlineMatch rebuilds a BarcodeMatch from the IndexedDB cache using cached.policy, the allowed/blocked/unverified verdict computed on the server under the rules at the time of the original scan. The cache is kept for SCAN_CACHE_RETENTION_DAYS = 30. Nothing re-evaluates it against the account's current allergens, Avoid marks, categories or conditions.
- **Failure scenario:** A user scans a granola bar while online and it is 'allowed'. Later she adds a peanut allergy or marks the brand Avoid. Offline, she rescans the same bar. offlineMatch returns the old 'allowed' verdict and allergenTags, so the confirm sheet shows no warning for a product that now conflicts with her rules. The commit is queued offline and never gets a server `flagged` mark (see the next finding).
- **Fix:** Stamp the cached policy with the rules epoch and use it only when the epoch is unchanged; otherwise fall back to 'unverified'. Or re-run evaluatePolicy on-device from cached allergen tags and the current profile.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A046 — Prepared-batch reuse picks a later row of an old batch, so the preview throws when it crosses the 2-day storage window
- **Where:** `lib/shopping/planner.ts:284`
- **Area:** feature accuracy; **category:** crash / wrong result
- **Defect:** When planShoppingPeriod() decides whether a slot joins an existing prepared batch, chosen.find() returns the first row of the same recipe revision that passes its own check (currentDay - row.localDate <= 2). It does not look at the batch's first day. A later row of a batch that started more than 2 days earlier can match, and the new slot then takes that batch's batchId. aggregateShopping() measures against group[0] (the batch's first day), so it throws, and the SQL accept would reject it as 'batch storage window exceeded'.
- **Failure scenario:** One person, a recipe with 4 servings that fits a slot at fraction 1, chosen on 4 consecutive days (variety 'repeat_friendly' or 'balanced'). Days 1-3 join one batch. For day 4, find() skips day 1 (3 days away) but matches day 2 (2 days away), and the servings sum 3+1=4 <= 4 passes. Day 4 gets the same batchId, and the next aggregateShopping() throws RangeError 'A prepared batch cannot cross its storage window'. The error is not an HttpError, so POST /api/shopping/preview answers 500. I reproduced it with four daily slots and one candidate recipe.
- **Fix:** Judge the whole batch: find the batch's first (earliest) row and require currentDay - firstDay <= 2 (and the same shopping window) before reuse. Otherwise start a new batchId. Do the check per batchId, not per row.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A047 — A withdrawn recipe held by an accepted slot fails the entire shopping preview with 410 instead of blocking that slot
- **Where:** `lib/server/recipe-plan.ts:246`
- **Area:** feature accuracy; **category:** wrong result / error handling
- **Defect:** For an accepted (kept) slot, previewShopping() looks for the recipe revision in the loaded candidates, which hold published recipes only. When it is missing, it falls back to keptRecipe(), which calls loadRecipeDetail() and then getCatalogRecipe(). getCatalogRecipe throws HttpError 410 'recipe_withdrawn' for a withdrawn root. Nothing catches it. The intended per-slot message ('changed in the recipe catalog. Choose that meal again') only appears when the root is superseded and not withdrawn.
- **Failure scenario:** A user accepted a recipe for Wednesday dinner. The recipe is later withdrawn (for example for a rights reason). Any shopping preview whose period covers that date now answers 410 'This recipe is no longer available for new plans.' for the whole period. It names no slot or date, and the user has no way to learn which meal to change. Preview, accept and the shopping list for the period are all unreachable.
- **Fix:** In keptRecipe, read the pinned revision with getPinnedRecipeRevisions (as acceptedSelectionRuleMarks does) or catch the 410. A withdrawn or changed revision then reaches the existing keptBlocked message for that slot.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A048 — Photo-confirmed pantry items (null food ref and null FoodDB id) crash every shopping preview
- **Where:** `lib/shopping/planner.ts:170`
- **Area:** feature accuracy; **category:** crash / broken feature
- **Defect:** The pantry-photo confirm path stores pantry rows whose identity is {foodRefId:null, foodDbId:null, ...}. The pantry and line validators accept that shape, but identityKey() throws a plain Error for it. replenishmentByWindow() calls identityKey(item.identity) for every pantry row of the user, before it checks confirmedGrams. aggregateShopping() also calls identityKey on every pantry row with grams above 0.
- **Failure scenario:** A user confirms one pantry photo item such as 'carrots' with null grams (the route allows this). Any later POST /api/shopping/preview that picks at least one recipe reaches replenishmentByWindow and throws 'Shopping identity needs a food ref or bundled FoodDB ID'. This is not an HttpError, so the route answers 500. The account's whole shopping planner stays broken until the row is deleted. I reproduced it with planShoppingPeriod and a single pantry row with that identity. With grams above 0, aggregateShopping throws in the same way. Manual PUT /api/shopping/pantry and POST lines with origin 'plan' and a null/null identity (lineFields.identity is nullable, and priorByIdentity calls identityKey(line.identity!)) trigger the same crash.
- **Fix:** Make identityKey tolerant: key a null/null identity by purchaseState and variantKey (or by a 'text:<variantKey>' form), or skip rows with no ref when matching recipes. Also add the same refine to the pantry and line identity schemas where a ref is required. Catch non-HttpError planner errors so they do not return 500.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A061 — Quick meals (Floor Day) toggle changes nothing about the day and removes Swap from every meal card
- **Where:** `lib/resolve.ts:238`
- **Area:** feature accuracy; **category:** spec-mismatch
- **Defect:** resolveDay only copies stored.floorDay into ResolvedDay.isFloorDay. No code path swaps slots to a quick-meal template any more. The Day type menu still offers a 'Quick meals / Three simple backup meals for this date' checkbox, and Today shows a 'Quick meals on. Three simple backup meals.' banner. Today also treats isFloorDay as a reason to hide Swap.
- **Failure scenario:** The user opens the Day type menu, ticks Quick meals and sees the banner. The day still shows the same 4 generated meals at full targets. app/page.tsx:1064-1066 sets canSwap = !resolved.isFloorDay && ..., and app/page.tsx:892 hides onSwap in the edit sheet, so Swap disappears from every meal card until Quick meals is turned off. Reproduced with a vitest snippet: floorDay:true gives isFloorDay true, the same 4 meal names, and the same 2100 kcal target. features.md F-008 says tapping Floor Day replaces every slot with the floor template, and that is false. Phase 9 spec section 2.4 says 'Floor Day is unchanged' and that the resolver uses floor meals as before. That is no longer true after the generator rewrite. No owner ruling accepts the no-op.
- **Fix:** Either implement quick meals in resolveDay (generate three small plates from the account's admitted foods at the floor share) or remove the Quick meals control, the banner and the !isFloorDay Swap gate until it is built.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A089 — Settings 'Edit profile' logs a fabricated weigh-in at the stale profile weight
- **Where:** `lib/profile/onboarding-client.ts:270`
- **Area:** feature accuracy; **category:** data-integrity
- **Defect:** persistCompletedOnboarding saves a weigh-in whenever `settings.weightKg !== base.weightKg || !deps.hasWeighIn(localDate)`. hasWeighIn only checks the local store day's weightLb for today. Settings > Edit profile (AppProfileCard -> OnboardingFlow) re-runs this function for an already-onboarded account. Its weight field is seeded from user_settings.weight_kg, which weigh-ins never update.
- **Failure scenario:** An account onboarded at 70 kg and now weighing 66 kg (daily weigh-ins up to yesterday) opens Edit profile to change only its goal. It has no weigh-in today, so saveMorningWeight(today, 70 kg) runs. A fake weigh-in for today is written to the server. latestWeighInKg then picks it as the newest sample, so the new target revision is derived at 70 kg with weight_source 'weigh-in'. The server recompute keeps that weight (weighInKgToKeep) until the next real weigh-in, so calories, protein and the water goal come out wrong and the weight/expenditure history gets a bogus point. An Oura/Health reading from earlier today does not count as a weigh-in for hasWeighIn.
- **Fix:** Only log a weigh-in when the typed weight differs from the profile weight, or when the account has no weigh-in at all. Never write one for an unchanged value on an already-onboarded account (base.onboardedAt set).
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A091 — Completing the Today invite / Finish profile silently opens the open food world for an existing account
- **Where:** `lib/profile/onboarding-client.ts:294`
- **Area:** feature accuracy; **category:** spec-mismatch
- **Defect:** persistCompletedOnboarding calls openFoodWorld whenever `!base.onboardedAt && conditions.length === 0`. Grandfathered (disposition 'invite') accounts have no onboarded_at either, and they reach this path through the Today invite or Settings 'Finish profile'. They get the onboarding_default open intent, and the DB trigger stamps food_world_default_due_at on their first onboarded_at write. Decision Q5 says other existing accounts are invited only after the safety and plausibility gates pass, and opt in. The first-client hold (OPEN_WORLD_HOLD_USER_IDS) is the only server-side guard.
- **Failure scenario:** Once OPEN_WORLD_ENABLED is on, a pre-cutover account that taps 'Set up' on the Today invite is switched to the open world with no invitation or consent. Its Eats become Favored and suggestions widen to the universe.
- **Fix:** Open by default only for a brand-new account (disposition was 'force', not 'invite'), e.g. gate on first_opened_at after ONBOARDING_CUTOVER; leave existing accounts to the invitation flow.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

### Medium / AI/tool calling (13)

#### A023 — Plan writes (set_slot_meal, add_slot_item, set_slot_item) never check diet-flag or profile hard rules
- **Where:** `lib/coach/policy.ts:94`
- **Area:** AI/tool calling; **category:** safety-rule
- **Defect:** Grounding a plan item judges it with checkItemWithMarks. That function hard-codes preferenceFlags: [] and never passes profileRules. refusePlanBlocked then refuses only items whose verdict is 'blocked' (allergen, banned category, Avoid, pregnancy/tuna). The account's diet flags (vegetarian, vegan, halal, kosher, no_pork, no_beef, no_shellfish and similar, stored in user_settings.diet_prefs.flags) and its confirmed profile hard rules are read only for log_meal (markLoggedActions), save_recipe (filterRecipeActions) and suggestions. No policy pass reads them for plan writes.
- **Failure scenario:** A vegetarian, halal or no-pork account says 'change my dinner to bacon and eggs for the next two weeks'. Grounding returns verdict 'allowed' with flagged [] for the pork item. refusePlanBlocked keeps the action. The phone's applySetSlotMeal writes it into the plan for up to 31 dates, with no refusal and no mark. The same food would be refused as a recipe ingredient and skipped as a suggestion. This breaks the rule 'a plan never holds a food the account's rules block' (lib/coach/plan-policy.ts header).
- **Fix:** For set_slot_meal, add_slot_item and set_slot_item, run the log_meal evidence-based policy pass (loadSuggestionEvidence with preferenceFlags and profile facets, evaluatePolicy with facetAction 'exclude' and profileRules) after grounding. Treat any non-allowed result as a refusal in refusePlanBlocked.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A024 — Fast-path water, weight and schedule actions ignore the date the user said
- **Where:** `lib/coach/actions/log-water.ts:69`
- **Area:** AI/tool calling; **category:** wrong-result
- **Defect:** The fast-path candidates build the action with no date for log_water and log_weight, and with date: today for shift_schedule. The Jev intent questions have no date or day field at all. A message such as 'I drank 3 cups of water yesterday' or 'move my meals 30 minutes later tomorrow' still passes isFastPathEligible, because it has one number with a unit, so confidence is 1.
- **Failure scenario:** The user types 'I drank 3 cups of water yesterday'. The classifier answers log_water at 0.95 or higher, with ml=720 and argConfidence 1. runFastPath grounds { kind: 'log_water', ml: 720 } with no date. applyLogWater uses actionDate(undefined) and adds 3 cups to today. The card says 'Logging 3 cups'. The same happens for 'I weighed 128 lb yesterday', which overwrites today's weigh-in and can re-derive today's target revision. 'Shift my meals 30 minutes later tomorrow' shifts today's slots. No Gemini turn runs to read the date.
- **Fix:** Take the fast path only when the message has no day word (yesterday, tomorrow, last night, a weekday name or a date). Otherwise return null from the candidate so the model turn reads the date. Or add a date question to the intent set and require it to be 'today'.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A025 — remove_from_eats and remove_from_avoid clear the other list's mark to neutral
- **Where:** `lib/coach/apply-prefs.ts:80`
- **Area:** AI/tool calling; **category:** wrong-result
- **Defect:** All four list kinds go through setFoodMembership(name, status), where status is null for both removals. A removal never checks which list the food is on now. 'Take salmon off my eats list' therefore sets the name's membership to neutral even when the food is on Avoid, and 'remove X from my avoid list' clears an Eats mark. The prompt says 'never invert one', but nothing enforces it.
- **Failure scenario:** The user has peanuts on Avoid, and then says 'take peanuts off my eats list' (the model or the Jev intent picks remove_from_eats). Grounding passes (flagged is [] for remove_from_eats). applyFoodListMark calls setFoodMembership('Peanuts', null). The server RPC set_food_membership clears the Avoid mark across all same-name refs. Peanut foods can then reach plans and suggestions again. The card says only 'Took Peanuts off Favored'. The existing tests assert that this call is made with null.
- **Fix:** In applyFoodListMark, read the current membership for the name. For remove_from_eats, clear only when the status is 'eats'. For remove_from_avoid, clear only when the status is 'avoid'. Otherwise return status 'failed' with a reason such as 'X is not on your Favored list'.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A027 — Fast-path Avoid and Favored marks take a compound food phrase as one food and mark one arbitrary search hit
- **Where:** `lib/server/coach-turn/intent.ts:13`
- **Area:** AI/tool calling; **category:** wrong-result
- **Defect:** foodMentions captures everything between 'add' or 'put' and 'to my eats/avoid list' as one name, so 'add peanuts and shellfish to my avoid list' yields the single name 'peanuts and shellfish'. foodArgs and the list-mark intent treat this as one deterministic argument with confidence 1. groundListMark then searches that string with limit 1, replaces the name with the top hit's catalog name, and applies one mark. A multi-item instruction is silently reduced to one mark on whichever food ranked first.
- **Failure scenario:** The user says 'add peanuts and shellfish to my avoid list'. The fast path (no Gemini) grounds one search hit for 'peanuts and shellfish', for example a shellfish row. It replies 'Adding <that food> to your Avoid list.' and writes one membership. The other food is never added, with no clarification. The user believes both allergens are on Avoid. A second instruction in one message ('...avoid list, and take pork off my eats list') is dropped the same way.
- **Fix:** In foodMentions, return null (use the model path) when the captured name contains ' and ', ',', '&', or a second verb. Or return one name per item and ground them all.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A029 — Compound quantities are read as the first number, so the fast path applies the wrong amount
- **Where:** `lib/coach/intent.ts:66`
- **Area:** AI/tool calling; **category:** wrong-result
- **Defect:** NUMBER_RE and extractNumbers read 'an hour', 'a cup' and '1/2 cup' as separate fixed numbers. 'An hour and a half' becomes 1 hour, 'a cup and a half' becomes 1 cup, '1/2 cup' becomes the numbers '1' and '2 cup', and '1 hour 30 minutes' becomes two numbers. With exactly one unit-bearing number, measuredNumber gives confidence 1. With two, it trusts Jev's which_number pick, but the answer is a sum that no single candidate holds. The fast path still clears the 0.90 argument threshold and applies the action with no model turn.
- **Failure scenario:** 'Push my meals back an hour and a half' extracts [{1, hour}]. confidence is 1, so shift_schedule applies 60 minutes instead of 90. 'Log 1/2 cup of water' extracts '1' (no unit) and '2 cup'. If Jev picks '2 cup' at 0.9 or more, 2 cups (480 ml) are logged instead of half a cup. 'Move meals 1 hour 30 minutes later' makes Jev pick either '1 hour' or '30 minutes', so 60 or 30 minutes are applied instead of 90.
- **Fix:** Detect fractions ('/' between digits), 'and a half', 'half' and adjacent number+unit pairs. In those cases set argConfidence for the amount to 0 so the turn falls to the model, or parse the compound amount deterministically.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A101 — list_coach_messages returns the oldest N messages, not the latest
- **Where:** `lib/mcp/coach-tools.ts:77`
- **Area:** AI/tool calling; **category:** wrong-result
- **Defect:** The tool is described as "newest last, for a review". It orders created_at ascending and applies limit, and with no sinceIso the lower bound is 1970. Once the account has more rows than the limit, the first N rows of all time come back and the recent turns are cut off.
- **Failure scenario:** An account has 300 coach messages and the agent calls list_coach_messages with no arguments. It gets the 50 oldest messages from the start of the account's history and none from this week. A weekly review built on this misses everything recent. Raising limit is capped at 100, so recent turns stay unreachable unless the agent guesses a sinceIso.
- **Fix:** Query descending with the limit, then reverse the result so it reads newest last. If sinceIso is given, keep the oldest-first window from that time.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A103 — MCP set_constraints skips the pace-hold target recompute that the REST route runs
- **Where:** `lib/mcp/coach-tools.ts:55`
- **Area:** AI/tool calling; **category:** safety-rule
- **Defect:** The set_constraints MCP tool calls putProfile directly. PUT /api/constraints follows a successful condition change with recomputeAfterHoldChange, which re-derives targets at 0 pace for pregnant, breastfeeding, eating-disorder, kidney and similar conditions, and restores the stored preset when a hold is removed. The MCP path never does this.
- **Failure scenario:** An agent holding a constraints:write token calls set_constraints with conditions:["pregnant"]. The profile is saved, but the active target revision stays at the old deficit pace until some later settings op or REST edit triggers a recompute. The account keeps a weight-loss calorie target while the rules say a hold applies. The reverse also happens: removing a condition via MCP leaves the 0-pace revision in force.
- **Fix:** In the set_constraints handler, call recomputeAfterHoldChange(ctx.admin, ctx.userId, "mcp") when the result status is ok and args.conditions !== undefined.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A116 — Coach daily and hourly turn budget and the ai_call link ignore OpenRouter-served turns (purpose 'coach-openrouter')
- **Where:** `lib/server/coach.ts:110`
- **Area:** AI/tool calling; **category:** spec-mismatch
- **Defect:** callModel writes the ai_calls row with purpose = payload.purpose. OpenRouter coach turns are built with coachOpenRouterPayload, so their purpose is 'coach-openrouter'. assertTurnBudget counts only purpose = 'coach', and lastAiCallId, which links the assistant message to its ai_calls row, also filters on purpose 'coach'. Turns answered by OpenRouter are therefore invisible to both.
- **Failure scenario:** With COACH_PROVIDER=openrouter, or with Gemini primary falling back to the OpenRouter pin on capacity failure, the 10-per-hour and 60-per-day turn limits (TURNS_PER_HOUR / TURNS_PER_DAY) never count those turns, so a user can send unlimited turns until the spend cap stops them. Separately, finish() calls lastAiCallId(admin, userId, 'coach') for an OpenRouter reply. It returns the most recent older 'coach' ok row (a previous Gemini turn or history synthesis), or a concurrent turn's row, or null. The saved message then carries a wrong ai_call_id and the wrong cost and provenance link.
- **Fix:** Count purposes in ('coach','coach-openrouter') in assertTurnBudget. In lastAiCallId, accept both purposes, or better, have callModel return the ledger row id so no 'latest row' guess is needed.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A128 — Coach plan writes (set_slot_meal / add_slot_item / set_slot_item) skip diet flags, profile hard rules and the human-food check; unverified foods pass
- **Where:** `lib/coach/actions/ground-kit.ts:33`
- **Area:** AI/tool calling; **category:** policy-parity
- **Defect:** groundNamedFood judges every plan-write item with checkItemWithMarks, which calls evaluatePolicy with preferenceFlags: [] and no profileRules (withProfileRules=false). The server then refuses a plan write only when flagged (blocked verdict) is non-empty (refusePlanBlocked). So the diet flags (vegan, kosher, halal, no_pork, ...), confirmed profile hard rules, and the human_food facet are never applied to a plan write, and an 'unverified' verdict is not refused. save_recipe, compose_meal, suggestions, and eligible foods all use the strict suggestionItemsVerdict (flags + profile rules + human_food + fail-closed on unverified). The phone-side apply (applySlot/applySetSlotMeal) does no re-check.
- **Failure scenario:** A vegan or kosher account (flags only, or a confirmed profile rule) tells the coach 'set breakfast to bacon and eggs for the next two weeks'. groundItems returns verdict 'allowed' (no allergen avoided, flags not evaluated), flagged is [], refusePlanBlocked keeps the action, and the phone writes it to 14 plan days. The same request through save_recipe or compose_meal is refused. Likewise a peanut-allergic account with a food that has no allergen evidence gets verdict 'unverified', flagged stays [], and the food is placed in the plan.
- **Fix:** In applyGroundedActionPolicies, run PLAN_WRITE_KINDS actions through the same loadSuggestionEvidence + suggestionItemsVerdict path as filterRecipeActions (refuse any item whose outcome is not 'allowed'), or make refusePlanBlocked consume that verdict.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A130 — Menu photo and uploaded-menu screening ignore the account's diet flags, so a vegetarian/halal/kosher menu pick can carry no warning
- **Where:** `lib/server/plan-menu.ts:28`
- **Area:** AI/tool calling; **category:** policy-parity
- **Defect:** menuVerdict calls evaluatePolicy with no preferenceFlags, and readPolicyProfile only supplies stored user_dietary_profiles rows as profileRules (legacy diet flags in user_settings.diet_prefs.flags are deliberately not synthesized there). The advisory 'check' text is also derived only from avoid_allergens, custom_rules, banned_categories and Avoid ids. screenMenu therefore never blocks or warns for vegan/vegetarian/pescatarian/no_pork/halal/kosher accounts whose rules are the legacy flags.
- **Failure scenario:** A vegetarian account (diet_prefs.flags = ['vegetarian'], no allergens, no banned categories, no stored profile row) photographs a restaurant menu. 'Pork belly' is returned among the three picks with check: null (no rules, no avoid ids -> final branch returns null), blocked: false. The user sees an unqualified recommendation for a food their rule excludes.
- **Fix:** Read the normalized diet flags (recipeFlagsFrom(user_settings.diet_prefs)) and pass them as preferenceFlags to evaluatePolicy in menuVerdict; fail to a 'Check it against your food rules' check when flags exist or the flag read fails.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A134 — Document meal-plan import grounds foods with the weak plan check, so diet-flag/profile-rule violations are placed as 'allowed'
- **Where:** `lib/plan/document-ground.ts:108`
- **Area:** AI/tool calling; **category:** policy-parity
- **Defect:** groundFood relies on groundNamedFood -> checkItemWithMarks and keeps the item whenever verdict === 'allowed'. That verdict ignores preferenceFlags and confirmed profile rules (same root cause as the coach plan writes), so the 'only allowed foods are kept' guarantee in the file header does not hold for diet and religious rules. The matched meal is then placed through set_slot_meal after one tap with no further server check.
- **Failure scenario:** A halal or vegan account uploads a PDF meal plan whose Monday lunch is 'ham sandwich'. Grounding finds the catalog row, allergen evidence is irrelevant, verdict 'allowed'; the meal appears in match.items with left=[] and 'Use for this meal' writes it to the plan.
- **Fix:** Judge document meal items with suggestionItemsVerdict over loadSuggestionEvidence (flags + profile rules + human_food), leaving out anything not 'allowed'.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A158 — set_slot_item rewrites a plan line with the macros of whatever the search returns for the model's short name, not the line's own food
- **Where:** `lib/coach/apply-slot.ts:53`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** set_slot_item is grounded by a fresh catalog search for the model's word (slot-items.ts:131 groundNamedLine -> groundNamedFood -> ports.searchFoods(name, 1)). applySlot then finds the plan line by a name substring (matchIndex) and rebuilds it from the search hit's per-100 g values: completeComponentFromCatalog(current.name, per100g(action), action.grams). The line keeps its own name and role, but takes the energy and macros of a different food. It also loses the line's foodKey. The policy verdict that refusePlanBlocked checks belongs to the search hit too, not to the line.
- **Failure scenario:** Meal 2 holds 'Rice, white, cooked' (150 g, 195 kcal). The user says 'make the rice 200 g'. The model emits set_slot_item { name: 'rice', grams: 200 }, the same short-name form the repo's own action corpus uses (tests/coach/action-golden/corpus.ts:35,96). The top catalog hit for 'rice' is a raw or dry row at 365 kcal/100 g. The plan line, still labelled 'Rice, white, cooked', is saved at 730 kcal instead of about 260, and the day's totals and scaling use that number. A second case: a dairy-free account has a 'Almond milk' line and asks to resize 'milk'. The search returns cow's milk, which is blocked, so refusePlanBlocked refuses a resize of a food that is allowed.
- **Fix:** For set_slot_item, scale the matched line's own macros (current.macros * grams / current.qty when unit is g, or its stored per-gram values) and keep its foodKey. Use grounding only to confirm identity, or ground against the matched line's own food ref. Run the plan policy on the line's food, not on the search hit.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A159 — Coach turn budget counts every model step and history synthesis, so the 10/hour and 60/day turn limits trip after a few turns
- **Where:** `lib/server/coach.ts:110`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** assertTurnBudget treats each ok ai_calls row with purpose 'coach' as one turn. It throws CoachRateLimited at TURNS_PER_HOUR=10 rows in the last hour and TURNS_PER_DAY=60 rows in the last day. But callModel writes one ai_calls row per generate() call. A model turn makes one call per loop round: each tool step, the final step, the refusal-correction or claim-correction retry, and the recall synthesis (all purpose 'coach' via coachTurnPayload). So the limit counts provider steps, not turns, which contradicts the documented 'daily count of successful turns' and '10 an hour and 60 a day' (docs/specs/phase-14-voice-agent.md:77).
- **Failure scenario:** A user asks 'what should I eat for lunch?'. The model calls suggest_options, then sends a final step: 2 rows. A few more ordinary asks need get_entries or search_foods and then a final step, and one needs a claim-correction retry: 2-3 rows each. After about 4 such turns in an hour, the hourly count reaches 10. The 5th turn gets 429 'Too many coach turns', although the user sent only 4 messages. Daily: about 20-30 real turns use up the 60.
- **Fix:** Count turns, not provider calls. For example, count the assistant coach_messages that carry a model_id or ai_call_id in the window. Or stamp each ai_calls row with the turn's messageId and count distinct ones.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Medium / determinism (4)

#### A014 — Oura sleep, resting HR, HRV and readiness are bucketed by UTC day, not the user's day
- **Where:** `lib/oura/map.ts:38`
- **Area:** determinism; **category:** correctness
- **Defect:** ouraSleepToSamples (and the readiness timestamp path) stamp real instants with tz DEFAULT_TZ ('UTC'). mergedDays buckets each sample with localDateOf(start_time, sample.tz), so a sleep period that starts at 23:00 local in UTC+1 or later zones lands on the previous calendar day of wake time. The code comment says UTC is only for synthetic day windows, not real instants, and the Oura bedtime_start string carries the real offset.
- **Failure scenario:** A user in Berlin or Tokyo sleeps 23:00 to 07:00 local. Oura sleep, lowest_heart_rate and average_hrv are filed under the day BEFORE the wake day. HAE sleep for the same night is bucketed by the user's zone (also the start day), so Oura and Apple data disagree on which day a night belongs to. The Today and Body cards then show last night's sleep, RHR and HRV one day stale or on the wrong date. Because the Oura sleep winner replaces Apple's, a user with both gets the wrong day's number.
- **Fix:** Take the zone/offset from the Oura bedtime_start string (or the account's stored time_zone) when mapping sleep-derived samples, and bucket sleep by wake day as Oura's `day` field does.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A054 — Targets sheet dates a manual revision by the UTC day, not the phone's local day
- **Where:** `components/TargetModeSheet.tsx:53`
- **Area:** determinism; **category:** duplicated-date-rule
- **Defect:** TargetModeSheet builds effectiveFrom with new Date().toISOString().slice(0, 10), which is the UTC date. Every other target writer uses the phone's local day (todayIso() / targetDayFor() in lib/settings/date.ts and lib/targets/revision.ts). lib/server/targets.ts says the server dates a revision by the day the phone sends, and authorTargets stores it as effective_from without change.
- **Failure scenario:** A user in US Pacific time saves grams or percent targets at 6 pm local on 10 Oct. UTC is already 11 Oct, so the revision gets effective_from = 11 Oct. Per AGENTS.md, a future-dated revision waits in the history, so today keeps the old numbers and the save looks ignored until tomorrow. A user east of UTC saving in the morning gets yesterday's UTC date. That backdates the revision and rewrites the target of the day before, which is already in the past.
- **Fix:** Use todayIso() from @/lib/settings/date, or targetDayFor() from @/lib/targets/revision, instead of the toISOString slice.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A069 — Meal cards keep their draft state across date switches: ingredient edits and the preview carry onto another day, and Save writes them to that day
- **Where:** `app/page.tsx:1074`
- **Area:** determinism; **category:** stale-state-date-switch
- **Defect:** The Today stack keys each card by `item.key`, which `mergeTimeline` builds as `slot-${slot.slot}`. The key has no date. When the viewed date changes, the same `SlotCard` instances stay mounted. All their local state is kept: `previewMacros` in SlotCard, `expanded` in useMealDetail, and `working`, `dirty`, `removed` and `saveError` in `Ingredients` (SlotCardDetail). While `dirty`, `Ingredients` shows `working` instead of the new day's `components`. The Save handler is `saveSlotEdit(slot.slot, components)`, which reads `viewedDate` at call time.
- **Failure scenario:** Expand Meal 1 on Monday and step an ingredient up or remove one, without saving (the 'Save ingredients' button is showing). Swipe to Tuesday. Tuesday's Meal 1 card still shows Monday's edited ingredient list and the preview kcal, because `shown = dirty ? working : components`. Tapping 'Save ingredients' calls `saveSlotEdit` with `viewedDate = Tuesday`. That writes Monday's component list as Tuesday's item override, so the wrong foods and calories land on Tuesday and Tuesday's own plan is lost. Even without Save, the card shows the wrong calories for the new date.
- **Fix:** Include the date in the card key: use `${viewedDate}:${item.key}` in the `SlotCardEnter` key, or pass a date key into `SlotCard`. That remounts the card and resets its local state. Also reset `previewMacros` and the Ingredients draft when `date` changes.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A167 — Server day context picks the cached target by the server's UTC date, so east-of-UTC accounts lose their meal layout on the morning a revision is dated
- **Where:** `lib/server/day-context.ts:294`
- **Area:** determinism; **category:** dates-tz
- **Defect:** serverStoreFor calls settingsWithTargetRevision(baseSettings, targets.revision) with no `today`. The default is todayIso(), which is the server process's local date, and Vercel runs in UTC. activeTargets(admin, userId, date) correctly returns the revision in force on the viewed date. But when that revision's effectiveFrom is later than the server's UTC date, withTargetHistory finds nothing in force on that 'today' and returns activeTargetProfile = null. The history still holds the revision, so resolveTargets(date) still finds the day's macros. mealCountFor/slotListFor/resolveSlotTimes read settings.activeTargetProfile instead, so the server falls back to the 3-meal layout whenever mealsPerDay is unset.
- **Failure scenario:** Pacific/Auckland account, no meals_per_day set, training 2400 / rest 2100 kcal; the phone shows 4 meals at 08:00, 11:30, 15:00 and 18:30. At 09:00 NZDT on 2026-10-11 (2026-10-10T20:00Z) the user weighs in, which writes a revision dated 2026-10-11. Until 13:00 NZDT, every buildDayContext for 2026-10-11 (coach turn, compose_meal, suggest_options, Plan-sheet ideas, preview_skip) resolves only meal-1@08:00, meal-2@12:30 and meal-3@18:30. Each open slot is sized to one third of the day instead of one quarter: about 700 instead of 525 kcal on a rest day. composeTarget/suggestionTarget for meal-4 find no named slot and fall to remainingMealShare over 3 slots. previewSkip refuses meal-4 because plannedSlotIds lacks it. meal-3 reads as dinner (18:30) on the server but as a snack (15:00) on the phone. The same happens on onboarding day and for Asia/Kolkata before 05:30 IST. This is distinct from the known lib/plan.ts:55 finding (the phone using today's cache for other dates): here the server's cache is wrong even for the account's own today.
- **Fix:** In serverStoreFor, pass the viewed date as `today`: settingsWithTargetRevision(baseSettings, targets.revision, date). This makes the cache the revision in force on that date, so the meal count and slot clocks match what the phone shows for that day.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Medium / sync (7)

#### A039 — Phone membership cache makes a repeat tap a no-op after a server-side Favor or a mark from another device
- **Where:** `lib/foods/prefs-client.ts:332`
- **Area:** sync; **category:** correctness
- **Defect:** setFoodMembership decides 'unchanged' from the device-local membership cache (readFoodMembership, localStorage). The cache is written only by this device's own marks. Nothing updates it from a sync pull or from POST /api/foods/favor, which writes the server membership row and prefs directly. When the cache holds {status:null} or the same status as the requested one but the server now differs, the call returns without queuing an op.
- **Failure scenario:** The user clears 'Kiwi', so the cache holds {status:null, rev:R}. They then tap Favor on 'Kiwi' in Eaten often. The server sets membership 'eats' and the next sync projects it. The cache still says null. In Foods the user taps to remove Kiwi from Favored, calling setFoodMembership('Kiwi', null). `previous?.status === status` is true (null === null), so the function returns null and queues no op. The local row goes neutral, but the server stays 'eats'. The next pull restores Favored and the removal is lost. The same happens when another device set the mark.
- **Fix:** Update the cache on a pull of user_food_prefs and on a successful favor. Alternatively drop the 'unchanged' shortcut unless the cache entry was confirmed by a server answer, or compare against the live local food row.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A076 — A whole-batch 4xx (including 401) charges every op in the batch an error attempt, so valid ops get parked for a year
- **Where:** `lib/sync/outbox.ts:374`
- **Area:** sync; **category:** op parking / collateral loss
- **Defect:** isClientFault treats every 4xx except 408 and 429 as the op's own fault. When /api/sync/ops rejects the whole request, parkOrRetry runs on every op in `due`. A single schema-invalid op in the first 200 (zod rejects the entire body), an expired or lapsed session (401), or a 403 or 404 all park the entire batch after 3 passes.
- **Failure scenario:** The session cookie lapses after the phone was offline. Three back-to-back passes (online event, visibility change, debounce) get 401. All up to 200 queued ops, valid ones included, reach error_attempts=3 and next_attempt_at = now + 1 year. They stay unsent until the user finds and taps 'Sync now' (the only caller of retryParked, SyncStatus.tsx:161). The same happens to every valid op sharing a batch with one malformed op.
- **Fix:** Treat 401/403 as transport-like (back off without spending the error budget). For other 4xx, bisect the batch or retry the ops singly so only the offending op is charged.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A078 — Re-starring a favorite after it was unstarred and synced is silently dropped
- **Where:** `lib/sync/merge.ts:59`
- **Area:** sync; **category:** data-loss / conflict handling
- **Defect:** A server delete writes change_log.current = null, so the next pull does deleteRow on the local tombstone (client.ts:278). Starring the same food again then takes the create path (favorites-client.ts toggleAs: row missing -> create, base_rev null). The server answers 'conflict' because the tombstoned row still exists. onConflict merges with settle(), where a tombstone on either side always dominates (merge.ts:59), and the rebased op is an 'update'. apply_sync_op answers 'deleted' for any non-restore op on a tombstoned row, and the client then deleteRow's the entry. The user's new star is discarded without any signal.
- **Failure scenario:** Star a food and sync. Unstar it and sync (pass N pushes the delete, pass N+1's pull removes the local tombstone). Star the same food again. The create op conflicts and is merged into a tombstoned update, the server returns 'deleted', and the mirror row is removed. The food shows as unstarred on every device, and the second tap is lost. I ran mergeEntity('favorites_foods', local{deleted_at:null, sort:2}, server{deleted_at:'...'}) and it returned deleted_at set (the server's tombstone). The _sync_upsert favorites branches never clear deleted_at, so no update could revive it either. No test covers re-star after a pull (tests/favorites/favorites-client.test.ts).
- **Fix:** In onConflict, when the op is a create/update and the server row is tombstoned, rebase it as a 'restore' (or have the client always use restore after a conflict on a tombstoned favorite). Alternatively keep the tombstone in the mirror on pull instead of deleting it, so toggleAs uses the restore path.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A079 — Per-entity ordering is not enforced: a delete can run before a backed-off create, which then resurrects the deleted row
- **Where:** `lib/sync/outbox.ts:360`
- **Area:** sync; **category:** out-of-order apply
- **Defect:** drainOutbox selects due ops with only `next_attempt_at <= at` and has no per-entity barrier. If a create or update got an 'error' result and is backing off, a later delete of the same entity_id is due and is sent alone. The server answers 'gone' because the row was never created. onGone then deleteRow's the mirror and deleteOp's the delete (outbox.ts:329-334). When the backed-off create is retried it applies, and applyApplied writes the row back.
- **Failure scenario:** Create op for a user_food or favorite gets an error result (transient RPC exception, backoff 1-2 s). The user deletes the item in that window. The delete drains alone and returns 'gone', so the op is dropped. The create then lands: the item the user deleted exists on the server, on every device, and in the local mirror again.
- **Fix:** When selecting ops, skip any op whose entity_id has an earlier-seq op that is not being sent in this batch (backoff, parked or in flight). Alternatively coalesce a delete into a pending create by cancelling both.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A138 — Applying an older op result overwrites newer optimistic mirror edits (lost water cup, UI regress)
- **Where:** `lib/sync/outbox.ts:275`
- **Area:** sync; **category:** sync-merge / race
- **Defect:** applyApplied for create/update does putRow({...local, ...op.payload, rev: result.rev}). It does not check whether a newer op for the same entity is still queued. The mirror already holds that newer op's optimistic payload, and the older payload is written over it.
- **Failure scenario:** Water at 4 cups. Tap 1 queues op1 (cups 5) and a pass sends it. Tap 2 during the round trip sets the mirror to 6 and queues op2 with base_rev r+1. op1's 'applied' arrives and putRow rewrites the mirror to cups 5, rev r+1. Tap 3 reads current=5 in writeCupsNow and writes 6, not 7. The server ends at 6 after three taps from 4: one cup is lost and the tile visibly drops back. Other whole-row mirror users (plan_days, favorites sort, user_foods) regress the same way until their pending op lands.
- **Fix:** In applyApplied, if any queued op for the same entity and id remains (other than the one just settled), update only rev, or merge the result under that pending payload. Alternatively, recompute the mirror as the server row plus pending payloads.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A141 — plan_days conflict handling loses edits: whole-field newer-wins on full-row payloads, optimistic-rev aliasing, no legacy-store projection
- **Where:** `lib/sync/merge.ts:128`
- **Area:** sync; **category:** sync-merge / data-loss
- **Defect:** Every plan_days op carries all five plan fields from the legacy store, with a base_rev taken from the mirror's optimistic rev+1. On conflict, mergeEntity runs newerWinsFields over those fields, comparing the device client_ts with the server updated_at. swaps, slot_notes and item_overrides are replaced whole, with no per-slot merge, and the fields the user did not touch count as 'defined' on both sides. The merged result is written only to the IDB mirror and the rebased op. The legacy store that Today renders is not re-projected. applyPulledPlanDay also skips every pulled change while an op is pending for that date.
- **Failure scenario:** (1) Device A offline sets floor_day=true and swaps meal-1 at 10:00. Device B sets swaps meal-2 at 10:05. On reconnect A's pull of B's change is skipped (op pending), then A's op conflicts. The server row is newer, so the server's swaps and floor_day win. A's floor_day and meal-1 swap are discarded, the mirror shows B's values, and A's Today still shows its own local values. (2) Two queued ops op1 (base r) and op2 (base r+1, the optimistic rev) while a remote device moved the server to r+1: op1 conflicts, but op2's base_rev matches the remote's revision by coincidence and applies from stale mirror data, silently overwriting the remote swaps and eaten ticks. The rebased op1' gets client_ts=now and a fresh tail seq, so it then reapplies its older content over op2's newer intent.
- **Fix:** Send only the changed plan fields (omit/keep is already supported server-side) and merge swaps/slot_notes/item_overrides per slot. Coalesce successive plan_days ops, or rebase every queued op for the entity on a conflict. After a plan_days conflict or applied settle, re-project the merged row into the legacy store.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A165 — Chained log-entry ops aimed at speculative revs overwrite another device's edit (a coach move is silently reverted)
- **Where:** `lib/log-note-client.ts:36`
- **Area:** sync; **category:** lost-update
- **Defect:** A second note edit (and coach move_entry or delete_entry, lib/coach/apply-entries.ts:166) on an entry with a queued op builds its op from the pending op's payload, with base_rev = pending.base_rev + 1, a rev the server only reaches if the first op applies. Both ops go out in one /api/sync/ops batch in seq order. If another device wrote the entry in between, the first op answers 'conflict' and its rebase (log-entry-ops.ts:123) keeps it queued. The second op's base_rev then equals the OTHER device's revision, so apply_sync_op's compare-and-swap passes and writes the phone's stale whole row (local_date, slot, eaten_at, items from rev 2) over the other device's write.
- **Failure scenario:** The phone is offline and the user types a note on an entry twice: N1 (base 2), then N2 (base 3, payload = N1's row plus the new note). Meanwhile on the tablet the coach moves that entry from 2026-10-09 dinner to 2026-10-10 lunch (server rev 3). The phone comes online and sends [N1, N2]. N1 conflicts with rev 3. N2's base 3 matches, so it applies and rewrites local_date 2026-10-09 and slot dinner. The move is silently undone on the server and on every device, and the meal's calories count on the wrong day. N1's later rebases then join notes onto N2's text, so text the user replaced comes back.
- **Fix:** Never let an op aim at a rev only its own predecessor can produce. Either coalesce successive note, move and delete edits into the single pending op for the entry (the user_settings model), or make the drain send at most one op per (entity, entity_id) per batch. When an op for a key answers conflict, rebase every later queued op for that key onto the server's row before sending it.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Medium / security (4)

#### A053 — Oura callback is an unauthenticated open redirect
- **Where:** `lib/health/oura-return.ts:17`
- **Area:** security; **category:** open-redirect
- **Defect:** The callback decodes the return path from the unverified `state` query value, and `safeReturnTo` returns `url.pathname + search + hash`. The WHATWG URL parser keeps a dot-segment path such as `/.//evil.com/x` as the pathname `//evil.com/x`. `app/api/health/oura/callback/route.ts` `back()` then runs `new URL(oauthReturnTo(state, origin), origin)`, which reads `//evil.com/x` as a protocol-relative URL and moves the host to evil.com.
- **Failure scenario:** An attacker builds `/api/health/oura/callback?error=1&state=x.<base64url('/.//evil.com/p')>` and sends it to a victim. No session is needed, because every path through `back()` decodes the state without checking it against `oauth_states`. The victim is sent a 302 to https://evil.com/p?oura=error&reason=denied from the app's own domain, which makes a convincing phishing link. A signed-in user can also reach this through POST /api/health/oura/start with `returnTo` set to `/.//evil.com`, because `safeReturnTo` accepts it.
- **Fix:** In `safeReturnTo`, reject any normalized pathname that starts with `//`, or return a value that is not re-parsed against the origin. Have `back()` apply `startsWith('/') && !startsWith('//')` to the result, and read `returnTo` only from a verified `oauth_states` row.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A055 — Storage policy lets users upload to the media bucket without a media_objects row, so the sweep and sign limits are bypassed
- **Where:** `supabase/migrations/20260920090100_phase4_media_bucket.sql:13`
- **Area:** security; **category:** upload-abuse
- **Defect:** The `media_own_folder` policy grants `for all to authenticated` on any object under the user's own `<uid>/` folder. The server design assumes every upload goes through POST /api/media/sign, which inserts a `media_objects` row, enforces 30 signs per minute and issues the object name. A client with its own JWT can call the Storage API directly and upload objects with any name. These objects have no `media_objects` row, so the daily media-sweep never lists or deletes them. The sign limit does not apply either.
- **Failure scenario:** A signed-in user loops direct Storage uploads of 8 MB JPEGs to `media/<uid>/<random>.jpg`. Each object is permanent, because the sweep only iterates `media_objects` rows (media-sweep route lines 71-76). Storage cost grows without limit and the sign rate limit never trips. Paths that read the object without checking for a row (transcribe, plan-inspire, plan-document, pantry-photo) will also accept such an object.
- **Fix:** Remove insert and update from the authenticated policy, leaving select and delete. Uploads should go only through the service-issued signed upload URL. Optionally have the sweep also list the bucket and delete objects with no row.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A068 — Authenticated users can write target_profiles directly, bypassing every server-side safety floor and pace hold
- **Where:** `supabase/migrations/20260911000500_rls.sql:11`
- **Area:** security; **category:** security-tenancy
- **Defect:** target_profiles is a pattern-1 owner table. Its policy target_profiles_rw is FOR ALL and the table is granted select, insert, update and delete to authenticated. Migration 20261006090100 tightened expenditure_estimates and target_proposals but states that target_profiles 'keeps its _rw policy'. No later migration revokes the DML grant or adds a guard trigger. The only trigger on the table is recipe_state_targets, which just bumps recipe state. Migration 20261228090000 revokes EXECUTE on write_target_revision, write_target_revision_if_active, write_target_revision_pair and approve_target_proposal from authenticated. It describes the hole it closes as a signed-in user writing any revision and skipping the adult floor, the pregnancy, kidney, eating-disorder and clinician pace holds, the pace caps and the kcal floors. That fix is moot while the table itself accepts the same rows over PostgREST.
- **Failure scenario:** A signed-in account in a pace-hold profile (pregnant, eating disorder, or under 18 by stored birth year) sends POST /rest/v1/target_profiles with its own user_id, effective_from = today, rev above the current one, kcal_train = kcal_rest = 900, goal_rate_bp_week = -100, authored_by = 'user', mode = 'grams' and the required gram columns. The only guards are the table check constraints, which do not cover a kcal floor, an age rule or a pace hold. The row becomes the latest effective revision. Every reader that trusts the server revision then uses it: Today, the coach, the plan generator, care points, and the expenditure engine's profile reads. lib/server/targets.ts and lib/server/proposals.ts never see the write, and the comment at lib/server/proposals.ts:70 saying the eligibility check 'cannot be skipped' is false.
- **Fix:** New migration: drop target_profiles_rw and create a select-only policy for authenticated, then revoke insert, update and delete on target_profiles from authenticated, as 20261006090100 already did for target_proposals. Every app write already goes through the service-role target-writes.ts. Update the tenancy table-ops matrix and add a canary test that a direct authenticated insert is refused.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** docs/audit/specs/2026-09-22-phase-12-r14-gpt6-sol.md finding 2 (BLOCK on target_profiles table grants); never fixed at table level. No owner ruling accepts it.

#### A097 — Direct PostgREST writes to target_profiles (and user_settings) still bypass every server target safety rule
- **Where:** `supabase/migrations/20261228090000_target_writes_service_role_only.sql:28`
- **Area:** security; **category:** safety-rule / authorization
- **Defect:** The 2026-12-28 migration closes the SECURITY DEFINER target writers (write_target_revision*, approve_target_proposal) to service_role. It leaves the table itself writable by every signed-in user. The Phase 0 RLS pattern 'for all ... grant select, insert, update, delete ... to authenticated' still covers target_profiles and user_settings, and no later migration revokes it. The phase 6 migration even documents that target_profiles 'keeps its _rw policy'. The adult floor, the pregnant/kidney/eating-disorder/clinician pace holds, the under-18 refusal, the pace caps and the kcal/protein/fat floors live only in lib/server/targets.ts, lib/server/target-eligibility.ts and proposals.ts. A direct table write skips all of them. Because the age gate reads the STORED user_settings.birth_year, a direct update of that column also lifts it.
- **Failure scenario:** A signed-in account (for example one flagged pregnant, or one whose stored birth_year makes it under 18) sends POST /rest/v1/target_profiles with its own JWT and a row of kcal_train=900 and effective_from=today. RLS accepts it because user_id equals auth.uid(). No trigger or CHECK enforces floors or holds. activeProfile() then returns that row as the latest effective revision. Today, the coach and the plan resolution all use 900 kcal with a 0-floor. The same account can PATCH user_settings.birth_year to 1990 and so defeat the adult_only gate. tests/tenancy/table-ops.json:56 lists insert/update/delete on target_profiles as an expected, allowed op, so the hole is codified, not accidental.
- **Fix:** Revoke insert, update and delete on public.target_profiles from authenticated and keep select only. Drop or narrow target_profiles_rw to a select policy, as was done for expenditure_estimates and target_proposals. Add a BEFORE INSERT/UPDATE guard on user_settings for birth_year and the other floor and hold inputs, or route those columns through service-role-only writers. Update tests/tenancy/table-ops.json.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** docs/audit/specs/2026-09-22-phase-12-r14-gpt6-sol.md BLOCK #2 (raised, not fixed or ruled)

### Medium / DB (2)

#### A075 — Approved weekly proposal is dated to the week_start Monday, which is in the past and can be shadowed by a newer revision
- **Where:** `supabase/migrations/20261023090500_approve_proposal_via_revision.sql:37`
- **Area:** DB; **category:** effective-from
- **Defect:** approve_target_proposal writes `effective_from = coalesce(v_prop.week_start, current_date)`. Since the job moved to weekJustEnding, week_start is the Monday of the week that already ended (7-13 days before the Monday-UTC cron fire). It is not the approval day. The target picker orders by `effective_from desc, rev desc`. The function's baseline v_active is also read with `current_date`, the UTC date, not the account day.
- **Failure scenario:** A proposal is created for week_start Oct 5. On Oct 8 a weigh-in or profile edit makes the server recompute and write a revision effective Oct 8 (recompute dates by the account day). On Oct 12 the user taps Approve and gets 'approved', but the new Oct 5 row is older than the Oct 8 row, so the old numbers stay in force and the approval is silently inert. With no later revision, the approval rewrites targets for the past week's days, so already-lived days show a different target and on-plan status. The 2026-09-13 audit judged this harmless because it only saw the stale-grams angle, not the inert approval.
- **Fix:** Have approval date the revision by the account's day (pass `day.date` from decideProposal to the RPC) instead of week_start, and read v_active as of that date.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** 2026-09-13 audit judged the stale-grams angle harmless (findings-full.json); the inert-approval and past-dating angles were not covered

#### A162 — Cross-account deadlock: a first catalog food_ref mint locks every account's recipe_plan_state row and then evidence_clock, but barcode upsert and Favor take evidence_clock first
- **Where:** `supabase/migrations/20261202090000_scope_recipe_food_ref_clock.sql:15`
- **Area:** DB; **category:** deadlock
- **Defect:** Inserting a catalog food_ref fires the row-level AFTER trigger recipe_state_food_refs, which runs `update recipe_plan_state set rev = rev + 1 where user_id is not null`. That locks the clock row of every account. Only after that does the statement-level evidence_clock_food_refs_ins trigger lock the global evidence_clock row (20261213091100:6). Two other paths take these locks in the opposite order. (1) upsert_barcode (20261018090000:76-96): its catalog_foods insert fires the statement-level evidence_clock_catalog_foods_ins, which takes evidence_clock first. Its catalog_food_revisions update or insert then fires recipe_state_catalog_evidence (20261128090000:150), which takes every recipe_plan_state row. On catalog_food_revisions, 'evidence_clock_*' also sorts before 'recipe_state_*', so evidence fires first there too. (2) favor_food_families takes `evidence_clock FOR SHARE` at line 137. Its user_food_prefs insert at line 180 then fires recipe_state_food_prefs, which locks the caller's own recipe_plan_state row.
- **Failure scenario:** User Y logs or marks a catalog food that nobody has referenced yet, so get_or_create_food_ref inserts a new catalog food_ref. Y's transaction now holds every account's recipe_plan_state row and waits for evidence_clock. At the same moment user X scans an unknown barcode: upsert_barcode already holds evidence_clock and its catalog_food_revisions write now waits for the recipe rows Y holds. Postgres detects a deadlock and aborts one of them with 40P01, so either Y's log or Favor or X's scan fails with a 500. The same happens between Y's mint and any user's Favor tap (Favor holds evidence SHARE and then needs its own recipe row, which the mint holds). The window grows with the number of accounts, because the mint updates one row per account before it reaches evidence_clock. The two users never share any data. Separately, every catalog mint, barcode import and catalog revision change holds all N recipe-state rows until commit, so it blocks behind, and blocks, every account's settings, prefs, plan_days and recipe log or undo writes.
- **Fix:** Use one global lock order. Simplest: make the food_refs and catalog recipe-state bump take evidence_clock first, for example `perform 1 from evidence_clock where id = 1 for update` at the start of recipe_plan_bump_food_ref_state and recipe_plan_bump_global_state. Better: replace the per-account fan-out with a single global recipe-catalog clock row that proofs compare against, so no transaction locks N account rows.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Medium / UI (2)

#### A087 — Legacy onboarding form never runs the safety round, so pace holds are never stored
- **Where:** `components/Onboarding/OnboardingFlow.tsx:281`
- **Area:** UI; **category:** safety-rule
- **Defect:** The legacy form calls persistCompletedOnboarding(base, state) with no SafetyAnswers and no storedEligibility, and has no pregnancy, breastfeeding, clinician-diet or health-condition question. The pace-hold safety design (G1-G3) depends on stored constraint_profiles.conditions, which this path never writes. The legacy form is the default /onboarding unless NEXT_PUBLIC_CHAT_ONBOARDING === '1', and it is also the ErrorBoundary fallback after a v2 crash, which drops the v2 round's taps.
- **Failure scenario:** A pregnant, breastfeeding, eating-disorder or kidney-disease user onboards through the legacy form (or is dropped into it after a v2 crash). Nothing is stored, the server reads no hold, and a 20% below-burn loss plan with the high protein factor is written.
- **Fix:** Add the safety round to the legacy flow, or make the legacy path default to a 0 pace until the round is answered. Do not ship the legacy form as the default while the flag is off without it.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A093 — Legacy onboarding form crashes the page for an under-18 birth year
- **Where:** `components/Onboarding/OnboardingFlow.tsx:352`
- **Area:** UI; **category:** crash
- **Defect:** OnboardingFlow calls buildCompletedSettings(currentBase, currentState, new Date()) in the component body with no eligibility argument and no try/catch. For an under-18 birth year, deriveTargetRevision -> eligibleSettings throws AdultOnlyError. PlanStep (OnboardingSteps.tsx:306) does the same. The v2 shell wraps this call in try/catch (ConversationalOnboarding.tsx:620), but the legacy form does not. app/page for onboarding wraps only the v2 path in an error boundary, and there is no app/error.tsx or global-error.tsx.
- **Failure scenario:** With NEXT_PUBLIC_CHAT_ONBOARDING unset (the default per .env.example) or after OnboardingErrorBoundary falls back to the legacy form, a user enters birth year 2012, height, weight, an activity level and a goal. The render throws AdultOnlyError and the whole onboarding page crashes with Next's default error screen. 'Skip for now' is unreachable. Reproduced with tsx: createOnboardingState + onboardingReducer (birthYear 2012, maintain goal), then buildCompletedSettings throws 'AdultOnlyError: ...plans are built for adults 18 and over'.
- **Fix:** Wrap both buildCompletedSettings calls in the legacy flow in try/catch (treat AdultOnlyError as a friendly 'plans start at 18' stop with Skip enabled), or add the v2 minor stop to the legacy form. Add an app/error.tsx.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

### Medium / ops (12)

#### A010 — Oura plus Apple (Health Auto Export) double-counts steps and active energy
- **Where:** `lib/health/daily.ts:23`
- **Area:** ops; **category:** correctness
- **Defect:** HAE writes one folded daily step/active-energy sample whose interval is only 1 hour long (start=day 00:00 local, end=start+1h, lib/health/normalize.ts hourAfter), while Oura activity is a whole-UTC-day interval (00:00:00Z to 23:59:59Z, lib/oura/map.ts). unionNonOverlapping lets the Watch-labelled sample claim only its 1-hour span and adds the other source's value prorated by the uncovered fraction (~96%), so two full-day totals are summed instead of one being chosen.
- **Failure scenario:** User has Oura and Health Auto Export with an Apple Watch. HAE posts step_count 8000 for 2026-09-15 (device 'Devin's Apple Watch', NY zone) and the Oura pull stores daily_activity steps 8200. rollUpDay returned steps = 15858 (reproduced with a temporary vitest calling normalizeHealthAutoExport, ouraActivityToSamples and rollUpDay). The doubled number reaches /api/health/daily, the MCP get_body_data tool, the export, Today's Body card and the activity context (7-day step baseline and active-kcal average) that feeds the expenditure estimate job.
- **Fix:** For step_count and active_energy pick one source per day (prefer the preferred or most complete source) instead of unioning daily aggregates from different providers. At minimum give the folded HAE daily sample the full local-day interval, and exclude or de-prioritise a daily-aggregate Oura sample when a device-interval source exists.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A011 — Oura 401 'refresh then retry' never actually refreshes the token
- **Where:** `lib/server/oura.ts:141`
- **Area:** ops; **category:** correctness
- **Defect:** pullTwoDays passes ouraGet a `refresh` callback that calls accessTokenFor(admin, source) with the same stale `source` object. accessTokenFor only exchanges the refresh token when expires_at is within the 5-minute skew. For a token that Oura rejects with 401 while the stored expires_at is still in the future, the callback returns the identical access_token, the retry gets a second 401, and `refreshed` is already true, so ouraGet throws 'Oura <path> failed with 401'.
- **Failure scenario:** The stored expires_at is later than reality (Oura invalidated the access token early, or the expiry was computed from Date.now()+expires_in after a slow exchange). Every daily cron pull and the post-connect pull fail with 401 until the clock passes expires_at, so Oura data stops updating for that user. Spec section 7 promises exactly one refresh-then-retry on 401.
- **Fix:** Give accessTokenFor a `force` flag (or a separate refreshTokens function) that skips the expiry check. Have the 401 callback call it and use the rotated pair.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A067 — foodsFor reads all user_foods, including soft-deleted rows, with unpaged and unbatched queries on every coach turn
- **Where:** `lib/server/day-context.ts:241`
- **Area:** ops; **category:** perf-unbounded-read
- **Defect:** `foodsFor` runs `user_foods.select().eq(user_id)` with no `deleted_at` filter and no paging, so it hits the 1,000-row cap silently. It then runs `food_refs ... .in("user_food_id", ids)` with every id in one URL, and `user_food_prefs ... .in("food_ref_id", refIds)` unbatched. `userFoodRefIds` in the same file was fixed to use `fetchAllRows` and `fetchAllChunked`, but this function was not.
- **Failure scenario:** Label scans and custom foods each create a `user_foods` row, and soft-deleted rows are never dropped from this read. An active account that accumulates a few hundred foods over months gets a very long GET URL on every coach turn (`serverStoreFor`), plan-ideas call and compose pool. The query fails with a 4xx and the coach or chip request returns an error. Past 1,000 foods the list is silently truncated, so the coach plans without some of the user's foods.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A071 — Progress export reads target_profiles unpaged, so accounts with over 1000 revisions get wrong targets for recent dates
- **Where:** `lib/server/export.ts:330`
- **Area:** ops; **category:** row-cap
- **Defect:** loadTargetProfiles selects all target_profiles up to `through`, ordered ascending, with no paging. PostgREST max_rows is 1000, and the repo's own paged-read.ts/date-chunks.ts exist for this. The cap drops the NEWEST rows, and profileForDate walks the truncated ascending list.
- **Failure scenario:** An account has more than 1000 revision rows (the phone cache comment says revisions can be written daily on weigh-ins, and recompute/adaptive rows add more). The export for any date after the 1000th row's effective_from is resolved to that 1000th row, so kcal_target, day_type, target_revision and the targets are stale for the most recent dates. No error is raised.
- **Fix:** Use fetchAllRows with a stable key order, or read only the revision in force at `from` plus the revisions between from and through.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A081 — Health ingest records its dedupe event before applying samples, so a failed apply makes the retry a silent no-op and the samples are lost
- **Where:** `lib/server/health-ingest.ts:103`
- **Area:** ops; **category:** silent-failure
- **Defect:** applyIngest calls the health_ingest_event RPC first, which inserts an ingest_events row keyed (source_id, payload_hash) in its own transaction. It then calls health_ingest_apply as a separate RPC. If the apply fails, the route answers 500 but the event row stays. The retry carries the same payload and hash, so health_ingest_event hits ON CONFLICT and returns is_new=false. applyIngest returns status 'duplicate' with accepted 0 and never applies the samples. Nothing deletes or marks the event on failure. The Oura pull in lib/server/oura.ts avoids this by applying regardless of is_new. Only the HTTP ingest path has the bug.
- **Failure scenario:** A Health Auto Export or Shortcut client posts a payload. health_ingest_apply fails with a transient DB error or a timeout, and the client gets 500. The client retries the identical body, which is the normal behaviour for HAE. The server answers 200 {status:'duplicate', accepted:0}. The client treats the data as delivered, and the weight, HRV and other samples never reach health_samples. The loss is silent and permanent. For HAE the sample window is only 8 days, so the data is gone once it ages out.
- **Fix:** Make recording the event and applying the samples one transaction, for example by doing both inside a single RPC. Or, when the apply fails, delete the event row or mark it 'failed'. Or, on is_new=false, still call health_ingest_apply, which is idempotent because it upserts, as the Oura pull does.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** Raised as a spec-review note in docs/audit/specs/2026-09-22-phase-10-r1-gpt6-sol.md item 8, with no ruling or fix.

#### A083 — Nightly JSON backup omits about two dozen user-owned tables added after the RLS migration, including dietary-profile hard rules, allergen checks, shopping and recipe-plan state
- **Where:** `app/api/jobs/backup/route.ts:40`
- **Area:** ops; **category:** silent-failure
- **Defect:** The TABLES list is hand-maintained and tracks supabase/migrations/20260911000500_rls.sql. No test checks that it matches the schema. Many later user-scoped tables are absent, so the backup run reports ok:true with a bytes count while missing them. Examples: user_dietary_profiles, user_allergen_checks, food_membership_revisions, shopping_periods, shopping_lines, shopping_pantry, shopping_purchase_windows, recipe_plan_selections, recipe_plan_state, recipe_consumed_slot_state, favorites_catalog_recipes, coach_action_undos, coach_action_receipts, food_signal_events, taste_chip_receipts and taste_dislike_removals.
- **Failure scenario:** A restore from the Storage 'backups' dump recovers the user's foods and logs but not their religious or user hard-rule profiles (user_dietary_profiles), their checked-allergen records, their shopping lists, pantry or accepted recipe selections. The restored account is silently less safe, because dietary rules are gone, and has lost data. The backup_runs row still says status ok. The code comment says the real pg_dump on the Mac is the acceptance backup, but this cron is the only off-box copy and it advertises itself as covering 'every user-owned table'.
- **Fix:** Add the missing user-owned tables with their primary-key ordering to TABLES and COMPOSITE_KEYS. Add a test that diffs TABLES against the set of public tables that have a user_id column, minus an explicit allow-list of excluded ones.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A085 — Meal, recipe and water exports silently truncate at PostgREST max_rows (1000) while the default limit is 5000, and no next cursor or truncation notice is emitted
- **Where:** `lib/server/export.ts:198`
- **Area:** ops; **category:** silent-failure
- **Defect:** streamMeals, streamRecipes and streamWater fetch `.limit(opts.limit + 1)` and compute `hasMore = rows.length > opts.limit`. limitParam defaults to MAX_LIMIT (5000). supabase/config.toml sets max_rows = 1000, and PostgREST caps the response at 1000 rows whatever .limit() asks for. With limit >= 1000, `rows.length > limit` can never be true, so hasMore is false and next_cursor is null. The CSV 'Export truncated' notice is keyed off next_cursor, so it never appears. The body-profile export and the backup already page around this cap. These three do not.
- **Failure scenario:** A user who has logged a year or more of meals (over 1000 log_entries) requests GET /api/export?kind=meals, with the default limit or any limit of 1000 or more. They get the first 1000 entries as a complete-looking file. There is no next_cursor and no truncation line, so the rest of their history is silently missing from their data export. Water is affected after more than 1000 logged days. Recipes are affected after more than 1000 recipes.
- **Fix:** Clamp the per-query fetch to ROW_CAP-1, or page the select with .range() until limit+1 rows are collected. Alternatively lower MAX_LIMIT and the default to at most 999, so that limit+1 <= 1000.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A086 — CSV export of a large log is silently truncated with no way to fetch the rest
- **Where:** `app/api/export/route.ts:84`
- **Area:** ops; **category:** data-loss
- **Defect:** The streamed meals/progress export caps a page at limit (default 5000 entries). For format=csv, csvResponse appends only the text notice 'Re-request with the returned cursor', but the cursor is returned nowhere in CSV (it exists only in the JSON body). The only UI, ExportCard -> downloadExport, fetches one CSV page and saves it.
- **Failure scenario:** A user with more than 5000 logged entries taps 'Download meals CSV' under copy that says 'Everything you have logged ... Leave the dates empty for the whole log.' They get the first 5000 entries, and the only hint is a '# Export truncated' comment on the last line. The remaining history cannot be fetched from the CSV path, so the export is incomplete.
- **Fix:** Have downloadExport follow next_cursor (use JSON pages and build the CSV client-side, or expose the cursor in a response header) until exhausted. At minimum, show a visible 'only the first N entries' notice.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** docs/audit/2026-09-13 finding #45 (partially fixed: notice added, cursor loop never implemented)

#### A106 — Seeds balance silently truncated at the 1,000-row API cap
- **Where:** `lib/server/care-points.ts:36`
- **Area:** ops; **category:** correctness
- **Defect:** readCarePoints and readCareShop compute `balance` (and `pending`) by selecting every settled/pending ledger row with a plain `.select()` and summing in JS. No `.order()`, no paging. PostgREST caps the response at max_rows=1000 and gives no sign of truncation. The repo's own `fetchAllRows` helper exists for exactly this case and is not used.
- **Failure scenario:** An account passes 1,000 settled/pending ledger rows. Up to about 6 rows a day can be awarded, plus purchases, so a daily user gets there in under a year. GET /api/care/points and GET /api/care/shop then sum an arbitrary 1,000 rows and show a balance lower than the real one. `care_purchase` checks the full ledger in SQL. The phone's shop state uses the truncated balance, so the UI can show 'insufficient' for items the user can really afford. The number can also change between calls because the order is undefined.
- **Fix:** Page the read with `fetchAllRows` ordered by `id`, or have the server sum the balance. For example, add a `care_balance(p_user_id)` RPC and use it in both places.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A112 — Meals export silently stops at 1,000 entries and reports no cursor
- **Where:** `lib/server/export.ts:192`
- **Area:** ops; **category:** unpaged-read
- **Defect:** streamMeals does one select with .limit(opts.limit + 1). The route defaults limit to MAX_LIMIT = 5000 (app/api/export/route.ts:29,70). PostgREST max_rows = 1000 (supabase/config.toml:10) caps the response at 1000 rows whatever .limit asks for. hasMore is computed as entries.length > opts.limit, so 1000 > 5000 is false and next_cursor is null.
- **Failure scenario:** An account with 1,400 non-deleted log_entries (about 280 days at 5 meals a day) downloads /api/export?kind=meals with no limit param. It gets the oldest 1,000 entries and a null next_cursor. The CSV carries no truncation notice, because the notice is only appended when a cursor exists. The user's 'full export' is missing their latest ~400 meals and nothing says so. The same happens for any explicit limit above 1000.
- **Fix:** Cap the effective page size at 999 (or at the API row cap minus the sentinel row) in limitParam/MAX_LIMIT. Or read the page with fetchAllRows or keyset paging and compute hasMore from a sentinel row on the real page size.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); Sol: confirmed, re-rated high to medium

#### A113 — Water and recipes exports have the same 1,000-row truncation with no cursor
- **Where:** `lib/server/export-water.ts:93`
- **Area:** ops; **category:** unpaged-read
- **Defect:** streamWater (export-water.ts:93-107) and streamRecipes (export.ts:482-495) use .limit(opts.limit + 1) with a default limit of 5000. The API cap returns at most 1000 rows, so hasMore is false and next_cursor is null. streamFavorites (export.ts:530-536) runs three unpaged selects with the same cap.
- **Failure scenario:** An account with more than 1,000 water_log days (about 2.7 years of daily water logging) exports water. It gets the first 1,000 days, no cursor and no truncation notice. The newest days are silently missing. The same applies to more than 1,000 recipes, and to more than 1,000 favorited foods.
- **Fix:** Clamp the export page size below the row cap, or page with fetchAllRows or a keyset loop and derive hasMore from a sentinel row.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A114 — Progress and water exports read day-type overrides with an unchunked .in(local_date) list of up to 5,000 dates
- **Where:** `lib/server/export.ts:316`
- **Area:** ops; **category:** unpaged-read
- **Defect:** loadOverrides (export.ts:316-322) and loadWaterOverrides (export-water.ts:43-48) select plan_days with .in('local_date', dates). The date list is the whole page, up to opts.limit = 5000. There is no chunking and no paging.
- **Failure scenario:** A progress export for an account with 1,100 logged days sends a .in() list of about 1,100 dates, which is a request line of roughly 13 KB. The gateway can reject it with a 400 or 414, which fails the export. If it is accepted, the response is capped at 1,000 plan_days rows. The overrides for the later days are lost, those days fall back to the weekday day-type, and the exported day_type, kcal_target and water goal are wrong for them with no error.
- **Fix:** Use readByDateChunks over [page[0], page.at(-1)] and filter to the page, or fetchAllChunked with IN_CHUNK_SIZE.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

## Low severity (97)

### Low / nutrition accuracy (10)

#### A005 — BMR age uses the local-time year while the effective date is a noon-UTC instant
- **Where:** `lib/profile/energy.ts:140`
- **Area:** nutrition accuracy; **category:** nondeterminism
- **Defect:** bmr computes age with today.getFullYear() (local time). derive.ts effectiveDate builds noon UTC, and the other date logic in the same file (katchEligible, isoDay) uses UTC fields. Where the process zone is UTC+13 or UTC+14, noon UTC on Dec 31 is already Jan 1 locally.
- **Failure scenario:** A phone in Pacific/Auckland (NZDT, +13) derives or previews targets for effective date 2026-12-31. The Mifflin age is year 2027 minus birth year, which is one year older than the UTC server computes for the same revision. BMR differs by 5 kcal and the frozen seed (bmrKcal, initialTdeeKcal) differs between phone and server. Server-side recompute then rewrites the revision once because revisionMatches sees the difference.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A008 — Recipe nutrient maths ignores energy_kcal_calc, so the one energy rule is not applied to recipe totals and the logged recipe item
- **Where:** `lib/recipes/nutrients.ts:97`
- **Area:** nutrition accuracy; **category:** energy-accuracy
- **Defect:** computeRecipeNutrients, and its SQL twin in 20260919090300_phase3_sync_entities.sql, sum energy_kcal and energy_kcal_calc as independent codes. Coverage and 'complete' are judged on energy_kcal only. An ingredient that has only the Atwater-calculated energy, which is how the catalog stores foods USDA did not measure, counts as having no energy. The recipe's energy_kcal becomes the sum of only the ingredients that carry a measured value. The recipe's loggable user_food per_100g carries both energy_kcal (partial) and energy_kcal_calc (the rest). itemEnergy then prefers the partial reported value.
- **Failure scenario:** A recipe has ingredient A (energy_kcal 100 per serving) and ingredient B (energy_kcal_calc 80 only). Recipe energy_kcal is 100 and energy_kcal_calc is 80. Logging it gives a snapshot where itemEnergy picks reported = 100. The day total and rings count 100 instead of 180. The recipe is flagged partial, but the number is still an undercount of what the energy rule would give for the same data. The recipe card's 'at least N kcal' is also lower than the calculated figure.
- **Fix:** In the recipe sum, select each ingredient snapshot's energy with the energy rule (reported, else calculated) before summing, store it as the recipe's energy_kcal, and count it toward energy coverage. Change the SQL twin the same way (a new migration).
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A016 — Grams box text can disagree with the grams that get logged (comma decimals, '-' or other partial input)
- **Where:** `components/LogFoodSheet.tsx:274`
- **Area:** nutrition accuracy; **category:** log-portion-maths
- **Defect:** typeGrams always stores the text in gramsText, but updates `grams` only when Number(text) is finite and >= 0. The input uses inputMode="decimal". A decimal-comma keypad produces '1,5', which gives NaN. A lone '-' or '.' also gives NaN, and '-5' fails the >= 0 test. In these cases `grams` keeps its previous value, and canConfirmPortion stays true because it checks the stale number.
- **Failure scenario:** On a device with a comma-decimal locale, the user types '150,5'. The box shows '150,5' while grams stays 150 (from the last valid prefix) or the old portion grams. 'Log it' stays enabled and logs a number different from what is displayed. Typing '-' leaves the old grams committable while the box shows '-'.
- **Fix:** Normalise ',' to '.', and on an unparseable value set grams to 0 (disabling Log) or mark the field invalid, so the displayed text always matches the committed value.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A018 — Package count can round up one extra package because of float division in Math.ceil
- **Where:** `lib/shopping/aggregate.ts:156`
- **Area:** nutrition accuracy; **category:** rounding
- **Defect:** buyGrams is computed as Math.ceil(net / packageGrams) * packageGrams. `net` is rounded to 4 decimals, but the division is float, so an exact multiple of a decimal package size can come out as k + 1e-15 and ceil returns k + 1.
- **Failure scenario:** For a 340.2 g (12 oz) package and a need of exactly 7 packages (2381.4 g), 2381.4 / 340.2 = 7.000000000000001, so ceil gives 8 and the list tells the user to buy 8 packages. The same happens with 170.1 g. I checked with node: [[340.2,7,2381.4,7.000000000000001],[170.1,7,1190.7,7.000000000000001]]. The price estimate inherits it, since it uses Math.ceil(buyGrams / quote.packageGrams).
- **Fix:** Use Math.ceil(round(net / pkg) - 1e-9) or compare in integer micrograms, as purchase-mass.ts already does with BigInt.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A021 — 'Ramen bowl' and 'Overnight oats' are mapped to the wrong SR rows (dry noodles; plain cooked oatmeal)
- **Where:** `lib/food-db.json:1`
- **Area:** nutrition accuracy; **category:** food-data-mapping
- **Defect:** scripts/build-food-db.py:484 builds 'Ramen bowl' (category meal) from the SR row 'Soup, ramen noodle, chicken flavor, dry' (439 kcal, 60 g carbs, 17.5 g fat per 100 g, portion '1 package without flavor packet' 81 g). 'Overnight oats' is a copy of plain oatmeal cooked with water (71 kcal/100 g).
- **Failure scenario:** A user logs a ramen bowl by weight (a prepared bowl is about 400-500 g) or by 1 serving. Dry-weight values give about 1,750-2,200 kcal, roughly 4x too high, because the per-100 g figures are for the dry block, not broth and noodles. 'Overnight oats' made with milk, chia or yogurt is under-counted, since the row has no milk, fat or protein beyond cooked oats and water. Both ids are still offered by searchFoods and used by the plan/taste universe.
- **Fix:** Remove 'Ramen bowl', or source it from a prepared-soup row or a label with a bowl portion. Mark 'Overnight oats' as an approximation or give it a real milk-based recipe row. Then regenerate the JSON.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A022 — Importer ignores Foundation's sugars id 1063, leaving sugars_total empty for most Foundation foods
- **Where:** `scripts/import-fdc.py:85`
- **Area:** nutrition accuracy; **category:** nutrient-mapping
- **Defect:** NUTRIENT_MAP maps only id 2000 to sugars_total. In the Foundation CSV, id 1063 (nbr 269.3) carries the sugar value for 280 food-nutrient rows against 45 for 2000. lib/catalog/fdc-map.ts (branded) maps both 1063 and 2000, so the two mappers disagree.
- **Failure scenario:** Foundation foods such as fruits and dairy show no sugar amount in the catalog (null, 'not measured'), although USDA reports one. Sugar coverage and any sugar-based display or flag for those foods is silently missing.
- **Fix:** Add 1063 as an alias for sugars_total in the importer, with 2000 winning when both exist for a food. Re-import Foundation.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A035 — Barcode scan stores qty and 'g' unit inconsistent with grams
- **Where:** `components/ScanConfirmSheet.tsx:55`
- **Area:** nutrition accuracy; **category:** data-integrity
- **Defect:** For the '100 g' pill (portionId null) the editor computes grams = (explicitGrams ?? 100) x qty, but ScanConfirmSheet builds the item with unit 'g' and qty = edits.qty (the 'How many' stepper). The optimistic card (catalogCard) uses qty = grams for unit g, so the card and the stored row disagree.
- **Failure scenario:** Scan a product, choose the '100 g' pill and set How many = 3. grams = 300 and the snapshot is for 300 g, but the log_item is stored qty 3, unit 'g', grams 300. The export (lib/server/export.ts) prints qty 3 / unit g / grams 300. The entry fingerprint and any consumer reading qty with unit 'g' see 3 g. The coach day-context formats `${qty} ${unit}`.
- **Fix:** When portionId is null send qty = grams with unit 'g', as catalogCard and the Log sheet do.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A042 — Cured and processed meats read as 'fat' in the role inference
- **Where:** `lib/foods/role.ts:47`
- **Area:** nutrition accuracy; **category:** correctness
- **Defect:** The PROTEIN name list has ham, prosciutto and jerky but not bacon, sausage, pepperoni, chorizo, salami, hot dog, liver or other offal. Only 'bacon fat' is matched, as pure fat. Such foods fall through to the calorie rule and, being fat-heavy, are classed 'fat'. The module header says every meat name is protein.
- **Failure scenario:** A user adds 'Bacon', 'Pepperoni', 'Salami', 'Chorizo' or 'Hot dog'. judgeFoodRole returns {role:'fat', source:'calories'}. A vitest run gave 'Bacon', 'Pepperoni', 'Chorizo', 'Hot dog', 'Salami' and 'Liver' -> fat, while 'Ham' and 'Turkey bacon' -> protein. The Eats dot shows fat. Because the server snapshot (meal-snapshot.ts foodFor) and the phone use inferFoodRole when no role is stored, partsOf/rankPlates treat the food as a fat part and not a protein anchor. The meal generator can then pair bacon with another protein anchor, or not anchor on it.
- **Fix:** Add bacon, sausage(s), pepperoni, salami, chorizo, hot dogs/frankfurters, liver and kidney, bratwurst and similar names to PROTEIN. Keep the 'bacon fat' PURE_FAT check ahead of it.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A143 — Daily capture cap day is bucketed by a client-supplied time zone
- **Where:** `lib/server/capture.ts:193`
- **Area:** nutrition accuracy; **category:** date-of-day
- **Defect:** assertUnderCaps calls ai_calls_today(p_user_id, p_tz) with req.tz from the request body. assertKnownTimeZone only checks that it is some IANA zone. The SQL counts rows where (created_at at time zone p_tz)::date equals (now() at time zone p_tz)::date, so the day boundary comes from whatever zone the caller names, not the account's stored zone.
- **Failure scenario:** A client that reaches the hard daily cap switches the request tz to a zone whose local midnight has just passed, such as one 12 or more hours away from the zone it was using. The counter then covers only the calls made since that zone's midnight, and the request is allowed again. Repeating this can roughly double the intended per-day capture count. The per-user and global spend caps still apply.
- **Fix:** Resolve the zone for the cap from user_settings.time_zone (readAccountZone, then UTC as the logged last resort), or use a rolling 24-hour window on created_at, and never the request's tz.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A144 — Recipe-page ingredient parser drops common 'N (size) can X' lines and rewrites some food names
- **Where:** `lib/plan/recipe-jsonld.ts:35`
- **Area:** nutrition accuracy; **category:** wrong-result
- **Defect:** ingredientName splits on /[,(]/ and takes the first piece before stripping quantities and units. A line such as '1 (15-ounce) can black beans' becomes '1 ', then '', and is dropped from the recipe ingredients. The UNITS and PREP regexes also delete meaningful words from the food name: 'whole milk' becomes 'milk', 'ground beef' becomes 'beef', 'large eggs' becomes 'eggs'.
- **Failure scenario:** A pasted recipe link lists '1 (14 oz) can coconut milk' and '2 cups whole milk'. The coach planning ask receives only 'milk' and omits the coconut milk. The cards and rules then work from a food list that differs from the page.
- **Fix:** Remove parenthetical groups and quantities first, then split on the comma. Do not strip 'whole' or 'ground' when they are part of the food name.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

### Low / feature accuracy (17)

#### A004 — Authored (pinned) target write accepts any goalRateBpWeek, bypassing goal presets
- **Where:** `lib/server/targets.ts:378`
- **Area:** feature accuracy; **category:** validation
- **Defect:** authoredSchema allows goalRateBpWeek as any integer from -200 to 200 (app/api/targets/route.ts:33-34), unlike the derive path, which refines it with validateRate. authorTargets writes it straight into target_profiles.goal_rate_bp_week (targets.ts:378-379). The only gate is paceAllowed. The value is not checked against the account's goal or the RATE_PRESETS_BP.
- **Failure scenario:** POST /api/targets with mode 'grams', valid kcal values and goalRateBpWeek -200 for an account whose goal is 'maintain', or a 'gain_muscle' account with -200. The revision stores -200. buildProposal then calls rateTarget with that rate (lib/proposal.ts:111-116) and proposes a weekly deficit of up to 20% of TDEE against the stated goal. The preset set (-25/-50/-75) is bypassed. The wrong-sign pace feeds the weekly proposal, so the user sees the opposite of their goal.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A026 — OFF 'en:crustaceans' declaration does not count as evidence for the 'crustacean' allergen, so a complete label clears it
- **Where:** `lib/policy/allergens.ts:154`
- **Area:** feature accuracy; **category:** allergen-safety
- **Defect:** The alias table sends 'crustaceans' to the combined 'shellfish' key, but 'crustacean shellfish' to the 'crustacean' key. deriveEvidence('crustacean', ...) decides `tagged` by allergenKey(tag) === 'crustacean'. An OFF tag en:crustaceans becomes 'crustaceans', which resolves to 'shellfish', so it never matches. The keyword list for the 'crustacean' rule has no generic 'crustacean' word and no non-English names.
- **Failure scenario:** A user's profile avoids 'crustacean shellfish' (alias key 'crustacean', FALCPA major allergen). They scan an OFF product that declares en:crustaceans and has a complete foreign-language ingredient list, e.g. 'crevettes 40%, sel, eau'. I ran deriveEvidence('crustacean', {ingredientsText:'crevettes 40%, sel, eau', labelComplete:true, tags:['crustaceans']}) and got level 'not_listed'. For a major allergen, not_listed means 'allowed: No crustacean shellfish listed on the label', so the product is shown as safe despite the explicit declaration. The same input for key 'shellfish' correctly returns 'listed'.
- **Fix:** In deriveEvidence, treat a 'shellfish' or 'crustaceans' tag as tagged for the crustacean key, since it is the broader class. Alternatively have off-map emit both 'shellfish' and 'crustacean' for en:crustaceans. Add 'crustacean' and 'crustaceans' to the crustacean keywords.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A033 — Offline or queued log commits skip the server policy marks and the commit's other server work
- **Where:** `lib/log/queue-commit.ts:65`
- **Area:** feature accuracy; **category:** spec-mismatch
- **Defect:** A commit that gets a 5xx, 408, 429, 401 or network failure is queued as a log_entries op and applied by POST /api/sync/ops, which calls apply_sync_op directly. It never goes through applyLogEntry. The only source of `flagged` (blocked, unverified-allergen and Avoid marks), recordFingerprint, deleteCommittedMedia and the stale_revision check is applyLogEntry. The comment in queue-commit.ts says both paths reach applyLogEntry, which is false.
- **Failure scenario:** Offline, or on a 5xx, a user logs a food on her Avoid list or containing a listed allergen via search, capture or scan. The op drains through /api/sync/ops. The card never gets the flags, `unverified:allergen` / 'Check the label' marks never appear, and no rules-unreadable notice appears. The 'logging marks, never refuses' ruling is only honoured on the online path. Draft media from a queued capture is also not deleted at commit, so it waits for the 24 h sweep.
- **Fix:** Re-evaluate policy after a drained log_entries op applies, for example by calling a policyIssues-style check from sync/ops or reading flags on the post-sync reconcile. Or route queued log creates through applyLogEntry.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A036 — Label food rows are created before the request is validated, so refused or retried commits leave orphans
- **Where:** `lib/server/log.ts:275`
- **Area:** feature accuracy; **category:** data-integrity
- **Defect:** applyLogEntry calls commitLabelFood (inserts a user_foods row and a food_ref) before unknownRefIssues, staleRevision and the apply_sync_op RPC. If any of those refuse or the RPC throws, the entry does not exist, so existingLabelRef finds nothing on the retry and a second user_foods row is inserted.
- **Failure scenario:** A label meal (the label item plus a catalog item pinned to a revision that has since been superseded) gets stale_revision. The label food was already inserted. Each retry or re-pick inserts another 'label_scan' food with the same name, so the user's own-foods list fills with duplicates. The same happens when apply_sync_op returns a 5xx and the client retries.
- **Fix:** Run the ref and revision validation first, or make the label food creation idempotent, for example keyed by draft_id.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A041 — Starter choices ignore a wheat allergy: gluten-tagged bread is still offered
- **Where:** `lib/foods/starter.ts:47`
- **Area:** feature accuracy; **category:** safety-rule
- **Defect:** The bread starters declare only the allergen 'gluten'. starterChoices and starterExcludedByCurrentRules compare them against `allergenKey(avoid_allergens)`. 'wheat' and 'gluten' are separate keys in lib/policy/allergens.ts: 'wheat' is a major allergen and has no alias to 'gluten'. An account that avoids 'wheat' therefore keeps white bread and whole-wheat bread in its starter choices.
- **Failure scenario:** An account with avoid_allergens ['wheat'] reaches onboarding or auto-seed. starterChoices returns white-bread and whole-wheat-bread (a vitest run printed `["wheat"] bread:true wwbread:true`). `["gluten"]` correctly removes them. The fresh-rules recheck in persistStarterSelection uses the same predicate, so it also lets them through. The user can select them as Eats and 'Pick for me' can add them. evaluatePolicy later returns 'unverified' for a wheat avoid with tags ['gluten'], so they stay out of generated plans. The user is still offered and may save a food that conflicts with their stated allergy. This contradicts the AGENTS.md rule that starters are filtered by the account's explicit dietary rules. Related: account-defined allergens such as corn or banana cannot exclude any starter, because filtering uses only each starter's declared allergen list.
- **Fix:** Tag the bread starters with both 'wheat' and 'gluten'. Make the starter check treat wheat and gluten as one concern, or reuse the policy engine's textNames/allergenRule for each starter's name.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A045 — An unparseable redirect Location in the recipe-link fetch throws a non-HttpError (500)
- **Where:** `lib/server/recipe-url.ts:159`
- **Area:** feature accuracy; **category:** robustness
- **Defect:** fetchRecipePage calls `new URL(res.location, url)` outside any try/catch. A malformed Location header (for example 'https://[') throws a TypeError. It is not an HttpError, so the route answers a generic 500 instead of the intended 422 'unreachable'.
- **Failure scenario:** A user pastes a link whose server redirects with 'Location: http://[bad'. POST /api/plan/inspire returns an internal error instead of 'That page didn't open'.
- **Fix:** Wrap the Location resolution in try/catch and throw HttpError(422,'unreachable') on failure, or pass the raw header string to checkRecipeUrl.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A050 — Estimator takes the median of every body_mass sample per day, which breaks the dashboard's scale-beats-manual rule
- **Where:** `lib/server/health-daily.ts:120`
- **Area:** feature accuracy; **category:** data-correctness
- **Defect:** `weighInsKg` reads the raw `weigh_ins` view, which holds every body_mass sample from every source. The engine then takes the median per day (lib/expenditure.ts:271). The dashboard's `rollUpDay` (lib/health/daily.ts:164-176) drops manual samples when an ingest sample exists and takes the latest ingest sample. The comment at the top of health-daily.ts says the estimator and dashboard cannot see different numbers, but the weigh-in path does not use `rollUpDay`.
- **Failure scenario:** A scale syncs 80.0 kg and the user types the rounded value 80.4 kg in the Morning weight. The dashboard shows 80.0. The estimator's median of the two samples is 80.2. With two ingest sources, or a scale plus a manual copy, the Theil-Sen slope input is a blend of the sources rather than the shown weight. A source that is added or dropped mid-window adds spurious steps to the weight trend. The estimator's weightTrendKg then disagrees with the number the user sees.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A063 — Meal count and slot clocks for any viewed date come from today's cached target, not that date's revision
- **Where:** `lib/plan.ts:55`
- **Area:** feature accuracy; **category:** wrong-result
- **Defect:** When mealsPerDay is null (the default), mealCountFor reads settings.activeTargetProfile.training.kcal. That is the current cache, and plannedSlotIds (lib/plan/slot-share.ts:71), timesForLayout and resolveSlotTimes (lib/resolve.ts:89) all pass store.settings. The server already derives the count from the revision in force on each entry's own date (lib/server/log-occasion.ts:74 comment, 'a past entry's meal count is the one its own day had, never today's'; trainingKcalOn(date)). The phone does not.
- **Failure scenario:** The account has rev1 (effective 2026-01-01, 1700 kcal) and rev2 (effective 2026-10-01, 2000 kcal), and mealsPerDay is null. On 2026-10-10 the user views 2026-09-15. resolveDay returns 4 slots (the 4-meal clocks 08:00/11:30/15:00/18:30) with day target 1700 kcal. The server's rule gives 3 slots at 08:00/12:30/18:30. I reproduced this: the 2026-09-15 view shows 4 slots at 1700 kcal. A past day gets a phantom Meal 4. Its open slots split the day four ways instead of three. Occasions and templates are chosen from the wrong clocks, so Meal 3 at 15:00 becomes a snack plate. The mismatch with the server's occasion stamps feeds history affinity. The server's day-context store has the reverse problem for a future date: with the active cache null, the count falls back to 3.
- **Fix:** Resolve the meal count from targetRevisionOn(settings, date).training.kcal. Pass `{ ...store.settings, activeTargetProfile: targetRevisionOn(...) }` into slotListFor and resolveSlotTimes inside plannedSlotIds, timesForLayout and ratiosFor, and into swap/skip callers.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A064 — Ticked slot with a food-bearing followPlan snapshot plus a log filed under it reads as unticked and empty
- **Where:** `lib/resolve.ts:289`
- **Area:** feature accuracy; **category:** wrong-result
- **Defect:** For an eaten slot whose override is followPlan with components (a time-edit snapshot or a legacy tick) and which has its own log entry, `components` becomes [] (eatenPlanSnapshotIfUnlogged is null while planSnapshot is non-null). No base meal is generated, because fixedMacros makes the slot fixed. No estimate is built either, because undescribedEatenSlots excludes a slot that holds components. meal is therefore null. eatenAt is read only `shown ? stored.eaten[slot] : undefined`, so ResolvedSlot.eaten is false.
- **Failure scenario:** Store with eaten['meal-3'], itemOverrides['meal-3'] = {followPlan:true, components:[Salmon], time:'19:30'} and extras:[800 kcal log with slot 'meal-3']. resolveDay gives slot meal-3 eaten:false, meal:undefined, consumed 800. The card shows an unticked empty slot even though the user ticked it. Day completion (completionFor) skips it as unplanned, so a fully eaten day can read 'partially done'. A second tap writes a new eaten mark over the existing one. The count (800) is right but the card state is wrong. Existing tests (tests/plan/eaten-shell-rule.test.ts) assert only macros and consumed, never eaten.
- **Fix:** Treat an eaten slot whose snapshot is suppressed by a log like the logged-ritual case: build eatenEstimateMeal(date, slot, undefined, stored) for it, so meal is non-null and eaten stays true. Or derive eaten from stored.eaten[slot] independently of `shown`.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A065 — Swap sheet offers the meal that is already on the card as the first alternative
- **Where:** `lib/today/swap-alternatives.ts:133`
- **Area:** feature accuracy; **category:** wrong-result
- **Defect:** The current meal is excluded by comparing row.id with input.currentMealId. A generated meal's id is `suggested:<date>:<slot>`, and a swapped one keeps its previous baseMealId. Composed alternatives are ids of the form `plate:<foods>`, so they never equal currentMealId. The generated plate is also usually the top-ranked plate for the slot, because the swap sheet and the layout both use rankPlates, the same date and the same target.
- **Failure scenario:** With the starter foods and a 2100 kcal rest account, Today shows meal-1 'Egg with oatmeal'. Opening Swap for meal-1 lists 'Egg with oatmeal' as the first card, with 'Swap to this'. The same happens for all 4 slots (verified: the first alternative equals the current meal name for each). The user sees the meal they already have offered as an 'other meal'. After a swap, the new plate is offered again too.
- **Fix:** Also drop a composed row whose foodIds/components equal the slot's current components (or whose visibleKey equals the current meal's). Alternatively pass the current plate key and compare plate.key.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A066 — 'Marked not eaten' leaves the frozen generated meal in place as a hand-edit
- **Where:** `lib/plan-day-client.ts:245`
- **Area:** feature accuracy; **category:** wrong-result
- **Defect:** Ticking a generated meal rewrites the slot override with the plate's components and drops followPlan. Unticking only clears the eaten mark; it never removes or restores that override. The slot stops following the plan after an Undo or untick.
- **Failure scenario:** The user ticks Meal 2 (writes override{baseMealId:'suggested:…', title, components}, no followPlan), taps the 'marked eaten' Undo or unticks it, then later changes targets, adds a logged snack or puts a food on Avoid. Meal 2 stays the old plate while the other open meals re-plan. It counts as a fixed slot in slotTarget, so the other slots' shares change. The 'Back to the suggested meal' button is needed to recover. Undo of a tick does not return the day to the state before the tick. features.md calls ticking a simple eaten mark.
- **Fix:** When unticking a slot whose override was written by the tick (followPlan absent, baseMealId starting with 'suggested:' and unchanged since), restore followPlan:true with empty components, or delete the override. This is the same restore rule the skip flow uses (restoreMealMarked).
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A090 — Calendar export wraps late meals past midnight instead of clamping like the app
- **Where:** `lib/ics.ts:84`
- **Area:** feature accuracy; **category:** wrong-result
- **Defect:** effectiveMinutes returns parseTime(base) + shiftMinutes with no clamp, and formatTime wraps modulo 1440. The app's resolveSlotTimes/shiftTime clamp to 23:59. The DTSTART/DTEND date stays on the anchor day, so a wrapped DTEND can precede DTSTART.
- **Failure scenario:** With the default 3-meal layout and the whole-day shift at +330 minutes, Today shows 13:30 / 18:00 / 23:59, but the .ics sets meal 3 at 00:00 (DTSTART 20260101T000000). A late meal at 23:50 gets DTEND 00:05 on the same date, an invalid event. Reminders fire at the wrong time.
- **Fix:** Use the shared shiftTime/resolveSlotTimes result (clamped) for the calendar, and compute DTEND from the clamped start.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A092 — Under-18 check counts calendar years, so 17-year-olds pass as adults
- **Where:** `lib/profile/rate-eligibility.ts:131`
- **Area:** feature accuracy; **category:** spec-mismatch
- **Defect:** ageOn(birthYear, onDate) = year(onDate) - birthYear, and isMinorOn is `< 18`. A person born in late 2008 is still 17 until their birthday in 2026 but computes as 18 from Jan 1, 2026. The minor_under_18 profile spec says 'if (current year - birth year) <= 18, ask or collect the full date of birth; treat as under 18 until confirmed', but no such question or confirmation exists.
- **Failure scenario:** A 17-year-old who enters a birth year 18 years back (or types age 18 by mistake) passes the adult gate and is given a calorie-deficit plan and weight goal. Up to about 12 months of 17-year-olds are affected.
- **Fix:** Treat year difference 18 as 'unconfirmed' and ask 'Are you 18 or older?' (or collect a date of birth) before building a plan.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A094 — A new under-18 signal leaves the account's existing paced revision in force
- **Where:** `lib/server/target-recompute.ts:260`
- **Area:** feature accuracy; **category:** safety-rule
- **Defect:** When the stored birth year, or the minor_under_18 profile, makes the account a minor, plan() returns skip 'adult_only' before the hold/neutralise logic. recomputeAfterHoldChange (called from /api/profile/instances for minor_under_18) then does nothing. The active adult revision, including a loss pace and the high protein factor, stays in force. The hold path neutralises paced revisions, but the minor path does not. The profile definition says adult kcal plans and weight goals are DISABLED.
- **Failure scenario:** An account with an active 20%-deficit plan adds the 'Under 18' dietary profile (or a coach/profile edit sets an under-18 birth year). The deficit revision stays active and keeps driving Today's targets.
- **Fix:** On adult_only, supersede the revision in force (and scheduled paced ones) with a 0-pace, standard-protein, non-adult-plan state, or mark targets unavailable, instead of skipping.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A119 — First constraint_profiles write is an unconditional upsert, so two writers at rev 0 overwrite each other (allergens can be lost)
- **Where:** `lib/server/constraints.ts:163`
- **Area:** feature accuracy; **category:** race / safety-rule
- **Defect:** putProfile's compare-and-swap only protects rev>=1 (update ... where rev = rev). When the account has no row (rev 0) it does client.from('constraint_profiles').upsert(next). Both writers read rev 0, both pass baseRev===0, and the second upsert silently replaces the first row. `next` is built from the empty `current`, so any field the second request omits (`req.avoidAllergens ?? current.avoid_allergens`) resets to empty. No DB trigger enforces rev monotonicity.
- **Failure scenario:** A new account (no constraint_profiles row). The phone saves allergens ['peanut'] at baseRev 0 while an MCP set_constraints, onboarding safety round or a second device saves only conditions at baseRev 0. Both get status ok; the later upsert wins and the peanut allergen disappears with no conflict returned. Avoid/allergen filtering then lets peanut foods through for that account.
- **Fix:** Use an insert (not upsert) at rev 0 and treat unique violation 23505 as a conflict (re-read and return status 'conflict'), or use upsert with ignoreDuplicates and a returned-row check.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A125 — Malformed path ids reach Postgres unvalidated and return 500 instead of 400/404 (proposals decide, coach thread delete/rename/clear, weak recipe id regex)
- **Where:** `app/api/proposals/[id]/decide/route.ts:31`
- **Area:** feature accuracy; **category:** input-validation
- **Defect:** Several id-taking routes pass the raw path segment straight into a uuid column filter or RPC argument. POST /api/proposals/[id]/decide passes `id` to decideProposal, which calls rpcApproveTargetProposal or `.eq('id', proposalId)`. DELETE and PATCH /api/coach/threads/[id] and DELETE /api/coach/threads/[id]/messages pass `id` to deleteChatThread, renameChatThread and clearChatThread. GET /api/recipes/[id] and GET/PUT /api/recipes/[id]/favorite only check `/^[0-9a-f-]{36}$/i`, which accepts any 36-character hex-or-dash string such as 36 dashes. Postgres rejects all of these with 22P02 (invalid uuid). The error is caught as a generic failure: a bare `throw error` in decideProposal, `HttpError(500, 'internal')` in the thread helpers, and `failed()` in the recipe repository.
- **Failure scenario:** POST /api/proposals/not-a-uuid/decide, DELETE /api/coach/threads/abc, or GET /api/recipes/------------------------------------ returns 500 or 503 and writes a server error log line, rather than 400/404. Sibling routes (care messages, coach undo, shopping periods, recipe plan and preview) validate with z.uuid(). A client or monitor sees spurious 5xx, and the 5xx alarm and log noise can be driven by any signed-in user. No data is exposed, because every query is scoped by user_id.
- **Fix:** Validate with z.uuid() at the top of each handler and answer 400 or 404. Replace the `[0-9a-f-]{36}` regex in the recipe routes with z.uuid().
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A132 — Calendar-invalid dates pass regex checks and crash as HTTP 500 (health daily, MCP get_body_data, export from/cursor, undo cursor)
- **Where:** `lib/server/health-daily.ts:68`
- **Area:** feature accuracy; **category:** input-validation
- **Defect:** Many entry points validate dates only with /^\d{4}-\d{2}-\d{2}$/, so '2026-13-45' passes. Date.parse then gives NaN. In app/api/health/daily/route.ts and lib/mcp/health-tools.ts the guards `span < 0` and `span + 1 > 90` are both false for NaN, so the request continues. rawSamples then calls new Date(NaN).toISOString(), which throws RangeError, and the route answers 500. The export routes feed unchecked dates and cursors straight to the database, which rejects them as errors. app/api/coach/undo uses decodeCursor, which accepts any string Date.parse accepts (for example 'abc 1,<uuid>').
- **Failure scenario:** GET /api/health/daily?from=2026-13-45&to=2026-13-46 gives 500 (RangeError) instead of 400. The MCP tool get_body_data with from='2026-13-45' errors the same way. GET /api/export?kind=body-data&cursor=<base64 of '2026-13-45'> throws RangeError in addDays. GET /api/export?kind=meals&from=2026-02-31 gives a database date error, and the export route reports it as a 500. GET /api/coach/undo?before=abc%201,<uuid> reaches the PostgREST filter created_at.lt."abc 1" and gives a 500 from the cast. Each case should be a 4xx.
- **Fix:** Validate with z.iso.date() or a round-trip check (toISOString().slice(0,10) === value) at each boundary. Treat NaN spans as invalid. Require an ISO instant for the undo cursor.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

### Low / AI/tool calling (14)

#### A001 — Retry loop ignores the caller's abort; an already-aborted attempt leaves an unhandled rejection
- **Where:** `lib/ai/call.ts:127`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** The attempt loop never checks `signal.aborted`. The module header and the code comment promise that no attempt starts after the caller's abort fires, but only the entry checks enforce it. If the signal fires during the backoff sleep, the next iteration still calls `call.transport.send(...)`. `untilAborted` then sees `signal.aborted` and does `return onAbort()`. That rejects the wrapper, but it never attaches a handler to `run`, the promise `send` just returned. When `send` rejects, nothing handles it.
- **Failure scenario:** A Jev caller that passes a signal and keeps the default retry gets a 429 or 529. Examples are `lib/coach/role-advice.ts`, `lib/server/taste-chips.ts` and `lib/log/sanity.ts`. The request is cancelled or the turn deadline fires during the 400 ms backoff. The second attempt still starts and `postSystemOne` calls `fetch` with an already-aborted combined signal. That `fetch` rejects with an AbortError nobody handles. Under Node's default `--unhandled-rejections=throw` this is an unhandledRejection event that can crash the function or fail the request. It also bills nothing but consumes `beforeRetry` budget (in callers that meter retries) and a Jev request-budget slot.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A028 — Undo of delete_entry restores the entry without its title
- **Where:** `lib/coach/apply-entries.ts:136`
- **Area:** AI/tool calling; **category:** undo-mismatch
- **Defect:** undoDeleteEntry rebuilds the commit with buildCommitRequest and never passes `title`. The restored local card keeps `entry.name`, but the server row is committed with no title. log_meal and the coach's other paths do send the title, and buildCommitRequest only sets req.title when given one. The restore also forces method 'text' and rewrites every item as grams-only (qty = grams, unit 'g'), so the original portion label, qty and unit are lost.
- **Failure scenario:** The user has 'Chicken wrap' logged through the coach, so the server row has title 'Chicken wrap'. The coach deletes it and the user taps Undo. The entry comes back on the phone with the right name, but the server row has no title. After the next sync pull the card reverts to a derived or blank name. Items logged as '2 eggs' come back as '100 g'.
- **Fix:** Store entry.name (the title) in the delete_entry token, and pass `title` to buildCommitRequest in undoDeleteEntry. Keep each item's original qty, unit and portion in the token and restore those too.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A037 — Undo of a deleted entry drops the meal title
- **Where:** `lib/coach/apply-entries.ts:140`
- **Area:** AI/tool calling; **category:** data-loss
- **Defect:** undoDeleteEntry rebuilds the commit with buildCommitRequest but passes no `title`, so the restored server entry has title null. The local card keeps entry.name, but entryPatchFromRow overwrites patch.name with deriveMealTitle(...) when row.title === null on the next reconcile or pull. Restored items also lose portion_id and was_edited.
- **Failure scenario:** User saved a meal named 'Post-gym lunch' with 3 items. The coach deletes it and the user taps Undo. The new entry carries no title, and after the next pull, or on another device, the card reads the derived title instead of 'Post-gym lunch'.
- **Fix:** Keep the title in the delete token (originals) and pass it to buildCommitRequest.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A056 — Coach thread GET returns 500 for a non-numeric or fractional limit
- **Where:** `app/api/coach/threads/[id]/route.ts:45`
- **Area:** AI/tool calling; **category:** input-validation
- **Defect:** `limit` is read as `Math.min(50, Math.max(1, Number(param ?? 50)))`. `?limit=abc` gives NaN, because both Math.max and Math.min propagate it. `?limit=2.5` is not an integer. Both values reach `.limit()` and PostgREST rejects them.
- **Failure scenario:** GET /api/coach/threads/<id>?limit=abc runs the query with `limit=NaN`. The route then answers 500 `internal` ("Could not read the transcript.") when it should answer 400. The failure is also logged as a server error.
- **Fix:** Parse the limit with zod or `Number.isInteger`. Respond 400 on bad input, or fall back to 50.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A102 — Pre-auth body parsing can throw on non-object JSON batch elements and returns 500
- **Where:** `app/api/mcp/route.ts:67`
- **Area:** AI/tool calling; **category:** input-validation
- **Defect:** toolNamesInBody reads candidate.method on each batch element with no null check. scopesForBody runs before withTokenUser, so this happens before authentication. TOOL_SCOPES[name] is also a plain object lookup, so a name such as "constructor" or "toString" returns an inherited function that is truthy and not "read".
- **Failure scenario:** An unauthenticated POST with body [null] throws a TypeError at line 67, which becomes a 500 from jsonError instead of a 400 or 401. An authenticated read-only token calling tools/call with name "constructor" is added as a required scope and gets 403 "Token lacks the [function] scope" instead of an unknown-tool error. Both are harmless but wrong.
- **Fix:** Skip elements that are not objects, and look scopes up with Object.hasOwn(TOOL_SCOPES, name).
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A104 — get_body_data accepts impossible calendar dates
- **Where:** `lib/mcp/health-tools.ts:32`
- **Area:** AI/tool calling; **category:** input-validation
- **Defect:** The date check is only a regex. Date.parse rolls 2026-02-30 over to 2026-03-02, so a bad date silently shifts the window. For 2026-13-01 the span is NaN, so the guard passes, and rawSamples then calls toISOString on an invalid Date and throws a RangeError.
- **Failure scenario:** An agent calls get_body_data with from=2026-02-30, to=2026-03-05. It silently gets data from 2026-03-02, not an error. With from=2026-13-01 the tool errors with RangeError: Invalid time value rather than the intended validation message.
- **Fix:** Reject the call when either date fails to round-trip (new Date(x).toISOString().slice(0,10) !== x) or the span is NaN.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A111 — MCP list_coach_messages is documented 'newest last' but with a limit returns the oldest messages
- **Where:** `lib/mcp/coach-tools.ts:71`
- **Area:** AI/tool calling; **category:** truncation-order
- **Defect:** The tool orders created_at ascending and applies .limit(a.limit ?? 50). With the epoch floor as default `since`, the limit keeps the OLDEST N messages, not the newest N. The description says 'newest last, for a review'.
- **Failure scenario:** An account has 300 coach messages. A review agent calls list_coach_messages with no args, or with limit 100, to read recent turns. It gets messages 1-50 (or 1-100) from the account's first days and never sees recent ones. A weekly review done through this tool judges stale turns. Passing sinceIso is the only workaround, and the schema does not say so.
- **Fix:** Order descending with the limit, then reverse the rows to present them oldest to newest. Or only apply the limit from the newest end.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A124 — Chat search takes at most 240 newest message hits across all threads, so one chatty thread can hide matches in the others
- **Where:** `lib/server/coach-threads.ts:424`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** searchChatThreads runs one full-text query over all of the account's chat threads with `.order('created_at', desc).limit(240)`. It applies the 3-matches-per-thread cap afterwards, in JS. The 240 limit is global, so if one thread holds 240 or more newer matching messages, they fill the whole result set. Matches in every other thread are cut off before the per-thread cap can spread results across threads.
- **Failure scenario:** A user searches a common word such as 'chicken'. A long-running nutrition chat has 300 recent messages containing it, and a different saved chat has 2 older messages containing it. The query returns only the 240 newest rows, all from the long chat. The other chat is not returned unless its title matches, so a search 'works' but silently omits older chats.
- **Fix:** Query per thread, or use an RPC with a window function (row_number() over (partition by thread_id)) so each thread contributes its top 3 hits before the global limit.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A127 — Plan-sheet 'Not this' exclusion list outgrows the 2 KB body cap on /api/plan/ideas, so refills fail with 413
- **Where:** `app/api/plan/ideas/route.ts:23`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** The route caps the request body at 2 KB (MAX_BYTES = 2 * 1024). The schema allows up to 40 excludeIds of up to 400 characters each (lib/plan/chips.ts:49). An ideaId is the plate key, the plate's food ids joined with '+' (lib/meals/plate.ts:310, lib/coach/suggest-pool.ts:195). With account-food uuids, a 3-food plate id is about 110 characters. PlanSheet keeps appending every skipped id to its `skipped` list (components/PlanSheet.tsx:415) and sends the last 40 on each refill (components/PlanSheet.tsx:216). The schema's own 40-id limit therefore cannot fit in the body gate.
- **Failure scenario:** A user taps 'Choose for me' on a meal slot and keeps tapping 'Not this'. Each time all three cards are skipped, a refill goes out carrying every id skipped so far. After about 5-6 refills (roughly 18 skipped 3-food plates, about 2 KB of ids) readJson throws 413 too_large. The chip then shows an error and no further ideas appear for that ask. The ids are not trimmed to fit the byte budget, so the promise that a refill never shows rejected ideas again breaks, and the sheet cannot recover until it is closed and reopened.
- **Fix:** Raise the route's byte cap to cover 40 x the worst-case id length. Alternatively cap the client list by serialized size, or send a short hash of each ideaId.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A136 — Media path accepted without format check on /api/coach/transcribe and /api/pantry/photo
- **Where:** `lib/server/coach-transcribe.ts:69`
- **Area:** AI/tool calling; **category:** input-validation
- **Defect:** transcribeRequestSchema takes any string up to 512 chars as the storage path, and pantry/photo takes any string up to 200 chars. fetchOwnedObject only compares the first path segment with the user id. Capture, plan/inspire and plan/document constrain paths with a media/<uuid>/<uuid>.ext regex. Capture also runs assertLiveMediaObject, which rejects tombstoned objects. These two routes do neither check.
- **Failure scenario:** A path like 'media/<my uid>/../<other uid>/<file>.m4a' passes the first-segment check, and only the storage layer's key normalisation stands between it and another user's object. Even in the benign case, an object the user already deleted or that is past the sweep (media_objects.deleted_at set, but the file not yet removed) can still be read and sent to a model. Transcribe also has no per-user rate limit, only the 120/min per-IP pre-limit.
- **Fix:** Apply the shared MEDIA_PATH regex and assertLiveMediaObject in fetchOwnedObject itself, and reject any segment equal to '.' or '..'.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A149 — Jev calls cut off by the caller's own short deadline are logged as provider timeouts and can open the Jev circuit for every user
- **Where:** `lib/server/plan-ideas.ts:40`
- **Area:** AI/tool calling; **category:** reliability
- **Defect:** suggestOptions starts its Jev timer (remainingMs, which is 450 ms for plan chips via JEV_DEADLINE_MS, or whatever is left of the 8 s SUGGEST_BUDGET_MS on the coach path, as low as 1 ms) before calling systemOne (lib/coach/suggest.ts:206-223). Inside callModel, two circuit reads (circuit.ts:73,77) and the spend-reservation RPC (call.ts:209-212) run before the first attempt and use up that time. When the attempt is then cut off by the caller's own deadline or abort, it is classified as 'timeout' (call.ts:70) and written as an ai_calls row (call.ts:286-288). The circuit counts 'timeout' as a provider failure (circuit.ts:24) and keys it on provider 'typesafe' and the one shared Jev request model, with no user filter.
- **Failure scenario:** Once open-world plates are Jev-eligible (or a coach suggest build runs close to its 8 s budget), five plan-chip taps in ten minutes, from any users, each take Jev a little over 450 ms including the gate reads. Five 'timeout' rows open the Jev circuit (circuit.ts:77-79) for ten minutes for everyone. Every Jev feature then degrades for all accounts: the coach intent fast path, reply verification (falls back to the regex), role advice, taste chips and suggestion ranking. Jev itself is healthy. This is a separate trigger from known #149 (caller aborts): here a self-imposed hard deadline of a few hundred ms is counted as a provider outage.
- **Fix:** Do not count a deadline the caller set below the lane's normal deadline (or any caller abort) as a provider failure. For example, record such calls as a distinct status like 'deadline'/'cancelled' that PROVIDER_FAILURES excludes, or count only attempts whose budget was at least DEFAULT_DEADLINE_MS. Start the chip's 450 ms after the gate reads, or pass it as the attempt budget only.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A151 — Two turns on one thread race for the same seq: the loser gets a false 503 'in_progress' after its model call was billed
- **Where:** `lib/server/coach-threads.ts:299`
- **Area:** AI/tool calling; **category:** race
- **Defect:** nextSeq reads max(seq)+1 at turn setup (setup.ts:79). persist inserts the user row and then the assistant row much later. coach_messages has unique (thread_id, seq) (migration 20261001000000_phase7_coach.sql:38). persist maps every 23505 to 503 'in_progress', 'Still working on that one' (coach-threads.ts:465-470). That message assumes the same message id. Unlike writeWeeklyReview (coach.ts:163-176), the turn path does not re-read the seq and retry.
- **Failure scenario:** The same chat is open on a phone and a laptop, or a plan-thread ask and a chat reply go to one thread. Two different messages are sent within seconds. Both read seq N. Turn A saves N and N+1. Turn B's model call finishes and is billed, then its insert at N fails with 23505. B answers 503 'Still working on that one'. On retry, storedTurn finds nothing for B's message id, so the whole turn runs again with a second model call.
- **Fix:** Tell a seq conflict apart from a message-id conflict (check the constraint name). On a seq conflict, re-read nextSeq and retry the insert, as writeWeeklyReview does. Or allocate seq inside one RPC or a sequence.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A153 — Weekly review pays for a Gemini call for every account every week, including accounts with no logged days
- **Where:** `lib/coach/weekly-review.ts:109`
- **Area:** AI/tool calling; **category:** efficiency
- **Defect:** The weekly-review cron lists every user_settings row (dueAccounts via accountZones, app/api/jobs/weekly-review/route.ts:63-70). writeWeeklyReview always calls runWeeklyReview, which always calls the model. It has no check on loggedDayCount. With fewer than 3 logged days, the model can only answer what fallbackReview (weekly-review.ts:77-82) already gives without a model: 'not_enough_data / logging'.
- **Failure scenario:** 1,000 accounts, most of them dormant or never onboarded. Each Sunday the job makes 1,000 Gemini calls (output cap 4,096 tokens each, reserved against the $50 global daily cap). Each dormant account also gets a new 'Weekly review' thread marked unread, with copy the code could have produced alone.
- **Fix:** In runWeeklyReview, return the fallbackReview result without a model call when loggedDayCount(days) < 3. Consider also skipping accounts with no logged days at all, so they get no message.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A160 — Zero placeholders in update_profile numericArgs become trainingWeekdays = Sunday, overwriting the user's training days
- **Where:** `lib/coach/actions/schemas.ts:168`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** update_profile carries [heightCm, weightKg, birthYear, bodyFatPct, ...trainingWeekdays] in one numericArgs array. The provider doc says to use 'zero placeholders' for unnamed fields, and the provider schema requires numericArgs on every action, with a maximum length of 11. 0 is both the placeholder and a valid weekday (Sunday). expandCompactArgs drops a 0 only in the four fixed positions. Every element past index 3 becomes trainingWeekdays, zeros included, and duplicates are not refused. So a goal-only or birth-year-only update whose numericArgs is padded past four zeros writes trainingWeekdays = [0] (or [0,0,0,0,0,0,0]).
- **Failure scenario:** The user says 'switch my goal to maintain'. The model fills the required numericArgs with full-length zeros [0,0,0,0,0,0,0,0,0,0,0] and stringArgs ['', '', 'maintain']. The strict parse yields { goal: 'maintain', trainingWeekdays: [0,0,0,0,0,0,0] }. applyUpdateProfile adds trainingWeekdays to the touched fields, syncs it to user_settings and re-derives the target revision with Sunday as the only training day. Every other day changes day type, with training versus rest calories and the training-10 slot.
- **Fix:** Do not overload 0 for the rest list. Encode weekdays 1-7, or move trainingWeekdays to the named `weekdays` key, which already exists. Alternatively, treat an all-zero tail as absent and refuse duplicate weekdays in the strict schema.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Low / determinism (10)

#### A051 — Estimator and proposal cache stamps 'Saved on' with the UTC date
- **Where:** `lib/estimator-client.ts:69`
- **Area:** determinism; **category:** duplicated-date-rule
- **Defect:** fetchCached stamps asOf with new Date().toISOString().slice(0, 10), the UTC date. ProposalCard shows it to the user as 'Saved on <date>' when the cached proposal is shown offline. The rest of the phone code uses local dates.
- **Failure scenario:** A US user loads proposals at 8 pm local on 10 Oct. The cache is stamped 2026-10-11. Offline, the card says 'Saved on 2026-10-11', a date that has not happened yet for that user.
- **Fix:** Use todayIso() or localIsoDate(new Date()) for asOf.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A062 — Anchor date-variety uses a signed modulo, so every date before 2026-01-01 ranks with inflated, inverted rotation
- **Where:** `lib/meals/plate.ts:394`
- **Area:** determinism; **category:** determinism
- **Defect:** `variety = 1 - ANCHOR_ROTATION * (((tier.indexOf(anchor) + day) % tier.length) / tier.length)` uses JS `%`. `day` is `daysSinceEpoch(date)` against ROTATION_EPOCH 2026-01-01, so it is negative for any earlier date. The remainder is then in (-n, 0], the fraction is negative, and variety lands in [1, 1.3) instead of (0.7, 1]. The sibling `rotate()` in the same file normalises negatives correctly (`((by % n) + n) % n`); this site does not.
- **Failure scenario:** A user opens a 2025 date, for example when backfilling or browsing history. Probe with planDay on eats(eggs, yogurt, tuna, oats, toast, banana, rice, broccoli, oliveOil) and three 600 kcal slots: 2026-01-02 gives breakfast score 0.830 and 2025-12-26 gives 0.954. Scores above what any post-epoch date can produce show the multiplier exceeds 1. The rotation also runs in the opposite direction: the anchor that is penalised after the epoch is favoured before it, and tier-mates tie differently. The day-assignment search also compares repeat (0.5x) against distinct plates using these inflated scores. The result is deterministic, but it is not the documented rotation and the pre-epoch day plan differs from what the model describes.
- **Fix:** Normalise: `const phase = (((tier.indexOf(anchor) + day) % tier.length) + tier.length) % tier.length;` and use `phase / tier.length`.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A070 — Weekly/hold week page keeps a stale 'today' after midnight
- **Where:** `app/week/page.tsx:105`
- **Area:** determinism; **category:** midnight-rollover
- **Defect:** WeekPage computes `today` once with useMemo(() => todayISO(), []). It has no midnight or visibility refresh, unlike Today (app/page.tsx syncClock) and the target day-roll.
- **Failure scenario:** A PWA left open on Week overnight keeps yesterday as today. The stats (days elapsed, 'on plan', not due yet vs missed) and the week grid mark the real today as upcoming and treat yesterday as the current day, until a reload.
- **Fix:** Track today in state refreshed on visibilitychange and at local midnight.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A072 — Taste history dates manual shopping lines by the UTC date of updated_at
- **Where:** `lib/server/taste-history.ts:235`
- **Area:** determinism; **category:** timezone-date
- **Defect:** Never-edited manual shopping lines are dated `updated_at.slice(0, 10)`, the UTC date, and read with a `${to}T23:59:59.999Z` bound. The window, the log entries and the episodes use the account's local dates.
- **Failure scenario:** A US-evening user adds a manual line at 21:00 local Oct 10 (Oct 11 04:00Z). It is excluded from the read until the next day (it is after today's UTC bound) and then counted on Oct 11, one local day late. An Asia-morning user's line is dated one day early, so it can collapse into or out of a (date, slot) episode against logs.
- **Fix:** Convert updated_at to the account's local date (the zone already used for `today`) before windowing and dating.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A100 — Calendar (.ics) meal times ignore the app's clamped slot resolution and can end before they start
- **Where:** `lib/ics.ts:78`
- **Area:** determinism; **category:** time-of-day
- **Defect:** effectiveMinutes returns base + shiftMinutes unclamped, and formatTime wraps modulo 1440 while the date stays the fixed anchor date. The app's resolveSlotTimes/shiftTime (lib/plan.ts) clamps each time to 00:00-23:59. DTEND = start + 15 min is wrapped separately, so a start near midnight gets a DTEND earlier on the same anchor date.
- **Failure scenario:** With a +240 min whole-day shift and meal-1 set to 23:50, Today shows meal-1 at 23:59 but the exported calendar puts it at 03:50. A slot at 23:55 gets DTEND 00:10 on the same date, which is before DTSTART, an invalid VEVENT. A negative shift is wrong the same way: 07:00 minus 8 h exports as 23:00 instead of 00:00. Night-shift users get reminders at the wrong hours. I ran generateMealPlanIcs with shift 240 and meal-1 23:50 and got DTSTART 20260101T035000 while resolveSlotTimes gave 23:59.
- **Fix:** Resolve each slot with resolveSlotTimes using the real slotTimes and shiftMinutes (so the clamp applies), and compute DTEND from the clamped start, capped to the same day or rolled to the next day's date.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A109 — Coach recentGut lookback window computed from the UTC date
- **Where:** `lib/server/coach-ports.ts:290`
- **Area:** determinism; **category:** timezone
- **Defect:** recentGut computes `from` as the UTC date of (now minus days) and filters gut_log.local_date >= from. local_date is a user-local date.
- **Failure scenario:** For a user west of UTC in the evening, or east of UTC just after local midnight, the UTC date is off by one from the user's day. The 'last N days' window is then one day short or one day long, which gives the coach wrong data for gut-symptom questions. This is an edge-case error only.
- **Fix:** Derive today from the account day (accountDay or localDateIn with the stored zone), then step back by calendar days.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A110 — Direct compose and suggestion-pool rotation fall back to the server UTC date
- **Where:** `lib/coach/suggest-pool.ts:47`
- **Area:** determinism; **category:** timezone
- **Defect:** When no date is passed, the rotation date defaults to new Date().toISOString().slice(0,10), the UTC date. The same applies in lib/coach/compose-pinned.ts:27.
- **Failure scenario:** For a user whose local day differs from the UTC day (evenings in the Americas), a compose or suggest call that omits the date seeds date-stable variety and the history windows from tomorrow's date. The cards shown and the plan resolved for the viewed day can then rank differently. This only affects ordering, not safety. The code comment accepts it as a fallback.
- **Fix:** Require the caller to pass the viewed day, or derive the fallback from the account zone.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A118 — A failed time-zone read silently dates estimate and weekly-proposal jobs by UTC and locks the wrong day
- **Where:** `lib/server/account-day.ts:90`
- **Area:** determinism; **category:** nondeterminism / idempotency
- **Defect:** readAccountZone swallows every read error and returns null, and resolveAccountDay then falls to UTC. The estimate and weekly-proposal jobs use that date as both the computation date (asOf) and the job_runs lock key, with no way to tell a real 'no zone' from a transient failure.
- **Failure scenario:** During a brief PostgREST error for one account, the 07:00 UTC estimate run dates a Pacific/Auckland or America/Los_Angeles account by the UTC day, writes the estimate for the wrong local_date and takes lock key=UTC date; the later fire with a healthy read computes the account's real day and writes a second estimate row, so the account has estimates for two different 'today' values and the first (wrong-day) one may be the latest read by latestEstimate.
- **Fix:** In the jobs, read the zone with a throwing variant (like timeZoneFor) so a failed read returns 'retry' instead of dating by UTC.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A142 — Saved-chat recall answer labels messages with the UTC date
- **Where:** `lib/coach/history-recall.ts:41`
- **Area:** determinism; **category:** date-of-day
- **Defect:** dateLabel() formats created_at with timeZone 'UTC'. The server-built recall answer (historyAnswer, sent as the coach's reply text) therefore cites the UTC calendar day. The same card in HistorySourceCards.sourceDate formats the instant in the device zone.
- **Failure scenario:** A US user wrote a message at 21:30 local on Oct 10. The coach's recall reply cites it as Oct 11, while the source card beside it shows Oct 10. The user is told the message was written on a day it was not.
- **Fix:** Pass the turn's tz (clock.tz) into historyAnswer and format the instant in that zone.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A166 — Retiming a log into the spring-forward gap moves it an hour earlier in America/* zones but an hour later in Pacific/Auckland
- **Where:** `lib/coach/apply-shared.ts:161`
- **Area:** determinism; **category:** dates-tz
- **Defect:** instantAt runs a fixed two-pass offset correction. For a wall-clock time that does not exist (the DST gap), the second pass overshoots back across the transition in zones west of UTC. The time is then saved before the gap, not shifted forward the way JavaScript Date and Temporal 'compatible' disambiguation do. Zones east of UTC land after the gap, so the result depends on the zone. Every manual and coach retime (saveExtraTime, move_entry) and every coach log_meal time goes through this function.
- **Failure scenario:** An America/Los_Angeles user drags a snack to 02:30 on 2026-03-08 (spring-forward day). instantAt returns 2026-03-08T09:30Z, which is 01:30 PST, and the card then shows 01:30, an hour before the time the user chose. The same drag in Pacific/Auckland on 2026-09-27 gives 03:30 NZDT. A move to 01:30 or 03:30 on that day is unaffected.
- **Fix:** After the two passes, if the formatted local time does not equal the requested time (a gap), pick the later candidate (the instant + the offset difference), or use the 'compatible' rule: resolve with the offset in force before the transition, then move forward.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Low / architecture (4)

#### A052 — Water export uses today's training weekdays and weight for every historical date
- **Where:** `lib/server/export-water.ts:73`
- **Area:** architecture; **category:** duplicated-business-rule
- **Defect:** waterGoalsFor.forDate picks each date's day type from the current user_settings.training_weekdays. It also sizes the goal with the current active revision's weight (streamWater calls activeProfile(client, userId) with no date). The progress export (targetFor in lib/server/export.ts:249-254) uses the training weekdays of the revision in force on each date, and Today uses the day type resolved from the date's revision. The file header claims the export gives 'the same answer Today gives'.
- **Failure scenario:** A user moves training from Mon/Wed/Fri to Tue/Thu in September. The October water export rewrites the `goal` for every August water row using the new weekdays and the newest weight. progress.csv shows day_type 'training' for a Monday while water.csv shows the rest-day goal for that Monday. The numbers also differ from what Today showed that day.
- **Fix:** Resolve the revision per exported date, as streamProgress does with loadTargetProfiles and profileForDate. Take trainingWeekdays and weight from that revision when computing each row's goal.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A057 — NHANES microdata scan ignores data file types
- **Where:** `tests/foods/nhanes-no-microdata.test.ts:17`
- **Area:** architecture; **category:** guard-coverage
- **Defect:** The scan only reads files matching /\.(ts|tsx|js|mjs|cjs|json|sql|md|css)$/. The workspace test's tracked-file check only matches /\.xpt$|DR[12]IFF|DEMO_L|P_DEMO/. A respondent-level file committed under lib/, app/, components/ or supabase/ as .csv, .tsv, .parquet, .txt or .gz, or a file with any other name, passes both guards.
- **Failure scenario:** Someone commits `lib/foods/universe/artifacts/dr1iff.csv` (or a parquet file) with SEQN-keyed rows. Neither the content scan (extension filtered out) nor the `git ls-files` regex catches it, so H1 and H2 pass while microdata ships.
- **Fix:** Scan every file under the scanned roots, skipping binary files by content, or add csv, tsv, txt, parquet and gz to `TEXT`. Fail on any tracked file in those roots outside an extension allowlist.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A058 — Open-world admission oracle reuses the production evidence builder
- **Where:** `tests/meals/open-world-safety.test.ts:80`
- **Area:** architecture; **category:** circular-oracle
- **Defect:** The 'oracle' in the 500-profile admission test calls `evaluatePolicy` with `EVIDENCE` from `admissionEvidence(item)`. That is the same input builder `admitUniverse` uses. The only independent check is `item.allergens[key] === "clear"` for avoided allergens, plus a regex check for the vegan and vegetarian flags in a separate test. Banned categories, custom ingredient rules, kosher or religious hard rules and the other preference flags have no independent check.
- **Failure scenario:** `admissionEvidence` stops passing the item's name or ingredient text, or drops `policyCategories`. A food named 'garlic bread' then clears a custom 'garlic' rule or the `onion_garlic` category in both admission and the oracle. All 500 seeds still pass. 'Admits 0 non-allowed foods' is then only self-consistency for these rule types.
- **Fix:** Add an independent text oracle for the rule types that do not go through `allergens`. For example, for each custom ingredient word and banned category, assert no admitted item's name matches a fixed keyword table owned by the test.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A060 — Kosher meat-with-dairy guard (W8 acceptance 8) passes even with the rule switched off
- **Where:** `tests/meals/open-world-layout.test.ts:210`
- **Area:** architecture; **category:** vacuous-guard
- **Defect:** The test 'no plate over 365 dates holds a meat food beside a dairy food' builds a kosher account (flags: ["kosher"], Favored chicken and yogurt) and checks that no plate pairs meat with dairy. It has no control showing that the same pool without the kosher rule does produce such plates. The plate templates choose one anchor plus a starch, vegetable, fruit or fat, so meat and dairy never meet in a plate in this pool. The assertion therefore holds whether or not `plateOk` / `checkPlateRules` runs inside `rankPlates` (lib/meals/plate.ts:289).
- **Failure scenario:** A regression drops `plateOk` from `openWorldInputs` (lib/meals/open-world.ts:183-191), or `rankPlates` stops calling it. `expect(open.ranking.plateOk).toBeDefined()` would fail only if the field were removed. A call site that ignored it, or a `checkPlateRules` that returns ok for everything, leaves the test green. I ran the same 365 dates with no kosher flag, using the test's own evidence functions (`universePlateEvidence` and `ownPlateEvidence`): 1460 plates, 0 with meat and dairy. The 'plates > 0' assertion only proves plates exist.
- **Fix:** Add a positive control. Either force a pool where an unrestricted `rankPlates` does emit a meat-plus-dairy plate (for example a template that allows cheese as a fat part) and assert the kosher run removes it, or unit-test `rankPlates` with a stub `plateOk` that rejects the top plate and assert it is skipped. Judge meat and dairy in the test from fixed food names, not from the production classifier.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

### Low / sync (9)

#### A074 — Conflict rebase deletes the old op before enqueueing its replacement (three non-atomic steps)
- **Where:** `lib/sync/outbox.ts:187`
- **Area:** sync; **category:** lost op / non-atomic IndexedDB
- **Defect:** The generic onConflict does putRow(merged), then deleteOp(old), then enqueue(rebased), in three separate transactions. The op's payload is the only surviving record of the user's edit. If the page dies, the account switches (AccountChanged), or enqueue throws between deleteOp and enqueue, the edit is gone while the mirror already shows it as saved. assertKeyMatchesPayload in enqueue can also throw a TypeError after the old op was deleted.
- **Failure scenario:** The app is backgrounded or killed right after the conflict response is processed. The old op is deleted and the rebased op was never written. The row holds the merged values locally, the server never receives the user's change, the outbox is empty, and SyncStatus reports everything as sent.
- **Fix:** Do the delete, mirror write and enqueue in a single readwrite transaction (like settleUserSettings), or enqueue the rebased op first and delete the old op afterwards.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A077 — A rebased log-entry note is joined with the server note unconditionally, duplicating or resurrecting text
- **Where:** `lib/sync/log-entry-ops.ts:116`
- **Area:** sync; **category:** conflict handling
- **Defect:** The note op's payload carries the user's full replacement note, not a delta. rebaseLogNote runs joinNotes(server.note, mine.note) whenever the entry conflicts for any reason (another device changed items or rev), without checking whether the server's note differs from the note the edit was based on.
- **Failure scenario:** The server holds note 'felt fine'. The user edits it to 'felt fine, then good'. The entry's rev was bumped by another device, so the update conflicts. The rebased note becomes 'felt fine\nfelt fine, then good', which duplicates the old text. If the user cleared the note, the join returns the server's old note and the deletion is reverted.
- **Fix:** Record the note the edit was based on (or the server's rev/note at queue time) and join only when the server note differs from that base. Otherwise use the user's note.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A080 — Any pull-side failure, including the unrelated post-pull food and target projection, blocks the push entirely
- **Where:** `lib/sync/client.ts:485`
- **Area:** sync; **category:** availability
- **Defect:** runPass awaits pullChanges and rethrows its failure before pushOutbox is attempted. pullChanges ends with refreshFoodProjection and refreshTargetHistory. These make direct browser Supabase reads (loadAccountFoodSnapshot, paging, the food_refs join) that have nothing to do with the outbox.
- **Failure scenario:** The direct PostgREST reads fail (a transient error, a paging check, a permission fault) while /api/sync works. Every pass throws after the cursor was already saved, so the push never runs and queued user edits are never sent. This persists as long as the read fails.
- **Fix:** Run the push even when the pull's projection step fails (catch and record the error, then continue), or move the projection refreshes out of the pull's critical path.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A082 — Settings recovery replays the feed from seq 0 on every pass, so it never finishes for a feed over 25,000 changes
- **Where:** `lib/sync/client.ts:243`
- **Area:** sync; **category:** watermark / liveness
- **Defect:** While settingsAwaitingBaseline is true (a queued settings op with no confirmed baseline, as captureTimeZone queues on a new device), pullChanges resets cursor to 0. It applies no settings row until the whole feed has been replayed (`!hasMore`), and the pull is capped at 50 pages x 500 changes. Each later pass restarts from 0 again, because the baseline stays unconfirmed.
- **Failure scenario:** A long-lived account with more than 25,000 change_log rows signs in on a new device and the first online open queues the time_zone settings op. Every pass pulls 25,000 rows, never reaches the end of the feed, and never establishes the baseline. The settings op stays parked and unsent indefinitely, and each pass costs 50 requests.
- **Fix:** Resume the recovery replay from a saved recovery cursor, or read the settings row directly instead of replaying the whole feed.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A137 — Per-op server 'error' results park the op after 3 attempts with no automatic release
- **Where:** `lib/sync/outbox.ts:198`
- **Area:** sync; **category:** sync-outbox / data-loss
- **Defect:** app/api/sync/ops converts any RPC exception into an {status:'error'} result, including transient database errors such as statement timeout, serialization failure or connection reset. parkOrRetry counts those as permanent: after MAX_ERROR_ATTEMPTS=3 the op gets next_attempt_at = now + 365 days. Only the manual 'Sync now' action in SyncStatus calls retryParked. Nothing releases it automatically. The backoff steps are 1 s, 2 s and 4 s (with jitter), and the drain is only triggered by writes, visibility changes and online events.
- **Failure scenario:** A short database hiccup (a few seconds) makes three consecutive passes return error for the same water_log, favorites_meals or plan_days op. The op is parked for a year. Later writes to the same entity chain onto its optimistic rev, so they conflict or park too. The edit never reaches the server, other devices never see it, and pendingCount() keeps counting it with no visible reason until the user finds 'Sync now'. This is the per-op variant of the confirmed whole-batch 4xx parking.
- **Fix:** Distinguish retryable server errors (SQLSTATE class 40/53/57/08, timeouts) from deterministic ones. Never park the retryable ones, or park with a short ceiling and release parked ops on the next successful sync pass.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A139 — Repeated conflicts duplicate note text (joinNotes is not idempotent)
- **Where:** `lib/sync/merge.ts:137`
- **Area:** sync; **category:** sync-merge / data-corruption
- **Defect:** On each conflict, joinNotes(local.note, server.note) concatenates both texts whenever they differ. It does no containment or dedupe check. The rebased payload already contains the server's earlier text, so a second conflict appends that text again.
- **Failure scenario:** A user_food_prefs note 'hurt on 9/12' conflicts with the server's 'fine 9/04'. The merge gives 'fine 9/04\nhurt on 9/12' and the rebased op is sent at base 5. Meanwhile any other write bumps the server rev (a membership toggle uses pref.rev+1 and keeps the note). The second conflict joins the local 'fine 9/04\nhurt on 9/12' with the server's 'fine 9/04' and returns 'fine 9/04\nhurt on 9/12\nfine 9/04'. Each further rev bump adds another copy, in symptom-evidence notes on user_food_prefs, log_entries and gut_log.
- **Fix:** In joinNotes, return the longer text if one side's lines are a subset of the other's, or join by distinct trimmed lines in a stable order.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A140 — Food membership revision is the device clock in ms, so a skewed device can override or discard another device's explicit Avoid
- **Where:** `lib/foods/prefs-client.ts:127`
- **Area:** sync; **category:** sync / clock-assumption
- **Defect:** The membership rev is Math.max(Date.now(), cachedRev+1, localClock+1) and is written verbatim to food_membership_revisions. The server accepts a write only if membership.rev < excluded.rev, with no bound or server-side clock. Cross-device ordering is therefore decided by raw device clocks. The route reports the loser as 'rejected', and reconcileFoodMembership reverts the local mark to the server's status. The membership cache is localStorage only, so a device that has not seen the other device's mark has no floor.
- **Failure scenario:** Device A's clock is 1 hour ahead (manual time, travel or a dead clock). The user marks 'peanut butter' as eats on A (rev = T+1h). Ten minutes later on correctly-clocked device B, the user taps Avoid. B mints rev = T+10min, which the server rejects as older, and B's UI silently reverts the Avoid to eats. The user's most recent explicit rule change is lost. Only a second tap works, after the cache holds the server rev.
- **Fix:** Let the server assign the revision (previous rev + 1) or take max(client rev, server rev + 1) in the RPC, with a bounded clock if timestamps are kept. At minimum, do not silently revert a fresher explicit tap: surface the rejection or retry at serverRev + 1.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A164 — A pulled echo overwrites the mirror of a row that still has a queued op, so a water tap loses a cup
- **Where:** `lib/sync/client.ts:289`
- **Area:** sync; **category:** race
- **Defect:** pullChanges writes every generic entity row (water_log, gut_log, favorites_*, recipes, user_foods) straight over the IndexedDB mirror with putRow, even when the outbox still holds a newer local op for that same key. Only plan_days checks for a pending op (lib/sync/plan-days.ts:34). Each applied op comes back as an echo in the next pass's pull, so that echo rolls the mirror back past every op queued after it. Water writes read the mirror to compute the next count (lib/water-client.ts:139), so a tap made while the mirror is rolled back builds on the stale count.
- **Failure scenario:** The day starts at 3 cups (rev 1). Tap 1 queues A (cups 4, base 1), and a pass applies A as rev 2 at seq s. Tap 2 queues B (cups 5, base 2), and the mirror shows 5. The next pass pulls seq s and writes {cups 4, rev 2} over the mirror. A tap before B's push answers, or while B is backing off after a 5xx/429/timeout, reads 4 and queues C (cups 5, base 2). B applies (rev 3, cups 5). C conflicts, and the water merge takes max(5, 5) = 5. Three taps from 3 end at 5, not 6. Until B lands, Today shows 4 for a cup the user already logged. A favorites unstar that is still queued is shown starred again the same way.
- **Fix:** In pullChanges, apply the plan_days guard to every generic entity: skip the putRow (and still advance the cursor) when the outbox holds an op for (entity, entity_key), or when the mirror's rev is greater than change.rev. Do the check in one transaction over [entity, outbox], as applyPlanDay does.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A168 — plan_days pull skip plus a 'duplicate' answer permanently drops another device's change to that day
- **Where:** `lib/sync/plan-days.ts:34`
- **Area:** sync; **category:** watermark-skip
- **Defect:** applyPlanDay returns true without writing when any plan_days op for the date is queued, so pullChanges advances and saves the cursor past that change. If the queued op then settles without re-reading the server row, the skipped remote change is never applied. That happens on 'duplicate' (outbox.ts:317 → dropOp → deleteOp only), the expected answer when a push committed but its response was lost; the ops route admits a cut-off batch loses committed results. Nothing re-fetches the row, and no later change for the date arrives to repair it.
- **Failure scenario:** The phone toggles Floor Day on 2026-10-10 (op P, base 1). P commits on the server as rev 2, but the response is lost, so P stays queued. The tablet ticks meal-1 as eaten (rev 3). The phone's next pass pulls seq 11 (rev 2) and seq 12 (rev 3). Both are skipped because P is pending, and the cursor moves to 12. P is re-pushed and answers 'duplicate', so the op is deleted. The phone's mirror stays at its speculative rev 2 without the tick, and Today (store.days) never shows meal-1 as eaten. That changes the day's rings and totals until some later edit to that date happens to resync it.
- **Fix:** When a pulled plan_days change is skipped for a pending op, remember the highest skipped rev for that date (for example in meta). On 'duplicate' (or any settle that does not carry the server row) for a plan_days op, re-read the row, or roll the cursor back to just before the skipped seq, as the restore path does, so the next pull re-applies it. An alternative is to project the newest skipped row once the outbox no longer holds an op for the date.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Low / security (14)

#### A059 — MCP batch calls can use read tools without the read scope
- **Where:** `app/api/mcp/route.ts:79`
- **Area:** security; **category:** authz-scope
- **Defect:** `scopesForBody` drops the `read` scope from the required set, and `scopeForBody` returns the first non-read scope or `read`. `withTokenUser` checks only that one scope. A token that has `constraints:write` but not `read` therefore passes when the body is a JSON-RPC batch that mixes a read tool call with a write tool call. The loop at lines 118-122 checks only the non-read scopes, so the read call runs unchecked. Non-tool methods behave the same way.
- **Failure scenario:** A token minted with only the `constraints:write` scope (scripts/mint-token.ts accepts arbitrary scopes) sends `[ {tools/call read tool}, {tools/call write tool} ]`. `withTokenUser` demands only `constraints:write`, and the read tool returns health or coach data the token was never granted.
- **Fix:** Include `read` in the required set when any tool in the body needs it, and when the body has any other tools/call or non-initialize method. Check every required scope, `read` included, against `ctx.scopes`.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A084 — Jev provider error bodies are stored and logged for every purpose except profile-taste and profile-prefs, although other purposes carry the user's own message or food text
- **Where:** `lib/ai/typesafe.ts:147`
- **Area:** security; **category:** pii-in-logs
- **Defect:** postSystemOne keeps the first 200 characters of a non-2xx response body in the thrown ProviderHttpError message. That message goes into ai_calls.error through callModel and into console.warn through degradeReason. Only REDACTED_ERROR_PURPOSES (profile-taste, profile-prefs) are reduced to the HTTP status, and the code itself notes that a provider error body 'may echo that text'. Other Jev purposes send raw user or health text: the coach intent pre-pass sends the user's message, sanity sends the log draft, and role-advice, verify and facet-warm send food names and reply text.
- **Failure scenario:** A 4xx or 5xx from System One that echoes part of the request, such as a validation error quoting the offending input, causes up to 200 characters of the user's coach message or health-related food text to be written to ai_calls.error and to the server logs. That is the leak the redaction list was added to prevent for two purposes, left open for the rest.
- **Fix:** Redact the body for every Jev purpose by default, and keep it only for an explicit allow-list of purposes whose input is not user text.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A099 — pantry/photo accepts an unvalidated mediaPath, so the owner check passes a path-traversal key
- **Where:** `app/api/pantry/photo/route.ts:24`
- **Area:** security; **category:** security-tenancy
- **Defect:** POST /api/pantry/photo validates mediaPath only as z.string().min(1).max(200). Every other media entry point (capture, plan/inspire, plan/document, coach attachments) applies the MEDIA_PATH regex 'media/<uuid>/<uuid>.<ext>'. fetchOwnedObject then checks only objectKey(path).split('/')[0] === userId before downloading with the service-role client. Unlike capture, the pantry path also skips the media_objects liveness and owner check (assertLiveMediaObject).
- **Failure scenario:** Account A sends mediaPath = '<A-uid>/../<B-uid>/<B-object-uuid>.jpg'. The first segment equals A's id, so the ownership check passes. The service-role download then asks Storage for that key. If the Storage layer resolves '..', or any future path-handling change does, A's pantry photo draft reads B's private image. Exploitation also needs B's random object uuid and depends on Storage key normalisation, so this is defence in depth, not a demonstrated leak.
- **Fix:** Reuse the shared MEDIA_PATH regex in the pantry Body schema. Make fetchOwnedObject reject any key that does not match '<userId>/<uuid>.<ext>' (no '..' or empty segments). Call assertLiveMediaObject in draftPantryPhoto.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A115 — Path traversal in fetchOwnedObject lets pantry/photo and coach/transcribe read another user's media with the service role
- **Where:** `lib/server/media.ts:70`
- **Area:** security; **category:** cross-account-leak
- **Defect:** fetchOwnedObject only checks that the first path segment equals the caller's uid (`key.split("/")[0] !== userId`). It does not reject `..`, `.`, empty or other odd segments, and it does not check the media_objects row. The key then goes to the service-role storage client. supabase-js builds a URL string and fetch applies WHATWG dot-segment normalisation, so `<myuid>/../<victimuid>/<uuid>.jpg` downloads the victim's object. Every other mediaPath consumer (capture, plan-inspire, plan-document) is protected by the strict MEDIA_PATH regex (`media/<36 hex/dash>/<36 hex/dash>.ext`). Two routes skip it: POST /api/pantry/photo validates only `z.string().min(1).max(200)`, and POST /api/coach/transcribe validates only `z.string().min(1).max(512)`.
- **Failure scenario:** Attacker (a shopping-pilot user) knows or obtains a victim's media path (uid plus random uuid, for example from a leaked log, support ticket or shared screenshot). They POST /api/coach/transcribe {"path":"media/<attackerUid>/../<victimUid>/<uuid>.m4a"}. The segment check passes, normalisation resolves the URL to the victim's object, and the victim's voice clip is transcribed and the text returned. The same trick on POST /api/pantry/photo sends the victim's photo to the vision model and returns the ingredient names it sees. The path unguessability limits this, but the ownership check is meant to be the boundary and it is bypassable.
- **Fix:** In fetchOwnedObject, require `^media/<uid>/<uuid>.<ext>$` (or at least exactly 2 segments, with segment 0 === userId and the file segment matching the UUID.ext regex) and throw 403 or 400 otherwise. Also apply the MEDIA_PATH regex in the pantry/photo and coach/transcribe zod schemas.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A120 — day_marks_started_on is documented as server-owned but a direct PostgREST update can rewind or null it
- **Where:** `supabase/migrations/20261209090100_plan_days_day_complete.sql:49`
- **Area:** security; **category:** rls-server-owned-column
- **Defect:** user_settings.day_marks_started_on is meant to be written only by the plan_days_record_first_mark trigger and to only ever move earlier (ruling R3). Unlike food_world, shopping_focus_* and the food_world markers, no guard trigger or column privilege protects it. user_settings still has the Phase 0 owner policy with table-wide UPDATE for authenticated (20260911000500_rls.sql, pattern 1).
- **Failure scenario:** An authenticated user sends PATCH /rest/v1/user_settings?user_id=eq.<self> with {"day_marks_started_on": null}, or a far-future date. lib/server/expenditure.ts marksStartedOn() reads that column, and the engine then applies the pre-marking rule again, where coverage-complete but unmarked days count as fully logged. Counted days and proposal eligibility rise on weaker evidence. The migration comment says clearing a mark cannot bring the old rule back, and this write does exactly that. The trigger can lower the value again on a later mark, but nothing stops the rewind.
- **Fix:** Add a before update-of guard trigger (security invoker, current_user in ('authenticated','anon')) that raises 42501 when day_marks_started_on changes and the new value is not an earlier non-null date. Alternatively revoke table UPDATE on user_settings from authenticated and grant a column allowlist.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A121 — Route-level quotas on telemetry and event tables are bypassable through direct PostgREST inserts and the record_* RPCs
- **Where:** `supabase/migrations/20261019090100_client_timings.sql:39`
- **Area:** security; **category:** quota-bypass
- **Defect:** client_timings, food_signal_events and onboarding_events grant INSERT to authenticated. The size, row-count and rate limits live only in the Next routes. /api/timings allows 8 KB, 200 rows and 60/min. /api/foods/signals and /api/onboarding/events cap 20 events and 60/min per account. The database has no per-account cap, no rate limit and no length limit on client_timings.device. The security-invoker RPCs record_food_signals and record_onboarding_events are also executable by authenticated with no limiter.
- **Failure scenario:** A signed-in account loops direct inserts against /rest/v1/client_timings, /rest/v1/food_signal_events or the RPCs at full speed. client_timings has no purge job at all and device is unbounded text, so rows and bytes grow without limit. food_signal_events purges only after 180 days. The unthrottled inserts bypass the S2 rate-limit design and can run up storage. pilot_arm_assigned events are also client-authored, so a user can write any arm to the W15 ablation table. The route's per-account throttle never runs on this path.
- **Fix:** Revoke direct INSERT on these tables from authenticated and write them only through the routes with the admin client (as done for ai_calls). Or add a per-account rate check inside the RPCs, such as a rate_limit_hit call or a daily row-count cap, a length check on device, and a purge for client_timings.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A131 — MCP route reads the whole request body before authentication and before any size check
- **Where:** `app/api/mcp/route.ts:94`
- **Area:** security; **category:** pre-auth-parse
- **Defect:** readCappedBody does await req.text() and only then measures Buffer.byteLength against 64 KB. It never checks Content-Length, and it runs before withTokenUser. The same raw text is then JSON.parsed by toolNamesInBody pre-auth. The post-auth readJson is never reached for oversized bodies.
- **Failure scenario:** An unauthenticated caller POSTs a multi-MB body (up to the platform limit of about 4.5 MB per request). The function buffers and decodes it into a string, then runs a byte count, then responds 413. The per-IP limit of 30/min allows about 30 such requests a minute from each IP, and many IPs multiply it. Nothing rejects on the declared Content-Length first. readJson in lib/server/http.ts does check it, and this route bypasses that.
- **Fix:** Reject on Content-Length > MAX_BODY_BYTES first, and read the stream with a byte cap. Do the scope pre-parse only after the token is verified, or only on a body already known to be small.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A135 — Plan-sheet document photo is sent to the model with EXIF/GPS intact
- **Where:** `lib/server/plan-document.ts:62`
- **Area:** security; **category:** privacy-boundary
- **Defect:** For kind 'image', source() downloads the stored object and passes media.bytes straight to documentPlanPayload. The pipeline never calls stripImageMetadata. The sibling plan-inspire and pantry-photo paths strip metadata first, and spec W12-F says the Plan sheet photo path must get the same server-side strip. The server trusts the phone's canvas re-encode, but the upload goes to a signed URL, so any client can upload a JPEG with EXIF.
- **Failure scenario:** A user uploads a JPEG with GPS EXIF through /api/media/sign (or an old client does). POST /api/plan/document {kind:'image', mediaPath} sends the full bytes, location and device metadata included, to OpenRouter or Gemini. The same photo through /api/plan/inspire would have been stripped. /api/log/propose (lib/server/capture.ts loadMedia) also passes raw bytes through.
- **Fix:** Call stripImageMetadata(media.bytes, kind) in plan-document.ts and capture.ts photo/label paths before building the payload, and refuse unparseable files as inspire does.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** Partly known: spec W12-F (phase-18-open-world-foods.md:39,1435) and docs/decisions/2026-10-05-pantry-photo-privacy-boundary.md list it as an open follow-up. It is not ruled acceptable.

#### A145 — Direct-table INSERT grants let clients bypass the per-IP and per-account limiter on telemetry tables
- **Where:** `supabase/migrations/20261226090200_onboarding_events.sql:121`
- **Area:** security; **category:** rls-server-owned-table
- **Defect:** onboarding_events, food_signal_events and client_timings grant INSERT (and the column list) to authenticated, so a client can insert rows over PostgREST without going through the 60/min/account and 120/min/IP limited routes, the 20-event and 48 KB batch caps, or the API's issued-identifier checks. The purge crons only bound age, not volume.
- **Failure scenario:** A signed-in client loops large PostgREST inserts into client_timings (the enumerated path and step values are valid) or food_signal_events. It grows these tables without bound for 90 to 180 days. food_signal_events rows with attacker-chosen keys that pass only the database's syntax check also feed the account's own taste signals, bypassing the route's `SIGNAL_RANKING_VERSIONS` and key-issuance validation.
- **Fix:** Revoke direct INSERT and route writes through the existing service-role path, or add a rate-limited SECURITY DEFINER insert function. Move the issued-identifier and ranking-version checks into the function.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A146 — BEFORE-INSERT SECURITY DEFINER guard on coach_threads leaks another account's chat count and locks its advisory key
- **Where:** `supabase/migrations/20261126090000_coach_conversations.sql:9`
- **Area:** security; **category:** definer-trigger-oracle
- **Defect:** _coach_chat_insert_guard is SECURITY DEFINER and runs BEFORE INSERT, before the row-level-security WITH CHECK. It takes pg_advisory_xact_lock and counts public.coach_threads using the caller-supplied new.user_id, with no auth.uid() check. When that user has 8 or more active chats it raises 'coach_chat_limit', otherwise the RLS check raises. The two errors differ.
- **Failure scenario:** Signed-in attacker A, knowing victim B's user UUID, sends `insert into coach_threads(user_id,kind) values (B,'chat')`. B with 8 active chats returns ERROR coach_chat_limit. B with fewer returns 'new row violates row-level security policy'. A learns B's chat-count bracket and briefly takes B's per-user advisory lock (hashtextextended(B, 26090000)). Reproduced locally with 8 seeded chats for B. Other BEFORE definer triggers, such as the same_owner family, give equivalent existence oracles for known UUIDs.
- **Fix:** Make the guard return early when new.user_id is distinct from auth.uid(), so the RLS error wins. Or make the trigger SECURITY INVOKER.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A147 — user_settings is owner-DELETE/INSERT-able, so every server-owned marker guard can be reset by delete and re-insert
- **Where:** `supabase/migrations/20260911000500_rls.sql:21`
- **Area:** security; **category:** rls-server-owned-column
- **Defect:** Pattern-1 grants `select, insert, update, delete` on user_settings to authenticated, with a `for all` owner policy. The later trigger guards (user_settings_food_world_guard, _food_world_markers, _shopping_focus_guard, and the day_marks_started_on trigger) only reject changes to a column on UPDATE, or INSERT of a non-default value. They do not stop DELETE followed by a fresh INSERT, which silently resets the server-owned columns food_world_set_at, food_world_default_due_at, shopping_focus_until/action/previous, day_marks_started_on and food_world to their defaults. day_marks_started_on itself is also directly UPDATE-able (the confirmed example), because there is no guard on it at all.
- **Failure scenario:** Local replay of all migrations on throwaway Postgres 16, as role authenticated with sub=A: `update user_settings set day_marks_started_on='2020-01-01'` succeeds. Then `delete from user_settings where user_id=A; insert into user_settings(user_id,first_opened_at) values (A,now())` succeeds, and day_marks_started_on returns to NULL. R3 (the coverage rule that is not supposed to be restorable by clearing marks), the D14 invariant that a retried onboarding-default POST can never re-open an account the person already decided about, and an active shopping focus can all be reset from PostgREST. The same delete also fires taste_chip_holds_release_row and wipes the sync-visible settings row.
- **Fix:** `revoke delete on public.user_settings from authenticated` (account deletion goes through auth.users cascade). Also revoke INSERT, or restrict it to the first row by column grants. Add a guard that makes day_marks_started_on server-written, as shopping_focus is.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A148 — change_log and change_seq are owner-writable, so the sync feed can be forged even if target_profiles is locked down
- **Where:** `supabase/migrations/20260911000500_rls.sql:12`
- **Area:** security; **category:** rls-server-owned-table
- **Defect:** change_log (the feed that sync_changes returns to every device) and change_seq (the per-user sequence counter) get the pattern-1 `for all` owner policy and full DML grants to authenticated. Both are written only by SECURITY DEFINER server paths (apply_sync_op, approve_target_proposal, the _taste_chips_write and save_food_note functions, etc.).
- **Failure scenario:** As user A over PostgREST: `insert into change_log(user_id,seq,entity,entity_key,rev,op,current) values (A,900000,'target_profiles',gen_random_uuid()::text,1,'create','{"kcal_train":900,"kcal_rest":900}')` succeeds, and `sync_changes(A,0,100)` then returns that row to every device. The phone mirrors target_profiles rows from the feed into Settings.activeTargetProfile and the history cache, so display targets are poisoned. This holds even after target_profiles direct writes are revoked. A forged high seq, or an UPDATE of change_seq.next_seq to a lower value, also makes the next next_change_seq() collide with the (user_id, seq) key. apply_sync_op then fails for that account permanently.
- **Fix:** Revoke insert, update and delete on change_log and change_seq from authenticated, leaving select on change_log. Leave the policies read-only (`for select`). All writers are SECURITY DEFINER or service_role.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A150 — MCP pre-auth limiter checks the token-hash key before the IP key, so a blocked IP can still force one rate_limits insert per request
- **Where:** `app/api/mcp/route.ts:103`
- **Area:** security; **category:** security
- **Defect:** guarded() calls enforceRateLimit(preIdentityKey) first. That key is per bearer token, `mcp:pre:<sha256>`. Only then does it call the IP key. A caller can send a fresh random bearer each time, so the first check always hits a new key: the per-instance refused map cannot skip it, and rate_limit_hit INSERTs a new row. The IP check refuses only after that. The flood brake therefore never saves the database write, and expired rows are swept only on about 1 hit in 100, at most 200 rows each time.
- **Failure scenario:** An attacker behind one IP sends MCP requests at a high rate, each with a random 'Bearer xyz…'. The IP key goes over its 30/min, and every request returns 429. Every request still does one DB round trip and adds one new rate_limits row. The table and the limiter's Postgres load grow with attacker traffic, not with the 30/min cap. Legitimate rate_limit_hit calls slow down, and limiter errors turn into 503 rate_limit_unavailable on every route (fail closed).
- **Fix:** Check the IP key first, so a refused IP is short-circuited in memory before any per-token key reaches the database. Optionally key the token limit on a truncated hash.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A152 — Coach turn budget is a non-atomic read-then-act that fails open, and POST /api/coach has no per-user limiter
- **Where:** `lib/server/coach.ts:104`
- **Area:** security; **category:** rate-limit
- **Defect:** assertTurnBudget counts today's ok 'coach' rows in ai_calls at turn setup. Each new turn's row is written only after its model call finishes, so concurrent turns all see the same count. A failed read returns without limiting (line 112). The route has only the per-IP flood brake (app/api/coach/route.ts:68, 120/min). Nothing else enforces the documented 10/hour and 60/day per-user budget. This is separate from known #116 (OpenRouter purpose not counted).
- **Failure scenario:** A user at 9/10 for the hour (or a script with their session) sends 20 turns in parallel. Every setup reads 9 ok rows and passes, so 20 model turns run and are billed. Only the $2/day spend cap stops them. The same happens whenever the ai_calls read errors.
- **Fix:** Add a per-user enforceRateLimit after requireUser, e.g. `coach:user:${userId}` at 10/3600, plus a daily key. The DB limiter is atomic and fails closed. Keep the ai_calls count as the 'successful turns' display.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Low / DB (9)

#### A038 — Re-Favor of a family is a silent no-op for a ref minted after the first Favor
- **Where:** `supabase/migrations/20261215090000_favor_food_families.sql:162`
- **Area:** DB; **category:** correctness
- **Defect:** favor_food_families treats a family whose membership row already has status 'eats' as already favored and writes nothing. The same migration changes get_or_create_food_ref so a ref minted after a Favor does not inherit 'eats' (line 251, favor_rev = rev). A family can therefore be 'eats' while some of its current refs have no 'eats' pref. A second Favor skips those refs, and planFavor still reports the family as favorable.
- **Failure scenario:** The user favors 'kiwi' (refs A and B written, favor_rev = rev). Later a new catalog ref C for the kiwi family is minted and does not inherit 'eats'. C becomes an 'Eaten often' item. GET /api/foods/taste returns favorable:true because the family verdict is 'eats' and every member is allowed. The user taps Favor. The RPC finds v_status = 'eats', adds the family to v_favored, writes no user_food_prefs rows and returns status ok. The client shows 'Added to your usual foods', but C is still not Favored. The row keeps offering Favor, and every tap repeats the no-op. The test 'a ref minted after a Favor does not inherit eats' only covers a later ordinary mark, not a second Favor.
- **Fix:** In the preflight, treat a family as already favored only if every ref in the captured set already has an 'eats' pref. Otherwise write the prefs for the missing refs, keeping the membership rev and favor_rev as they are or bumping them. Make planFavor's 'eats' verdict and `favorable` depend on the same per-ref check.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A049 — Accept stores confirmed stock for a line whose need is unknown, because SQL LEAST ignores NULL
- **Where:** `supabase/migrations/20261128090000_recipe_plan_accept.sql:577`
- **Area:** DB; **category:** preview/accept mismatch
- **Defect:** For new and updated lines, confirmed_stock_grams is written as least(needGrams, v_stock). In PostgreSQL, least() ignores NULL arguments. When needGrams is null (unknown raw purchase amount) and the pantry holds stock, the column gets the full pantry stock. The preview (aggregateShopping) sets confirmedStockGrams to null in that case.
- **Failure scenario:** A recipe line has purchase_conversion_status 'unknown' and the pantry holds 200 g of that identity. The preview shows no confirmed stock, and the accept writes confirmed_stock_grams = 200 with need_grams null. The list then shows 200 g in stock against an unknown need, and what was accepted differs from what the user previewed. Related: the same update keeps checked = true when the new need is null, because the SQL comparison with null is not true, while aggregateShopping unchecks it.
- **Fix:** Use case when need is null then null else least(need, v_stock) end for both statements. Set checked = false when the old or new need is null.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A095 — health_ingest_apply correction upsert updates end_time but never start_time or tz
- **Where:** `supabase/migrations/20261013090200_fix_health_dedupe_key.sql:73`
- **Area:** DB; **category:** wrong result / data consistency
- **Defect:** When a sample carries a vendor_sample_id (the Health Auto Export 'hae:<type>:<localDay>' id, and Oura '<doc id>:<type>'), the dedupe key excludes the times. The ON CONFLICT DO UPDATE then refreshes value, unit, end_time, device_label and vendor_updated_at, but leaves start_time and tz from the first version.
- **Failure scenario:** An Oura sleep period or an HAE sleep row is re-exported after it was extended, with an earlier bedtime or a different tz. value and end_time take the new data. start_time stays at the old value, so the stored sample spans a window that never existed. daily_health and weigh_ins bucket by (start_time at time zone tz)::date, so the sample can stay on the wrong local day or tz after a correction, and the duration (end-start) disagrees with value. health_weigh_in's own upsert does update start_time and tz, so the two writers disagree.
- **Fix:** Add start_time = excluded.start_time and tz = excluded.tz to the DO UPDATE SET list. Re-check that the generated dedupe_key is unaffected, since it is vendor-id based on this branch.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A096 — get_or_create_food_ref and favor_food_families take the two clock rows in opposite order, so same-user concurrency can deadlock
- **Where:** `supabase/migrations/20261215090000_favor_food_families.sql:136`
- **Area:** DB; **category:** locking / deadlock
- **Defect:** favor_food_families locks the account's account_rules_clock row FOR UPDATE and then evidence_clock FOR SHARE (lines 136-137). get_or_create_food_ref inserts a food_refs row first. The statement-level trigger evidence_clock_food_refs_ins updates the global evidence_clock row and holds that row lock until commit. It then inserts a user_food_prefs backfill row. The row trigger rules_clock_user_food_prefs updates that user's account_rules_clock row. The order is evidence then rules, the reverse of Favor's rules then evidence.
- **Failure scenario:** The same user taps Favor on a family while another request (a log commit or the sync of a first-use food) mints a new catalog food_ref for that account. Favor holds rules_clock and waits for the evidence share lock. The mint transaction holds the evidence row and waits for rules_clock. Postgres reports 40P01 after the deadlock timeout. If Favor is the victim, the user sees a 500 on Favor. If the mint is the victim, get_or_create_food_ref's 'exception when others' block (line 258) swallows the deadlock and the new ref is left without its inherited family mark.
- **Fix:** Take the clocks in one global order. In favor_food_families, read evidence_clock FOR SHARE before the account_rules_clock FOR UPDATE. Alternatively make the backfill in get_or_create_food_ref run its inserts before the food_refs insert, or narrow its exception handler to catch only unique_violation.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A098 — approve_target_proposal picks the active revision with the database's UTC current_date, not the account's day
- **Where:** `supabase/migrations/20261023090500_approve_proposal_via_revision.sql:26`
- **Area:** DB; **category:** wrong result / timezone
- **Defect:** The floors, goal rate and step cap carried into an approved proposal come from the revision selected by 'effective_from <= current_date'. current_date is the UTC date of the Postgres session. It is also the fallback for effective_from when week_start is null (line 37). The repo rule (lib/server/account-day.ts, t24b) says the server's 'today' for target revisions must be the account's own day, never a deployment-wide default.
- **Failure scenario:** A US-evening user (for example 20:00 PDT, already the next day in UTC) has a revision scheduled for 'tomorrow' in their zone. The approval selects that future revision as v_active, so its kcal_min, protein_g_min, fat_g_min and goal rate become the carried-over floors. The correct in-force revision, today's, is ignored. An approved proposal can then be written with floors from a revision that is not yet in force.
- **Fix:** Have the service pass the account-day date as a parameter, or compute it in SQL from user_settings.time_zone with a pg_timezone_names check, and use that in both places.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A107 — full-week accolade can only be granted by a sync call made on the Sunday itself
- **Where:** `supabase/migrations/20261225090300_care_accolades.sql:173`
- **Area:** DB; **category:** spec-mismatch
- **Defect:** The rule is defined as 'a retained meal on all seven dates of a completed local week'. The grant is only evaluated when `p_local_date = v_today` and `isodow(p_local_date) = 7`. Once Sunday has passed, no later sync can ever grant it.
- **Failure scenario:** A user logs Monday to Sunday but does not open the care or accolades endpoint until Monday. `care_accolades_sync` runs with a Monday date, the Sunday branch is skipped, and the full-week accolade is never granted. The same happens if they only open the app Sunday before logging that day's meal.
- **Fix:** Evaluate the previous completed Monday to Sunday week, and the current week once it has closed, on any sync. Grant it with idempotent evidence keyed to the week.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A108 — Care points and accolades sync fail when the phone's day differs from the stored zone's today
- **Where:** `supabase/migrations/20261225090100_care_points_ledger.sql:309`
- **Area:** DB; **category:** correctness
- **Defect:** The phone always sends `?date=<its local day>`, and `resolveCareDay` forwards it as `p_local_date`. `care_points_sync` raises 22023 'future_date' when that date is later than today in the account's stored zone (`_care_effective_zone`). The route maps 22023 to HTTP 400. `readCareShop` on the phone calls points first and returns 'failed' on any non-2xx, so the whole shop and Seeds view fail. `care_accolades_sync` has no 22023 mapping, so the same condition on a later zone-derived path would surface as 502. When the phone's day is behind the stored zone's today, `p_local_date <> v_today` and nothing is minted.
- **Failure scenario:** The stored zone was captured on first sync as America/Los_Angeles. The user travels to Auckland or Tokyo, and the phone's date is a day ahead of the stored zone's today. Every GET /api/care/points returns 400, the shop reads 'failed', and no Seeds can be viewed or spent. In the other direction, with phone-day behind stored-zone, `p_local_date <> v_today` skips every award for that day. The skipped award is never backfilled, because only today's date can mint.
- **Fix:** In `care_points_sync`, ignore a `p_local_date` that is not today in the effective zone and use `v_today` instead of raising. Alternatively, have resolveCareDay derive the date from the stored zone for the sync call, and use the client day only for display or purchase dating.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A161 — AI spend day-row seed charges calls that finish after UTC midnight twice
- **Where:** `supabase/migrations/20261218090100_ai_spend_reservations.sql:144`
- **Area:** DB; **category:** wrong-number
- **Defect:** _ai_spend_lock_day creates a new day's global shard rows and user day row seeded from that day's ai_calls cost. It includes every ai_calls row created that UTC day, including rows that carry a spend_reservation_id for a reservation made the day before. The call ledger inserts the ai_calls row when the call ends (created_at defaults to now()). ai_spend_settle and _ai_spend_reconcile charge the cost to the reservation's own day (r.day). So a call reserved before midnight and finished after it is charged to day D by settle, and charged again to day D+1 by the seed. After the deploy day, every row the seed counts is a cross-midnight row, because any other call that day already has a reservation.
- **Failure scenario:** A coach turn is reserved at 23:59:50 UTC on day D. Its 40 s call settles at 00:00:25 on D+1, and its ai_calls row is written at that time. Settle adds the cost to D. The user's first model call on D+1 then creates the D+1 user row and seeds it with that same cost. If it is also the first reservation of D+1 deployment-wide, shard 0 of the global row is seeded with it too. The user's $2 cap and the $50 global cap on D+1 start with spend that belongs to D, so for heavy users one more call can be refused 'spend_cap'.
- **Fix:** Seed only the ai_calls rows that no reservation will charge: add `and c.spend_reservation_id is null` to both seed sums. Rows that name a reservation are already counted through settle or reconcile on the reservation's day.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

#### A163 — Same-account deadlock: Favor and set_food_membership take account_rules_clock before recipe_plan_state; every user_settings, user_foods and constraint_profiles write takes them in the reverse order
- **Where:** `supabase/migrations/20261128090000_recipe_plan_accept.sql:94`
- **Area:** DB; **category:** deadlock
- **Defect:** Same-event AFTER ROW triggers fire in name order. On user_settings, user_foods, user_food_prefs and constraint_profiles, the 'recipe_state_*' trigger (which locks the account's recipe_plan_state row) sorts before 'rules_clock_*' (_bump_rules_clock, which locks account_rules_clock). So every apply_sync_op settings or food op, taste_chips_confirm, taste_dislike_remove, shopping_focus_set and constraint write locks recipe_plan_state and then account_rules_clock. favor_food_families locks account_rules_clock FOR UPDATE first (20261215090000:136), runs its preflight reads, and then writes user_food_prefs, which locks recipe_plan_state. set_food_membership writes food_membership_revisions (rules clock only) before user_food_prefs, so it takes the same reversed order.
- **Failure scenario:** One account taps Favor on an 'Eaten often' row while a settings op from its phone or a second device is being applied (a water goal, a slot time, a taste-chip confirm, Shopping focus). Favor holds account_rules_clock and waits for recipe_plan_state. The settings write holds recipe_plan_state and waits for account_rules_clock. Postgres aborts one with 40P01, so the Favor POST or the sync op errors, and an op error counts toward the outbox's park attempts.
- **Fix:** Pick one per-account order and enforce it. For example, have favor_food_families and set_food_membership take the account's recipe_plan_state row (insert ... on conflict do update, or select for update) before locking or bumping account_rules_clock. Or rename the triggers so rules_clock_* fires before recipe_state_* everywhere, and audit the explicit locks to match.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); found in the Opus gap round

### Low / UI (2)

#### A032 — Duplicate-capture 409 shows an unrelated or empty draft
- **Where:** `components/CaptureSheet.tsx:271`
- **Area:** UI; **category:** wrong-result
- **Defect:** On a 409 duplicate_request (the same input hash succeeded in the last 10 minutes) settle() calls latestDraft(), which returns the most recently saved localStorage draft of any capture, regardless of method, hash or age. The draft is cleared on commit, so there is usually none; if some other abandoned draft exists, it is shown.
- **Failure scenario:** User logs 'black coffee' by text, commits it (draft cleared), and logs the same text for the same slot again within 10 minutes. The server returns 409, latestDraft() is null, and the sheet shows 'You just sent this. Here it is again.' with no draft, a dead end. If an unrelated earlier unsaved draft is still in localStorage (app killed, never dismissed), that draft is presented as the result and can be saved as the wrong food.
- **Fix:** Store the draft keyed by input hash or request id and return the matching one on a 409. Or have the server return the draft, and exempt committed inputs from the duplicate guard.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A088 — Edit-profile and invite preview ignores the account's stored pace holds
- **Where:** `components/Onboarding/OnboardingSteps.tsx:306`
- **Area:** UI; **category:** spec-mismatch
- **Defect:** PlanStep and OnboardingFlow compute the preview with buildCompletedSettings(base, state, new Date()) and no eligibility. missingProfileFields also demands a pace. For an account holding a stored pace hold (kidney, pregnancy, clinician diet), the screen shows and asks for a deficit/surplus pace, but the server writes a maintenance revision.
- **Failure scenario:** A user with stored 'Pregnant' or kidney disease opens Settings > Edit profile with a lose-fat goal. The Plan step shows a deficit calorie target and protein. After 'Use this plan' the server saves maintenance (and standard protein for kidney), so Today shows different numbers from the confirmed plan.
- **Fix:** Read the stored eligibility (readStoredEligibility) in the legacy flow and pass it to buildCompletedSettings, missingProfileFields and persistCompletedOnboarding.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

### Low / ops (8)

#### A012 — HAE rejected[] indexes refer to folded samples, and empty sleep rows are dropped silently
- **Where:** `lib/server/health-ingest.ts:70`
- **Area:** ops; **category:** correctness
- **Defect:** The 8-day freshness check iterates `result.samples` after foldHealthAutoExportDays has merged rows, then pushes `{ index }` using the position in the folded array. That index is not the payload row index that normalize's other rejections use, so the response mixes two index spaces. Separately, a HAE sleep row with neither `asleep` nor `inBed` is skipped with no rejected entry (normalize.ts sleep branch).
- **Failure scenario:** An export has 10 step rows over 3 days, so 3 folded samples. A stale day is rejected as index 0, 1 or 2, which an exporter or debugger reads as payload row 0-2 and so blames the wrong row. A blank sleep row yields accepted 0 and rejected [], so the user cannot tell why nothing arrived.
- **Fix:** Carry the source row index on each sample through the fold, report that index in rejections, and add a 'no sleep value' rejection.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A073 — Date-only validators accept impossible dates such as 2026-13-01, which then crash the health read
- **Where:** `lib/health/contract.ts:82`
- **Area:** ops; **category:** input-validation
- **Defect:** dailyQuerySchema (and the MCP get_body_data schema) check only the YYYY-MM-DD shape. The span check `(Date.parse(to) - Date.parse(from)) / 86_400_000` yields NaN for month 13, so both `span < 0` and the 90-day guard are false and the request is not rejected.
- **Failure scenario:** GET /api/health/daily?from=2026-13-01&to=2026-13-05 passes validation. mergedDays then calls rawSamples with `new Date(NaN).toISOString()`, which throws RangeError, so the route returns a 500 instead of 400. 2026-02-31 is silently rolled to Mar 3 by Date.parse, so the response days are labelled differently from the request.
- **Fix:** Validate real calendar dates (round-trip through UTC) and reject a non-finite span.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A105 — Non-UUID ids reach Postgres and come back as 500 instead of 400 or 404
- **Where:** `app/api/health/tokens/[id]/route.ts:20`
- **Area:** ops; **category:** validation
- **Defect:** Several id-param routes do not validate the id as a UUID before using it in a uuid-typed query: DELETE /api/health/tokens/[id], POST /api/proposals/[id]/decide, DELETE and PATCH /api/coach/threads/[id], DELETE /api/coach/threads/[id]/messages. Recipes [id] and favorite use `/^[0-9a-f-]{36}$/i`, which accepts a string such as 36 dashes. Postgres raises 22P02 (invalid input syntax for type uuid). The code either rethrows the raw error (health tokens and proposals, which reach jsonError's generic 500 with an 'Unhandled error' log) or wraps it as HttpError 500 (coach thread delete and rename). Scoping by user_id is correct everywhere, so this is not a leak.
- **Failure scenario:** DELETE /api/health/tokens/not-a-uuid returns 500 'Something went wrong' and logs an unhandled error, where the contract says 404 for an unknown source. POST /api/proposals/abc/decide with decision 'reject' likewise returns 500 instead of 400 or 404. DELETE /api/coach/threads/abc returns 500 'Could not delete the thread.' while GET on the same id returns 404. Clients that retry on 5xx will retry forever, and the noisy 5xx can trip error alerts.
- **Fix:** Validate `z.uuid().safeParse(id)` and return 400 or 404 before querying, as the shopping, care-messages and coach/undo routes already do.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A117 — Oura 401 refresh is a no-op, the rotated-token write result is discarded, and rotation is not atomic with the DB write
- **Where:** `lib/server/oura.ts:105`
- **Area:** ops; **category:** retry-idempotency
- **Defect:** Three related problems in token handling. (1) pullTwoDays passes `refresh: () => accessTokenFor(admin, source)`, but accessTokenFor returns the stored access token unchanged whenever its stored expires_at is more than 5 minutes away, so the single refresh-then-retry on 401 never refreshes. (2) The rotation update `.eq('oauth', source.oauth)` has no .select(), and the result is thrown away (`void data`). Zero matched rows is treated as success, and the new pair is lost. If the update errors after Oura has already rotated, the stored refresh token is dead. (3) `source` is a stale snapshot, so a refresh after an earlier in-run rotation re-sends the already-consumed refresh token.
- **Failure scenario:** (1) A user revokes or re-authorises Oura, or the token is invalidated early, while the stored expires_at is still in the future. All three parallel ouraGet calls get 401, 'refresh' returns the same bad token, and the pull fails with 'Oura ... failed with 401' on every cron fire until the stored expiry passes. (2) Oura accepts the refresh and consumes the old refresh token, then the health_sources update fails on a transient DB error (HttpError 500) or the CAS matches nothing. The old refresh token is now invalid at Oura while the DB still holds it, so every later pull fails with exchange_failed until the user reconnects, with no flag or recovery path. (3) When the start-of-pull call rotated the token, a later 401 re-reads the old source.oauth and the exchange fails.
- **Fix:** Give the 401 path a force-refresh mode that ignores the stored expiry. Re-read the source row's current sealed oauth inside accessTokenFor. Serialise refreshes per source (a single in-flight promise). Check the rotation update with .select('id') and treat zero rows as lost, re-reading the stored pair (another worker rotated). Persist the rotated pair with a retry before returning, and mark the source needs-reconnect when it cannot be saved.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** docs/audit/2026-09-13/report.md R6 (CAS result discarded; code defect verified, high impact challenged). Parts (1) and (3) are new.

#### A122 — Backup pages by OFFSET over live tables, so concurrent writes skip or duplicate rows
- **Where:** `app/api/jobs/backup/route.ts:74`
- **Area:** ops; **category:** backup-consistency
- **Defect:** tablePages reads each table with `.order(pk).range(offset, offset+999)` as separate requests against tables being written, with no snapshot and no keyset cursor. The dump header says consistency 'per-request'.
- **Failure scenario:** While the dump is on page 2 of log_entries, a user deletes a row that sat on page 1, or inserts a row with a lower primary key. Every later row shifts by one. The row at the page boundary is skipped on delete, or written twice on insert. The backup is then missing a live row and still reports ok. The window is the whole upload, which grows with data size.
- **Fix:** Page by key (`gt` last primary key, composite keys via tuple comparison or a per-table ordered single key), as keysetRows does.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A123 — Backup has no time budget; at scale it times out every night and stays 'running' for 2 hours
- **Where:** `app/api/jobs/backup/route.ts:58`
- **Area:** ops; **category:** time-budget
- **Defect:** The dump is one streamed upload inside a 300 s function with no deadline or resume. If it takes longer than maxDuration, the function is killed. The catch block that records status 'error' never runs, so the backup_runs row stays 'running'.
- **Failure scenario:** Once the tables are large (change_log, ai_calls and health_samples are unbounded), the 03:45 UTC run is killed at 300 s. No object is written. The lease blocks any manual re-run with a 409 until it goes stale 2 hours later. The next cron fire is the next day. Backups stop with no alert, and the older dumps are the only ones left.
- **Fix:** Track elapsed time and fail the run explicitly (status error, logged) before the platform kill. Shorten the stale lease to a little over maxDuration. Split big tables across runs or move the dump off the function.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed); already known before this audit
- **Known before:** docs/architecture/2026-10-10/scale-review.md (Tier B "Backup function": no capacity proof, OFFSET paging, switch to keyset or pg_dump; observability item: alert on stale backup_runs)

#### A126 — Export meals cursor and coach-undo cursor are interpolated into a PostgREST or() filter without field validation
- **Where:** `lib/server/export.ts:149`
- **Area:** ops; **category:** input-validation
- **Defect:** decodeCursor (lib/server/export.ts:99-113) only checks that local_date, eaten_at and id are strings. applyWindow then splices them raw into `.or(...)`: `local_date.gt.${c.local_date}`, `and(local_date.eq.${c.local_date},eaten_at.gt.${c.eaten_at})`, `... id.gt.${c.id}`. The coach-undo cursor does the same at lib/server/coach-undo.ts:295 with a quoted createdAt that only has to satisfy Date.parse. A caller can put commas, parentheses or quotes in these fields and add their own or() clauses, or produce a non-date value that fails the Postgres cast.
- **Failure scenario:** A signed-in user requests /api/export?kind=meals&cursor=<base64url of {"local_date":"x","eaten_at":"","id":""}>. The filter casts 'x' to a date and Postgres returns 22007, which surfaces as a 500 instead of the 422 'malformed cursor'. A crafted id such as `z),and(local_date.gte.1900-01-01` rewrites the or() group, so the keyset cursor no longer constrains the page. The or() parameter is still ANDed with the RLS and user_id filters, so injection cannot reach another account's rows. The impact is a broken cursor contract and a 500 on bad input.
- **Fix:** In decodeCursor, require local_date to match /^\d{4}-\d{2}-\d{2}$/, eaten_at to be a strict ISO timestamp (or empty) and id to be a uuid or empty. For the undo cursor, parse createdAt strictly (z.iso.datetime) instead of Date.parse.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

#### A133 — Export cursors are interpolated into PostgREST filters and the DB without format validation
- **Where:** `lib/server/export.ts:142`
- **Area:** ops; **category:** input-validation
- **Defect:** decodeCursor for the meals export only checks that the three fields are strings. applyWindow then builds `.or(local_date.gt.${c.local_date},and(...,eaten_at.gt.${c.eaten_at}),and(...,id.gt.${c.id}))` from them. decodeTextCursor for the recipes export is passed to .gt('id', ...) with any string. A caller can put commas, parentheses or non-date text in the cursor. RLS and the .eq(user_id) filters keep this inside the caller's own rows, so there is no cross-account leak.
- **Failure scenario:** The cursor base64url({local_date:'x),y',eaten_at:'z',id:'q'}) makes PostgREST fail to parse the or(...) group. The export answers 500 (throw error) instead of 422 'malformed cursor'. recipes cursor 'abc' against a uuid column also gives 500. The caller can also alter the OR grammar (extra predicates) to bypass the keyset position.
- **Fix:** Validate the cursor shape (date regex plus calendar check, ISO instant, uuid) in decodeCursor, and decodeTextCursor against the expected id pattern, before building filters.
- **Verification:** 2 of 2 checks confirmed (confirmed, confirmed)

# Plausible findings (20)

One check agreed and the other did not. None is confirmed. Check each before acting.

#### P01 — Caller-side aborts are recorded as `timeout` rows and count toward the shared provider circuit
- **Where:** `lib/ai/call.ts:71`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** A caller abort (`callerAborted`, or `turnAborted` in `generateGrounded`) is a named `AbortError`. `classifyFailure` maps every AbortError to `timeout`. `circuit.ts` counts `timeout` rows in `PROVIDER_FAILURES`, per provider and model across all users, and opens the circuit at 5 in 10 minutes. A user or coach-turn abort is therefore indistinguishable from a provider stall in the ledger.
- **Failure scenario:** The coach turn aborts its lookup hop through `turnAborted` whenever the tool batch stops waiting (`generateGrounded` passes `args.signal`). Five such aborts in 10 minutes, from any accounts, write five `timeout` rows for `google` / `gemini-3.8-flash`. `assertCircuitClosed` then throws 'circuit open' for every user's lookup. That model is also the capture pin and the converse fallback, so capture and coach calls are refused until the window passes. The same applies to Jev calls with a caller signal: five cancelled requests open the Jev circuit for everyone.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The mechanism is real: mid-attempt caller aborts are recorded as `timeout` by `classifyFailure`, and `timeout` counts toward the circuit. But this is deliberate, tested behaviour, and the failure scenario does not hold. - `turnAborted` in `lib/ai/gemini-grounded.ts` is documented as "A turn abort, as the AbortError `classifyFailure` reads as a timeout". - `lib/ai/adapter.test.ts` (about lines 585-600) assert...

#### P02 — Eats-set reads are one unbatched .in() over every ref id, so a large Favored/Eats set can fail the eligible endpoint
- **Where:** `lib/server/eligible-foods.ts:93`
- **Area:** feature accuracy; **category:** scalability
- **Defect:** eligibleFoods passes the whole Eats ref list to a single food_refs `.in("id", refIds)`, and again to `.in("catalog_food_id", catalogIds)`. The same pattern is in meal-snapshot.ts snapshotFoods (lines 97-99, 120) and in loadSuggestionEvidence (lib/coach/suggest-policy.ts:105 and the revision and food-key reads). The rest of the codebase batches id reads at ID_BATCH = 100, documented as 'well under any gateway's request-line limit', and uses readByIdBatches or fetchAllChunked.
- **Failure scenario:** An open-world account with many Favored families accumulates a few hundred Eats refs (set_food_membership alone writes up to 50 refs per family). A 300-uuid `.in()` is a URL of about 11 KB. A gateway or PostgREST request-line limit rejects it, so eligibleFoods throws. GET /api/foods/eligible (v1, v2 and v3), candidateFoods and the taste and Favor paths that call it then answer 5xx or 503. The account gets no new suggestions at all, with no partial result.
- **Fix:** Use readByIdBatches/fetchAllChunked for the food_refs, catalog_food_revisions and user_food_prefs reads in eligibleFoods, snapshotFoods and loadSuggestionEvidence.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: Code confirmed: eligible-foods.ts:93 and :105 issue single unbatched .in() over all Eats refIds and catalogIds (also meal-snapshot.ts:99,100,123 and suggest-policy.ts:99-126), while date-chunks.ts defines ID_BATCH=100 with readByIdBatches for exactly this. No cap on Eats ref count found, and a failed read throws with no partial fallback. The actual gateway rejection at ~11KB URLs could not be exercised rea...

#### P03 — Pantry items set to 0 g still count as on hand for shopping focus and 'Use what I have'
- **Where:** `lib/server/shopping-focus.ts:76`
- **Area:** feature accuracy; **category:** wrong result
- **Defect:** The pantry reads for focus keys and for on-hand foods select every live row inside the 14-day box. They ignore confirmed_grams. The pantry API accepts confirmedGrams 0 (nonnegative), which is how a user says the stock is used up, and the planner treats 0 g as no stock (confirmedGrams > 0 everywhere in aggregate.ts and planner.ts).
- **Failure scenario:** A user sets rice to 0 g in the pantry after finishing it. For the next 14 days with focus on, plates containing rice get list/pantry coverage, and 'Use what I have' suggests rice. The shopping planner meanwhile says the pantry has none.
- **Fix:** Skip pantry rows with confirmed_grams equal to 0 in both reads. Treat null (unknown amount) as the owner decides.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The code reads are as described. shopping-focus.ts:75-78 and plan-on-hand.ts:56-61 do not filter on confirmed_grams, and the migration check allows >= 0. But the owner spec (docs/specs/phase-18-open-world-foods.md D7, line 352) defines the pantry signal as "14 days after confirmed_at; confirming again restarts it; deleting ends it". Grams are not a condition, and only deletion ends the signal. Pantry photo r...
- **Known before:** Spec D7 (docs/specs/phase-18-open-world-foods.md:352) defines the pantry time box by confirmed_at and deletion only; no grams condition.

#### P04 — Account with 14+ counted days but no valid observation is reported `held` at the seed instead of `starting` with a null number
- **Where:** `lib/expenditure.ts:435`
- **Area:** nutrition accuracy; **category:** spec-mismatch
- **Defect:** E2 says `starting` applies with fewer than 14 qualified days, or no valid observation yet. In that phase `tdeeKcal` is null and the status is `burn_in`, so the card shows "From your profile". The code returns `status: held`, `phase: provisional` and `tdeeKcal = roundKcal(seed)` for an account that has 14+ counted days but has never had a valid window. A new account that logs food but never weighs is the typical case.
- **Failure scenario:** A user logs 20 complete days and never weighs. The engine returns held/provisional with tdeeKcal = the formula seed and the reason "Holding the starting estimate - ...". In components/TdeeLines.tsx, `learnedLine` labels any `held` row with a non-null tdee as "Last learned" and "Holding steady". The UI therefore shows the formula number as something the app learned.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I traced this by reading the code. I did not run a snippet. The engine does what the finding says, but the UI impact is overstated. **Confirmed.** In `lib/expenditure.ts`, `estimateExpenditure` returns `burn_in` / `starting` / `tdeeKcal: null` only when lifetime qualified days are below 14. Take an account with 14 or more counted days and no weigh-ins, so the 14-day and 28-day windows are both invalid. The...

#### P05 — Recipe catalog cap counts every historical revision, so republishing can take the whole recipe catalog offline
- **Where:** `lib/recipe-catalog/repository.ts:91`
- **Area:** feature accuracy; **category:** latent outage
- **Defect:** searchCatalog() pages all rows of recipe_catalog_revisions (superseded and withdrawn included) against a hard cap of 64. hydrate() then drops every non-current revision. Selections hold foreign keys to old revisions, so old revisions must stay in the table.
- **Failure scenario:** The 24-recipe pilot has headroom now. Once enough recipes get new revisions (for example 24 recipes with 3 revisions each = 72 rows), searchCatalog throws 503 recipe_catalog_cap. Search, detail-by-search, the shopping planner and the coach all fail, although fewer than 64 recipes are published.
- **Fix:** Filter to current revisions (join to recipe_catalog.current_revision_id and publication_state = 'published') in the query, or apply the cap after hydration.
- **Verification:** 1 of 2 checks confirmed (confirmed, refuted). Treat as unproven.
- **Refute check said:** refuted: The premise fails. searchCatalog runs on the signed-in user's Supabase client, not the admin client. The callers (app/api/recipes/route.ts, lib/server/recipe-plan.ts, lib/server/coach-ports.ts) pass that auth client; recipe-plan.ts:113 says "All account reads above use the auth client". Row-level security on recipe_catalog_revisions (migration 20261127090000_recipe_catalog_shopping.sql:403-406) lets authenti...

#### P06 — Every sync pass triggers an uncoalesced, unthrottled full server snapshot recompute on Today
- **Where:** `app/page.tsx:278`
- **Area:** UI; **category:** perf-request-storm
- **Defect:** Today re-runs `loadEligibleLocalFoodIds` on every SYNCED_EVENT with no dedupe, throttle or in-flight coalescing. Every sync pass dispatches SYNCED_EVENT in its `finally`, including no-op passes. Only an open-world v3 snapshot can be served from a held copy. Closed accounts store a v2 snapshot, and `heldOpenSet` rejects anything that is not v3, so they always do a network round trip.
- **Failure scenario:** A closed-world user ticks four meals in a row, or switches back to the app. Each save triggers a sync pass 1.5 s later (SAVE_DEBOUNCE_MS), and a `runAgain` pass follows. Each pass dispatches SYNCED_EVENT, so each one fires GET /api/foods/eligible?v=3. The server runs `mealSnapshot`, which does a paged Eats read, a policy-evidence load, 90-day history affinity and the facets read. There are also two rate-limit RPCs per request. In-flight requests overlap, because `latestRead` only discards stale results and does not cancel them. The route allows 30 requests per minute per user, so a burst yields 429s. `readEligible` then sets `starterGate` to 'unavailable', and the 'Couldn't check your food rules' / retry notice shows on Today.
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I traced this by reading the code. I did not run it. The mechanism is real, but the 429 consequence is overstated. Confirmed: - app/page.tsx registers `readEligible` on SYNCED_EVENT. It has no throttle, no dedupe and no in-flight coalescing. `latestRead` only discards stale results. - lib/sync/client.ts:522 dispatches SYNCED_EVENT in a `finally` after every pass, no-op passes included. - In lib/foods/eligi...

#### P07 — Pulling plan days costs one full-store parse and write plus a whole-outbox read per change
- **Where:** `lib/sync/plan-days.ts:29`
- **Area:** sync; **category:** perf-quadratic
- **Defect:** `applyPulledPlanDay` runs once per pulled plan_days change. Each call does `getAll()` on the whole outbox to look for one pending op. It then calls `loadStore()`, which re-reads localStorage and does `JSON.parse` plus `normalizeStore` on every call, and `saveStoreFor`, which does a full `JSON.stringify` and `setItem` of the whole store. The cost per change grows with the store size and the outbox length, so a bulk pull is quadratic.
- **Failure scenario:** A new device, or one that cleared its cursor, pulls a year or more of plan_days in 500-row pages. Every row triggers an outbox scan, a full-store parse and a full-store write to localStorage on the main thread. The first sync freezes the UI for seconds. The same holds for `restoreCachedPlanDays` at startup (lib/sync/plan-cache.ts:27 reads the entire outbox per cached day).
- **Fix:** Not recorded by the finder. Owner to decide.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I traced the call path in the code and did not run a timing repro. The code does what the finding says. In lib/sync/client.ts:263-264 the pull loop awaits `applyPulledPlanDay` once per plan_days change. Each call (lib/sync/plan-days.ts:28-31) does a whole-outbox `getAll()`. It then calls `loadStore()`. In lib/store.ts, `loadStore` returns the cache only for an unbound account or after a failed persist. Oth...

#### P08 — media-sweep deletes any storage path named in a media_objects row, and users can insert such rows for arbitrary paths
- **Where:** `supabase/migrations/20260920090100_phase4_media_bucket.sql:28`
- **Area:** security; **category:** security-tenancy
- **Defect:** The media_objects_rw policy lets an authenticated user insert or update rows where user_id equals their own id. The path column is the primary key and nothing ties it to the user's folder, and created_at and entry_id are also writable. app/api/jobs/media-sweep/route.ts selects unattached rows older than 24h and calls deleteMedia(admin, row.path), which removes objectKey(path) from the bucket with the service-role client. It never checks that the path starts with the row's own user_id. A user can also set entry_id on their own rows to exempt them from the sweep.
- **Failure scenario:** Account A inserts a media_objects row with path = 'media/<B-uid>/<known-uuid>.jpg', user_id = A, created_at backdated more than 24h and entry_id null. The next daily sweep deletes B's stored capture image. This needs B's object path (a random uuid), so it is not practically guessable today. The sweep still lets a row owner trigger a service-role delete outside their own folder, which is a missing owner binding.
- **Fix:** Select user_id with path in the sweep and skip, with an error log, any row whose objectKey does not start with `${user_id}/`. Add a CHECK constraint or WITH CHECK clause that path starts with 'media/' || user_id || '/'. Also consider restricting the storage.objects media_own_folder policy to select/delete, since direct client uploads skip the media_objects row and the sweep.
- **Verification:** 1 of 2 checks confirmed (confirmed, refuted). Treat as unproven.
- **Refute check said:** refuted: The missing binding is real. The media_objects_rw policy only checks user_id, nothing ties path to the user's folder, and deleteMedia in lib/server/media.ts removes any path with the service role. But the stated attack does not work. path is the table's primary key. signUpload inserts a media_objects row for every object before it creates the upload URL, and the sweep only tombstones rows (deleted_at), never...

#### P09 — Restore op on a missing local row can roll the cursor back to -1 and break pull permanently
- **Where:** `lib/sync/outbox.ts:261`
- **Area:** sync; **category:** watermark
- **Defect:** For a restore that the server treats as an idempotent no-op, apply_sync_op returns seq = coalesce(max(change_log.seq ...), 0). The client does `setCursor(h, result.seq - 1)` when `!local`. With seq 0 the cursor becomes -1, and /api/sync/changes rejects since=-1 (`^\d+$`) with 400. The pull then throws every pass, and because pull runs before push, sync stops entirely. Even for a normal seq it rewinds the cursor to just before that entity's last change and re-downloads the whole feed since then.
- **Failure scenario:** A restore op is acknowledged for a live row that has no change_log rows (a directly written row) and no local mirror row. The cursor is set to -1 and every later syncOnce fails at pull with 400 `since must be a non-negative integer`.
- **Fix:** Clamp with Math.max(0, result.seq - 1), and only rewind when result.seq > 0.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The seq-0 branch cannot be reached through the sync path, and the ordinary rewind is deliberate. The only way to get seq 0 is a restore on a live row with no change_log rows. A client only queues a restore after it has seen or made a tombstone. The client gets a tombstone from its own delete op or from a pull, and both write a change_log row. Nothing prunes change_log: I found no migration that deletes from ...

#### P10 — Signed upload URL is documented as 60 s but Supabase issues a 2-hour token
- **Where:** `lib/server/media.ts:65`
- **Area:** ops; **category:** upload-expiry
- **Defect:** `signUpload` returns `expiresInSeconds: 60` and `SIGNED_UPLOAD_SECONDS = 60`. `createSignedUploadUrl` takes no expiry option, and the token it returns is valid for the Storage default of about 2 hours. The row stores the declared size, but the real upload can be any size up to 8 MB.
- **Failure scenario:** A leaked or logged upload URL stays usable for about 2 hours, not 60 s. The client trusts the 60 s figure and the declared `bytes` is only a claim, so the `media_objects.bytes` accounting can be wrong by up to 8 MB per object.
- **Fix:** Stop reporting a fixed 60 s, or enforce it on the server. Treat `bytes` as advisory, or read the real size from storage metadata when the row is attached or swept.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The technical claim is accurate: createSignedUploadUrl takes no expiry, so the 60 s figure is only a label and the token lives about 2 hours. This is not a new bug, though. The 2026-09-13 audit (docs/audit/2026-09-13/findings-full.json ~3755-3765) reported the same finding, and docs/plans/2026-09-11-phase-3-4/lane-M-capture-server.md:3462 (Open Question #1) records the decision "accept as documented". The en...
- **Known before:** docs/audit/2026-09-13 (findings-full.json, same finding) and docs/plans/2026-09-11-phase-3-4/lane-M-capture-server.md Open Question #1 ("accept as documented")

#### P11 — client_timings check constraints re-added without NOT VALID, a full-table scan under ACCESS EXCLUSIVE with no lock or statement timeout
- **Where:** `supabase/migrations/20261229090000_client_timings_plan_chips.sql:8`
- **Area:** DB; **category:** migration safety
- **Defect:** The migration drops and re-adds client_timings_path_check and client_timings_step_check as ordinary validated CHECKs. ADD CONSTRAINT then scans the whole table while holding ACCESS EXCLUSIVE. client_timings is the append-only telemetry table that every capture, scan, log and coach hop writes to. The file also lacks the 'set local lock_timeout / statement_timeout' preamble every other recent migration uses. Its header claims 'Live-safe: a check widened, no data moved', which is false for the lock.
- **Failure scenario:** With a large client_timings table, the migration blocks every concurrent POST /api/timings insert for the duration of two full scans. With no lock_timeout it can also queue behind a long-running reader. While it waits, it blocks all new inserts behind itself, the lock-queue convoy.
- **Fix:** Add 'set local lock_timeout = 3s' and use 'add constraint ... not valid', then validate in a follow-up file. Because the constraints are only widened, existing rows already satisfy them.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The mechanics are true. The migration re-adds validated CHECKs, which scan the table under ACCESS EXCLUSIVE, and it has no lock_timeout. But the claimed failure does not hold up in practice. - The same drop-and-add pattern was already used on this table in 20261021090000_client_timings_dictation.sql and 20261023092000_client_timings_attach_step.sql. No ruling or audit flags it. - The table holds only short, ...
- **Known before:** Same pattern in migrations 20261021090000 and 20261023092000, already applied.

#### P12 — Oura 401 refresh path cannot actually refresh and can silently drop rotated tokens
- **Where:** `lib/server/oura.ts:133`
- **Area:** ops; **category:** correctness / race
- **Defect:** pullTwoDays fires three ouraGet calls in Promise.all, each with `refresh: () => accessTokenFor(admin, source)` using the ORIGINAL `source` snapshot. accessTokenFor only exchanges when the snapshot's expires_at is within the skew; otherwise it returns the same (rejected) access token, so the 'one refresh then retry' on 401 retries the same bad token. If the token was near expiry, up to four concurrent exchanges reuse the same single-use refresh token (the initial call plus three 401 refreshes). The CAS write `.eq('oauth', source.oauth)` has its result discarded (`void data`), so when it matches 0 rows (a concurrent rotation or reconnect already changed the column) the newly issued pair is returned but never stored.
- **Failure scenario:** Oura invalidates an access token early (revocation/clock skew) while expires_at still looks valid: all three requests 401, the refresh callback returns the same token, the pull throws 'Oura daily_activity failed with 401' every day and the cron marks the source as failed/retry forever. Separately, after a rotation lost the CAS race the DB still holds a consumed refresh token, and the next pull fails exchange_failed until the user reconnects.
- **Fix:** Give accessTokenFor a `force` flag used by the 401 callback, share one in-flight refresh promise per source within a pull, serialize the three reads (or refresh once up front), and check that the CAS update matched one row (re-read the winner's tokens when it did not).
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I confirmed this by tracing the code in lib/server/oura.ts and lib/oura/client.ts. I did not run a repro snippet. 1. The 401 refresh does not refresh. pullTwoDays passes `refresh: () => accessTokenFor(admin, source)` (oura.ts:133), and `source` is the original snapshot. accessTokenFor (oura.ts:105-107) returns `current.access_token` unchanged whenever the snapshot's expires_at is outside the skew window. N...

#### P13 — Gemini provider error detail (300 chars) is persisted and logged
- **Where:** `lib/ai/adapter.ts:105`
- **Area:** security; **category:** error-body-privacy
- **Defect:** geminiHttpError appends detail.trim().slice(0,300) from the SDK error message to the ProviderHttpError. That message becomes ai_calls.error (call.ts:297, recorded verbatim) and is logged in plan-inspire, plan-document and pantry-photo. Gemini 400/INVALID_ARGUMENT messages can describe or quote the offending request part. The calls carry health context, food photos and documents. The OpenRouter transport was changed to status-only for exactly this reason.
- **Failure scenario:** A Gemini 400 for a coach, document or photo call includes a fragment of the user's text or filename. The first 300 chars of it land in ai_calls.error and in server logs.
- **Fix:** Keep the status and the provider's error code only, or redact. If provider detail is needed for debugging, store a short allowlisted reason.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I confirmed the code path by reading it. I did not run it live, and I could not show that Gemini actually quotes user content. `geminiHttpError` (lib/ai/adapter.ts:101-106) appends `detail.trim().slice(0,300)` from the SDK error message to the `ProviderHttpError`. `callModel` (lib/ai/call.ts:297) passes `lastError.message` unchanged to `record(...)`, so it reaches `ai_calls.error`. The same message is prin...

#### P14 — Deployment-wide HEALTH_TZ is applied as a day/week zone to accounts with no stored time_zone
- **Where:** `lib/server/jobs.ts:151`
- **Area:** determinism; **category:** date-of-day
- **Defect:** weekStartOf, todayIso and accountZones resolve a null user_settings.time_zone to process.env.HEALTH_TZ before UTC. timeZoneFor in lib/server/expenditure.ts (line 54) and the HAE ingest in lib/server/health-ingest.ts (line 77) do the same. The account-day contract (lib/server/account-day.ts header, t24b) forbids this: HEALTH_TZ is one account's personal zone applied to every other account. The estimate and weekly-proposal jobs were moved to resolveAccountDay, but the weekly-review due test and week boundary, the weekly-proposal week boundary and the ingest bucketing still read it. docs/features.md F-160 describes the HEALTH_TZ fallback, so this may be accepted legacy behaviour.
- **Failure scenario:** With HEALTH_TZ=America/New_York in production, an account in Tokyo whose time_zone is still null (never opened online) gets its Sunday 18:00 review at New York's Sunday evening. Its weekly_proposal week_start is computed in New York time while the same job's asOf and estimate use UTC (weekly-proposal/route.ts lines 130-133). Health Auto Export samples for that account are bucketed to New York days.
- **Fix:** Drop HEALTH_TZ from these chains and use the same stored zone, request zone, then logged-UTC order as resolveAccountDay. Use one resolved zone for both weekStart and asOf in weekly-proposal.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The code does what the finding says. weekStartOf, todayIso, accountZones, timeZoneFor and the HAE ingest all fall back from a null stored zone to HEALTH_TZ, then UTC. I don't treat that as a bug, for three reasons. (1) docs/features.md F-160 documents this fallback ("user_settings.time_zone, else HEALTH_TZ, else UTC") as the intended behaviour for the weekly-review due test and week boundary, and the HEALTH_...
- **Known before:** docs/features.md F-160 (documented HEALTH_TZ fallback); account-day.ts t24b scopes the HEALTH_TZ ban to target revisions

#### P15 — Coach role save sends a stale whole-row pref and can revert an Avoid mark (or recreate a removed food)
- **Where:** `lib/coach/role-advice.ts:139`
- **Area:** AI/tool calling; **category:** sync-merge / safety-rule
- **Defect:** persistStoredRole builds a whole-row user_food_prefs update from the IndexedDB mirror row: status, no_cook and note are copied from it, with base_rev set to the mirror's rev. The mirror is not refreshed when another device marks the food. set_food_membership writes user_food_prefs but inserts no change_log row, so other devices' mirrors keep the old status. The server's user_food_prefs upsert replaces status from the payload. On the resulting conflict, mergeEntity does newer-client_ts-wins per field, so the stale status wins.
- **Failure scenario:** Device A's mirror holds pref {status:'eats', rev:3} for a food. On device B the user marks it Avoid at 10:00; set_food_membership bumps the server pref to rev 4 with status 'avoid'. At 10:05 the user confirms a role on A through the coach. The op carries status:'eats' with base_rev 3, so it conflicts. local = {...mirror, ...payload} has client_ts 10:05, newer than the server's updated_at of 10:00, so 'eats' wins. The rebased op overwrites the pref and the food is eligible again although food_membership_revisions says avoid. If B instead set the food to neutral, set_food_membership deleted the pref row. A's op then gets 'gone', and onGone re-queues it as a create with base_rev null, so the deleted pref comes back with the stale status.
- **Fix:** Send the role-only payload {role} (the server already special-cases it with rev = p_rev - 1 and food_role_conflict), or re-read the pref from the server before enqueueing. Do not carry status in a role write.
- **Verification:** 1 of 2 checks confirmed (confirmed, refuted). Treat as unproven.
- **Refute check said:** refuted: The only caller of persistStoredRole is confirmMealComponentRole, and applyFoodListMark in lib/coach/apply-prefs.ts calls that immediately after this device applied its own food-membership mark. The status in the role payload is therefore the mark this device just made, not a mirror row left over from earlier. The finding's scenario, a role confirmed 5 minutes later from a stale mirror, does not match the ca...

#### P16 — coach_messages and coach_threads are client-writable although record_coach_undo and taste_chips_confirm treat message tool_calls as server proof
- **Where:** `supabase/migrations/20261210090300_coach_action_undos.sql:128`
- **Area:** security; **category:** rls-server-owned-table
- **Defect:** coach_messages carries pattern-1 owner `for all` DML (with a thread-owner check only). record_coach_undo (the `tool_calls.actions` and `tool_calls.composed` match) and taste_chips_confirm (the `tool_calls->'tasteChips'` proposal check) treat a stored assistant message as proof that the coach issued an action or card. A user can insert their own assistant message with any tool_calls, model_id, ai_call_id or provenance.
- **Failure scenario:** A user inserts an assistant coach_messages row with tool_calls {actions:[{actionId:'forged-1',kind:'log_water',...}]}. record_coach_undo then passes the unknown_action gate and reaches the target comparison (local run returned target_mismatch instead of unknown_action). With a fully consistent forged action, a coach Undo record can be created for any action, and taste_chips_confirm accepts any coach proposal. The server-recorded Undo and the chip-proposal checks therefore prove nothing against a hostile client. The impact stays within the caller's own data.
- **Fix:** Restrict authenticated to select, plus insert of role='user' only (WITH CHECK role='user' and tool_calls is null). Write assistant rows through the service role.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The premise is true. The coach_messages_rw policy in supabase/migrations/20261103090100_same_owner_references.sql (lines 394-401) lets a user insert, update or delete their own rows, so a user can forge an assistant message with any tool_calls. This is not a defect, because the forgery gains the user nothing. The finding's own impact line concedes this: it stays within the caller's own data. record_coach_und...

#### P17 — health_sources is owner-writable, so ingest tokens can be minted, un-revoked or retargeted outside the issuance route
- **Where:** `supabase/migrations/20260911000500_rls.sql:12`
- **Area:** security; **category:** rls-server-owned-table
- **Defect:** health_sources (token_hash, revoked_at, kind, oauth, time_zone) has the pattern-1 owner policy with full DML for authenticated. Tokens are meant to be issued only by POST /api/health/tokens (20 per hour, server-side hash). That row is the bearer credential that resolveSourceByToken checks.
- **Failure scenario:** With a stolen browser session JWT, an attacker can `update health_sources set revoked_at=null` on the user's own revoked source, or insert a source with a token_hash they chose. The route's issuance limit, kind allow-list and one-time reveal are then bypassed. The oauth column can be overwritten with junk sealed values, making the oura-pull job error for that source. Local test: `insert into health_sources(user_id,kind,token_hash) values (A,'manual','\x0102')` returned an id as authenticated.
- **Fix:** `revoke insert, update, delete on health_sources from authenticated`, and keep a select policy. The app already uses adminClient for every write.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The grant is real, but it is documented, owner-scoped, and gives no new capability. Migration 20260925000000_phase5_health_ingest.sql:26 states that health_sources keeps its Phase 0 _rw policy because the owner manages her own sources. That migration revokes writes only on health_samples and ingest_events. All of that is deliberate. A browser session with RLS can only touch rows where user_id equals auth.uid...

#### P18 — Out-of-scope coach actions are dropped silently, so the claim check ends the turn with a wrong 'tell me the amounts once more' reply
- **Where:** `lib/server/coach-turn/final-step.ts:57`
- **Area:** AI/tool calling; **category:** correctness
- **Defect:** actionsInScope drops every action the ask box's scope does not allow, and adds no clarification. The prose still claims the write, so verify flags a claim with no action (final-step.ts:174-182). The turn spends a correction round asking the model to resend the action (final-step.ts:186-191). The resent action is dropped by the same filter, so claimWithoutAction is set (final-step.ts:193). modelReply then replaces the reply with 'I have not logged that yet. Tell me the amounts once more and I will.' (reply.ts:37). That text is wrong for every action kind except log_meal, and resending can never succeed from that scope.
- **Failure scenario:** On the Foods tab ask box (scope page:foods), the user types 'log two eggs for breakfast'. The model returns log_meal with 'Logged 2 eggs.' log_meal is not in PAGE_KINDS.foods (scope.ts:28-29), so it is dropped. Verify flags the claim, and a second billed model round produces the same action, which is dropped again. The user reads 'Tell me the amounts once more and I will.' They repeat the amounts and get the same answer every time. The same happens on a meal card when the user names another slot or date, or asks for water or weight.
- **Fix:** When actionsInScope removes actions, record a scope clarification (e.g. 'That has to be done from Today' or the global coach) in state.actionClarifications. That stops the claim-correction loop and tells the user where the action can be done. Also word the claimWithoutAction copy per action kind rather than always about logging amounts.
- **Verification:** 1 of 2 checks confirmed (uncertain, confirmed). Treat as unproven.
- **Refute check said:** confirmed: I traced the path in the code but did not run it. The defect is real, though the scope guidance should make it uncommon. 1. final-step.ts:57 filters the actions with `actionsInScope` and pushes no clarification when it drops one. Nothing else in lib/ or app/ handles a scope drop. 2. `log_meal` is not in `PAGE_KINDS.foods` (scope.ts:28-29), so on the Foods page the action is dropped. `state.actions` ends up...

#### P19 — /api/coach/transcribe has no per-user limit; only a 120/min per-IP brake bounds a signed-in user's paid transcriptions
- **Where:** `app/api/coach/transcribe/route.ts:27`
- **Area:** security; **category:** rate-limit
- **Defect:** The route rate-limits only `coach:transcribe:pre:ip:<ip>` before identity. Once requireUser passes it never applies a per-user key. Each call downloads the user's audio and runs up to three paid model attempts: Gemini primary, Gemini backup and OpenRouter (coach-transcribe.ts:119-154). Capture and coach turns have per-user budgets, but transcription has none apart from the daily spend cap.
- **Failure scenario:** One account, or a client looping on a failing upload, calls transcribe from several IPs (mobile network changes, or a script with the session JWT). Each IP allows 120 calls a minute. The account can use its whole $2 daily spend in minutes. After that every other AI feature (capture, coach, Plan sheet) answers 429 spend_cap for the rest of the day.
- **Fix:** After requireUser, add `await enforceRateLimit(`coach:transcribe:user:${userId}`, N, 60)` with a small N, e.g. 10/min, plus a daily cap like capture's.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The facts are right but they do not make a real defect. app/api/coach/transcribe/route.ts only applies the per-IP key `coach:transcribe:pre:ip:<ip>` (120 per 60 s) before requireUser, with no per-user key. The attempt chain in lib/server/coach-transcribe.ts is also as described: Gemini, then the backup or OpenRouter. The claimed impact does not hold, for four reasons. 1. The spend cap is the intended per-use...

#### P20 — Marking one back-dated day as 'fully logged' moves day_marks_started_on to that date and stops every unmarked day since then from counting
- **Where:** `supabase/migrations/20261209090100_plan_days_day_complete.sql:55`
- **Area:** DB; **category:** correctness
- **Defect:** The trigger sets user_settings.day_marks_started_on to the MARKED day's local_date, and moves it earlier whenever an older day is marked. It does not record when marking began. isQualifiedDay (lib/expenditure.ts:144) then refuses every unmarked day on or after that date. DayCompleteControl offers the mark on any past day that has food logged (showsDayComplete: date <= today). So one tap that vouches for an old day stops all the coverage-complete days between that date and today from counting. Before the tap the user had not started marking, so those days were never suspect under R3, whose stated purpose is 'the date marking began'.
- **Failure scenario:** An account has logged complete days for 70 days and has never marked one. Its estimate is adaptive at 2000 kcal and eligible for a proposal. The user scrolls back 45 days and taps 'I logged everything I ate that day'. The trigger sets day_marks_started_on to that date. Every unmarked day of the last 44 is now disqualified. The next nightly estimate drops to status 'held' at the seed (1700), proposalEligible false, reason 'Holding the starting estimate — 0 of 10 counted days in the last 14'. Clearing the mark cannot undo this. The same happens to an account already marking daily that later vouches for an older day: the coverage days before its real first mark stop counting, which lowers lifetime counts and the data weight.
- **Fix:** Record when marking began, not the earliest marked date. Use the server's account-local date at the first mark (for example, least of current account day and existing value, never a back-dated local_date), or require the marked date to be today or yesterday when it would start the rule. If the owner wants the current semantics, the control must warn before a back-dated first mark.
- **Verification:** 1 of 2 checks confirmed (refuted, confirmed). Treat as unproven.
- **Refute check said:** refuted: The behaviour is the documented design, not an accidental defect. The migration comment (supabase/migrations/20261209090100_plan_days_day_complete.sql) says the column "is set from the earliest marked local date and never moves later". The trigger implements that, and AGENTS.md says the same: the trigger "stores the first-ever marked date ... which only moves earlier". Ruling R3 (docs/decisions/2026-10-04-ad...

