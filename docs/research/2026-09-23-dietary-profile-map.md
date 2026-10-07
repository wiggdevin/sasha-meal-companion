# Dietary profile map: do's and don'ts for every diet, and how Jev helps

Status: RESEARCH DRAFT, 2026-09-23. Nothing here is wired into policy yet.
Owner ask (Devin, 2026-09-23): map every disease, ailment, food preference, dietary need, like,
dislike and religious factor to do's and don'ts, including flexible rules ("mostly pescatarian but
sometimes chicken"), goals ("gain as much muscle as possible") and doctor directives ("focus on
anti-inflammatory foods"), and make Jev useful for it.

Machine-readable twin: [`dietary-profiles.draft.json`](./dietary-profiles.draft.json). That file is
the source of truth. Section 4 of this document is generated from it, so edit the JSON, not the
tables. Adversarial review: `docs/audit/research/2026-09-23-dietary-map-r*-gpt6-sol.md`.

## 1. Summary

- **124 profiles** in 10 categories: allergies and intolerances (19), medical conditions (27),
  doctor directives (6), medication–food interactions (15), life stages (6, including an under-18
  age gate), religious and cultural practices (13), ethical, lifestyle and named diets (24), goals
  (6), texture and swallowing (2), and likes and dislikes (6).
- **71 new facets** on top of the existing 25, plus **9 rubric fixes** to existing facets. Two new
  facets are templates (`contains_allergen:<name>`, `contains_ingredient:<name>`). With them, any
  allergen, dislike or personal trigger the user names reaches policy without a code change.
- **Hard blocks stay rare.** 53 profiles have a HARD list, and each HARD list has one of five bases:
  `allergy`, `celiac`, `religious`, `user_rule` (the user's own "never"), or
  `user_confirmed_safety`. The last basis covers medicine or pregnancy rules such as MAOI + tyramine,
  CKD + star fruit or pregnancy + Listeria foods. For those, the user confirms each rule item, and
  the app does not turn them on from a diagnosis alone. This keeps Phase 13 §4.3: `CONDITION_RULES`
  stays empty, and a condition never triggers a rule by itself.
- **Flexible rules use strengths, not booleans.** The strengths are `never`, `avoid`, `limit`,
  `sometimes` and `prefer`. They take budgets ("chicken up to 2×/week"), contexts ("when eating out")
  and time windows (Ramadan daylight hours, Lent Fridays, a 2-week low-iodine prep).
- **Evidence is graded honestly.** Many condition diets are `limited`: IBS, Crohn's, UC, GERD, gout,
  PCOS and "anti-inflammatory". The map says so, and those profiles only rank and nudge. They never
  block.
- **Jev judges foods only (D0).** It never receives the diagnosis, the profile or the user. The
  set of questions asked about a food is the same for every user, so the questions cannot reveal a
  user's rules either. Section 6
  lists each Jev use with its data class and latency. Most of the value comes from cached facet tags
  that code combines with the profile at zero model latency.

## 2. Method and sources

- Read the current system: `lib/foods/facet-vocabulary.ts`, `facet-questions.ts`,
  `facet-thresholds.ts`, `lib/policy/facet-rules.ts`, `constraints.ts`, `condition-rules.ts`,
  `lib/coach/deflect.ts`, `lib/profile/onboarding-state.ts` (12 preference flags) and
  `docs/specs/phase-13-model-lanes-food-safety.md` (data classes D0/D1/D2, Jev = D0 only).
- Primary sources, preferred in this order: US regulation and agencies (FDA, CDC, NIH ODS, NIDDK,
  NHLBI, USDA/HHS DGA 2025-2030), then society guidelines (ADA 2026, AHA/ACC 2025, KDIGO 2024,
  KDOQI 2020, AGA 2021/2024, ACG 2021/2022, ACR 2020, AASLD 2023, EASL 2019, ESPEN 2021, ATA, BHOF,
  ISSN, AND/ACSM, IDF-DAR), then peer-reviewed reviews for religious rules and diet patterns.
- Every URL was resolved on 2026-09-23. Where the publisher blocks bots, the DOI or PMID metadata was
  checked through Crossref or PubMed instead. That check caught one wrong DOI (an MAOI review), which
  was replaced. 138 sources are listed in §9.
- Discovery used WebSearch and WebFetch. The `agy` (Gemini) lane failed on an expired OAuth login and
  was not retried. GPT-6 Sol ran the adversarial medical check (see §8).
- Notable changes since 2024 that the map uses:
  - DGA 2025-2030 (released 2026-01-07): protein 1.2-1.6 g/kg/day; "no amount" of added sugar
    recommended; at most 10 g added sugar per meal; saturated fat ≤10% of calories; sodium
    <2,300 mg; limit highly processed foods.
  - FDA allergen guidance, Edition 5 (Jan 2025): the tree-nut list drops to 12 nuts and coconut is
    no longer a tree nut. "Milk" and "egg" now cover other animal species.
  - 2025 AHA/ACC hypertension guideline: potassium salt substitutes are recommended except with CKD
    or potassium-retaining drugs.
  - KDIGO 2024: protein 0.8 g/kg for CKD G3-G5; avoid more than 1.3 g/kg.
  - 2025 joint advisory on GLP-1 nutrition (ACLM/ASN/OMA/TOS).
  - AHA 2026 dietary guidance (supersedes 2021); ADA Standards of Care 2026; ACG 2025 EoE guideline;
    2026 linezolid label.

## 3. How to read a profile

Each profile has these fields:

| Field | Meaning | Maps to code |
|---|---|---|
| HARD avoid | Blocked. The verdict is `blocked`, or `unverified` when evidence is missing. | `evaluatePolicy` precedence floor > avoid > ingredient > category > jev (unchanged) |
| SOFT limit | Never blocks. It lowers the food's rank, drops the food from suggestions at `avoid` strength, can carry a budget, and gives one gentle note at log time at most. | new ranking layer (not the verdict) |
| PREFER | Raises the food's rank in suggestions and swaps. | new ranking layer |
| Targets | Numeric changes to the plan (protein g/kg, sodium mg, caffeine mg, eating window). | plan / targets code |
| Options | Variants the user picks (halal schools, kosher level, Jain sunset rule, "my allergist cleared baked egg"). | profile instance `options` |
| Evidence | `regulatory` · `strong` · `moderate` · `limited` · `insufficient` · `expert_opinion` · `religious_rule` · `user_rule` | shown in the UI next to the rule |
| Confirmation | *item-level*: the user confirms each hard rule before it applies. *profile-level*: one confirmation turns on the profile. Inference alone never turns on anything. | confirm card |
| Clinician note | Shows "Your clinician's advice comes first", and the coach defers questions about symptoms and medicines (`deflect.ts`). | copy + deflection |

Rule strengths (`never`, `avoid`, `limit`, `sometimes`, `prefer`) and the profile-instance schema
are defined in the JSON (`enums.rule_strength`, `profile_instance_schema`).

### 3.1 Flexible and partial rules ("mostly", "sometimes", "trying to cut back")

A flexible rule is a **base rule plus exceptions**. It is not a separate diet.

```jsonc
// "I'm mostly pescatarian but sometimes chicken"
{ "profile_id": "pescatarian_plus_poultry",
  "rule_overrides": [
    { "facet": "meat",     "strength": "avoid" },                 // base: no land meat suggested
    { "facet": "poultry",  "strength": "sometimes",
      "budget": { "count": 2, "per": "week" }, "context": ["eating_out", "family_meals"] },
    { "facet": "red_meat", "strength": "avoid" } ] }              // user can raise to "never"
```

Rules for all flexible profiles:
1. Suggestions follow the base rule. An exception can come up only while its budget or context
   allows.
2. Logging an excepted food is always silent. A budget counts; it does not scold. The week's count
   shows only if the user asks for it.
3. "Trying to cut back on X" is `limit` with a downward weekly trend, not `never`.
4. "Mostly" never means `never`. Only the user's own words ("never", "not at all", "I'm allergic")
   or a confirm card can raise a rule to `never`.
5. The coach asks one question when a phrase is ambiguous ("Is chicken OK any time, or now and
   then?"). It never guesses a hard rule.

### 3.2 Precedence and conflicts

Precedence, highest first: allergy/celiac floor → religious hard → user_confirmed_safety hard →
user_rule hard → clinician-directed targets (for example, the CKD protein cap) → condition soft
limits → goals → patterns → likes and dislikes.

Conflicts that the map flags (each profile has a `conflicts[]` list):
- **Muscle gain vs CKD:** 1.6-2.2 g/kg against a cap of 0.8, and never more than 1.3. The clinician
  cap wins. The coach shows the conflict and suggests the user raise it with their care team.
- **DASH / hypertension "more potassium" vs CKD or ACE/ARB/spironolactone:** potassium nudges and
  salt-substitute nudges are suppressed.
- **Pregnancy or gestational diabetes vs keto/low-carb:** keto is disabled. Carbohydrate never goes
  below 175 g/day (ADA 2026 §15).
- **CKD with unknown stage:** there is no protein change until the user gives the stage and
  dialysis status.
- **Ramadan (or other long fasts) with type 1 diabetes, insulin/sulfonylurea, SGLT2i, pregnancy,
  dialysis or eating-disorder recovery:** no fasting plan is generated until the user records a
  clinician-approved plan. Logging still works.
- **Under 18:** adult weight-loss, keto, fasting and adult target defaults are disabled.
- **Keto or intermittent fasting vs SGLT2 inhibitor, type 1 diabetes, pregnancy, eating-disorder
  recovery or cirrhosis:** the profile needs a clinician note before it turns on.
- **Fat loss vs pregnancy, eating-disorder recovery or cancer treatment:** the deficit is disabled.
- **Lithium vs a low-sodium directive or keto:** these are not started without the prescriber.
- **Hemochromatosis vs "iron-rich" suggestions:** iron-rich prefer weights are suppressed.

### 3.3 Safety framing (applies to every medical entry)

- A condition entry is soft guidance with a clinician note. It is never a diagnosis. The coach's
  `deflect.ts` still handles symptom, medication and test questions.
- The app shows evidence strength next to every condition rule, and says plainly when evidence is
  weak or when responses vary between people.
- Ambiguous allergy phrases ("allergic to nuts", "shellfish allergy", "dairy") turn on the broader,
  safer set until the user answers one clarifying question (JSON `ambiguous_phrases`).
- A negative answer never clears a safety rule on its own. Missing ingredients, generic terms
  ("spices", "natural flavours"), unknown gelatin source, unstated preparation (Listeria) and
  unverified dysphagia texture all return `unverified`.
- Hard rules that come from medicine (MAOI, CKD star fruit, pregnancy foods, disulfiram, G6PD fava,
  PKU aspartame, tacrolimus + grapefruit, low-iodine prep, dysphagia level) turn on only after the user confirms each item.
  They show the user's own words ("My pharmacist said no grapefruit").
- `eating_disorder_recovery` turns off deficits, "good/bad food" language and fasting, and stops
  other profiles from nudging.
- Several popular restrictions are not supported by evidence. The map says so instead of adding
  them: nuts and seeds in diverticulitis (AGA 2021: no need to avoid), cooked cruciferous vegetables
  and soy in hypothyroidism, gluten-free for Hashimoto's without celiac disease, leafy-green bans on
  warfarin (the advice is to keep intake consistent), and protein restriction in cirrhosis (EASL:
  1.2-1.5 g/kg).

## 4. Profiles

Generated from the JSON. The facet lists name the existing (25) and new (§5) facets that express
each rule.

### 4.1 Allergies and intolerances (19)

#### Milk allergy  
`allergy_milk`

- **User says:** "I'm allergic to milk"; "dairy allergy"; "cow's milk protein allergy"; "CMPA"; "casein allergy"
- **HARD avoid (basis: allergy):** `contains_dairy`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My allergist cleared specific baked-milk foods → Only the exact foods/recipes the user lists (per the allergist's plan) are allowed; every other baked good stays blocked.
- **Do:** Offer calcium- and vitamin-D-fortified plant milks, calcium-set tofu, canned fish with bones. Read labels each purchase: casein, whey, ghee, lactalbumin, 'non-dairy' creamers can contain casein.
- **Don't:** Treat lactose-free milk as safe: it still contains milk protein. Treat goat or sheep milk as safe (FDA counts all milk).
- **Facets:** existing `contains_dairy`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_dairy` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1). Needs the lactose-free and goat/sheep rubric fix.
- **Evidence:** regulatory — Major allergen (FALCPA). Avoidance is the standard of care. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies); [fda_allergen_qa_2025](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-questions-and-answers-regarding-food-allergens-including-food-allergen-labeling)

#### Egg allergy  
`allergy_egg`

- **User says:** "egg allergy"; "allergic to eggs"
- **HARD avoid (basis: allergy):** `contains_egg`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My allergist cleared specific baked-egg foods → Only the exact foods/recipes the user lists are allowed; other baked goods stay blocked.
- **Do:** Suggest egg-free binders (flax 'egg', aquafaba) and egg-free protein swaps.
- **Don't:** Assume duck or quail eggs are safe. Miss hidden egg: mayonnaise, meringue, some pasta, glazes, albumin.
- **Facets:** existing `contains_egg`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_egg` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — Major allergen. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies); [fda_allergen_qa_2025](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-questions-and-answers-regarding-food-allergens-including-food-allergen-labeling)

#### Peanut allergy  
`allergy_peanut`

- **User says:** "peanut allergy"; "allergic to peanuts"
- **HARD avoid (basis: allergy):** `contains_peanut`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Treat 'may contain peanuts' / shared-facility warnings as blocked unless the user relaxes it.
- **Don't:** Suggest satay, many Asian and African sauces, or mixed nuts without label evidence.
- **Facets:** existing `contains_peanut`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_peanut` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — Major allergen; severe reactions common. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies); [niaid_fa](https://www.niaid.nih.gov/diseases-conditions/guidelines-clinicians-and-patients-food-allergy)

#### Tree-nut allergy  
`allergy_tree_nut`

- **User says:** "tree nut allergy"; "almond allergy"; "cashew allergy"; "walnut allergy"
- **HARD avoid (basis: allergy):** `contains_tree_nut`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Ask which nuts: many people react to only some; store named nuts via contains_allergen:<name> if narrower.
- **Don't:** Assume coconut, nutmeg or water chestnut are tree nuts (they are not); a coconut allergy needs its own named rule.
- **Facets:** existing `contains_tree_nut`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_tree_nut` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — Major allergen. FDA's 2025 list has 12 tree nuts; coconut no longer counts. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies); [fda_allergen_qa_2025](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-questions-and-answers-regarding-food-allergens-including-food-allergen-labeling)

#### Fish allergy  
`allergy_fish`

- **User says:** "fish allergy"; "allergic to fish"; "finfish allergy"
- **HARD avoid (basis: allergy):** `contains_finfish`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Watch fish sauce, Worcestershire, Caesar dressing, some imitation crab (surimi).
- **Don't:** Block shellfish unless the user also names it.
- **Facets:** existing —; new `contains_finfish`
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_finfish` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1). Until contains_finfish exists, fish_seafood is the (over-inclusive) fallback.
- **Evidence:** regulatory — Major allergen. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies)

#### Crustacean shellfish allergy  
`allergy_crustacean`

- **User says:** "shrimp allergy"; "allergic to crab/lobster"; "crustacean allergy"
- **HARD avoid (basis: allergy):** `crustacean_shellfish`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Ask whether molluscs (clams, oysters, squid) are also a problem; add allergy_mollusc if yes.
- **Don't:** Rely on US labels for molluscs: they are not a declared US allergen.
- **Facets:** existing —; new `crustacean_shellfish`
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `crustacean_shellfish` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1). Fallback: existing shellfish facet (includes molluscs).
- **Evidence:** regulatory — Major allergen (crustaceans only in US law). · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies); [eu_1169](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)

#### Mollusc allergy  
`allergy_mollusc`

- **User says:** "mollusk allergy"; "allergic to clams / oysters / squid"
- **HARD avoid (basis: allergy):** `mollusc`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Facets:** existing —; new `mollusc`
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `mollusc` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — EU Annex II allergen; not a US major allergen, so label evidence is weaker. · Confirmation: profile-level · Clinician note: no
- **Sources:** [eu_1169](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)

#### Wheat allergy  
`allergy_wheat`

- **User says:** "wheat allergy"; "allergic to wheat"
- **HARD avoid (basis: allergy):** `contains_wheat`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Allow barley, rye and oats unless the allergist says otherwise.
- **Don't:** Treat 'gluten-free' as proof of wheat-free (wheat starch can be gluten-free-processed); check the wheat declaration.
- **Facets:** existing —; new `contains_wheat`
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_wheat` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1). Fallback: contains_gluten (over-inclusive).
- **Evidence:** regulatory — Major allergen. Different from celiac disease. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies)

#### Soy allergy  
`allergy_soy`

- **User says:** "soy allergy"; "allergic to soya"
- **HARD avoid (basis: allergy):** `contains_soy`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My allergist said highly refined soy oil / soy lecithin is fine → exempt those two ingredients
- **Facets:** existing `contains_soy`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_soy` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — Major allergen. · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies)

#### Sesame allergy  
`allergy_sesame`

- **User says:** "sesame allergy"; "allergic to sesame / tahini"
- **HARD avoid (basis: allergy):** `contains_sesame`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Don't:** Trust older labels or bakery items: some makers added sesame on purpose after the FASTER Act.
- **Facets:** existing `contains_sesame`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_sesame` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1).
- **Evidence:** regulatory — 9th major allergen since the FASTER Act (2023). · Confirmation: profile-level · Clinician note: no
- **Sources:** [fda_allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies)

#### Other named allergy (mustard, celery, lupin, corn, kiwi, coconut, buckwheat, etc.)  
`allergy_other_named`

- **User says:** "allergic to mustard"; "celery allergy"; "lupin allergy"; "corn allergy"; "kiwi allergy"
- **HARD avoid (basis: allergy):** `contains_allergen:<name>`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Store the user's exact word; confirm spelling; show it on every blocked card.
- **Facets:** existing —; new `contains_allergen:<name>`
- **Jev:** Parametric noul contains_allergen:<name>, cached per (food revision, name). Floor precedence like the 9 majors.
- **Evidence:** regulatory — EU Annex II covers mustard, celery, lupin, sulphites; others are individual. · Confirmation: item-level · Clinician note: no
- **Sources:** [eu_1169](https://eur-lex.europa.eu/eli/reg/2011/1169/oj); [niaid_fa](https://www.niaid.nih.gov/diseases-conditions/guidelines-clinicians-and-patients-food-allergy)

#### Alpha-gal syndrome (mammalian meat allergy)  
`alpha_gal`

- **User says:** "alpha-gal"; "red meat allergy"; "lone star tick allergy"; "mammal meat allergy"
- **HARD avoid (basis: allergy):** `red_meat`, `mammalian_derived`
- **SOFT limit:** `contains_dairy`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Dairy also makes me react → contains_dairy -> hard
- **Do:** Offer poultry, fish, eggs and plant proteins.
- **Don't:** Assume poultry is a problem; it is not mammalian.
- **Facets:** existing `contains_dairy`; new `mammalian_derived`, `red_meat`
- **Jev:** noul red_meat + mammalian_derived; choice gelatin_source (pork/beef -> blocked, fish/plant -> allowed, unstated -> unverified).
- **Evidence:** strong — CDC: avoid mammalian meat; some people also react to dairy, mammalian gelatin and other mammal products. Fish gelatin is not a mammal product; gelatin of unstated source is 'unverified'. · Confirmation: item-level · Clinician note: yes
- **Sources:** [cdc_alphagal](https://www.cdc.gov/alpha-gal-syndrome/about/index.html); [cdc_alphagal_products](https://www.cdc.gov/alpha-gal-syndrome/data-research/products-containing-alpha-gal/index.html)

#### Sulfite sensitivity  
`sulfite_sensitivity`

- **User says:** "sulfite allergy"; "sulphites make me wheeze"
- **HARD avoid (basis: allergy):** `contains_allergen:sulfites`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Flag wine, dried fruit, bottled lemon juice, some pickles and shrimp.
- **Facets:** existing —; new `contains_allergen:sulfites`
- **Jev:** Parametric allergen noul with name 'sulfites (sulphites, sodium metabisulfite)'.
- **Evidence:** regulatory — FDA requires declaration at >=10 ppm; reactions mostly in people with asthma. · Confirmation: item-level · Clinician note: no
- **Sources:** [fda_sulfite](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-G/section-101.100); [eu_1169](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)

#### Oral allergy syndrome (pollen-food)  
`oral_allergy_syndrome`

- **User says:** "my mouth itches with raw apples"; "pollen food allergy"; "OAS"
- **HARD avoid (basis: allergy):** `contains_allergen:<name>`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My allergist said cooked/canned forms are fine → cooked forms allowed; raw stays blocked
- **Do:** Ask what reaction the user had; any throat, breathing or whole-body symptom -> keep all forms blocked and suggest an allergist.
- **Don't:** Allow the cooked form unless the user confirms their allergist said so.
- **Facets:** existing —; new `contains_allergen:<name>`
- **Jev:** Parametric allergen template (global list) or deterministic match per named food; all forms hard by default; cooked forms allowed only with the allergist option.
- **Evidence:** moderate — Usually mouth symptoms from the raw food, but systemic reactions including anaphylaxis occur (ACAAI). Cooking often denatures the protein; tolerance is individual. · Confirmation: item-level · Clinician note: yes
- **Sources:** [acaai_pfas](https://acaai.org/allergies/allergic-conditions/food/pollen-food-allergy-syndrome/); [niaid_fa](https://www.niaid.nih.gov/diseases-conditions/guidelines-clinicians-and-patients-food-allergy)

#### Celiac disease  
`celiac`

- **User says:** "celiac"; "coeliac"; "gluten-free for celiac"; "I can't have gluten at all"
- **HARD avoid (basis: celiac):** `contains_gluten`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Processed or restaurant food clears only with a gluten-free claim/certification; otherwise 'unverified'. Oats only if labelled gluten-free. Count cross-contact warnings as blocked.
- **Don't:** Treat barley, rye, malt, brewer's yeast or ordinary oats as safe. Suggest restaurant fried foods from shared fryers without a caveat.
- **Facets:** existing `contains_gluten`; new —
- **Jev:** Floor rule. Deterministic allergen tags first; Jev noul `contains_gluten` on food state only, threshold tuned for recall (a false 'absent' can harm). Outcome 'unknown' = 'Check the label', never suggested (Phase 13 §4.1). Needs the oats/brewer's-yeast rubric fix.
- **Evidence:** strong — Lifelong strict gluten-free diet is the only treatment; FDA 'gluten-free' <20 ppm. · Confirmation: profile-level · Clinician note: yes
- **Sources:** [niddk_celiac](https://www.niddk.nih.gov/health-information/digestive-diseases/celiac-disease/eating-diet-nutrition); [fda_gf](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/gluten-free-labeling-foods); [fda_gf_qa](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/questions-and-answers-gluten-free-food-labeling-final-rule)

#### Non-celiac gluten/wheat sensitivity  
`ncgs`

- **User says:** "gluten sensitive"; "gluten makes me bloated"; "NCGS"
- **HARD avoid:** —
- **SOFT limit:** `contains_gluten`, `fodmap_fructan`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Treat gluten as a strict rule for me → contains_gluten -> hard (user_rule)
- **Do:** Suggest the user asks their doctor about celiac testing BEFORE cutting gluten (testing needs gluten in the diet).
- **Don't:** Require cross-contact avoidance unless the user asks.
- **Facets:** existing `contains_gluten`; new `fodmap_fructan`
- **Jev:** Same facets as celiac; soft by default.
- **Evidence:** limited — Diagnosis by exclusion; many symptoms track fructans, not gluten. · Confirmation: item-level · Clinician note: yes
- **Sources:** [salerno_ncgs](https://doi.org/10.3390/nu7064966); [acg_ibs_2021](https://doi.org/10.14309/ajg.0000000000001036)

#### Lactose intolerance  
`lactose_intolerance`

- **User says:** "lactose intolerant"; "milk upsets my stomach"; "can't digest dairy"
- **HARD avoid:** —
- **SOFT limit:** `high_lactose`
- **PREFER:** `calcium_rich`
- **Targets:** —
- **Do:** Rank lactose-free milk, hard cheeses and yogurt as fine. Keep calcium up.
- **Don't:** Block all dairy: this is not an allergy. Use the contains_dairy facet for this profile.
- **Facets:** existing —; new `calcium_rich`, `high_lactose`
- **Jev:** score high_lactose (3 levels); code limits 'high' items per meal, not all dairy.
- **Evidence:** strong — NIDDK: many people tolerate some lactose (often up to ~12 g at once); hard cheese and yogurt are usually tolerated. · Confirmation: item-level · Clinician note: no
- **Sources:** [niddk_lactose](https://www.niddk.nih.gov/health-information/digestive-diseases/lactose-intolerance/eating-diet-nutrition)

#### Fructose malabsorption  
`fructose_malabsorption`

- **User says:** "fructose intolerance (dietary)"; "fruit sugar upsets me"
- **HARD avoid:** —
- **SOFT limit:** `fodmap_excess_fructose`, `honey`
- **PREFER:** —
- **Targets:** —
- **Facets:** existing —; new `fodmap_excess_fructose`, `honey`
- **Jev:** noul fodmap_excess_fructose.
- **Evidence:** limited — Overlaps with IBS; hereditary fructose intolerance is a different, rare, clinician-managed disease. · Confirmation: item-level · Clinician note: yes
- **Sources:** [monash](https://www.monashfodmap.com/about-fodmap-and-ibs/)

#### Histamine intolerance (self-reported)  
`histamine_intolerance`

- **User says:** "histamine intolerance"; "low histamine diet"
- **HARD avoid:** —
- **SOFT limit:** `contains_ingredient:<name>`
- **PREFER:** —
- **Targets:** —
- **Do:** Use the user's own named foods only.
- **Don't:** Impose a long generic list.
- **Facets:** existing —; new `contains_ingredient:<name>`
- **Jev:** Parametric contains_ingredient per user-named trigger; tyramine_rich is NOT a histamine proxy.
- **Evidence:** limited — Diagnosis is not standardised; food histamine lists disagree. · Confirmation: item-level · Clinician note: yes
- **Sources:** [histamine_2020](https://doi.org/10.3390/biom10081181)

### 4.2 Medical conditions (soft guidance, clinician note) (27)

#### Eosinophilic esophagitis (EoE)  
`eosinophilic_esophagitis`

- **User says:** "EoE"; "eosinophilic esophagitis"; "food gets stuck"
- **HARD avoid (basis: user_confirmed_safety):** `contains_ingredient:<name>`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "elimination phase then reintroduction, set by the GI team"}`
- **Do:** Store exactly the foods the GI team eliminated (often dairy, wheat, egg, soy); track the phase.
- **Don't:** Treat EoE eliminations as allergy floor rules with cross-contact blocking unless the team says so. Start an elimination diet on the app's initiative.
- **Facets:** existing —; new `contains_ingredient:<name>`
- **Jev:** Global allergen facets (contains_dairy, contains_wheat, contains_egg, contains_soy) reused; policy basis user_confirmed_safety.
- **Evidence:** strong — ACG 2025: elimination diets (e.g., dairy-first or multi-food) are a treatment option, with endoscopic monitoring and planned reintroduction. Not an IgE allergy. · Confirmation: item-level · Clinician note: yes
- **Sources:** [acg_eoe_2025](https://doi.org/10.14309/ajg.0000000000003194)

#### G6PD deficiency  
`g6pd_deficiency`

- **User says:** "G6PD"; "favism"; "can't eat fava beans"
- **HARD avoid (basis: user_confirmed_safety):** `fava_bean`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Facets:** existing —; new `fava_bean`
- **Jev:** noul fava_bean; ingredient keyword first.
- **Evidence:** strong — Fava beans can trigger haemolysis in G6PD deficiency. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_g6pd](https://medlineplus.gov/genetics/condition/glucose-6-phosphate-dehydrogenase-deficiency/)

#### Phenylketonuria (PKU)  
`pku`

- **User says:** "PKU"; "phenylketonuria"
- **HARD avoid (basis: user_confirmed_safety):** `aspartame`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** meal_planner: DISABLED - no generated plans or food ideas; logging only; protein_and_phe: the metabolic clinic's phenylalanine prescription and medical-food regimen only
- **Don't:** Set protein targets or generate ordinary macro-based plans, suggestions or 'high-protein' ideas.
- **Facets:** existing —; new `aspartame`
- **Jev:** noul aspartame. Profile switches off the planner and protein nudges.
- **Evidence:** regulatory — Aspartame labels must warn phenylketonurics. The whole diet is managed by a metabolic clinic. · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_aspartame](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-172/subpart-I/section-172.804); [ml_pku](https://medlineplus.gov/genetics/condition/phenylketonuria/); [acmg_pku_2025](https://doi.org/10.1016/j.gim.2024.101289)

#### IBS / low-FODMAP  
`ibs_low_fodmap`

- **User says:** "IBS"; "irritable bowel"; "low FODMAP"; "my dietitian put me on FODMAP"
- **HARD avoid:** —
- **SOFT limit:** `fodmap_fructan`, `fodmap_gos`, `fodmap_excess_fructose`, `fodmap_polyol`, `high_lactose`, `onion_garlic`, `beans`
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"phases": ["elimination 2-6 weeks", "reintroduction (one FODMAP group at a time)", "personalised long-term"]}`
- **Do:** Track the phase; after elimination, prompt reintroduction. Keep only the groups that the user's reintroduction showed are triggers.
- **Don't:** Keep all FODMAPs restricted indefinitely. Present Jev FODMAP tags as lab values (Monash data are the reference).
- **Facets:** existing `beans`, `onion_garlic`; new `fodmap_excess_fructose`, `fodmap_fructan`, `fodmap_gos`, `fodmap_polyol`, `high_lactose`
- **Jev:** Existing low_fodmap flag uses category rules for onion_garlic/beans; add 4 subclass nouls + high_lactose score.
- **Evidence:** moderate — ACG 2021: conditional recommendation for a limited low-FODMAP trial; best with a dietitian. Not a lifelong diet. · Confirmation: item-level · Clinician note: yes
- **Sources:** [acg_ibs_2021](https://doi.org/10.14309/ajg.0000000000001036); [monash](https://www.monashfodmap.com/about-fodmap-and-ibs/); [niddk_ibs](https://www.niddk.nih.gov/health-information/digestive-diseases/irritable-bowel-syndrome/eating-diet-nutrition)

#### Crohn's disease  
`crohns`

- **User says:** "Crohn's"; "Crohns"; "IBD"; "inflammatory bowel disease"
- **HARD avoid:** —
- **SOFT limit:** `ultra_processed`, `emulsifier_additives`, `processed_meat`, `high_saturated_fat`
- **PREFER:** `omega3_rich`, `whole_grain`, `high_fiber`
- **Targets:** —
- **Options (user-set variants):** My doctor says I have a narrowing/stricture → high_insoluble_fiber_residue -> hard (user_confirmed_safety); fibre prefer removed
- **Do:** Build the plan from the user's own confirmed triggers (Phase 13 §4.3). Watch protein and energy intake during flares (malnutrition risk).
- **Don't:** Blanket-ban fibre, dairy or gluten. Comment on symptoms, flares or medications (deflect.ts).
- **Facets:** existing —; new `emulsifier_additives`, `high_fiber`, `high_insoluble_fiber_residue`, `high_saturated_fat`, `omega3_rich`, `processed_meat`, `ultra_processed`, `whole_grain`
- **Jev:** Facets on foods only; the diagnosis never goes to Jev.
- **Evidence:** limited — AGA 2024: Mediterranean diet for most IBD patients; no diet consistently prevents flares. Triggers are individual. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aga_ibd_2024](https://pubmed.ncbi.nlm.nih.gov/38276922/); [ioibd_2020](https://doi.org/10.1016/j.cgh.2020.01.046); [ccf_diet](https://www.crohnscolitisfoundation.org/patientsandcaregivers/diet-and-nutrition)

#### Ulcerative colitis  
`ulcerative_colitis`

- **User says:** "UC"; "colitis"; "ulcerative colitis"
- **HARD avoid:** —
- **SOFT limit:** `red_meat`, `processed_meat`, `emulsifier_additives`, `ultra_processed`, `high_saturated_fat`
- **PREFER:** `omega3_rich`, `whole_grain`
- **Targets:** —
- **Do:** Keep the user's own confirmed avoid rules as the primary layer.
- **Don't:** Diagnose flares or advise on medication.
- **Facets:** existing —; new `emulsifier_additives`, `high_saturated_fat`, `omega3_rich`, `processed_meat`, `red_meat`, `ultra_processed`, `whole_grain`
- **Jev:** Food facets only.
- **Evidence:** limited — IOIBD 2020: reduce red and processed meat, emulsifiers and dairy fat; increase marine omega-3 from food. Low-quality evidence. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ioibd_2020](https://doi.org/10.1016/j.cgh.2020.01.046); [aga_ibd_2024](https://pubmed.ncbi.nlm.nih.gov/38276922/); [ccf_diet](https://www.crohnscolitisfoundation.org/patientsandcaregivers/diet-and-nutrition)

#### Acid reflux / GERD  
`gerd`

- **User says:** "reflux"; "heartburn"; "GERD"; "acid reflux"
- **HARD avoid:** —
- **SOFT limit:** `contains_ingredient:<name>`
- **PREFER:** —
- **Targets:** last_meal_hours_before_bed: 3
- **Options (user-set variants):** Pick my triggers → user toggles any of: caffeine, coffee_or_tea, alcohol, spicy_hot, high_acid, carbonated, high_fat, fried, chocolate, mint
- **Do:** Offer an evening meal-timing nudge.
- **Don't:** Ban the whole common-trigger list by default.
- **Facets:** existing `alcohol`; new `caffeine`, `carbonated`, `coffee_or_tea`, `contains_ingredient:<name>`, `fried`, `high_acid`, `high_fat`, `spicy_hot`
- **Jev:** Only the user-chosen trigger facets; plus contains_ingredient:<name> for chocolate/mint.
- **Evidence:** limited — ACG 2022: weight loss if overweight and no meals 2-3 h before bed are suggested; avoid only the foods that trigger YOUR symptoms. · Confirmation: item-level · Clinician note: yes
- **Sources:** [acg_gerd_2022](https://doi.org/10.14309/ajg.0000000000001538); [niddk_gerd](https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults/eating-diet-nutrition)

#### Diverticulosis / diverticulitis  
`diverticular_disease`

- **User says:** "diverticulitis"; "diverticulosis"; "diverticular disease"
- **HARD avoid:** —
- **SOFT limit:** `red_meat`
- **PREFER:** `high_fiber`, `whole_grain`, `beans`
- **Targets:** —
- **Do:** Actively correct the nuts/seeds/popcorn myth if the user raises it.
- **Don't:** Block nuts, seeds or popcorn.
- **Facets:** existing `beans`; new `high_fiber`, `red_meat`, `whole_grain`
- **Jev:** No new facet needed beyond high_fiber/whole_grain/red_meat.
- **Evidence:** moderate — AGA 2021: high-fibre diet; nuts, seeds and popcorn need NOT be avoided; limit red meat. Acute attacks: follow the clinician's short-term plan. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aga_divert_2021](https://doi.org/10.1053/j.gastro.2020.09.059); [niddk_divert](https://www.niddk.nih.gov/health-information/digestive-diseases/diverticulosis-diverticulitis/eating-diet-nutrition)

#### Gout / high uric acid  
`gout`

- **User says:** "gout"; "high uric acid"; "hyperuricemia"
- **HARD avoid:** —
- **SOFT limit:** `high_purine`, `alcohol`, `sugar_sweetened_beverage`
- **PREFER:** —
- **Targets:** —
- **Do:** Frame as supportive to medication, not a substitute.
- **Don't:** Promise diet alone controls gout.
- **Facets:** existing `alcohol`; new `high_purine`, `sugar_sweetened_beverage`
- **Jev:** noul high_purine; beer is caught by alcohol + high_purine.
- **Evidence:** limited — ACR 2020: conditionally limit alcohol, purine intake and high-fructose corn syrup; urate-lowering therapy is the main treatment. · Confirmation: item-level · Clinician note: yes
- **Sources:** [acr_gout_2020](https://doi.org/10.1002/acr.24180)

#### Type 1 diabetes  
`type1_diabetes`

- **User says:** "type 1 diabetes"; "T1D"; "insulin-dependent"
- **HARD avoid:** —
- **SOFT limit:** `sugar_sweetened_beverage`
- **PREFER:** `whole_grain`, `high_fiber`, `beans`
- **Targets:** carb_awareness: show carbs per meal; do not compute insulin
- **Do:** Show carbohydrate grams clearly. Remember fast sugar is the TREATMENT for a low: never flag glucose tabs/juice logged for a hypo.
- **Don't:** Suggest insulin doses or corrections. Suggest keto or fasting without the care team (see conflicts).
- **Conflicts with:** keto, intermittent_fasting, ramadan_fasting
- **Facets:** existing `beans`; new `high_fiber`, `sugar_sweetened_beverage`, `whole_grain`
- **Jev:** high_carb_starchy is only a ranking hint; carb grams come from nutrient data.
- **Evidence:** strong — ADA SOC 2026: no single macronutrient split; carbohydrate counting matched to insulin; alcohol can cause delayed hypoglycaemia. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ada_soc_2026](https://professional.diabetes.org/standards-of-care); [ada_nutrition_2019](https://doi.org/10.2337/dci19-0014)

#### Type 2 diabetes  
`type2_diabetes`

- **User says:** "type 2 diabetes"; "T2D"; "diabetic"; "sugar diabetes"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`, `refined_grain`, `processed_meat`, `high_glycemic_load`
- **PREFER:** `whole_grain`, `high_fiber`, `beans`, `protein_dense`
- **Targets:** —
- **Options (user-set variants):** Diabetes treatment → insulin/sulfonylurea -> insulin_or_sulfonylurea profile; SGLT2 -> sglt2_inhibitor profile; unanswered or unsure -> treated as high-risk for fasting gates
- **Do:** Let the user pick a pattern (Mediterranean, low-carb, etc.); layer it. Ask the treatment question before any fasting, IF or low-carb plan.
- **Don't:** Promise remission. Change medication timing.
- **Conflicts with:** keto (if on SGLT2i or insulin)
- **Facets:** existing `beans`; new `added_sugar`, `high_fiber`, `high_glycemic_load`, `processed_meat`, `protein_dense`, `refined_grain`, `sugar_sweetened_beverage`, `whole_grain`
- **Jev:** added_sugar/refined_grain/high_glycemic_load facets.
- **Evidence:** strong — ADA SOC 2026 / 2019 consensus: several patterns work (Mediterranean, DASH, low-carb, plant-based); cut added sugars and refined grains; water over sugary drinks. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ada_soc_2026](https://professional.diabetes.org/standards-of-care); [ada_nutrition_2019](https://doi.org/10.2337/dci19-0014)

#### Prediabetes  
`prediabetes`

- **User says:** "prediabetes"; "borderline diabetes"; "insulin resistance"; "A1c is a bit high"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`, `refined_grain`
- **PREFER:** `whole_grain`, `high_fiber`, `beans`
- **Targets:** weight_loss_pct_if_overweight: 5-7
- **Facets:** existing `beans`; new `added_sugar`, `high_fiber`, `refined_grain`, `sugar_sweetened_beverage`, `whole_grain`
- **Jev:** as type2_diabetes
- **Evidence:** strong — ADA SOC 2026 Section 3: ~7% weight loss plus activity (DPP) delays progression. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ada_soc_2026](https://professional.diabetes.org/standards-of-care)

#### High blood pressure  
`hypertension`

- **User says:** "high blood pressure"; "hypertension"; "BP is high"
- **HARD avoid:** —
- **SOFT limit:** `high_sodium`, `alcohol`, `processed_meat`
- **PREFER:** `high_potassium`, `whole_grain`, `calcium_rich`
- **Targets:** sodium_mg_max: 2300; sodium_mg_ideal: 1500; potassium_mg_food: 3500-5000 unless CKD or K-retaining drugs
- **Do:** Use label sodium first; Jev high_sodium only when no label.
- **Don't:** Recommend potassium salt substitutes or high-potassium pushes if CKD or ACE-inhibitor/ARB/spironolactone is on the profile.
- **Conflicts with:** ckd, ace_arb_spironolactone
- **Facets:** existing `alcohol`; new `calcium_rich`, `high_potassium`, `high_sodium`, `processed_meat`, `whole_grain`
- **Jev:** score high_sodium (deterministic-first).
- **Evidence:** strong — 2025 AHA/ACC: DASH-style pattern, sodium <2300 moving to <1500 mg, more dietary potassium, less alcohol. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aha_acc_htn_2025](https://doi.org/10.1016/j.jacc.2025.05.007); [nhlbi_dash](https://www.nhlbi.nih.gov/education/dash-eating-plan); [aha_sodium](https://www.heart.org/en/healthy-living/healthy-eating/eat-smart/sodium/how-much-sodium-should-i-eat-per-day)

#### Heart disease / high LDL cholesterol  
`heart_ldl`

- **User says:** "high cholesterol"; "high LDL"; "heart disease"; "heart-healthy"; "had a heart attack"
- **HARD avoid:** —
- **SOFT limit:** `high_saturated_fat`, `processed_meat`, `fried`, `added_sugar`, `high_sodium`, `alcohol`, `red_meat`, `ultra_processed`
- **PREFER:** `omega3_rich`, `high_fiber`, `whole_grain`, `beans`
- **Targets:** sat_fat_pct_kcal_max: 10; sat_fat_pct_kcal_if_ldl_lowering: 5-6; fish_servings_per_week: 2
- **Do:** Offer swaps (olive oil for butter, fish/beans for processed meat).
- **Don't:** Set dietary cholesterol caps as a separate rule (no numeric DGA limit).
- **Facets:** existing `alcohol`, `beans`; new `added_sugar`, `fried`, `high_fiber`, `high_saturated_fat`, `high_sodium`, `omega3_rich`, `processed_meat`, `red_meat`, `ultra_processed`, `whole_grain`
- **Jev:** score high_saturated_fat (deterministic-first), noul fried/processed_meat/omega3_rich.
- **Evidence:** strong — AHA 2026 dietary guidance (supersedes 2021): healthy weight; plenty of varied vegetables/fruit; whole grains; healthy proteins; unsaturated in place of saturated fat; minimally processed over ultra-processed; minimise added sugars; less sodium; if you don't drink, don't start. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aha_diet_2026](https://doi.org/10.1161/CIR.0000000000001435); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Chronic kidney disease (not on dialysis)  
`ckd`

- **User says:** "CKD"; "kidney disease"; "stage 3 kidney disease"; "renal diet"; "my kidneys are weak"
- **HARD avoid (basis: user_confirmed_safety):** `star_fruit`
- **SOFT limit:** `high_sodium`, `phosphate_additive`, `processed_meat`
- **PREFER:** `whole_grain`
- **Targets:** stage_required: ask G1-G5 and dialysis status; no protein change until known; protein_g_per_kg_if_G3_G5_not_dialysis: 0.8; protein_g_per_kg_max_if_progression_risk: 1.3; protein_exceptions: not for metabolically unstable or malnourished users - clinician decides; sodium_mg_max: 2000; potassium: lab-driven, clinician toggle only; phosphorus: lab-driven, clinician toggle only
- **Options (user-set variants):** My care team told me to limit potassium → high_potassium -> soft; My care team told me to limit phosphorus → high_phosphorus -> soft
- **Do:** Make star fruit a confirmed hard rule (neurotoxic in kidney failure). Surface the protein conflict with any muscle-gain goal.
- **Don't:** Auto-restrict potassium or phosphorus without the care team. Push potassium salt substitutes.
- **Conflicts with:** muscle_gain, fat_loss (high protein), hypertension (potassium prefer), keto
- **Facets:** existing —; new `high_phosphorus`, `high_potassium`, `high_sodium`, `phosphate_additive`, `processed_meat`, `star_fruit`, `whole_grain`
- **Jev:** Food facets only; protein comes from nutrient data.
- **Evidence:** strong — KDIGO 2024: protein 0.8 g/kg/day for G3-G5, avoid >1.3; sodium <2 g/day; potassium and phosphorus individualised to labs. · Confirmation: item-level · Clinician note: yes
- **Sources:** [kdigo_2024](https://kdigo.org/wp-content/uploads/2024/03/KDIGO-2024-CKD-Guideline.pdf); [kdoqi_2020](https://doi.org/10.1053/j.ajkd.2020.05.006); [niddk_ckd](https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/eating-nutrition); [starfruit_2021](https://pubmed.ncbi.nlm.nih.gov/33693950/)

#### Kidney failure on dialysis  
`ckd_dialysis`

- **User says:** "dialysis"; "hemodialysis"; "peritoneal dialysis"; "ESRD"
- **HARD avoid (basis: user_confirmed_safety):** `star_fruit`
- **SOFT limit:** `high_sodium`
- **PREFER:** —
- **Targets:** protein_g_per_kg: 1.0-1.2 (metabolically stable; team may individualise); fluid_ml: set by dialysis team; potassium_phosphorus: lab-driven, options only
- **Options (user-set variants):** My dialysis team told me to limit potassium → high_potassium -> soft; My dialysis team told me to limit phosphorus → high_phosphorus, phosphate_additive -> soft
- **Do:** Count soups, ice and jelly toward a fluid limit if the team set one.
- **Don't:** Apply the non-dialysis 0.8 g/kg protein cap.
- **Facets:** existing —; new `high_phosphorus`, `high_potassium`, `high_sodium`, `phosphate_additive`, `star_fruit`
- **Jev:** Food facets only.
- **Evidence:** strong — KDOQI 2020: protein 1.0-1.2 g/kg/day on maintenance dialysis; fluid, potassium and phosphorus per labs. · Confirmation: item-level · Clinician note: yes
- **Sources:** [kdoqi_2020](https://doi.org/10.1053/j.ajkd.2020.05.006); [starfruit_2021](https://pubmed.ncbi.nlm.nih.gov/33693950/)

#### Kidney stones (calcium oxalate)  
`kidney_stones`

- **User says:** "kidney stones"; "calcium oxalate stones"; "renal stones"
- **HARD avoid:** —
- **SOFT limit:** `high_sodium`
- **PREFER:** `calcium_rich`
- **Targets:** fluid_goal: enough for >=2.5 L urine/day (clinician); calcium_mg: 1000-1200 from food
- **Options (user-set variants):** My doctor said low-oxalate → high_oxalate -> soft
- **Don't:** Cut calcium: low calcium raises stone risk.
- **Facets:** existing —; new `calcium_rich`, `high_oxalate`, `high_sodium`
- **Jev:** score high_sodium; optional high_oxalate.
- **Evidence:** moderate — AUA 2014: high fluid, normal dietary calcium, limit sodium and animal protein; oxalate limits only for high urinary oxalate. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aua_stones_2014](https://doi.org/10.1016/j.juro.2014.05.006)

#### Fatty liver (MASLD / NAFLD)  
`masld`

- **User says:** "fatty liver"; "NAFLD"; "MASLD"; "NASH"; "MASH"
- **HARD avoid:** —
- **SOFT limit:** `sugar_sweetened_beverage`, `added_sugar`, `ultra_processed`, `alcohol`
- **PREFER:** `whole_grain`, `high_fiber`, `omega3_rich`
- **Targets:** weight_loss_pct_if_overweight: 7-10
- **Options (user-set variants):** My doctor said no alcohol → alcohol -> hard (user_confirmed_safety)
- **Facets:** existing `alcohol`; new `added_sugar`, `high_fiber`, `omega3_rich`, `sugar_sweetened_beverage`, `ultra_processed`, `whole_grain`
- **Jev:** Food facets only.
- **Evidence:** moderate — AASLD 2023: 7-10% weight loss, Mediterranean-style diet, limit fructose/sugary drinks; alcohol limited or avoided (avoid with advanced fibrosis). · Confirmation: item-level · Clinician note: yes
- **Sources:** [aasld_nafld_2023](https://doi.org/10.1097/HEP.0000000000000323)

#### Cirrhosis / advanced liver disease  
`cirrhosis`

- **User says:** "cirrhosis"; "liver cirrhosis"; "end-stage liver disease"
- **HARD avoid (basis: user_confirmed_safety):** `alcohol`, `raw_or_undercooked_animal`
- **SOFT limit:** `high_sodium`
- **PREFER:** `protein_dense`
- **Targets:** protein_g_per_kg: 1.2-1.5; late_evening_snack: True; sodium_mg_max_if_ascites: 2000
- **Don't:** Apply a low-protein rule (old myth). Suggest intermittent fasting.
- **Conflicts with:** intermittent_fasting, ckd (protein)
- **Facets:** existing `alcohol`; new `high_sodium`, `protein_dense`, `raw_or_undercooked_animal`
- **Jev:** Food facets only.
- **Evidence:** strong — EASL 2019: do not restrict protein (1.2-1.5 g/kg), avoid long fasts, late-evening snack; raw oysters risk Vibrio infection. · Confirmation: item-level · Clinician note: yes
- **Sources:** [easl_nutrition_2019](https://doi.org/10.1016/j.jhep.2018.06.024); [cdc_vibrio](https://www.cdc.gov/vibrio/about/index.html)

#### Hemochromatosis (iron overload)  
`hemochromatosis`

- **User says:** "hemochromatosis"; "iron overload"; "too much iron"
- **HARD avoid (basis: user_confirmed_safety):** `raw_or_undercooked_animal`
- **SOFT limit:** `alcohol`
- **PREFER:** —
- **Targets:** —
- **Don't:** Promote iron-rich foods or fortified cereal as a goal. Suggest vitamin C supplements.
- **Facets:** existing `alcohol`; new `raw_or_undercooked_animal`
- **Jev:** raw_or_undercooked_animal (+mollusc).
- **Evidence:** moderate — NIDDK: avoid iron and vitamin C supplements, raw shellfish (Vibrio) and limit alcohol; phlebotomy is the treatment. · Confirmation: item-level · Clinician note: yes
- **Sources:** [niddk_hemo](https://www.niddk.nih.gov/health-information/liver-disease/hemochromatosis/eating-diet-nutrition); [cdc_vibrio](https://www.cdc.gov/vibrio/about/index.html)

#### PCOS  
`pcos`

- **User says:** "PCOS"; "polycystic ovary syndrome"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`, `refined_grain`
- **PREFER:** `high_fiber`, `whole_grain`, `protein_dense`
- **Targets:** —
- **Don't:** Market any single 'PCOS diet' as proven.
- **Facets:** existing —; new `added_sugar`, `high_fiber`, `protein_dense`, `refined_grain`, `sugar_sweetened_beverage`, `whole_grain`
- **Jev:** Food facets only.
- **Evidence:** limited — 2023 international guideline: no specific diet is better than others; general healthy eating and weight management where relevant. · Confirmation: item-level · Clinician note: yes
- **Sources:** [pcos_2023](https://doi.org/10.1210/clinem/dgad463)

#### Iron-deficiency anaemia  
`iron_deficiency`

- **User says:** "anemia"; "anaemia"; "low iron"; "iron deficient"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `iron_rich`
- **Targets:** timing: tea/coffee between meals, not with iron-rich meals (coffee_or_tea tag used for the tip only)
- **Do:** Pair plant iron with vitamin-C foods. Suggest tea/coffee between meals rather than with them.
- **Don't:** Advise supplement doses (deflect.ts 'deficiency' pattern already deflects questions).
- **Facets:** existing —; new `coffee_or_tea`, `iron_rich`
- **Jev:** score iron_rich (deterministic-first).
- **Evidence:** moderate — NIH ODS: heme iron absorbs best; vitamin C boosts non-heme iron; tea/coffee and calcium at meals reduce absorption. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ods_iron](https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/)

#### Osteoporosis / low bone density  
`osteoporosis`

- **User says:** "osteoporosis"; "osteopenia"; "low bone density"
- **HARD avoid:** —
- **SOFT limit:** `alcohol`, `high_sodium`
- **PREFER:** `calcium_rich`, `protein_dense`
- **Targets:** calcium_mg: 1000-1200 (food first); vitamin_d_iu: RDA 600 (to age 70), 800 (>70); BHOF suggests 800-1000 for adults 50+; higher doses only per clinician; protein_g_per_kg_min: 1.0; alcohol_drinks_per_day_max: 2
- **Don't:** Give bisphosphonate dosing advice (see bisphosphonate profile for timing only).
- **Facets:** existing `alcohol`; new `calcium_rich`, `high_sodium`, `protein_dense`
- **Jev:** score calcium_rich.
- **Evidence:** strong — BHOF 2022 clinician's guide: adequate calcium, vitamin D and protein; limit alcohol. · Confirmation: item-level · Clinician note: yes
- **Sources:** [bhof_2022](https://doi.org/10.1007/s00198-021-05900-y); [ods_calcium](https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/); [ods_vitd](https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/)

#### During cancer treatment  
`cancer_treatment`

- **User says:** "chemo"; "chemotherapy"; "radiation"; "cancer treatment"; "oncology diet"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `protein_dense`, `energy_dense`
- **Targets:** protein_g_per_kg: 1.0-1.5; energy_kcal_per_kg: 25-30; weight_loss_goal: off unless oncologist says
- **Options (user-set variants):** My care team said to be careful with food safety (low blood counts) → raw_or_undercooked_animal, unpasteurized, high_listeria_risk -> hard (user_confirmed_safety); Mouth sores → spicy_hot, high_acid, hard_to_chew -> soft; My pharmacist said no grapefruit → grapefruit_family -> hard
- **Don't:** Recommend supplements, antioxidants or 'anti-cancer' diets. Push weight loss.
- **Conflicts with:** fat_loss, intermittent_fasting, keto
- **Facets:** existing —; new `energy_dense`, `grapefruit_family`, `hard_to_chew`, `high_acid`, `high_listeria_risk`, `protein_dense`, `raw_or_undercooked_animal`, `spicy_hot`, `unpasteurized`
- **Jev:** Food facets only.
- **Evidence:** moderate — ESPEN 2021: protein 1-1.5 g/kg and enough energy; NCI PDQ symptom-based advice. Food safety per FDA at-risk guide. · Confirmation: item-level · Clinician note: yes
- **Sources:** [espen_cancer_2021](https://doi.org/10.1016/j.clnu.2021.02.005); [nci_pdq](https://www.cancer.gov/about-cancer/treatment/side-effects/appetite-loss/nutrition-hp-pdq); [fda_at_risk](https://www.fda.gov/food/people-risk-foodborne-illness/food-safety-older-adults-and-people-cancer-diabetes-hivaids-organ-transplants-and-autoimmune)

#### Weakened immune system (transplant, immunosuppressants, HIV)  
`immunocompromised`

- **User says:** "transplant"; "immunosuppressed"; "immunocompromised"; "on tacrolimus"
- **HARD avoid (basis: user_confirmed_safety):** `raw_or_undercooked_animal`, `unpasteurized`, `high_listeria_risk`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My medicine label says no grapefruit → grapefruit_family -> hard
- **Facets:** existing —; new `grapefruit_family`, `high_listeria_risk`, `raw_or_undercooked_animal`, `unpasteurized`
- **Jev:** Food facets only.
- **Evidence:** strong — FDA at-risk food-safety guide; grapefruit raises levels of some immunosuppressants. · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_at_risk](https://www.fda.gov/food/people-risk-foodborne-illness/food-safety-older-adults-and-people-cancer-diabetes-hivaids-organ-transplants-and-autoimmune); [fda_grapefruit](https://www.fda.gov/consumers/consumer-updates/grapefruit-juice-and-some-drugs-dont-mix)

#### Eating disorder / recovery  
`eating_disorder_recovery`

- **User says:** "eating disorder"; "anorexia"; "bulimia"; "binge eating"; "ARFID"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** calorie_deficit: disabled; numbers_visible: treatment-team choice; good_bad_food_language: disabled
- **Do:** Offer to hide calories/weight if the user wants. Use neutral language about all foods.
- **Don't:** Offer fat-loss plans, fasting, keto, 'cheat' language or streak shaming.
- **Conflicts with:** fat_loss, intermittent_fasting, keto, cut_back_sugar
- **Facets:** existing —; new —
- **Jev:** None. Coach copy rules only. This profile disables other profiles' soft nudges.
- **Evidence:** expert_opinion — Nutrition care is led by the treatment team; calorie counting and restrictive language can harm. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ed_ada_2011](https://doi.org/10.1016/j.jada.2011.06.016)

#### After bariatric surgery  
`bariatric_post_op`

- **User says:** "gastric sleeve"; "gastric bypass"; "bariatric surgery"; "WLS"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`, `carbonated`, `alcohol`, `high_fat`
- **PREFER:** `protein_dense`
- **Targets:** stage_required: ask the programme's current stage: clear liquid / full liquid / puree / soft / solid; suggestions never exceed it; protein_g_min: 60; protein_note: up to 1.5 g/kg ideal body weight per programme; no_fluids_with_meals_min: 30
- **Do:** Until the stage is known, give no meal suggestions.
- **Facets:** existing `alcohol`; new `added_sugar`, `carbonated`, `high_fat`, `protein_dense`, `sugar_sweetened_beverage`
- **Jev:** protein_dense + texture_level (one-directional screen).
- **Evidence:** strong — AACE/TOS/ASMBS 2019: protein >=60 g/day, small meals, avoid sugars (dumping), staged textures after surgery. · Confirmation: item-level · Clinician note: yes
- **Sources:** [asmbs_2019](https://doi.org/10.1016/j.soard.2019.10.025); [asmbs_life_after](https://asmbs.org/patients/life-after-bariatric-surgery/)

### 4.3 "My doctor said…" directives (6)

#### Low-fibre / low-residue diet (doctor-directed, usually temporary)  
`low_residue_directive`

- **User says:** "low residue"; "low fiber diet"; "doctor said no fiber for now"; "flare diet"; "before colonoscopy"
- **HARD avoid:** —
- **SOFT limit:** `high_insoluble_fiber_residue`, `raw_cruciferous`, `raw_leafy_greens`, `beans`, `whole_grain`
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "until_date", "ask_end_date": true}`
- **Do:** Ask for an end date and revert automatically. Follow any written prep sheet the user gives over the app's list.
- **Don't:** Leave a temporary directive on indefinitely.
- **Facets:** existing `beans`, `raw_cruciferous`, `raw_leafy_greens`; new `high_insoluble_fiber_residue`, `whole_grain`
- **Jev:** score high_insoluble_fiber_residue.
- **Evidence:** expert_opinion — Used short-term for flares, strictures or procedure prep; content set by the care team. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aga_ibd_2024](https://pubmed.ncbi.nlm.nih.gov/38276922/); [niddk_divert](https://www.niddk.nih.gov/health-information/digestive-diseases/diverticulosis-diverticulitis/eating-diet-nutrition)

#### Low-iodine diet before radioactive iodine (doctor-directed)  
`low_iodine_directive`

- **User says:** "low iodine diet"; "before RAI"; "radioactive iodine prep"
- **HARD avoid (basis: user_confirmed_safety):** `high_iodine`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "until_date", "typical": "1-2 weeks before treatment"}`
- **Facets:** existing —; new `high_iodine`
- **Jev:** noul high_iodine; non-iodized salt is allowed.
- **Evidence:** expert_opinion — ATA patient guidance; the treating centre's sheet wins. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ata_low_iodine](https://www.thyroid.org/low-iodine-diet/)

#### Anti-inflammatory eating ('my doctor says focus on anti-inflammatory foods')  
`anti_inflammatory`

- **User says:** "anti-inflammatory diet"; "my doctor says focus on anti-inflammatory foods"; "reduce inflammation through food"; "inflammation diet"
- **HARD avoid:** —
- **SOFT limit:** `ultra_processed`, `processed_meat`, `red_meat`, `added_sugar`, `sugar_sweetened_beverage`, `refined_grain`, `fried`, `alcohol`
- **PREFER:** `omega3_rich`, `high_fiber`, `whole_grain`, `beans`
- **Targets:** —
- **Do:** Ask: 'Did your doctor name any foods or a reason?' and add those as the user's own rules. Lead with additions (fish, beans, olive oil, colourful plants) before removals.
- **Don't:** Claim foods 'cure' inflammation or disease. Ban nightshades, dairy or gluten as 'inflammatory' without the user's clinician.
- **Facets:** existing `alcohol`, `beans`; new `added_sugar`, `fried`, `high_fiber`, `omega3_rich`, `processed_meat`, `red_meat`, `refined_grain`, `sugar_sweetened_beverage`, `ultra_processed`, `whole_grain`
- **Jev:** Pure ranking pack: weights over existing+new facets; no blocks.
- **Evidence:** limited — No formal definition. Operationalised as a Mediterranean-style pattern. Diet-inflammation evidence is mostly biomarker/observational (DII); the Mediterranean pattern itself has strong outcome data. · Confirmation: item-level · Clinician note: yes
- **Sources:** [dii_2014](https://doi.org/10.1017/S1368980013002115); [predimed_2018](https://doi.org/10.1056/NEJMoa1800389); [harvard_antiinflam](https://www.health.harvard.edu/staying-healthy/foods-that-fight-inflammation)

#### Low-fat diet (doctor-directed: gallbladder, pancreatitis)  
`low_fat_directive`

- **User says:** "low fat diet"; "gallbladder diet"; "pancreatitis diet"; "after gallbladder removal"
- **HARD avoid:** —
- **SOFT limit:** `high_fat`, `fried`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Doctor said no alcohol → alcohol -> hard (user_confirmed_safety)
- **Facets:** existing `alcohol`; new `fried`, `high_fat`
- **Jev:** high_fat score + fried.
- **Evidence:** expert_opinion — Care team sets the fat level; NIDDK: low-fat eating and no alcohol are common advice after pancreatitis; gallstone advice is general healthy eating. · Confirmation: item-level · Clinician note: yes
- **Sources:** [niddk_pancreatitis](https://www.niddk.nih.gov/health-information/digestive-diseases/pancreatitis/eating-diet-nutrition); [niddk_gallstones](https://www.niddk.nih.gov/health-information/digestive-diseases/gallstones/eating-diet-nutrition)

#### Low-sodium (doctor-directed)  
`low_sodium_directive`

- **User says:** "low sodium"; "low salt"; "doctor said cut salt"; "2 gram sodium diet"; "heart failure salt limit"
- **HARD avoid:** —
- **SOFT limit:** `high_sodium`, `processed_meat`
- **PREFER:** —
- **Targets:** sodium_mg_max: user enters clinician number (default 2000)
- **Options (user-set variants):** I also have a fluid limit → target fluid_ml (code)
- **Conflicts with:** lithium
- **Facets:** existing —; new `high_sodium`, `processed_meat`
- **Jev:** high_sodium (deterministic-first).
- **Evidence:** strong — AHA/ACC 2025; KDIGO 2024 (<2 g in CKD). · Confirmation: item-level · Clinician note: yes
- **Sources:** [aha_acc_htn_2025](https://doi.org/10.1016/j.jacc.2025.05.007); [kdigo_2024](https://kdigo.org/wp-content/uploads/2024/03/KDIGO-2024-CKD-Guideline.pdf)

#### High-protein (doctor-directed: wound healing, sarcopenia, recovery)  
`high_protein_directive`

- **User says:** "doctor said more protein"; "need more protein for healing"; "sarcopenia"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `protein_dense`
- **Targets:** protein_g_per_kg: user enters clinician number (older adults typically 1.0-1.5)
- **Conflicts with:** ckd
- **Facets:** existing —; new `protein_dense`
- **Jev:** protein_dense.
- **Evidence:** moderate — PROT-AGE; ESPEN. · Confirmation: item-level · Clinician note: yes
- **Sources:** [prot_age_2013](https://doi.org/10.1016/j.jamda.2013.05.021); [espen_cancer_2021](https://doi.org/10.1016/j.clnu.2021.02.005)

### 4.4 Medication–food interactions (15)

#### Insulin or a sulfonylurea (hypoglycaemia risk)  
`insulin_or_sulfonylurea`

- **User says:** "insulin"; "glipizide"; "glyburide"; "glimepiride"; "gliclazide"
- **HARD avoid:** —
- **SOFT limit:** `alcohol`
- **PREFER:** —
- **Targets:** skipped_meals_and_fasting: no fasting/IF/Ramadan plan generated without a clinician-approved plan; alcohol: with food only; lows can be delayed; hypo_treatment_foods: never flagged when logged for a low
- **Conflicts with:** ramadan_fasting, intermittent_fasting, keto, religious_fast_generic
- **Facets:** existing `alcohol`; new —
- **Jev:** None; scheduling and copy rules.
- **Evidence:** strong — ADA SOC 2026: insulin and insulin secretagogues cause hypoglycaemia; alcohol and missed meals raise the risk. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ada_soc_2026_s5](https://doi.org/10.2337/dc26-S005); [ada_soc_2026](https://professional.diabetes.org/standards-of-care)

#### Hypothyroidism on levothyroxine  
`hypothyroid_levothyroxine`

- **User says:** "hypothyroid"; "Hashimoto's"; "levothyroxine"; "Synthroid"; "underactive thyroid"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** dose_timing: empty stomach with water, 30-60 min before breakfast (or bedtime >=3 h after food), per prescriber; separate_by_4h: calcium supplements, iron supplements, antacids; coffee: wait 30-60 min after the dose (timing, not a limit)
- **Do:** Offer a morning reminder spacing breakfast/coffee from the dose, only if the user asks.
- **Don't:** Ban cruciferous vegetables or soy (cooked normal amounts are fine). Suggest gluten-free for Hashimoto's unless celiac is confirmed.
- **Facets:** existing —; new —
- **Jev:** No food facet gate: this is a timing rule handled in code.
- **Evidence:** strong — ATA 2014 / label: food, coffee, calcium, iron, soy and high fibre reduce absorption; consistency matters most. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ata_hypo_2014](https://doi.org/10.1089/thy.2014.0028); [ml_levothyroxine](https://medlineplus.gov/druginfo/meds/a682461.html)

#### On a GLP-1 medicine (semaglutide, tirzepatide)  
`glp1_medication`

- **User says:** "Ozempic"; "Wegovy"; "Mounjaro"; "Zepbound"; "semaglutide"
- **HARD avoid:** —
- **SOFT limit:** `high_fat`, `fried`, `alcohol`, `sugar_sweetened_beverage`
- **PREFER:** `protein_dense`, `high_fiber`
- **Targets:** protein_g_per_kg_during_loss: 1.2-1.6; protein_g_per_day_alt: 80-120; meal_size: small, frequent
- **Do:** Watch for very low intake days; nudge protein first.
- **Conflicts with:** ckd (protein cap wins), ckd_dialysis
- **Facets:** existing `alcohol`; new `fried`, `high_fat`, `high_fiber`, `protein_dense`, `sugar_sweetened_beverage`
- **Jev:** Food facets only.
- **Evidence:** moderate — 2025 joint advisory (ACLM/ASN/OMA/TOS): prioritise protein and nutrient density, small meals, fluids; limit fatty foods and alcohol for GI tolerance. · Confirmation: item-level · Clinician note: yes
- **Sources:** [glp1_2025](https://pubmed.ncbi.nlm.nih.gov/40445127/)

#### Warfarin (Coumadin/Jantoven)  
`warfarin`

- **User says:** "warfarin"; "Coumadin"; "blood thinner (warfarin)"
- **HARD avoid:** —
- **SOFT limit:** `alcohol`
- **PREFER:** —
- **Targets:** vitamin_k: keep weekly intake consistent; flag big week-to-week swings (tracked via vitamin_k_rich)
- **Do:** Track vitamin_k_rich foods per week and show consistency.
- **Don't:** Tell the user to avoid leafy greens. Apply this to DOAC users.
- **Facets:** existing `alcohol`; new `vitamin_k_rich`
- **Jev:** score vitamin_k_rich; code computes weekly variance.
- **Evidence:** strong — NIH ODS: keep vitamin K intake consistent rather than avoiding greens; DOACs (apixaban, rivaroxaban) have no vitamin K rule. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ods_vitk](https://ods.od.nih.gov/factsheets/VitaminK-HealthProfessional/)

#### MAO inhibitor (phenelzine, tranylcypromine, isocarboxazid)  
`maoi`

- **User says:** "MAOI"; "Nardil"; "Parnate"; "Marplan"; "phenelzine"
- **HARD avoid (basis: user_confirmed_safety):** `tyramine_rich`, `alcohol`
- **SOFT limit:** `caffeine`
- **PREFER:** —
- **Targets:** label_list: match the specific drug's label list in code (phenelzine: cheeses esp. aged, pickled herring, beer incl. alcohol-free, wine, liver, yeast extract, dry sausage, fava pods, yogurt); unknown -> unverified; caffeine_chocolate: avoid excessive amounts (label)
- **Options (user-set variants):** Selegiline patch 6 mg → tyramine_rich -> soft
- **Do:** Continue the rule for 2 weeks after stopping (per prescriber).
- **Facets:** existing `alcohol`; new `caffeine`, `tyramine_rich`
- **Jev:** noul tyramine_rich; 'unknown' shows 'Check with pharmacist'.
- **Evidence:** strong — Tyramine/dopamine food restriction is part of labelling for non-selective MAOIs; the phenelzine label also names alcohol and excess caffeine/chocolate. Transdermal selegiline at 6 mg/24 h is exempt. · Confirmation: item-level · Clinician note: yes
- **Sources:** [maoi_2012](https://doi.org/10.4088/JCP.11096su1c.03); [dailymed_phenelzine](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?audience=consumer&setid=b7ec6ae7-3d76-42aa-9d8a-fc3e187769b5); [ml_phenelzine](https://medlineplus.gov/druginfo/meds/a682089.html)

#### Linezolid (Zyvox) course  
`linezolid`

- **User says:** "linezolid"; "Zyvox"
- **HARD avoid:** —
- **SOFT limit:** `tyramine_rich`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** My doctor/pharmacist said avoid them completely → tyramine_rich -> hard (user_confirmed_safety)
- **Time window:** `{"type": "course length"}`
- **Do:** Suggest small portions only of aged cheese, cured meat, soy sauce, tap beer, red wine.
- **Facets:** existing —; new `tyramine_rich`
- **Jev:** noul tyramine_rich.
- **Evidence:** strong — 2026 label: avoid LARGE amounts of high-tyramine foods (pressor response above ~100 mg tyramine). Less strict than non-selective MAOIs. · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_linezolid_label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021130s050lbl.pdf)

#### Grapefruit-interacting medicine (some statins, some calcium-channel blockers, etc.)  
`statin_grapefruit`

- **User says:** "simvastatin"; "lovastatin"; "atorvastatin"; "Zocor"; "felodipine"
- **HARD avoid (basis: user_confirmed_safety):** `grapefruit_family`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Activate only when the user confirms their label/pharmacist says so.
- **Don't:** Infer from 'I take a statin' alone.
- **Facets:** existing —; new `grapefruit_family`
- **Jev:** noul grapefruit_family (ingredient keyword first).
- **Evidence:** strong — FDA: grapefruit raises blood levels of some drugs (e.g., simvastatin, lovastatin; atorvastatin with large amounts). Rosuvastatin and pravastatin are not meaningfully affected. · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_grapefruit](https://www.fda.gov/consumers/consumer-updates/grapefruit-juice-and-some-drugs-dont-mix)

#### Tacrolimus / cyclosporine / sirolimus / everolimus  
`immunosuppressant_grapefruit`

- **User says:** "tacrolimus"; "Prograf"; "Envarsus"; "cyclosporine"; "sirolimus"
- **HARD avoid (basis: user_confirmed_safety):** `grapefruit_family`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Do:** Also apply the immunocompromised food-safety profile if the user confirms it.
- **Facets:** existing —; new `grapefruit_family`
- **Jev:** noul grapefruit_family (keyword first).
- **Evidence:** strong — Prograf label: avoid grapefruit and grapefruit juice (raises drug levels). · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_prograf_label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2021/050708s053%2C050709s045%2C210115s005lbl.pdf); [fda_grapefruit](https://www.fda.gov/consumers/consumer-updates/grapefruit-juice-and-some-drugs-dont-mix)

#### Lithium  
`lithium`

- **User says:** "lithium"; "lithium carbonate"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** sodium: keep daily salt steady; avoid sudden low-salt diets; fluids: steady; extra with heat/exercise
- **Don't:** Start a low-sodium or keto plan without the prescriber.
- **Conflicts with:** hypertension (sodium cut), keto, low_sodium_directive
- **Facets:** existing —; new —
- **Jev:** None; code watches large sodium swings.
- **Evidence:** strong — Label/MedlinePlus: changes in salt and fluid intake change lithium levels. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_lithium](https://medlineplus.gov/druginfo/meds/a681039.html)

#### Tetracycline or fluoroquinolone antibiotic  
`antibiotic_mineral_binding`

- **User says:** "doxycycline"; "tetracycline"; "minocycline"; "ciprofloxacin"; "levofloxacin"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** timing: keep dairy, calcium-fortified foods, iron and antacids apart from doses as the label says (e.g., cipro: 2 h before or 6 h after)
- **Time window:** `{"type": "course_length"}`
- **Facets:** existing —; new —
- **Jev:** contains_dairy + calcium_rich used for timing reminders only.
- **Evidence:** strong — Label: calcium, iron and dairy bind these drugs. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_tetracycline](https://medlineplus.gov/druginfo/meds/a682098.html); [ml_cipro](https://medlineplus.gov/druginfo/meds/a688016.html)

#### Oral bisphosphonate (alendronate, risedronate, ibandronate)  
`bisphosphonate`

- **User says:** "alendronate"; "Fosamax"; "risedronate"; "Actonel"; "Atelvia"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** timing_by_drug: {'alendronate_tablet': 'first thing, with 6-8 oz plain water; nothing else to eat, drink or take for >=30 min; stay upright until after the first food', 'risedronate_immediate_release': '>=30 min before first food/drink with 6-8 oz plain water; upright 30 min (follow label)', 'risedronate_delayed_release (Atelvia)': 'immediately AFTER breakfast with >=4 oz plain water; swallow whole while upright; no lying down for 30 min', 'ibandronate_oral': '60 min before food/drink/other medicines with plain water; upright 60 min'}; unknown_drug: no timing advice until the exact product is known
- **Facets:** existing —; new —
- **Jev:** None; timing reminder shows the label wording for the exact product.
- **Evidence:** strong — Product labels differ by drug and formulation. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_alendronate](https://medlineplus.gov/druginfo/meds/a601011.html); [fda_boniva_label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2007/021455s005lbl.pdf); [fda_atelvia_label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/022560s013bl.pdf)

#### Potassium-retaining medicine (ACE inhibitor, ARB, spironolactone)  
`ace_arb_spironolactone`

- **User says:** "lisinopril"; "losartan"; "spironolactone"; "ACE inhibitor"; "ARB"
- **HARD avoid:** —
- **SOFT limit:** `contains_ingredient:potassium chloride salt substitute`
- **PREFER:** —
- **Targets:** —
- **Do:** Suppress 'eat more potassium' nudges unless the clinician said so.
- **Facets:** existing —; new `contains_ingredient:potassium chloride salt substitute`
- **Jev:** contains_ingredient template.
- **Evidence:** moderate — 2025 AHA/ACC: potassium salt substitutes and supplementation are for people without CKD or K-retaining drugs. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aha_acc_htn_2025](https://doi.org/10.1016/j.jacc.2025.05.007)

#### SGLT2 inhibitor (empagliflozin, dapagliflozin, canagliflozin)  
`sglt2_inhibitor`

- **User says:** "Jardiance"; "Farxiga"; "Invokana"; "empagliflozin"; "dapagliflozin"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Don't:** Activate keto or extended fasting without a clinician note.
- **Conflicts with:** keto, intermittent_fasting, ramadan_fasting
- **Facets:** existing —; new —
- **Jev:** None; conflict rule.
- **Evidence:** strong — Euglycaemic DKA risk rises with very-low-carb/ketogenic diets, fasting and alcohol excess. · Confirmation: item-level · Clinician note: yes
- **Sources:** [sglt2_edka_2015](https://doi.org/10.2337/dc15-1380)

#### Disulfiram (Antabuse)  
`disulfiram`

- **User says:** "Antabuse"; "disulfiram"
- **HARD avoid (basis: user_confirmed_safety):** `alcohol`, `contains_ingredient:wine, beer, spirits, liqueur or cooking wine (including cooked-off)`, `contains_ingredient:vinegar`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "while taking + 14 days after last dose"}`
- **Do:** Also remind about non-food alcohol (mouthwash, cough syrup) once, as information.
- **Facets:** existing `alcohol`; new `contains_ingredient:vinegar`, `contains_ingredient:wine, beer, spirits, liqueur or cooking wine (including cooked-off)`
- **Jev:** alcohol facet is 'as consumed' and misses cooked-off wine: add the ingredient-level checks in code.
- **Evidence:** strong — MedlinePlus: avoid sauces, vinegars and all foods/drinks containing alcohol; a reaction may occur up to 2 weeks after stopping. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_disulfiram](https://medlineplus.gov/druginfo/meds/a682602.html)

#### Metronidazole / tinidazole course  
`metronidazole`

- **User says:** "metronidazole"; "Flagyl"; "tinidazole"
- **HARD avoid (basis: user_confirmed_safety):** `alcohol`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "course + 3 days"}`
- **Facets:** existing `alcohol`; new —
- **Jev:** alcohol facet.
- **Evidence:** limited — Product labels advise no alcohol during and for 3 days after (tinidazole); CDC 2021 notes convincing evidence of a disulfiram-like reaction is lacking. Follow the label. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ml_metronidazole](https://medlineplus.gov/druginfo/meds/a689011.html); [cdc_sti_2021](https://www.cdc.gov/mmwr/volumes/70/rr/rr7004a1.htm)

### 4.5 Life stage (6)

#### Gestational diabetes  
`gestational_diabetes`

- **User says:** "gestational diabetes"; "GDM"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`, `high_glycemic_load`
- **PREFER:** `high_fiber`, `protein_dense`
- **Targets:** carb_g_min: 175; plan: obstetric/diabetes team's meal plan
- **Don't:** Set a calorie deficit. Override the care team's meal plan.
- **Conflicts with:** fat_loss
- **Facets:** existing —; new `added_sugar`, `high_fiber`, `high_glycemic_load`, `protein_dense`, `sugar_sweetened_beverage`
- **Jev:** as type2_diabetes; pregnancy profile also applies.
- **Evidence:** strong — ADA SOC 2026 §15: at least 175 g carbohydrate, 71 g protein, 28 g fibre per day; carbohydrate distribution is individualised. · Confirmation: item-level · Clinician note: yes
- **Sources:** [ada_soc_2026_preg](https://doi.org/10.2337/dc26-S015)

#### Pregnancy  
`pregnancy`

- **User says:** "pregnant"; "expecting"; "I'm X weeks"
- **HARD avoid (basis: user_confirmed_safety):** `alcohol`, `high_mercury_fish`, `high_listeria_risk`, `unpasteurized`, `raw_or_undercooked_animal`
- **SOFT limit:** `caffeine`
- **PREFER:** `omega3_rich`, `iron_rich`, `calcium_rich`
- **Targets:** caffeine_mg_max: 200; low_mercury_fish_oz_per_week: 8-12 from Best Choices (or 1 serving/week from Good Choices such as albacore); tuna of unknown species -> unverified; kcal_extra: DGA 2020-2025 estimates: 0 (T1), ~+340 (T2), ~+452 (T3); individualise with the clinician; carb_g_min: 175; protein_g_min: 71; fiber_g_min: 28; calorie_deficit: disabled; ketogenic_or_very_low_carb: disabled
- **Do:** Reheat deli meats until steaming; suggest low-mercury fish (salmon, sardines, trout). Mention prenatal vitamin talk with the clinician.
- **Don't:** Suggest liver often or vitamin A supplements. Run fat-loss or fasting plans.
- **Conflicts with:** fat_loss, intermittent_fasting, keto (disabled), low_carb (floor 175 g), ramadan_fasting (exempt)
- **Facets:** existing `alcohol`; new `caffeine`, `calcium_rich`, `high_listeria_risk`, `high_mercury_fish`, `iron_rich`, `omega3_rich`, `raw_or_undercooked_animal`, `unpasteurized`
- **Jev:** Food facets only.
- **Evidence:** strong — CDC: no known safe alcohol amount; FDA/EPA fish advice; CDC Listeria; ACOG <200 mg caffeine; DGA 2025 iron/folate/iodine priorities. · Confirmation: item-level · Clinician note: yes
- **Sources:** [cdc_alcohol_preg](https://www.cdc.gov/alcohol-pregnancy/about/index.html); [fda_fish](https://www.fda.gov/food/consumers/advice-about-eating-fish); [cdc_listeria](https://www.cdc.gov/listeria/prevention/index.html); [cdc_preg_foods](https://www.cdc.gov/food-safety/foods/pregnant-women.html); [acog_caffeine](https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2010/08/moderate-caffeine-consumption-during-pregnancy); [ada_soc_2026_preg](https://doi.org/10.2337/dc26-S015); [dga_2020](https://www.dietaryguidelines.gov/sites/default/files/2020-12/Dietary_Guidelines_for_Americans_2020-2025.pdf)

#### Trying to conceive  
`trying_to_conceive`

- **User says:** "trying for a baby"; "TTC"; "planning pregnancy"
- **HARD avoid:** —
- **SOFT limit:** `alcohol`, `high_mercury_fish`
- **PREFER:** `iron_rich`
- **Targets:** folic_acid_note: clinician: 400 mcg/day
- **Facets:** existing `alcohol`; new `high_mercury_fish`, `iron_rich`
- **Jev:** Food facets only.
- **Evidence:** strong — Folic acid before conception; limit mercury. · Confirmation: item-level · Clinician note: yes
- **Sources:** [fda_fish](https://www.fda.gov/food/consumers/advice-about-eating-fish); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Breastfeeding  
`lactation`

- **User says:** "breastfeeding"; "nursing"; "pumping"; "lactating"
- **HARD avoid (basis: user_confirmed_safety):** `high_mercury_fish`
- **SOFT limit:** `alcohol`, `caffeine`
- **PREFER:** `omega3_rich`, `protein_dense`
- **Targets:** caffeine_mg_max: 300; alcohol: none is safest; if 1 drink, wait >=2 h before nursing; kcal_extra: DGA 2020-2025 estimates: ~+330 (0-6 mo), ~+400 (7-12 mo); individualise; deficit: gentle only
- **Do:** Vegan mothers: B12 is essential (flag for clinician).
- **Facets:** existing `alcohol`; new `caffeine`, `high_mercury_fish`, `omega3_rich`, `protein_dense`
- **Jev:** Food facets only.
- **Evidence:** strong — CDC: caffeine <=300 mg/day; alcohol timing; FDA/EPA fish advice applies. · Confirmation: item-level · Clinician note: yes
- **Sources:** [cdc_bf_diet](https://www.cdc.gov/breastfeeding-special-circumstances/hcp/diet-micronutrients/maternal-diet.html); [cdc_bf_alcohol](https://www.cdc.gov/breastfeeding-special-circumstances/hcp/vaccine-medication-drugs/alcohol.html); [fda_fish](https://www.fda.gov/food/consumers/advice-about-eating-fish); [dga_2020](https://www.dietaryguidelines.gov/sites/default/files/2020-12/Dietary_Guidelines_for_Americans_2020-2025.pdf)

#### Older adult (65+)  
`older_adult`

- **User says:** "I'm 70"; "senior"; "older adult"; "retired and want to keep strong"
- **HARD avoid:** —
- **SOFT limit:** `high_listeria_risk`, `unpasteurized`, `raw_or_undercooked_animal`
- **PREFER:** `protein_dense`, `calcium_rich`
- **Targets:** protein_g_per_kg: 1.0-1.2 (1.2-1.5 if ill); b12: fortified foods/supplement per clinician; vitamin_d: per clinician
- **Options (user-set variants):** Treat risky raw foods as off-limits → soft -> hard (user_rule)
- **Facets:** existing —; new `calcium_rich`, `high_listeria_risk`, `protein_dense`, `raw_or_undercooked_animal`, `unpasteurized`
- **Jev:** Food facets only; age is never sent to Jev.
- **Evidence:** moderate — PROT-AGE 2013; DGA 2025 older-adult section; FDA lists older adults as higher risk for foodborne illness. · Confirmation: item-level · Clinician note: no
- **Sources:** [prot_age_2013](https://doi.org/10.1016/j.jamda.2013.05.021); [dga_2025](https://cdn.realfood.gov/DGA.pdf); [fda_people_at_risk](https://www.fda.gov/food/consumers/people-risk-foodborne-illness)

#### Under 18 (child or teen)  
`minor_under_18`

- **User says:** "I'm 15"; "teen"; "for my child"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** adult_profiles: fat_loss, keto, intermittent_fasting, adult kcal plans and adult protein/sodium defaults DISABLED; sodium_mg_max: DGA: <1200 (1-3 y), <1500 (4-8), <1800 (9-13), <2300 (14+); weight_goals: only with a paediatric clinician (AAP 2023); age_certainty: birth year alone is not enough near 18; ask or collect full date of birth; treat as under 18 until confirmed
- **Conflicts with:** fat_loss, keto, intermittent_fasting, muscle_gain (adult protein ranges)
- **Facets:** existing —; new —
- **Jev:** None. Global age gate. Birth year alone is not enough: if (current year - birth year) <= 18, ask 'Are you 18 or older?' or collect the full date of birth; until answered, treat as under 18.
- **Evidence:** strong — Paediatric targets need an age-specific pathway (AAP 2023; DGA 2025). · Confirmation: profile-level · Clinician note: yes
- **Sources:** [aap_obesity_2023](https://doi.org/10.1542/peds.2022-060640); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

### 4.6 Religious and cultural (13)

#### Halal  
`halal`

- **User says:** "halal"; "I'm Muslim"; "no haram food"; "zabiha only"
- **HARD avoid (basis: religious):** `pork`, `alcohol`, `blood_product`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Meat must be halal-slaughtered → meat/poultry without halal evidence -> 'unverified' (requiresVerification); No shellfish / non-fish seafood (e.g., Hanafi) → shellfish, mollusc -> hard; Avoid carmine and insect ingredients → insect_derived -> hard; Gelatin → gelatin_source pork -> blocked; fish/plant -> allowed; beef or unstated -> unverified unless halal-certified
- **Facets:** existing `alcohol`, `beef`, `meat`, `pork`, `shellfish`; new `blood_product`, `gelatin_source`, `insect_derived`, `mollusc`, `poultry`
- **Jev:** Existing pork + alcohol (requiresVerification) + gelatin_source, blood_product. Jev can say 'contains pork', never 'is halal'.
- **Evidence:** religious_rule — Religious rules are the user's own. The app never certifies; 'no forbidden ingredient found' is not 'halal/kosher'. · Confirmation: item-level · Clinician note: no
- **Sources:** [regenstein_2003](https://doi.org/10.1111/j.1541-4337.2003.tb00018.x); [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/); [ifanca_gelatin](https://ifanca.org/app/uploads/2023/02/Islamic-Perspective-XV1.pdf)

#### Kosher  
`kosher`

- **User says:** "kosher"; "keep kosher"; "I'm Jewish and keep kosher"; "kosher-style"
- **HARD avoid (basis: religious):** `pork`, `shellfish`, `fish_without_fins_scales`, `mixes_meat_and_dairy`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Observance level → {'no_pork_shellfish': 'pork, shellfish/non-kosher fish -> hard; nothing else', 'kosher_style': 'adds meat+dairy separation, blood, insect_derived', 'strict_certified': "adds: every processed food, meat, wine and cheese needs kosher certification -> otherwise 'unverified'"}; Hours to wait after meat before dairy → [1, 3, 6]; Gelatin OK if kosher-certified → gelatin -> unverified; Passover rules → window: chametz = leavened wheat, barley, spelt, rye or oats (contains_ingredient list) -> hard unless certified kosher-for-Passover (then 'unverified' -> allowed on evidence); Avoid kitniyot on Passover (many Ashkenazi) → rice, corn, legumes, soy -> hard in the Passover window
- **Time window:** `{"optional": "Passover (8 days)"}`
- **Facets:** existing `meat`, `pork`, `shellfish`; new `fish_without_fins_scales`, `gelatin`, `insect_derived`, `mixes_meat_and_dairy`
- **Jev:** mixes_meat_and_dairy on a dish; code also checks across items in one meal and the wait window between meals.
- **Evidence:** religious_rule — Religious rules are the user's own. The app never certifies; 'no forbidden ingredient found' is not 'halal/kosher'. · Confirmation: item-level · Clinician note: no
- **Sources:** [regenstein_2003](https://doi.org/10.1111/j.1541-4337.2003.tb00018.x); [ou_primer](https://oukosher.org/nav-test-kosher-food-the-kosher-primer/); [ou_fish](https://oukosher.org/blog/industrial-kosher/fish-qa/); [ou_passover](https://oukosher.org/passover/articles/glossary-of-common-passover-terms/)

#### Hindu vegetarian (lacto-vegetarian)  
`hindu_vegetarian`

- **User says:** "Hindu vegetarian"; "pure veg"; "I don't eat meat or eggs for religious reasons"; "sattvic"
- **HARD avoid (basis: religious):** `meat`, `fish_seafood`, `beef`, `gelatin`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** No eggs → contains_egg -> hard; No onion or garlic → onion_garlic -> hard; Fasting days (Ekadashi, Navratri, etc.) → user-defined window; e.g., contains_grain -> hard on those days
- **Facets:** existing `beef`, `contains_egg`, `fish_seafood`, `meat`, `onion_garlic`; new `contains_grain`, `gelatin`
- **Jev:** Existing meat/fish_seafood/beef/onion_garlic + gelatin.
- **Evidence:** religious_rule — Practice varies by family and region; the user defines it. · Confirmation: item-level · Clinician note: no
- **Sources:** [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

#### No beef (Hindu, non-vegetarian)  
`hindu_no_beef`

- **User says:** "I'm Hindu, no beef"; "no cow"
- **HARD avoid (basis: religious):** `beef`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Also no beef gelatin/tallow → gelatin_source beef -> blocked; unstated -> unverified; fish/pork/plant -> allowed
- **Facets:** existing `beef`, `pork`; new `gelatin`, `gelatin_source`
- **Jev:** Existing beef facet + gelatin_source.
- **Evidence:** religious_rule — Common among non-vegetarian Hindus. · Confirmation: item-level · Clinician note: no
- **Sources:** [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/); [haf_diet](https://www.hinduamerican.org/employee-accommodation-request-dietary-restrictions)

#### Jain  
`jain`

- **User says:** "Jain"; "Jain food"; "no root vegetables"
- **HARD avoid (basis: religious):** `meat`, `fish_seafood`, `contains_egg`, `honey`, `root_vegetable`, `alcohol`, `gelatin`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** No food after sunset (chauvihar) → time window by local sunset; No mushrooms/yeast → contains_ingredient:mushroom -> hard; No dairy → contains_dairy -> hard
- **Facets:** existing `alcohol`, `contains_dairy`, `contains_egg`, `fish_seafood`, `meat`; new `gelatin`, `honey`, `root_vegetable`
- **Jev:** root_vegetable noul + existing facets.
- **Evidence:** religious_rule — Ahimsa-based; strictness varies. · Confirmation: item-level · Clinician note: no
- **Sources:** [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

#### Buddhist vegetarian  
`buddhist_vegetarian`

- **User says:** "Buddhist vegetarian"; "Chinese Buddhist diet"; "no five pungent"
- **HARD avoid (basis: religious):** `meat`, `fish_seafood`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** No onion, garlic, leek, chives, shallot → onion_garlic -> hard; No alcohol → alcohol -> hard; No eggs → contains_egg -> hard
- **Facets:** existing `alcohol`, `contains_egg`, `fish_seafood`, `meat`, `onion_garlic`; new —
- **Jev:** Existing facets.
- **Evidence:** religious_rule — Varies widely by tradition; many Buddhists eat meat. · Confirmation: item-level · Clinician note: no
- **Sources:** [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

#### Sikh dietary practice  
`sikh`

- **User says:** "Sikh"; "no kutha meat"; "Amritdhari"
- **HARD avoid (basis: religious):** `alcohol`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Vegetarian → vegetarian profile; No kutha (ritually slaughtered, e.g., halal/kosher) meat → meat labelled halal/zabiha/kosher -> hard; unlabelled meat allowed unless the user also chooses 'jhatka only' (then unverified); No beef → beef -> hard
- **Facets:** existing `alcohol`, `beef`, `meat`; new —
- **Jev:** Slaughter method is read from label text in code (halal/kosher marks); Jev cannot judge it.
- **Evidence:** religious_rule — Sikh Rehat Maryada prohibits kutha meat and intoxicants; practice varies. · Confirmation: item-level · Clinician note: no
- **Sources:** [sgpc_rehat](https://www.sgpc.net/sikh-rehat-maryada-in-english/); [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

#### Seventh-day Adventist  
`sda`

- **User says:** "Adventist"; "SDA"; "Seventh-day Adventist"
- **HARD avoid (basis: religious):** `pork`, `shellfish`, `fish_without_fins_scales`, `alcohol`
- **SOFT limit:** `caffeine`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Lacto-ovo vegetarian → vegetarian profile; No caffeine → caffeine -> hard
- **Facets:** existing `alcohol`, `pork`, `shellfish`; new `caffeine`, `fish_without_fins_scales`
- **Jev:** Existing + fish_without_fins_scales.
- **Evidence:** religious_rule — Church belief 22: healthful diet, abstain from biblically unclean foods and alcohol; many members are vegetarian. · Confirmation: item-level · Clinician note: no
- **Sources:** [sda_belief22](https://www.adventist.org/christian-behavior/); [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

#### Latter-day Saint (Word of Wisdom)  
`lds_word_of_wisdom`

- **User says:** "LDS"; "Mormon"; "Word of Wisdom"; "no coffee or tea"
- **HARD avoid (basis: religious):** `alcohol`, `coffee_or_tea`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** I also avoid caffeine → caffeine -> hard (user_rule); Also avoid coffee-flavoured foods (tiramisu, mocha) → coffee_or_tea covers flavours made with real coffee
- **Don't:** Block cola, energy drinks or herbal tea by default.
- **Facets:** existing `alcohol`; new `caffeine`, `coffee_or_tea`
- **Jev:** coffee_or_tea noul (not caffeine).
- **Evidence:** religious_rule — Word of Wisdom: no alcohol, coffee or tea (herbal teas are fine). The Church's 2012 statement: caffeine itself is not named. · Confirmation: item-level · Clinician note: no
- **Sources:** [lds_wow](https://www.churchofjesuschrist.org/study/manual/gospel-topics/word-of-wisdom); [lds_caffeine_2012](https://www.deseret.com/2012/9/7/20506366/caffeine-and-controversy/)

#### Ramadan fasting  
`ramadan_fasting`

- **User says:** "fasting for Ramadan"; "Ramadan"; "suhoor"; "iftar"
- **HARD avoid:** —
- **SOFT limit:** `fried`, `added_sugar`
- **PREFER:** `protein_dense`, `high_fiber`, `whole_grain`
- **Targets:** plan_generation: BLOCKED while type1_diabetes, insulin_or_sulfonylurea, sglt2_inhibitor, pregnancy, ckd_dialysis or eating_disorder_recovery is active, OR while any diabetes profile has an unanswered/unsure treatment question, until the user records a clinician-approved fasting plan; logging still works; fluids: spread between iftar and suhoor; daily_targets: fit into the eating window
- **Time window:** `{"type": "dawn_to_sunset", "dates": "user's local calendar", "meals": ["suhoor (pre-dawn)", "iftar (sunset)"]}`
- **Do:** Move meal slots to suhoor/iftar; stop daytime log nudges.
- **Don't:** Send 'you haven't eaten' nudges during the fast.
- **Conflicts with:** type1_diabetes, insulin_or_sulfonylurea, sglt2_inhibitor, type2_diabetes (treatment unknown), pregnancy, ckd_dialysis, eating_disorder_recovery
- **Facets:** existing —; new `added_sugar`, `fried`, `high_fiber`, `protein_dense`, `whole_grain`
- **Jev:** None; scheduling in code.
- **Evidence:** moderate — IDF-DAR 2021: people with diabetes need risk assessment before fasting; exemptions for illness, pregnancy, travel. · Confirmation: item-level · Clinician note: no
- **Sources:** [idf_dar_2021](https://www.daralliance.org/daralliance/idf-dar-practical-guidelines-2021/); [idf_dar_2026](https://idf.org/about-diabetes/resources/idf-dar-risk-calculator-update-2026/)

#### Catholic Lent (Fridays without meat)  
`lent_catholic`

- **User says:** "Lent"; "no meat on Fridays"; "Ash Wednesday"
- **HARD avoid (basis: religious):** `land_animal_flesh`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"abstinence_days": "Ash Wednesday, all Fridays in Lent, Good Friday (age 14+)", "fast_days": "Ash Wednesday, Good Friday: one full meal + two smaller (ages 18-59; health exemptions)"}`
- **Facets:** existing —; new `land_animal_flesh`
- **Jev:** New land_animal_flesh facet (the existing meat facet includes broth/gelatin and would over-block); fasting-day meal count handled in code.
- **Evidence:** religious_rule — USCCB: abstain from meat (14+) on those days; fish, broth, gelatin and meat flavourings are technically permitted; fasting (18-59) is separate from abstinence. · Confirmation: item-level · Clinician note: no
- **Sources:** [usccb_lent](https://www.usccb.org/resources/Fasting-Lent-Info.pdf); [usccb_meat](https://www.usccb.org/es/node/50977)

#### Orthodox Christian fasting  
`orthodox_fasting`

- **User says:** "Orthodox fast"; "Great Lent (Orthodox)"; "Nativity fast"; "Wednesday and Friday fast"
- **HARD avoid (basis: religious):** `meat`, `contains_dairy`, `contains_egg`, `contains_finfish`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Shellfish allowed on fast days → if false: crustacean_shellfish, mollusc -> hard; Fish/wine/oil allowed on the calendar's allowance days → per the user's local church calendar; Also no oil and wine on strict days → alcohol + contains_ingredient:olive oil -> hard
- **Time window:** `{"type": "user calendar (Wednesdays, Fridays, fasting seasons)"}`
- **Facets:** existing `alcohol`, `contains_dairy`, `contains_egg`, `meat`; new `contains_finfish`, `crustacean_shellfish`, `mollusc`
- **Jev:** Existing facets.
- **Evidence:** religious_rule — Rules vary by jurisdiction and by day; follow the user's parish calendar. · Confirmation: item-level · Clinician note: no
- **Sources:** [oca_fasting](https://www.oca.org/liturgics/outlines/fasting-fast-free-seasons-of-the-church); [orthodox_2003](https://doi.org/10.1186/1471-2458-3-16)

#### Other religious fast (Yom Kippur, Ekadashi, Navratri, etc.)  
`religious_fast_generic`

- **User says:** "fasting today for religious reasons"; "Yom Kippur"; "Ekadashi"; "Navratri fast"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "user-defined", "mode": "no food/drink OR restricted foods"}`
- **Facets:** existing —; new —
- **Jev:** None; window in code; restricted foods via existing facets.
- **Evidence:** religious_rule — User-defined. · Confirmation: item-level · Clinician note: no
- **Sources:** [religious_ije_2021](https://pubmed.ncbi.nlm.nih.gov/33207368/)

### 4.7 Ethical, lifestyle and named diet patterns (24)

#### Vegetarian (lacto-ovo)  
`vegetarian_lacto_ovo`

- **User says:** "vegetarian"; "veggie"; "I don't eat meat or fish"
- **HARD avoid (basis: user_rule):** `meat`, `fish_seafood`, `gelatin`
- **SOFT limit:** —
- **PREFER:** `beans`, `protein_dense`, `iron_rich`
- **Targets:** —
- **Options (user-set variants):** Avoid cheese made with animal rennet → contains_ingredient:animal rennet -> hard
- **Facets:** existing `beans`, `fish_seafood`, `meat`; new `gelatin`, `iron_rich`, `protein_dense`
- **Jev:** Existing vegetarian flag + gelatin.
- **Evidence:** strong — AND 2016: appropriately planned vegetarian diets are healthful; watch B12, iron, zinc, omega-3. · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025)

#### Lacto-vegetarian (no eggs)  
`lacto_vegetarian`

- **User says:** "lacto vegetarian"; "vegetarian, no eggs"
- **HARD avoid (basis: user_rule):** `meat`, `fish_seafood`, `contains_egg`, `gelatin`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Facets:** existing `contains_egg`, `fish_seafood`, `meat`; new `gelatin`
- **Jev:** Existing facets.
- **Evidence:** strong — As vegetarian. · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025)

#### Ovo-vegetarian (no dairy)  
`ovo_vegetarian`

- **User says:** "ovo vegetarian"; "vegetarian, no dairy"
- **HARD avoid (basis: user_rule):** `meat`, `fish_seafood`, `contains_dairy`, `gelatin`
- **SOFT limit:** —
- **PREFER:** `calcium_rich`
- **Targets:** —
- **Facets:** existing `contains_dairy`, `fish_seafood`, `meat`; new `calcium_rich`, `gelatin`
- **Jev:** Existing facets.
- **Evidence:** strong — As vegetarian. · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025)

#### Vegan  
`vegan`

- **User says:** "vegan"; "plant-based (strict)"; "no animal products"
- **HARD avoid (basis: user_rule):** `animal_product`, `gelatin`, `honey`, `insect_derived`
- **SOFT limit:** —
- **PREFER:** `beans`, `protein_dense`, `calcium_rich`, `iron_rich`
- **Targets:** b12: reliable B12 source (fortified foods or supplement) - clinician/dietitian; omega3: algae-based optional; iodine: iodized salt or supplement
- **Do:** Treat allergen 'may contain milk' as NOT a vegan violation (cross-contact is not an ingredient).
- **Don't:** Use contains_dairy/contains_egg (allergen facets with cross-contact) for vegan rules; use animal_product.
- **Facets:** existing `animal_product`, `beans`; new `calcium_rich`, `gelatin`, `honey`, `insect_derived`, `iron_rich`, `protein_dense`
- **Jev:** Existing vegan flag (animal_product) + honey/insect_derived/gelatin.
- **Evidence:** strong — AND 2016: healthful when planned; B12 supplementation is essential. · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025); [ods_b12](https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/)

#### Pescatarian  
`pescatarian`

- **User says:** "pescatarian"; "pescetarian"; "I eat fish but no meat"
- **HARD avoid (basis: user_rule):** `meat`
- **SOFT limit:** —
- **PREFER:** `omega3_rich`
- **Targets:** —
- **Facets:** existing `meat`; new `omega3_rich`
- **Jev:** NOTE: current FACET_RULES.pescatarian maps meat/pork/beef; meat already covers poultry. Verify poultry is covered by the meat rubric (it is).
- **Evidence:** moderate — Observational benefits; watch mercury (use FDA/EPA advice). · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025); [fda_fish](https://www.fda.gov/food/consumers/advice-about-eating-fish)

#### Mostly pescatarian, sometimes chicken  
`pescatarian_plus_poultry`

- **User says:** "mostly pescatarian but sometimes chicken"; "pesco-pollotarian"; "fish and chicken only"; "I eat fish, and chicken now and then"
- **HARD avoid:** —
- **SOFT limit:** `red_meat`
- **PREFER:** `omega3_rich`
- **Targets:** —
- **Flex model:** `{"base": {"facet": "meat", "strength": "avoid"}, "exceptions": [{"facet": "poultry", "allowance": "sometimes", "suggest_budget": "user sets n/week (default 2)", "strength": "allowed_in_budget"}], "red_meat": {"strength": "avoid (soft-strong) unless the user says never"}}`
- **Do:** Log chicken without warnings; suggest fish/plant meals first; show the week's chicken count only if the user wants it.
- **Don't:** Block chicken or nag after a chicken meal.
- **Facets:** existing `meat`; new `omega3_rich`, `poultry`, `red_meat`
- **Jev:** Needs the new poultry facet (meat alone cannot tell chicken from beef).
- **Evidence:** moderate — Flexitarian patterns show health benefits; this is a personal rule. · Confirmation: item-level · Clinician note: no
- **Sources:** [flexitarian_2017](https://doi.org/10.3389/fnut.2016.00055)

#### Pollotarian (poultry, no red meat)  
`pollotarian`

- **User says:** "pollotarian"; "I only eat chicken and turkey"; "no red meat"
- **HARD avoid (basis: user_rule):** `red_meat`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Fish OK → fish allowed
- **Facets:** existing —; new `red_meat`
- **Jev:** red_meat noul.
- **Evidence:** moderate — Personal rule. · Confirmation: item-level · Clinician note: no
- **Sources:** [flexitarian_2017](https://doi.org/10.3389/fnut.2016.00055)

#### Flexitarian / mostly plant-based  
`flexitarian`

- **User says:** "flexitarian"; "mostly plant-based"; "mostly vegetarian"; "semi-vegetarian"
- **HARD avoid:** —
- **SOFT limit:** `meat`
- **PREFER:** `beans`, `whole_grain`, `high_fiber`
- **Targets:** —
- **Flex model:** `{"base": {"facet": "meat", "strength": "limit", "suggest_budget": "user sets meat meals/week"}}`
- **Facets:** existing `beans`, `meat`; new `high_fiber`, `whole_grain`
- **Jev:** Existing meat facet; ranking only.
- **Evidence:** moderate — Review evidence favourable (weight, metabolic markers). · Confirmation: item-level · Clinician note: no
- **Sources:** [flexitarian_2017](https://doi.org/10.3389/fnut.2016.00055)

#### Cutting back on red / processed meat  
`reducetarian`

- **User says:** "trying to eat less red meat"; "cutting back on meat"; "less processed meat"
- **HARD avoid:** —
- **SOFT limit:** `red_meat`, `processed_meat`
- **PREFER:** —
- **Targets:** —
- **Flex model:** `{"base": {"facet": "red_meat", "strength": "limit", "suggest_budget": "n/week"}}`
- **Facets:** existing —; new `processed_meat`, `red_meat`
- **Jev:** red_meat + processed_meat nouls.
- **Evidence:** moderate — DGA/AHA advise limiting processed meat. · Confirmation: item-level · Clinician note: no
- **Sources:** [aha_diet_2026](https://doi.org/10.1161/CIR.0000000000001435); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Whole-food plant-based  
`whole_food_plant_based`

- **User says:** "WFPB"; "whole food plant based"
- **HARD avoid (basis: user_rule):** `animal_product`
- **SOFT limit:** `ultra_processed`, `added_sugar`
- **PREFER:** `beans`, `whole_grain`, `high_fiber`
- **Targets:** —
- **Options (user-set variants):** No added oil → contains_ingredient:oil -> soft
- **Facets:** existing `animal_product`, `beans`; new `added_sugar`, `high_fiber`, `ultra_processed`, `whole_grain`
- **Jev:** animal_product + ultra_processed.
- **Evidence:** moderate — As vegan, plus less processing. · Confirmation: item-level · Clinician note: no
- **Sources:** [and_veg_2016](https://doi.org/10.1016/j.jand.2016.09.025); [nova_2019](https://doi.org/10.1017/S1368980018003762)

#### No alcohol (sober, recovery, personal)  
`no_alcohol`

- **User says:** "I don't drink"; "sober"; "in recovery"; "alcohol-free"
- **HARD avoid (basis: user_rule):** `alcohol`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Also avoid 'non-alcoholic' beer/wine (<0.5%) → trace alcohol treated as present; Avoid dishes cooked with alcohol → alcohol facet includes retained cooking alcohol
- **Facets:** existing `alcohol`; new —
- **Jev:** Existing alcohol facet (Phase 13 adds no_alcohol flag).
- **Evidence:** user_rule — Personal. DGA 2025 names people in recovery among those who should avoid alcohol completely. · Confirmation: item-level · Clinician note: no
- **Sources:** [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Caffeine-free / limiting caffeine  
`caffeine_free`

- **User says:** "no caffeine"; "cutting caffeine"; "decaf only"
- **HARD avoid:** —
- **SOFT limit:** `caffeine`
- **PREFER:** —
- **Targets:** caffeine_mg_max: user-set (FDA: 400 mg/day is not generally associated with harm in healthy adults)
- **Options (user-set variants):** No caffeine at all → caffeine level Trace or higher -> hard (user_rule); unknown -> unverified
- **Facets:** existing —; new `caffeine`
- **Jev:** score caffeine.
- **Evidence:** moderate — FDA 400 mg/day reference. · Confirmation: item-level · Clinician note: no
- **Sources:** [fda_caffeine](https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much)

#### Cutting back on sugar  
`cut_back_sugar`

- **User says:** "cutting back on sugar"; "no added sugar"; "sugar-free"; "trying to eat less sugar"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `sugar_sweetened_beverage`
- **PREFER:** `high_fiber`
- **Targets:** added_sugar_g_per_meal_max: 10
- **Options (user-set variants):** Also avoid artificial sweeteners → non_nutritive_sweetener -> soft
- **Flex model:** `{"base": {"facet": "added_sugar", "strength": "limit", "trend": "weekly downward"}}`
- **Don't:** Count whole fruit or plain milk as added sugar.
- **Facets:** existing —; new `added_sugar`, `high_fiber`, `non_nutritive_sweetener`, `sugar_sweetened_beverage`
- **Jev:** score added_sugar (deterministic-first).
- **Evidence:** strong — DGA 2025: no amount of added sugar is recommended; <=10 g per meal. · Confirmation: item-level · Clinician note: no
- **Sources:** [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Gluten-free by choice  
`gluten_free_by_choice`

- **User says:** "I eat gluten free"; "avoiding gluten"
- **HARD avoid:** —
- **SOFT limit:** `contains_gluten`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Strict (treat as a rule) → hard (user_rule), cross-contact ignored
- **Facets:** existing `contains_gluten`; new —
- **Jev:** contains_gluten.
- **Evidence:** limited — No benefit shown without celiac/NCGS; honour as preference. · Confirmation: item-level · Clinician note: no
- **Sources:** [niddk_celiac](https://www.niddk.nih.gov/health-information/digestive-diseases/celiac-disease/eating-diet-nutrition)

#### Dairy-free by choice  
`dairy_free_by_choice`

- **User says:** "I don't do dairy"; "dairy free"
- **HARD avoid:** —
- **SOFT limit:** `contains_dairy`
- **PREFER:** `calcium_rich`
- **Targets:** —
- **Options (user-set variants):** Strict → hard (user_rule), cross-contact ignored
- **Facets:** existing `contains_dairy`; new `calcium_rich`
- **Jev:** contains_dairy (ignore the cross-contact clause for a choice).
- **Evidence:** user_rule — Personal; keep calcium/vitamin D up. · Confirmation: item-level · Clinician note: no
- **Sources:** [ods_calcium](https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/)

#### Carnivore / animal-only  
`carnivore`

- **User says:** "carnivore diet"; "only meat"; "animal-based"
- **HARD avoid:** —
- **SOFT limit:** `contains_grain`, `beans`, `high_carb_starchy`
- **PREFER:** `protein_dense`
- **Targets:** —
- **Conflicts with:** heart_ldl, ckd, gout
- **Facets:** existing `beans`; new `contains_grain`, `high_carb_starchy`, `protein_dense`
- **Jev:** Existing + new facets; ranking only.
- **Evidence:** insufficient — No long-term outcome data; low fibre and vitamin C; LDL often rises. Honour as preference; clinician note if on lipid or kidney profiles. · Confirmation: item-level · Clinician note: yes
- **Sources:** [aha_diet_2026](https://doi.org/10.1161/CIR.0000000000001435)

#### Keto / ketogenic  
`keto`

- **User says:** "keto"; "ketogenic"; "under 20 carbs"; "low carb high fat"
- **HARD avoid:** —
- **SOFT limit:** `high_carb_starchy`, `added_sugar`, `contains_grain`, `sugar_sweetened_beverage`
- **PREFER:** `protein_dense`
- **Targets:** net_carb_g_max: 20-50 (user-set)
- **Conflicts with:** sglt2_inhibitor, type1_diabetes, pregnancy (disabled), gestational_diabetes (disabled), lactation, ckd, eating_disorder_recovery, lithium, heart_ldl (monitor)
- **Facets:** existing —; new `added_sugar`, `contains_grain`, `high_carb_starchy`, `protein_dense`, `sugar_sweetened_beverage`
- **Jev:** high_carb_starchy noul for ranking; net carbs from nutrient data.
- **Evidence:** moderate — Short-term weight loss similar to other diets; strong for epilepsy; LDL rise common; contraindicated with SGLT2i, some T1D, pregnancy, pancreatitis, liver failure, eating disorders. · Confirmation: item-level · Clinician note: yes
- **Sources:** [keto_2021](https://doi.org/10.3389/fnut.2021.702802); [sglt2_edka_2015](https://doi.org/10.2337/dc15-1380)

#### Low-carb (moderate)  
`low_carb`

- **User says:** "low carb"; "cutting carbs"; "fewer carbs"
- **HARD avoid:** —
- **SOFT limit:** `added_sugar`, `refined_grain`, `sugar_sweetened_beverage`, `high_carb_starchy`
- **PREFER:** `high_fiber`, `protein_dense`
- **Targets:** carb_g_max: user-set (commonly <130 g); never below 175 g in pregnancy
- **Conflicts with:** pregnancy, gestational_diabetes, sglt2_inhibitor
- **Facets:** existing —; new `added_sugar`, `high_carb_starchy`, `high_fiber`, `protein_dense`, `refined_grain`, `sugar_sweetened_beverage`
- **Jev:** Food facets.
- **Evidence:** moderate — ADA 2019 consensus: low-carb is one acceptable pattern for diabetes. · Confirmation: item-level · Clinician note: no
- **Sources:** [ada_nutrition_2019](https://doi.org/10.2337/dci19-0014); [ada_soc_2026_preg](https://doi.org/10.2337/dc26-S015)

#### Paleo  
`paleo`

- **User says:** "paleo"; "caveman diet"; "ancestral diet"
- **HARD avoid (basis: user_rule):** `contains_grain`, `contains_ingredient:legume (beans, lentils, chickpeas, peas)`, `contains_peanut`, `contains_dairy`, `contains_soy`
- **SOFT limit:** `added_sugar`, `ultra_processed`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Dairy OK (primal) → contains_dairy removed
- **Facets:** existing `contains_dairy`, `contains_peanut`, `contains_soy`; new `added_sugar`, `contains_grain`, `contains_ingredient:legume (beans, lentils, chickpeas, peas)`, `ultra_processed`
- **Jev:** Existing + contains_grain.
- **Evidence:** limited — Short trials show modest metabolic benefits; eliminates whole grains/legumes without clear need. · Confirmation: item-level · Clinician note: no
- **Sources:** [paleo_2015](https://doi.org/10.3945/ajcn.115.113613)

#### Whole30 (30-day elimination)  
`whole30`

- **User says:** "Whole30"; "whole 30"
- **HARD avoid (basis: user_rule):** `alcohol`, `contains_grain`, `contains_soy`, `non_nutritive_sweetener`, `contains_ingredient:any added sugar or syrup`, `contains_ingredient:legume (beans, lentils, chickpeas, peanuts)`, `contains_ingredient:dairy other than ghee/clarified butter`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "30 days then reintroduction"}`
- **Facets:** existing `alcohol`, `contains_soy`; new `contains_grain`, `contains_ingredient:any added sugar or syrup`, `contains_ingredient:dairy other than ghee/clarified butter`, `contains_ingredient:legume (beans, lentils, chickpeas, peanuts)`, `non_nutritive_sweetener`
- **Jev:** Ingredient-level checks (the beans facet and the added_sugar score are the wrong tools here); program exceptions handled in code.
- **Evidence:** insufficient — Commercial programme; no trials. Follow the official rules and their exceptions (e.g., ghee, green beans, most peas). · Confirmation: item-level · Clinician note: no
- **Sources:** [whole30_rules](https://whole30.com/original-program-rules/)

#### Mediterranean  
`mediterranean`

- **User says:** "Mediterranean diet"; "eat like the Mediterranean"
- **HARD avoid:** —
- **SOFT limit:** `red_meat`, `processed_meat`, `added_sugar`, `ultra_processed`
- **PREFER:** `omega3_rich`, `whole_grain`, `beans`, `high_fiber`
- **Targets:** fish_servings_per_week: 2+; olive_oil: main fat
- **Don't:** Suggest starting alcohol for health.
- **Facets:** existing `beans`; new `added_sugar`, `high_fiber`, `omega3_rich`, `processed_meat`, `red_meat`, `ultra_processed`, `whole_grain`
- **Jev:** Food facets; ranking only.
- **Evidence:** strong — PREDIMED 2018 (cardiovascular events); AGA 2024 recommends for IBD. · Confirmation: item-level · Clinician note: no
- **Sources:** [predimed_2018](https://doi.org/10.1056/NEJMoa1800389); [aha_diet_2026](https://doi.org/10.1161/CIR.0000000000001435)

#### DASH  
`dash`

- **User says:** "DASH diet"; "dash eating plan"
- **HARD avoid:** —
- **SOFT limit:** `high_sodium`, `high_saturated_fat`, `added_sugar`, `sugar_sweetened_beverage`, `red_meat`
- **PREFER:** `whole_grain`, `high_fiber`, `calcium_rich`, `high_potassium`, `beans`
- **Targets:** sodium_mg_max: 2300; sodium_mg_lower_option: 1500
- **Conflicts with:** ckd (potassium), ace_arb_spironolactone (potassium)
- **Facets:** existing `beans`; new `added_sugar`, `calcium_rich`, `high_fiber`, `high_potassium`, `high_saturated_fat`, `high_sodium`, `red_meat`, `sugar_sweetened_beverage`, `whole_grain`
- **Jev:** Food facets.
- **Evidence:** strong — NHLBI DASH trials: lowers blood pressure and LDL. · Confirmation: item-level · Clinician note: no
- **Sources:** [nhlbi_dash](https://www.nhlbi.nih.gov/education/dash-eating-plan); [aha_acc_htn_2025](https://doi.org/10.1016/j.jacc.2025.05.007)

#### MIND diet  
`mind`

- **User says:** "MIND diet"; "brain diet"
- **HARD avoid:** —
- **SOFT limit:** `fried`, `red_meat`, `added_sugar`
- **PREFER:** `whole_grain`, `beans`, `omega3_rich`
- **Targets:** —
- **Facets:** existing `beans`; new `added_sugar`, `fried`, `omega3_rich`, `red_meat`, `whole_grain`
- **Jev:** Food facets.
- **Evidence:** limited — 2023 NEJM trial found no cognitive benefit vs control diet with weight loss. · Confirmation: item-level · Clinician note: no
- **Sources:** [mind_2023](https://doi.org/10.1056/NEJMoa2302368)

#### Intermittent fasting / time-restricted eating  
`intermittent_fasting`

- **User says:** "intermittent fasting"; "IF"; "16:8"; "OMAD"; "5:2"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** protein: fit daily target into the window (2-3 protein-dense meals)
- **Time window:** `{"type": "eating window (e.g., 12:00-20:00) or 5:2 low days", "user_set": true}`
- **Don't:** Send eating nudges outside the window.
- **Conflicts with:** type1_diabetes, sglt2_inhibitor, pregnancy, lactation, eating_disorder_recovery, cirrhosis, cancer_treatment
- **Facets:** existing —; new —
- **Jev:** None; schedule in code.
- **Evidence:** moderate — NEJM 2022: time restriction added no weight benefit beyond equal calorie restriction; safe for most healthy adults. · Confirmation: item-level · Clinician note: yes
- **Sources:** [tre_2022](https://doi.org/10.1056/NEJMoa2114833); [if_2019](https://doi.org/10.1056/NEJMra1905136)

### 4.8 Body-composition and performance goals (6)

#### Build muscle ('gain as much muscle as possible')  
`muscle_gain`

- **User says:** "build muscle"; "bulk"; "gain as much muscle as possible"; "lean bulk"; "get bigger"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `protein_dense`, `whole_grain`
- **Targets:** protein_g_per_kg: 1.6; protein_range_g_per_kg: 1.6-2.2; protein_per_meal_g_per_kg: 0.25-0.4 across 3-5 meals; energy_surplus_pct: 5-15 (~250-500 kcal/day) for lean gain; carbs: enough to fuel training
- **Do:** Explain that more than ~2.2 g/kg adds no known muscle benefit; 'as much as possible' = training + consistent surplus + sleep, not unlimited protein. Spread protein across meals; suggest a protein-rich meal after training.
- **Don't:** Exceed the CKD cap if CKD is on the profile (conflict wins to the clinician rule).
- **Conflicts with:** ckd, ckd_dialysis, eating_disorder_recovery (surplus framing)
- **Facets:** existing —; new `protein_dense`, `whole_grain`
- **Jev:** protein_dense for ranking; grams from nutrient data.
- **Evidence:** strong — Morton 2018: gains plateau near 1.6 g/kg/day (upper CI ~2.2); ISSN 2017: 1.4-2.0 g/kg/day; larger surpluses add mostly fat. · Confirmation: item-level · Clinician note: no
- **Sources:** [morton_2018](https://doi.org/10.1136/bjsports-2017-097608); [issn_protein_2017](https://doi.org/10.1186/s12970-017-0177-8); [iraki_2019](https://doi.org/10.3390/sports7070154); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Lose fat  
`fat_loss`

- **User says:** "lose weight"; "fat loss"; "cut"; "get lean"; "slim down"
- **HARD avoid:** —
- **SOFT limit:** `sugar_sweetened_beverage`, `ultra_processed`, `alcohol`, `fried`
- **PREFER:** `protein_dense`, `high_fiber`
- **Targets:** adults_only: True; rate_pct_bodyweight_per_week: 0.5-1.0; protein_g_per_kg: 1.2-1.6 general (DGA 2025); 1.6-2.2 if resistance training; up to 2.3-3.1 g/kg FAT-FREE mass only for lean trained athletes (Helms); kcal_plan_examples: obesity guideline example plans 1200-1500 (women) / 1500-1800 (men); not universal floors - no plan below these without a clinician; deficit_kcal: ~500-750/day typical
- **Conflicts with:** pregnancy, lactation (gentle), eating_disorder_recovery, cancer_treatment, gestational_diabetes
- **Facets:** existing `alcohol`; new `fried`, `high_fiber`, `protein_dense`, `sugar_sweetened_beverage`, `ultra_processed`
- **Jev:** protein_dense, energy_dense (prefer low), high_fiber.
- **Evidence:** strong — 2013 AHA/ACC/TOS obesity guideline (deficit ~500-750 kcal); ISSN 2017 and Helms 2014 for protein in trained people; Hall 2019 (ultra-processed diets raise intake). · Confirmation: item-level · Clinician note: no
- **Sources:** [obesity_2013](https://doi.org/10.1161/01.cir.0000437739.71477.ee); [issn_protein_2017](https://doi.org/10.1186/s12970-017-0177-8); [helms_2014](https://doi.org/10.1186/1550-2783-11-20); [hall_2019](https://doi.org/10.1016/j.cmet.2019.05.008); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Body recomposition (lose fat, keep/gain muscle)  
`recomposition`

- **User says:** "recomp"; "tone up"; "lose fat and build muscle"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `protein_dense`
- **Targets:** protein_g_per_kg: 1.6-2.2; energy: maintenance to small deficit (~10%)
- **Facets:** existing —; new `protein_dense`
- **Jev:** protein_dense.
- **Evidence:** moderate — Barakat 2020: recomposition occurs with resistance training and high protein, most in novices and returners. · Confirmation: item-level · Clinician note: no
- **Sources:** [barakat_2020](https://doi.org/10.1519/SSC.0000000000000584); [morton_2018](https://doi.org/10.1136/bjsports-2017-097608)

#### Endurance training  
`endurance`

- **User says:** "marathon"; "triathlon"; "cycling training"; "endurance athlete"; "running a lot"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `whole_grain`, `high_carb_starchy`
- **Targets:** carb_g_per_kg: 5-7 (~1 h/day), 6-10 (1-3 h/day), 8-12 (4-5 h/day); protein_g_per_kg: 1.2-2.0; during_long_sessions_carb_g_per_h: 30-60 (up to 90 for >2.5 h); sodium: higher with heavy sweat (DGA 2025 notes this)
- **Conflicts with:** keto, hypertension (sodium)
- **Facets:** existing —; new `high_carb_starchy`, `whole_grain`
- **Jev:** Ranking only.
- **Evidence:** strong — AND/DC/ACSM 2016 position. · Confirmation: item-level · Clinician note: no
- **Sources:** [acsm_2016](https://doi.org/10.1016/j.jand.2015.12.006); [dga_2025](https://cdn.realfood.gov/DGA.pdf)

#### Gain weight (underweight or poor appetite)  
`weight_gain`

- **User says:** "gain weight"; "I'm underweight"; "can't keep weight on"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `energy_dense`, `protein_dense`
- **Targets:** energy_surplus_kcal: 300-500
- **Facets:** existing —; new `energy_dense`, `protein_dense`
- **Jev:** energy_dense (prefer high).
- **Evidence:** moderate — Unintended weight loss needs a clinician. · Confirmation: item-level · Clinician note: yes
- **Sources:** [espen_cancer_2021](https://doi.org/10.1016/j.clnu.2021.02.005)

#### General healthy eating (default)  
`general_health`

- **User says:** "just eat healthier"; "general health"; "maintenance"
- **HARD avoid:** —
- **SOFT limit:** `ultra_processed`, `added_sugar`, `high_sodium`, `sugar_sweetened_beverage`
- **PREFER:** `whole_grain`, `high_fiber`, `protein_dense`
- **Targets:** protein_g_per_kg: 1.2-1.6 (DGA 2025); sat_fat_pct_kcal_max: 10; sodium_mg_max: 2300; added_sugar_g_per_meal_max: 10
- **Facets:** existing —; new `added_sugar`, `high_fiber`, `high_sodium`, `protein_dense`, `sugar_sweetened_beverage`, `ultra_processed`, `whole_grain`
- **Jev:** Default ranking weights.
- **Evidence:** strong — DGA 2025-2030. · Confirmation: profile-level · Clinician note: no
- **Sources:** [dga_2025](https://cdn.realfood.gov/DGA.pdf)

### 4.9 Texture and swallowing (2)

#### Swallowing difficulty (dysphagia)  
`dysphagia`

- **User says:** "dysphagia"; "trouble swallowing"; "thickened liquids"; "IDDSI level"
- **HARD avoid (basis: user_confirmed_safety):** `texture_level`
- **SOFT limit:** —
- **PREFER:** —
- **Targets:** iddsi_food_level: user enters SLP level; iddsi_drink_level: user enters SLP level
- **Do:** Suggest only foods the user has marked as prepared to their level; everything else is 'unverified'.
- **Don't:** Guess the level. Suggest mixed-consistency foods (cereal with milk, soup with chunks) above the level.
- **Facets:** existing —; new `texture_level`
- **Jev:** choice texture_level is a ONE-DIRECTIONAL screen: it can block a food clearly above the level, never clear one. Separate food and drink levels.
- **Evidence:** strong — IDDSI framework; level set by a speech-language pathologist. · Confirmation: item-level · Clinician note: yes
- **Sources:** [iddsi](https://iddsi.org/framework)

#### Chewing difficulty / dental work / dentures  
`chewing_difficulty`

- **User says:** "can't chew well"; "dentures"; "after dental surgery"; "soft foods"
- **HARD avoid:** —
- **SOFT limit:** `hard_to_chew`
- **PREFER:** —
- **Targets:** —
- **Time window:** `{"type": "optional_until_date"}`
- **Facets:** existing —; new `hard_to_chew`
- **Jev:** noul hard_to_chew.
- **Evidence:** expert_opinion — Practical texture preference. · Confirmation: item-level · Clinician note: no
- **Sources:** [iddsi](https://iddsi.org/framework)

### 4.10 Likes, dislikes and aversions (6)

#### Nightshade-free (preference)  
`nightshade_free`

- **User says:** "no nightshades"; "nightshades bother me"
- **HARD avoid:** —
- **SOFT limit:** `nightshade`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Strict → hard (user_rule)
- **Facets:** existing —; new `nightshade`
- **Jev:** nightshade noul.
- **Evidence:** limited — Little evidence; honour as preference. · Confirmation: item-level · Clinician note: no

#### Dislikes ('I hate cilantro / mushrooms / olives')  
`disliked_ingredients`

- **User says:** "I hate"; "I don't like"; "can't stand"; "not a fan of"; "yuck"
- **HARD avoid:** —
- **SOFT limit:** `contains_ingredient:<name>`
- **PREFER:** —
- **Targets:** —
- **Options (user-set variants):** Never show me this → hard (user_rule)
- **Do:** Learn from swaps and deletions; ask before hardening.
- **Facets:** existing —; new `contains_ingredient:<name>`
- **Jev:** Parametric contains_ingredient per dislike (no cross-contact clause).
- **Evidence:** user_rule — Preference. · Confirmation: item-level · Clinician note: no

#### Spice tolerance  
`spice_tolerance`

- **User says:** "I can't handle spicy"; "mild please"; "I love spicy food"
- **HARD avoid:** —
- **SOFT limit:** `spicy_hot`
- **PREFER:** —
- **Targets:** —
- **Facets:** existing —; new `spicy_hot`
- **Jev:** score spicy_hot vs user's max level.
- **Evidence:** user_rule — Preference. · Confirmation: profile-level · Clinician note: no

#### Texture aversions  
`texture_aversion`

- **User says:** "I hate slimy food"; "mushy textures"; "no soggy food"
- **HARD avoid:** —
- **SOFT limit:** `texture_profile`
- **PREFER:** —
- **Targets:** —
- **Facets:** existing —; new `texture_profile`
- **Jev:** choice texture_profile.
- **Evidence:** user_rule — Preference. · Confirmation: item-level · Clinician note: no

#### Cuisine likes  
`cuisine_preferences`

- **User says:** "I love Mexican food"; "mostly Asian food"; "home-style"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `cuisine`
- **Targets:** —
- **Facets:** existing —; new `cuisine`
- **Jev:** choice cuisine; code boosts liked cuisines.
- **Evidence:** user_rule — Preference. · Confirmation: profile-level · Clinician note: no

#### Picky eater / small food range  
`picky_eater`

- **User says:** "picky eater"; "fussy eater"; "I only eat a few foods"; "selective eater"
- **HARD avoid:** —
- **SOFT limit:** —
- **PREFER:** `cuisine`, `texture_profile`
- **Targets:** —
- **Do:** Suggest 'bridge' foods close to liked ones (Jev similarity score, D0). One new food at a time; no pressure language.
- **Don't:** Shame or rank the user's safe foods as bad.
- **Facets:** existing —; new `cuisine`, `texture_profile`
- **Jev:** Jev score 'how similar is food A to food B' (both foods only) for bridge suggestions.
- **Evidence:** expert_opinion — Gradual exposure; ARFID (weight loss, deficiencies, supplement dependence, distress) needs a clinician. · Confirmation: item-level · Clinician note: no
- **Sources:** [ed_ada_2011](https://doi.org/10.1016/j.jada.2011.06.016)

## 5. New facets

### 5.1 Design rules for facet questions

1. **Food state only.** Every question runs over `facetState(food)`: name, brand, description,
   preparation and ingredient text. It never sees the user, the profile, a diagnosis, a medicine or
   an age. "Does this contain grapefruit?" is D0. "Can someone on simvastatin eat this?" is not
   allowed.
2. **Deterministic first.** When the label or catalog has the number (sodium, saturated fat, added
   sugar, fibre, potassium, protein/kcal, calcium, iron), code decides by FDA %DV bands (≤5% low,
   ≥20% high). Jev fills the gap only for unlabelled foods: restaurant meals, home cooking, voice
   logs. Ingredient keyword matches (grapefruit, fava, star fruit, aspartame, phosphate additives,
   mercury fish) run before Jev in the same way.
3. **noul for presence, score for degree, choice for categories.** A noul near 0.5 means
   uncertainty, not "a little". Degree facets (sodium, caffeine, lactose, heat, processing) are
   scores with concrete example levels.
4. **Thresholds by consequence** (from `facet-thresholds.ts` calibration). Allergen and
   user_confirmed_safety facets are tuned for recall: `unknown` means "Check the label" and the
   food is not suggested. Ranking facets are tuned for precision.
5. **Rubric version bump.** Adding facets is a `RUBRIC_VERSION` change and needs a new labelled
   calibration set per facet. Phase 13 §4.1 requires ≥30% positives for allergen facets.
6. **User-independent question sets.** The facets asked about a food never depend on who is asking.
   A per-user question ("does this contain mustard?" asked only for one user) would tell Jev about
   that user's allergy. Templates (`contains_allergen:<name>`, `contains_ingredient:<name>`)
   therefore use one global name list that is asked for every food. A name outside the list is
   matched deterministically in code, and its result stays `unverified`. TypeSafe's published DPA
   lists sensitive-data safeguards as N/A, which is one more reason to keep Jev strictly D0.
7. **Scores rank; measured numbers enforce.** Degree scores (`caffeine`, `high_sodium`,
   `high_potassium`, `high_phosphorus`) rank and flag. They never prove that a daily limit is met.
   Daily limits (for example, pregnancy caffeine 200 mg, CKD sodium) are summed from measured
   nutrients × logged portions. When a value is missing, the app says the limit cannot be checked.
8. **Cost.** One food with all 96 facets (25 + 71) is about 96 short questions in one parallel Jev
   request. At $0.042 per 1M input tokens this is well under $0.001 per food. The result is cached
   per food revision and rubric version, so each food is tagged once.

### 5.2 Top 10 new facets by value

Ranked by the number of profiles served × the harm avoided × the precision gained over existing
facets:

| Rank | Facet | Why it matters |
|---|---|---|
| 1 | `contains_allergen:<name>` (template) | Any user-named allergen (mustard, coconut, kiwi, sulfites…) reaches the floor with no code change. It closes the gap between the top 9 and real users. |
| 2 | `red_meat` | Used by heart/LDL, UC, gout, alpha-gal, pollotarian, "cutting back on red meat", Mediterranean and anti-inflammatory profiles. Today only `pork` and `beef` exist. |
| 3 | `poultry` | Needed for every "mostly X but sometimes chicken" rule. `meat` cannot tell chicken from beef. |
| 4 | `processed_meat` | Used by heart, hypertension, diabetes, IBD, anti-inflammatory, Mediterranean and pregnancy (deli meats). |
| 5 | `high_sodium` (score, label first) | Used by hypertension, DASH, heart, CKD, cirrhosis/ascites, low-sodium directives and lithium consistency. |
| 6 | `added_sugar` + `sugar_sweetened_beverage` | Used by diabetes, prediabetes, "cutting back on sugar", MASLD, gout, bariatric surgery and fat loss. `simple_sugars` covers only sweeteners. |
| 7 | Food-safety trio: `raw_or_undercooked_animal`, `unpasteurized`, `high_listeria_risk` | Used by pregnancy, cancer treatment, immunocompromised users, cirrhosis, hemochromatosis (Vibrio) and older adults. These are real safety rules with strong evidence. |
| 8 | `ultra_processed` (NOVA score) | Used by anti-inflammatory, Mediterranean, IBD, MASLD, fat loss and the DGA 2025 default. |
| 9 | Allergen splits: `contains_finfish`, `crustacean_shellfish`, `contains_wheat` | They fix over-blocking: today `fish_seafood` blocks shrimp for a fish allergy, and `contains_gluten` blocks rye for a wheat allergy. They also match the FDA allergen categories. Ambiguous phrases still turn on the broader set first. |
| 10 | `protein_dense` | Used by 22 profiles: muscle gain, fat loss, recomposition, older adults, GLP-1, bariatric surgery and cancer. It powers the "more protein" suggestions users ask for most. |

Next ten: `gelatin` + `gelatin_source`, `caffeine` (+ `coffee_or_tea` for LDS), `high_lactose`, `tyramine_rich`,
`grapefruit_family`, `high_mercury_fish`, `omega3_rich`, `whole_grain`/`refined_grain`,
`high_saturated_fat`, `contains_ingredient:<name>`.

### 5.3 All new facets

| # | Facet | Primitive | Jev question (food state only) | Deterministic first | Profiles | Value |
|---|---|---|---|---|---|---|
| 1 | `protein_dense` | score | How protein-dense is this food per calorie? | protein_g / kcal from label or catalog | 22 | 1 |
| 2 | `added_sugar` | score | How much added sugar does one typical serving of this food contain? | added_sugars_g from label: >=10 g (20% DV; DGA 2025 per-meal ceiling) high | 18 | 1 |
| 3 | `sugar_sweetened_beverage` | noul | Is this a drink sweetened with added sugar? | — | 16 | 1 |
| 4 | `red_meat` | noul | Does this food contain meat from a mammal? | — | 11 | 1 |
| 5 | `omega3_rich` | noul | Is this food a rich source of marine omega-3 fats (EPA/DHA)? | — | 11 | 1 |
| 6 | `processed_meat` | noul | Is this food, or does it contain, processed meat? | — | 10 | 1 |
| 7 | `high_sodium` | score | How much sodium does one typical serving of this food contain? | sodium_mg per serving from label: <=140 low (FDA 'low sodium'), >=460 (20% DV) high | 10 | 1 |
| 8 | `ultra_processed` | score | How processed is this food, using the NOVA classification? | — | 10 | 1 |
| 9 | `gelatin` | noul | Does this food contain gelatin or collagen from an animal? | — | 8 | 1 |
| 10 | `fried` | noul | Is this food deep-fried or pan-fried in a lot of fat? | — | 8 | 1 |
| 11 | `contains_ingredient:<name>` | noul | Does this food contain <name> as an ingredient? | — | 8 | 1 |
| 12 | `caffeine` | score | About how much caffeine does one typical serving contain? | — | 7 | 1 |
| 13 | `raw_or_undercooked_animal` | noul | Is an animal food in this item eaten raw or undercooked? | — | 6 | 1 |
| 14 | `high_saturated_fat` | score | How much saturated fat does one typical serving contain? | sat_fat_g from label: >=4 g (20% DV) high | 4 | 1 |
| 15 | `unpasteurized` | noul | Does this food contain unpasteurized milk, cheese made from it, or unpasteurized juice/cider? | — | 4 | 1 |
| 16 | `high_listeria_risk` | noul | Is this a food that CDC lists as higher risk for Listeria when eaten as is? | — | 4 | 1 |
| 17 | `grapefruit_family` | noul | Does this food contain grapefruit or a related citrus that interacts with some medicines? | ingredient keyword match first | 4 | 1 |
| 18 | `high_mercury_fish` | noul | Could this food contain a fish that FDA/EPA list among choices to avoid for mercury? | ingredient keyword match first | 3 | 1 |
| 19 | `contains_allergen:<name>` | noul | Could this food contain <name>, given its ingredients and any may-contain warning? | — | 3 | 1 |
| 20 | `poultry` | noul | Does this food contain poultry? | — | 2 | 1 |
| 21 | `contains_finfish` | noul | Does this food contain finfish, or does its label warn that it may contain fish? | ingredient/allergen tag 'fish' | 2 | 1 |
| 22 | `crustacean_shellfish` | noul | Does this food contain crustacean shellfish, or does its label warn that it may contain crustaceans? | ingredient/allergen tag 'crustacean shellfish' | 2 | 1 |
| 23 | `tyramine_rich` | noul | Is this a high-tyramine food of the kind restricted with MAO inhibitors? | — | 2 | 1 |
| 24 | `high_lactose` | score | How much lactose does one typical serving contain? | — | 2 | 1 |
| 25 | `contains_wheat` | noul | Does this food contain wheat, or does its label warn that it may contain wheat? | ingredient/allergen tag 'wheat' | 1 | 1 |
| 26 | `whole_grain` | noul | Is this food mainly a whole grain or made mainly with whole grain? | — | 22 | 2 |
| 27 | `high_fiber` | score | How much dietary fibre does one typical serving contain? | fiber_g from label | 20 | 2 |
| 28 | `calcium_rich` | score | How good a source of calcium is one typical serving? | calcium_mg from label | 10 | 2 |
| 29 | `refined_grain` | noul | Is the grain in this food mainly refined rather than whole grain? | — | 5 | 2 |
| 30 | `iron_rich` | score | How good a source of iron is one typical serving? | iron_mg from label | 5 | 2 |
| 31 | `high_fat` | score | How much total fat does one typical serving contain relative to its size? | fat_g from label | 4 | 2 |
| 32 | `high_carb_starchy` | noul | Is this food a major source of carbohydrate? | total_carb_g - fiber_g from label | 4 | 2 |
| 33 | `high_potassium` | score | How much potassium does one typical serving contain? | potassium_mg from label | 4 | 2 |
| 34 | `mollusc` | noul | Does this food contain a mollusc? | — | 3 | 2 |
| 35 | `honey` | noul | Does this food contain honey or another bee product? | — | 3 | 2 |
| 36 | `coffee_or_tea` | noul | Is this, or does this contain, coffee or tea from the tea plant? | — | 3 | 2 |
| 37 | `spicy_hot` | score | How spicy-hot (chilli heat) is this food? | — | 3 | 2 |
| 38 | `gelatin_source` | choice | If this food contains gelatin or collagen, what is its stated source? | — | 2 | 2 |
| 39 | `high_insoluble_fiber_residue` | score | How much hard-to-digest insoluble fibre or residue does this food leave, as eaten? | — | 2 | 2 |
| 40 | `high_glycemic_load` | score | How large a blood-glucose load would one typical serving of this food cause? | — | 2 | 2 |
| 41 | `phosphate_additive` | noul | Does this food list a phosphate additive? | ingredient regex /phos/ | 2 | 2 |
| 42 | `fodmap_fructan` | noul | Is this food a significant source of fructans in a typical serving? | — | 2 | 2 |
| 43 | `star_fruit` | noul | Does this food contain star fruit (carambola)? | ingredient keyword match first | 2 | 2 |
| 44 | `energy_dense` | score | How energy-dense is this food (calories per gram)? | kcal / grams from catalog | 2 | 2 |
| 45 | `mammalian_derived` | noul | Does this food contain an ingredient derived from a mammal other than milk? | — | 1 | 2 |
| 46 | `mixes_meat_and_dairy` | noul | Does this single dish combine meat or poultry with a dairy ingredient? | — | 1 | 2 |
| 47 | `high_purine` | noul | Is this food high in purines? | — | 1 | 2 |
| 48 | `vitamin_k_rich` | score | How much vitamin K1 does one typical serving provide? | — | 1 | 2 |
| 49 | `root_vegetable` | noul | Does this food contain a root, bulb or tuber vegetable? | — | 1 | 2 |
| 50 | `fava_bean` | noul | Does this food contain fava (broad) beans? | ingredient keyword match first | 1 | 2 |
| 51 | `aspartame` | noul | Does this food contain aspartame? | ingredient keyword match first | 1 | 2 |
| 52 | `texture_level` | choice | Which IDDSI food or drink level best describes this item as served? | — | 1 | 2 |
| 53 | `contains_grain` | noul | Does this food contain a cereal grain or pseudo-grain? | — | 5 | 3 |
| 54 | `insect_derived` | noul | Does this food contain an insect-derived ingredient? | — | 3 | 3 |
| 55 | `fish_without_fins_scales` | noul | Does this food contain seafood that fails the kosher sign of having both fins and removable scales? | — | 2 | 3 |
| 56 | `emulsifier_additives` | noul | Does this food list an emulsifier or thickener additive associated with IBD research? | ingredient keyword match first | 2 | 3 |
| 57 | `high_phosphorus` | score | How much phosphorus does one typical serving provide? | — | 2 | 3 |
| 58 | `fodmap_excess_fructose` | noul | Is this food a significant source of excess fructose? | — | 2 | 3 |
| 59 | `high_acid` | noul | Is this food strongly acidic? | — | 2 | 3 |
| 60 | `carbonated` | noul | Is this a carbonated drink or a food containing one? | — | 2 | 3 |
| 61 | `non_nutritive_sweetener` | noul | Does this food contain a non-nutritive or low-calorie sweetener? | — | 2 | 3 |
| 62 | `hard_to_chew` | noul | Is this food hard, tough, crunchy or sticky enough to be difficult to chew? | — | 2 | 3 |
| 63 | `cuisine` | choice | Which cuisine does this dish most belong to? | — | 2 | 3 |
| 64 | `texture_profile` | choice | Which texture best describes this food as eaten? | — | 2 | 3 |
| 65 | `land_animal_flesh` | noul | Does this food contain the flesh of a land animal or bird itself (not only broth, fat, gelatin or flavouring)? | — | 1 | 3 |
| 66 | `blood_product` | noul | Does this food contain animal blood? | — | 1 | 3 |
| 67 | `fodmap_gos` | noul | Is this food a significant source of galacto-oligosaccharides (GOS)? | — | 1 | 3 |
| 68 | `fodmap_polyol` | noul | Is this food a significant source of polyols (sugar alcohols)? | — | 1 | 3 |
| 69 | `high_iodine` | noul | Is this food a significant source of iodine? | — | 1 | 3 |
| 70 | `nightshade` | noul | Does this food contain a nightshade vegetable or spice? | — | 1 | 3 |
| 71 | `high_oxalate` | noul | Is this food high in oxalate? | — | 1 | 3 |

Value: 1 = build first, 2 = next, 3 = nice to have. "Profiles" counts the profiles that reference the
facet directly or through options and flex models.

### 5.4 Fixes to existing facet rubrics

| Facet | Fix | Value |
|---|---|---|
| `contains_gluten` | Add oats not labelled gluten-free, brewer's yeast and malt to the true examples. POLICY (celiac): a Jev or ingredient-list 'absent' on a processed or restaurant food clears only with a gluten-free label claim or certification; otherwise the verdict is 'unverified'. Plain single whole foods (fresh fruit, plain meat, plain rice) may clear on ingredients alone. | 1 |
| `meat` | The rubric counts stock and gelatin as meat. Correct for vegetarians; wrong for Catholic abstinence, which permits broth/gelatin (use land_animal_flesh there). | 3 |
| `beans` | The rubric marks hummus, refried beans and tofu FALSE (texture-oriented). Programs that exclude legumes by ingredient (paleo, Whole30) need an ingredient-level legume check, not this facet. | 2 |
| `contains_dairy` | State that lactose-free milk products are TRUE (milk protein remains) and that goat/sheep milk is TRUE (FDA Q&A Ed. 5 widens 'milk'). Ghee is TRUE for allergy; diet programs that allow ghee (Whole30) handle that exception in code. | 1 |
| `contains_egg` | State that eggs of other birds (duck, quail) are TRUE (FDA Q&A Ed. 5). | 2 |
| `contains_tree_nut` | Align examples with the FDA 2025 12-nut list; coconut is FALSE for this facet (use contains_allergen:coconut for a coconut allergy). | 2 |
| `fish_seafood` | Keep as the diet facet (pescatarian/vegetarian); allergy rules move to contains_finfish / crustacean_shellfish / mollusc. | 1 |
| `alcohol` | State that 'non-alcoholic' beer/wine (<0.5% ABV) is TRUE-uncertain rather than FALSE for users in recovery; vanilla extract used in baking is FALSE as consumed. Consider a separate trace_alcohol facet. | 2 |
| `simple_sugars` | Leave as is; added_sugar (score) covers the diabetes/cut-back use. simple_sugars stays for the sweetener-spread use. | 3 |

### 5.5 Full rubrics (for `lib/foods/facet-questions.ts`)

**`red_meat`** (noul) — Does this food contain meat from a mammal?  
true: The food contains muscle meat, organ meat, or minced/processed meat from a mammal such as cattle, pig, sheep, lamb, goat, deer, bison, rabbit or horse.  
false: The food contains no mammal meat; poultry, fish, shellfish, eggs, dairy and plant foods alone are false.  
_Note:_ Mammal meat, matching the alpha-gal and IARC 'red meat' scope. Existing pork and beef facets stay as narrower subsets.

**`processed_meat`** (noul) — Is this food, or does it contain, processed meat?  
true: The food contains meat preserved by curing, salting, smoking, fermenting or added nitrite/nitrate, such as bacon, ham, sausage, hot dog, salami, pepperoni, deli/luncheon meat, corned beef or jerky.  
false: The food contains no cured, smoked, salted or nitrite-preserved meat; fresh unprocessed meat alone is false.

**`land_animal_flesh`** (noul) — Does this food contain the flesh of a land animal or bird itself (not only broth, fat, gelatin or flavouring)?  
true: The food contains pieces of meat, poultry, organ meat, or processed meat made from them (e.g., chicken, beef, bacon, sausage, ham).  
false: The food contains no land-animal or bird flesh; foods with only broth/stock, gelatin, lard, meat flavouring, fish, eggs or dairy are false.  
_Note:_ USCCB: broth, gelatin and meat-derived flavourings are technically permitted on abstinence days.

**`poultry`** (noul) — Does this food contain poultry?  
true: The food contains meat, stock or fat from a domesticated or game bird, such as chicken, turkey, duck, goose or quail.  
false: The food contains no bird meat or bird-derived stock; eggs alone are false.  
_Note:_ Needed to model 'mostly pescatarian but sometimes chicken' as an exception, not a new diet.

**`contains_finfish`** (noul) — Does this food contain finfish, or does its label warn that it may contain fish?  
true: The food states a finfish or finfish-derived ingredient (e.g., salmon, tuna, cod, anchovy, fish sauce, Worcestershire with anchovy, fish gelatin, fish oil) or carries a fish cross-contact warning.  
false: The food states no finfish ingredient and no fish cross-contact warning; shellfish alone is false.  
_Note:_ FDA major allergen 'fish'. The existing fish_seafood facet mixes fish and shellfish, which over-blocks for a fish-only allergy.

**`crustacean_shellfish`** (noul) — Does this food contain crustacean shellfish, or does its label warn that it may contain crustaceans?  
true: The food states shrimp, prawn, crab, lobster, crawfish/crayfish, krill or another crustacean ingredient, or carries a crustacean cross-contact warning.  
false: The food states no crustacean ingredient and no crustacean warning; molluscs and finfish alone are false.  
_Note:_ FDA major allergen is crustacean shellfish only; molluscs are not a US major allergen.

**`mollusc`** (noul) — Does this food contain a mollusc?  
true: The food contains a clam, mussel, oyster, scallop, squid/calamari, octopus, snail/escargot, abalone, or an extract/sauce from one (e.g., oyster sauce).  
false: The food contains no mollusc or mollusc-derived ingredient.  
_Note:_ Not declared under US FALCPA, so label evidence is weak; EU Annex II does declare molluscs.

**`contains_wheat`** (noul) — Does this food contain wheat, or does its label warn that it may contain wheat?  
true: The food states wheat or a wheat species/derivative (e.g., spelt, durum, semolina, farro, einkorn, kamut, bulgur, couscous, seitan, wheat starch) or a wheat cross-contact warning.  
false: The food states no wheat ingredient and no wheat warning; barley, rye and oats alone are false.  
_Note:_ Wheat allergy is not celiac disease: barley and rye are allowed for a wheat allergy but blocked for celiac disease.

**`gelatin`** (noul) — Does this food contain gelatin or collagen from an animal?  
true: The food contains gelatin, collagen, gelatine-based capsules or gummies, aspic, or marshmallow made with animal gelatin.  
false: The food contains no animal gelatin or collagen; agar, pectin, carrageenan and plant gums are false.  
_Note:_ Phase 13 spec §4.2 already names no_gelatin. Presence only; the SOURCE is a separate facet (gelatin_source) because fish or certified halal/kosher gelatin is acceptable for several profiles.

**`gelatin_source`** (choice) — If this food contains gelatin or collagen, what is its stated source?  
options: no gelatin or collagen | pork | beef/bovine | fish | plant-based substitute (agar, pectin) | gelatin of unstated source  
_Note:_ 'unstated source' maps to verdict unverified for alpha-gal, halal, kosher and Hindu rules; certification evidence (halal/kosher mark) is read by code, not Jev.

**`mammalian_derived`** (noul) — Does this food contain an ingredient derived from a mammal other than milk?  
true: The food contains mammal meat, organ, blood, lard, tallow, suet, mammal-derived gelatin or collagen, or mammal stock or broth.  
false: The food contains no mammal-derived ingredient other than dairy; poultry, fish and plant foods are false.

**`insect_derived`** (noul) — Does this food contain an insect-derived ingredient?  
true: The food contains carmine/cochineal (E120), shellac/confectioner's glaze, or insects/insect flour.  
false: The food contains no insect-derived ingredient; honey is judged separately.

**`honey`** (noul) — Does this food contain honey or another bee product?  
true: The food contains honey, bee pollen, royal jelly or propolis.  
false: The food contains no bee-derived ingredient; beeswax coating on fruit is false.

**`blood_product`** (noul) — Does this food contain animal blood?  
true: The food contains blood, blood sausage/black pudding, blood tofu, or blood plasma.  
false: The food contains no animal blood as an ingredient.

**`mixes_meat_and_dairy`** (noul) — Does this single dish combine meat or poultry with a dairy ingredient?  
true: The dish contains both land-animal meat or poultry and a milk-derived ingredient (e.g., cheeseburger, chicken alfredo, butter chicken with cream).  
false: The dish does not combine meat or poultry with dairy; fish with dairy is false.  
_Note:_ Meal-level: code also checks across items in one logged meal.

**`fish_without_fins_scales`** (noul) — Does this food contain seafood that fails the kosher sign of having both fins and removable scales?  
true: The food contains shellfish or molluscs, or a fish that lacks fins OR lacks removable (kosher) scales, e.g., catfish, eel, shark, monkfish, sturgeon/caviar, swordfish (disputed), or fish of unknown species (e.g., 'fish sticks', 'seafood mix').  
false: Every fish is named and has both fins and removable scales (e.g., salmon, tuna, cod, tilapia, carp), or there is no seafood.  
_Note:_ Swordfish and sturgeon are disputed; the user's own authority decides.

**`high_sodium`** (score) — How much sodium does one typical serving of this food contain?  
0. Very low: under about 140 mg per serving (e.g., fresh fruit, plain oats).  
1. Moderate: about 140-460 mg per serving (e.g., bread slice, plain cheese).  
2. High: about 460-900 mg per serving (e.g., canned soup cup, deli sandwich).  
3. Very high: over about 900 mg per serving (e.g., instant ramen with seasoning, restaurant entrée with soy sauce).  
_Note:_ RANK ONLY. A daily mg limit is enforced only from measured nutrients x logged portion; with missing values the app says the limit cannot be checked.

**`added_sugar`** (score) — How much added sugar does one typical serving of this food contain?  
0. None: no sugar or syrup added (whole fruit, plain milk and plain yogurt are none).  
1. Low: a little added sugar, under about 5 g per serving.  
2. Moderate: about 5-10 g per serving.  
3. High: over about 10 g per serving (e.g., soda, candy, frosted cereal, sweet coffee drink).

**`sugar_sweetened_beverage`** (noul) — Is this a drink sweetened with added sugar?  
true: The item is a beverage with added sugar or syrup, such as regular soda, sweet tea, lemonade, energy drink, sweetened coffee drink or fruit drink.  
false: The item is not a drink, or is a drink without added sugar (water, plain milk, 100% juice, diet soda, unsweetened tea or coffee).

**`ultra_processed`** (score) — How processed is this food, using the NOVA classification?  
0. NOVA 1: unprocessed or minimally processed (fresh, frozen, dried, plain milk, eggs, plain meat).  
1. NOVA 2: processed culinary ingredient (oil, butter, sugar, salt, flour).  
2. NOVA 3: processed food made from NOVA 1 foods plus salt/sugar/oil (canned beans, cheese, fresh bread, cured ham).  
3. NOVA 4: ultra-processed industrial formulation with ingredients rarely used at home (e.g., emulsifiers, flavourings, protein isolates, hydrogenated oils): soda, packaged snacks, instant noodles, reconstituted meat.  
_Note:_ Ingredient text makes this reliable; without it Jev relies on the food name.

**`emulsifier_additives`** (noul) — Does this food list an emulsifier or thickener additive associated with IBD research?  
true: The ingredients include carrageenan, carboxymethylcellulose (cellulose gum), polysorbate 80, maltodextrin or titanium dioxide.  
false: None of those additives are listed or implied.

**`fried`** (noul) — Is this food deep-fried or pan-fried in a lot of fat?  
true: The food as eaten is deep-fried or fried in a substantial amount of fat (e.g., fries, fried chicken, tempura, doughnuts, pakora, chips/crisps).  
false: The food is not fried, or only lightly sautéed/stir-fried; baked, grilled, steamed and raw are false.

**`high_saturated_fat`** (score) — How much saturated fat does one typical serving contain?  
0. Low: under about 1 g per serving.  
1. Moderate: about 1-4 g per serving.  
2. High: over about 4 g per serving (e.g., butter, cream sauce, fatty red meat, cheese, coconut oil, pastry).

**`high_fat`** (score) — How much total fat does one typical serving contain relative to its size?  
0. Low fat: under about 3 g per serving.  
1. Moderate.  
2. High fat: over about 15 g per serving or visibly greasy/rich.

**`refined_grain`** (noul) — Is the grain in this food mainly refined rather than whole grain?  
true: The main grain ingredient is refined (white flour, white rice, degerminated corn, most pasta, white bread, most crackers).  
false: The food has no grain, or its grain is mainly whole grain (whole wheat, brown rice, oats, quinoa, barley).

**`whole_grain`** (noul) — Is this food mainly a whole grain or made mainly with whole grain?  
true: The first grain ingredient is a whole grain (e.g., whole wheat, oats, brown rice, quinoa, barley, whole-grain corn, bulgur).  
false: The food has no grain, or its main grain is refined.

**`high_fiber`** (score) — How much dietary fibre does one typical serving contain?  
0. Low: under about 2 g.  
1. Good source: about 3-5 g.  
2. High: over about 5.6 g (20% DV).

**`high_insoluble_fiber_residue`** (score) — How much hard-to-digest insoluble fibre or residue does this food leave, as eaten?  
0. Low residue: refined grains, well-cooked peeled vegetables, smooth nut butters, tender meat, eggs.  
1. Moderate residue.  
2. High residue: raw vegetables, skins/peels, seeds, whole nuts, popcorn, dried fruit, corn kernels, tough fibrous cuts.

**`high_carb_starchy`** (noul) — Is this food a major source of carbohydrate?  
true: The food provides roughly 15 g or more of digestible carbohydrate per typical serving (bread, rice, pasta, potato, cereal, most fruit, sweets, sugary drinks).  
false: The food provides little digestible carbohydrate (meat, fish, eggs, cheese, most non-starchy vegetables, oils, nuts).

**`contains_grain`** (noul) — Does this food contain a cereal grain or pseudo-grain?  
true: The food contains wheat, rice, corn/maize, oats, barley, rye, millet, sorghum, quinoa, buckwheat, amaranth or a flour/starch made from them.  
false: The food contains no grain or grain-derived ingredient.

**`high_glycemic_load`** (score) — How large a blood-glucose load would one typical serving of this food cause?  
0. Low: little digestible carbohydrate, or carbohydrate with fibre/protein/fat that slows absorption (non-starchy vegetables, legumes, nuts, plain yogurt).  
1. Medium.  
2. High: large amounts of quickly absorbed carbohydrate (white bread, white rice, potatoes, sugary drinks, sweets, most breakfast cereals).  
_Note:_ A judgement to rank foods, not an insulin dose input. Never shown as a glycaemic-index number.

**`caffeine`** (score) — About how much caffeine does one typical serving contain?  
0. None: no caffeine at all (water, herbal tea, milk).  
1. Trace: decaf coffee or decaf tea (about 2-15 mg per cup), small amounts of milk chocolate.  
2. Low: under about 50 mg (e.g., green tea cup, cola can, dark chocolate).  
3. Moderate: about 50-150 mg (e.g., cup of brewed coffee, black tea, espresso shot).  
4. High: over about 150 mg (e.g., large coffee, energy drink, pre-workout).  
_Note:_ RANK/FLAG ONLY. A daily caffeine limit (e.g., pregnancy 200 mg) is summed only from known mg values; unknown items show 'caffeine not known' and the day is never reported as within the limit.

**`coffee_or_tea`** (noul) — Is this, or does this contain, coffee or tea from the tea plant?  
true: The item is or contains coffee, espresso, or tea from Camellia sinensis (black, green, white, oolong, matcha, chai made with black tea), including iced and decaf forms and coffee- or tea-flavoured foods that use real coffee/tea.  
false: The item contains no coffee or Camellia sinensis tea; herbal infusions (rooibos, chamomile, peppermint), cola and energy drinks are false.  
_Note:_ LDS guidance names coffee and tea, not caffeine. This facet stops the app from treating caffeine as the rule.

**`omega3_rich`** (noul) — Is this food a rich source of marine omega-3 fats (EPA/DHA)?  
true: The food is or mainly contains oily fish or seafood rich in EPA/DHA (e.g., salmon, sardines, mackerel (Atlantic), herring, trout, anchovies) or algae oil.  
false: The food is not a meaningful source of EPA/DHA; plant ALA sources (flax, chia, walnut) are false here.

**`high_mercury_fish`** (noul) — Could this food contain a fish that FDA/EPA list among choices to avoid for mercury?  
true: The food contains king mackerel, marlin, orange roughy, shark, swordfish, tilefish (Gulf of Mexico) or bigeye tuna, OR tuna whose species or product type is not stated (e.g., 'tuna steak', 'ahi', 'sushi tuna', 'seared tuna').  
false: Every fish is named and none is on that list: canned light/skipjack tuna, salmon, cod, shrimp and sardines are false; albacore/yellowfin are false here but are 'Good Choices' limited to 1 serving/week (code applies the limit).

**`raw_or_undercooked_animal`** (noul) — Is an animal food in this item eaten raw or undercooked?  
true: The item includes raw or undercooked meat, poultry, fish, shellfish or eggs as eaten (e.g., sushi/sashimi, raw oysters, ceviche, steak tartare, rare burger, runny eggs, raw cookie dough, homemade mayo/Caesar dressing).  
false: All animal ingredients are fully cooked or pasteurized, or there are none.

**`unpasteurized`** (noul) — Does this food contain unpasteurized milk, cheese made from it, or unpasteurized juice/cider?  
true: The food states raw/unpasteurized milk, raw-milk cheese, or unpasteurized juice or cider.  
false: The food is pasteurized or contains none of those; hard cheeses from pasteurized milk are false.

**`high_listeria_risk`** (noul) — Is this a food that CDC lists as higher risk for Listeria when eaten as is?  
true: The food is one CDC lists as higher-risk: unheated deli meat, cold cuts, hot dogs or fermented/dry sausage; unheated deli-sliced cheese; premade deli salads; refrigerated pâté or meat spreads; refrigerated smoked fish; any unheated queso fresco-type fresh soft cheese (queso fresco, queso blanco, requesón) EVEN IF made with pasteurized milk; raw-milk cheese, milk, yogurt or ice cream; raw or lightly cooked sprouts; raw enoki mushrooms; cut melon left unrefrigerated.  
false: The food is not in those groups, or the description states it is heated to 165°F / steaming hot, or it is a shelf-stable version (shelf-stable pâté or smoked fish). When preparation is not stated, answer as if unheated.

**`high_purine`** (noul) — Is this food high in purines?  
true: The food is or mainly contains organ meat (liver, kidney, sweetbreads), game, anchovies, sardines, herring, mackerel, mussels, scallops, trout, meat extract/gravy, or beer.  
false: The food is not a high-purine food; vegetables, dairy, eggs, grains and most legumes are false.

**`high_potassium`** (score) — How much potassium does one typical serving contain?  
0. Low: under about 200 mg.  
1. Moderate: about 200-400 mg.  
2. High: over about 400 mg (e.g., banana, potato, tomato sauce, beans, oranges, avocado, salt substitute).  
_Note:_ RANK ONLY; renal budgets use measured values or are reported as not checkable.

**`phosphate_additive`** (noul) — Does this food list a phosphate additive?  
true: The ingredients include a phosphate or 'phos' additive such as sodium phosphate, phosphoric acid, sodium tripolyphosphate, dicalcium phosphate or sodium aluminum phosphate.  
false: No phosphate additive is listed.  
_Note:_ Inorganic phosphate additives are absorbed far more than natural phosphorus.

**`high_phosphorus`** (score) — How much phosphorus does one typical serving provide?  
0. Low.  
1. Moderate.  
2. High: dairy-heavy foods, processed cheese, colas, organ meats, foods with phosphate additives.  
_Note:_ RANK ONLY; renal budgets use measured values or are reported as not checkable.

**`vitamin_k_rich`** (score) — How much vitamin K1 does one typical serving provide?  
0. Low: under about 20 mcg.  
1. Moderate: about 20-100 mcg (e.g., broccoli side, cabbage).  
2. High: over about 100 mcg (e.g., cooked kale, spinach, collards, turnip greens, Brussels sprouts, natto).

**`tyramine_rich`** (noul) — Is this a high-tyramine food of the kind restricted with MAO inhibitors?  
true: The food is or contains cheese (especially aged), yogurt, pickled or smoked fish (e.g., pickled herring), liver, dry/fermented sausage (salami, pepperoni, Lebanon bologna) or other aged/cured meat, fermented soy (soy sauce, miso, fermented tofu), sauerkraut or kimchi, beer (including alcohol-free and tap beer), wine, yeast extract (Marmite, brewer's yeast), fava/broad bean pods, or protein food that is aged, fermented, pickled, smoked or not fresh.  
false: The food is clearly none of those (e.g., fresh plain meat, fresh fish, eggs, fresh vegetables, grains). Anything aged, fermented, pickled, smoked or of unclear freshness is TRUE.  
_Note:_ For non-selective MAOIs this facet is one layer only: code also matches the drug label's own list (phenelzine, tranylcypromine, isocarboxazid) and treats any unknown as 'unverified'. A facet 'absent' never clears a label-listed food.

**`grapefruit_family`** (noul) — Does this food contain grapefruit or a related citrus that interacts with some medicines?  
true: The food contains grapefruit, pomelo, Seville/bitter orange (e.g., marmalade), or grapefruit juice, including blends.  
false: The food contains none of these; sweet orange, lemon, lime and tangerine are false.

**`high_lactose`** (score) — How much lactose does one typical serving contain?  
0. None or trace: lactose-free milk, butter, aged hard cheese (cheddar, parmesan, swiss), non-dairy foods.  
1. Low: under about 5 g (e.g., small yogurt, feta, a splash of milk in coffee).  
2. High: over about 5 g (e.g., glass of milk, ice cream, milkshake, ricotta, cottage cheese in quantity).

**`fodmap_fructan`** (noul) — Is this food a significant source of fructans in a typical serving?  
true: The food contains a notable amount of wheat, rye or barley (as a main ingredient), onion, garlic, shallot, leek bulb, inulin/chicory root fibre, or fructo-oligosaccharides.  
false: The food contains none of those in a meaningful amount; garlic-infused oil and spring-onion greens are false.  
_Note:_ Monash lab data are the gold standard; Jev only screens.

**`fodmap_gos`** (noul) — Is this food a significant source of galacto-oligosaccharides (GOS)?  
true: The food contains a notable amount of legumes/pulses (beans, chickpeas, lentils, soy beans), cashews, pistachios or soy milk made from whole beans.  
false: The food contains none of those in a meaningful amount; canned rinsed lentils in small serves may still be false.

**`fodmap_excess_fructose`** (noul) — Is this food a significant source of excess fructose?  
true: The food contains a notable amount of apple, pear, mango, watermelon, honey, agave, high-fructose corn syrup or fruit-juice concentrate.  
false: The food contains none of those in a meaningful amount.

**`fodmap_polyol`** (noul) — Is this food a significant source of polyols (sugar alcohols)?  
true: The food contains sorbitol, mannitol, xylitol, maltitol or isomalt, or a notable amount of stone fruit (peach, plum, cherry, apricot), mushrooms, cauliflower or avocado.  
false: The food contains none of those in a meaningful amount.

**`spicy_hot`** (score) — How spicy-hot (chilli heat) is this food?  
0. Not spicy.  
1. Mild.  
2. Medium: noticeable chilli heat.  
3. Hot: strong chilli heat (e.g., vindaloo, hot wings, ghost-pepper sauce).

**`high_acid`** (noul) — Is this food strongly acidic?  
true: The food is or mainly contains citrus fruit or juice, tomato/tomato sauce, vinegar-based dressing or pickle, or a carbonated soft drink.  
false: The food is not strongly acidic.

**`carbonated`** (noul) — Is this a carbonated drink or a food containing one?  
true: The item is a fizzy drink: soda, sparkling water, beer, sparkling wine, kombucha, carbonated energy drink.  
false: The item is not carbonated.

**`root_vegetable`** (noul) — Does this food contain a root, bulb or tuber vegetable?  
true: The food contains onion, garlic, potato, carrot, beetroot, radish, turnip, sweet potato, yam, ginger root, turmeric root or another vegetable that grows underground.  
false: The food contains no underground root, bulb or tuber vegetable.

**`fava_bean`** (noul) — Does this food contain fava (broad) beans?  
true: The food contains fava/broad beans, ful medames, falafel made with fava beans, or fava bean flour.  
false: The food contains no fava bean; chickpea-only falafel is false.

**`aspartame`** (noul) — Does this food contain aspartame?  
true: The ingredients include aspartame or the label says 'Phenylketonurics: contains phenylalanine'.  
false: No aspartame is listed.

**`non_nutritive_sweetener`** (noul) — Does this food contain a non-nutritive or low-calorie sweetener?  
true: The food contains sucralose, aspartame, acesulfame K, saccharin, stevia/steviol glycosides, monk fruit extract, or a sugar alcohol such as erythritol or xylitol.  
false: The food contains no such sweetener.

**`star_fruit`** (noul) — Does this food contain star fruit (carambola)?  
true: The food contains star fruit or carambola juice.  
false: The food contains no star fruit.

**`high_iodine`** (noul) — Is this food a significant source of iodine?  
true: The food is or contains seaweed/kelp/nori, iodized salt in notable amounts, dairy, egg yolk, seafood, or the colour erythrosine (Red No. 3).  
false: The food is not a notable iodine source.

**`iron_rich`** (score) — How good a source of iron is one typical serving?  
0. Poor.  
1. Moderate.  
2. Rich: about 20% DV (3.6 mg) or more, e.g., red meat, liver, mussels, fortified cereal, lentils, tofu, spinach (non-heme).

**`calcium_rich`** (score) — How good a source of calcium is one typical serving?  
0. Poor.  
1. Moderate.  
2. Rich: about 260 mg (20% DV) or more, e.g., milk, yogurt, cheese, fortified plant milk, calcium-set tofu, sardines with bones.

**`protein_dense`** (score) — How protein-dense is this food per calorie?  
0. Low: under about 5 g protein per 100 kcal.  
1. Moderate: about 5-10 g per 100 kcal.  
2. High: over about 10 g per 100 kcal (e.g., chicken breast, fish, egg whites, Greek yogurt, tofu, cottage cheese, whey).

**`energy_dense`** (score) — How energy-dense is this food (calories per gram)?  
0. Low: under about 1.5 kcal/g (vegetables, fruit, soups, lean protein).  
1. Medium: about 1.5-4 kcal/g.  
2. High: over about 4 kcal/g (nuts, oils, chocolate, chips, pastries).

**`nightshade`** (noul) — Does this food contain a nightshade vegetable or spice?  
true: The food contains tomato, white/red potato, eggplant, bell or chilli pepper, paprika, cayenne, goji berry or tomatillo.  
false: The food contains none of those; black pepper and sweet potato are false.

**`high_oxalate`** (noul) — Is this food high in oxalate?  
true: The food is or mainly contains spinach, rhubarb, beet greens, almonds, cashews, peanuts, soy/tofu in quantity, buckwheat, cocoa/dark chocolate or black tea.  
false: The food is not a high-oxalate food.

**`texture_level`** (choice) — Which IDDSI food or drink level best describes this item as served?  
options: IDDSI 0 thin liquid | IDDSI 1 slightly thick | IDDSI 2 mildly thick | IDDSI 3 liquidised/moderately thick | IDDSI 4 pureed/extremely thick | IDDSI 5 minced and moist | IDDSI 6 soft and bite-sized | IDDSI 7 regular/easy to chew or regular  
_Note:_ ONE-DIRECTIONAL screen: Jev may flag a food as clearly ABOVE a level (nuts, raw carrots, mixed-consistency soup) -> blocked, but can never CLEAR a food. Clearance needs the user's verified preparation (IDDSI testing methods); otherwise 'unverified'. Food and drink levels are separate inputs.

**`hard_to_chew`** (noul) — Is this food hard, tough, crunchy or sticky enough to be difficult to chew?  
true: The food is hard, tough, crunchy, chewy or sticky (e.g., nuts, raw carrots, steak, crusty bread, caramel, popcorn).  
false: The food is soft, tender or easily mashed with a fork.

**`cuisine`** (choice) — Which cuisine does this dish most belong to?  
options: American | Mexican/Latin American | Italian | Mediterranean/Middle Eastern | Indian/South Asian | Chinese | Japanese | Korean | Southeast Asian | Caribbean | African | European (other) | none/basic ingredient

**`texture_profile`** (choice) — Which texture best describes this food as eaten?  
options: crunchy/crisp | chewy | creamy/smooth | soft/tender | slippery/slimy | mixed/chunky | liquid

**`contains_allergen:<name>`** (noul) — Could this food contain <name>, given its ingredients and any may-contain warning?  
true: The food states <name> or a <name>-derived ingredient, carries a trace or cross-contact warning for <name>, OR lists a generic term that can legally hide <name> (e.g., 'spices', 'natural flavour(s)', 'seasoning', 'vegetable protein', 'starch') or has no ingredient list.  
false: A complete ingredient list is present, names no <name> ingredient and contains no generic term that could hide <name>. (This answers ingredients only; it says nothing about cross-contact.)  
_Note:_ Non-major allergens need not be declared and 'may contain' warnings are voluntary (FDA), so neither a Jev 'absent' nor a missing warning clears cross-contact. POLICY for a user-named (non-FALCPA) allergen: best possible verdict is 'unverified' ('No <name> in the ingredients; cross-contact is not declared by law'); a food becomes 'allowed' only when the user marks that exact product as checked (e.g., with the maker). Data class: to avoid a per-user question revealing a user's allergy to Jev, <name> must come from a GLOBAL list asked for every food (EU-14 + corn, coconut, kiwi, buckwheat, sulfites, mollusc, and names added by review). A name outside the global list is matched deterministically only, and the result stays 'unverified'.

**`contains_ingredient:<name>`** (noul) — Does this food contain <name> as an ingredient?  
true: The food contains <name> or an obvious form of it.  
false: The food contains no <name>; a flavour name without evidence of the ingredient is false.  
_Note:_ No cross-contact clause: dislikes and personal triggers are not allergies. Data class: the same global-list rule as contains_allergen applies; a user-specific name is matched deterministically in code and never sent to Jev as a per-user question.


## 6. How Jev helps

Jev's strength is many small, parallel, cheap judgments about foods. Code owns the user's profile,
the rules and the arithmetic. Under Phase 13 §2, Jev gets D0 only. The table follows that rule, and
each row states its data class.

| # | Use | What Jev does | Primitive | Data class sent to Jev | When it runs | Latency cost to the user |
|---|---|---|---|---|---|---|
| 1 | **Tag foods with facets** | Answers all 96 facet questions (the same set for every user) for one food in one parallel request. The warm job (`food_facets`) tags new foods and new rubric versions. | noul / score / choice | D0: food name, brand, description, preparation, ingredients | Background warm job; on-demand miss during search | 0 ms when cached. About 0.3-1 s on a cold miss, shown as "Checking…". Allergen `unknown` never shows as safe. |
| 2 | **Rank suggestions against a profile** | Nothing at rank time. Code multiplies cached facet probabilities by profile weights (hard → verdict, soft → penalty, prefer → boost, budgets → counters). An optional Jev `score` answers "how well does this fit as breakfast/dinner" (meal-fit facets exist). | none (code) / score | D0 | Every suggestion list, `food_ideas`, swaps | ~0 ms. Pure code over the cache. |
| 3 | **Suggest swaps and "bridge" foods** | Scores how similar food B is to food A ("like pepperoni pizza") over a candidate set that is built **without** the user's rules: the global nearest neighbours of A in the catalogue, precomputed per food. Code then removes the candidates that break the user's rules and ranks the rest. A candidate list filtered by the user's rules before Jev sees it would reveal those rules, so that is not done. | score (pairwise similarity), cached per food pair | D0: two foods; user-independent candidates | Precomputed; on-demand for new foods | ~0 ms cached; about 0.3-0.8 s for a new food |
| 4 | **Detect profiles and exceptions in the user's own words** | **Not Jev.** Text such as "my doctor says I have CKD" or "I'm Muslim" is D2 (health or religion). A deterministic synonym matcher (the JSON `synonyms[]` and `ambiguous_phrases`) plus the `converse` lane (Gemini, behind the existing D2 gate) proposes profiles, strengths and exceptions. A confirm card lets the user accept each rule. This map proposes no Jev path for this, including after `JEV_HEALTH_ATTESTED`; any future change needs its own spec. | — | none to Jev | Onboarding and chat | 0 ms for the matcher. The confirm card is UI time, not model time. |
| 5 | **Check coach replies against the rules** | The raw reply text is **not** sent to Jev, because a reply can repeat the user's diagnosis or medicines (D2). Code pulls the food mentions from the reply: `food_ideas`/`log_draft` blocks already carry food ids, and a catalog matcher handles free text. Code then checks those foods' cached facets against the active rules. Only an isolated food name that has no cached facets goes to Jev, as a normal D0 facet tag (row 1). A HARD hit → replace the reply with a safe re-ask. A SOFT hit → add a note or re-rank. This amends Phase 13 §4.4, which proposed sending reply text. | code; noul only for uncached food names | D0: food names only | After each coach turn with food content | ~0 ms (cache); about 0.3-0.8 s for an uncached food, in parallel with coach-verify |
| 6 | **Label and ingredient capture warnings** | After `labelToNutrients`, runs the full global facet set (not a user-specific subset) on the extracted ingredient list. Code then picks the warnings that match the user's rules. The capture card shows "Contains sesame", "Check: may contain peanuts" or "Grapefruit – your rule" before the user logs. Numbers (sodium, sugar) come from the label, not Jev. | noul/score | D0: extracted ingredients | Barcode, label photo, menu photo | About 0.3-1 s after extraction |
| 7 | **Learn likes and dislikes from logs** | Code counts which facets and cuisines the user logs, swaps away or deletes (D1, stays in code). Jev only supplies the D0 tags (`cuisine`, `texture_profile`, `spicy_hot`) that make the counts meaningful. A learned pattern becomes a `prefer` or `limit` suggestion. The user confirms it ("You rarely eat spicy food. Keep suggestions mild?"). It never becomes a hard rule by itself. | choice/score (tags only) | D0 tags; the counts are D1 in code | Weekly review | 0 ms at runtime |
| 8 | **Keep "unknown" honest** | For a hard rule, a facet between the absent and present thresholds shows as `unverified` ("Check the label"). It queues a re-tag with richer state, such as the scanned label, and it never shows as allowed. | noul | D0 | On view | 0 ms (cache) |
| 9 | **Time-window and budget rules** | Not Jev. Code handles Ramadan hours, Lent Fridays, IF windows, weekly chicken budgets and the kosher meat→dairy wait. Jev only provides the facet tags those rules read. | — | — | — | 0 ms |
| 10 | **Grounded lookup check** | For the Phase 13 `lookup` lane ("is this brand gluten-free?"), a Jev attribution `score` checks every claim against the grounded snippet. Claims under 0.85 are dropped. | score | D0 | On lookup | About 0.3-0.8 s |

What Jev must never do here: decide that a person may eat something, read a diagnosis, certify
halal/kosher/gluten-free, estimate a lab-driven limit (potassium, phosphorus, insulin), or turn a
user's words into a hard rule without a confirm card.

## 7. Integration notes (for the spec that adopts this)

1. `PREFERENCE_FLAGS` (12 flags) becomes a set of profile instances. The existing flags map to
   profiles one-to-one: vegetarian → `vegetarian_lacto_ovo`, `no_pork`/`no_beef` → user_rule
   profiles, `low_fodmap` → `ibs_low_fodmap`, `halal`/`kosher` keep `requiresVerification`.
2. HARD lists feed `evaluatePolicy` without changing its precedence. SOFT and PREFER lists feed a
   new `rankFoods(profileInstances, facets, nutrients)` layer that returns a score and reasons. They
   never change the verdict, so the policy module stays pure and its tests stay valid.
3. `CONDITION_RULES` stays empty. A condition profile is a **preference pack the user turns on**
   ("Help me follow my doctor's low-sodium advice"). The pack holds soft rules plus
   `user_confirmed_safety` items that the user confirms one by one. This is a proposed amendment to
   Phase 13 §4.3. Devin (and ideally Sasha's nutritionist) should approve it before any condition
   pack ships.
4. Build facets in value order (§5.2). Each needs a rubric, a labelled set (≥30% positives for
   safety facets), threshold calibration, and a `RUBRIC_VERSION` bump.
5. Copy: each soft rule shows its evidence strength and one source link. Each condition pack shows
   "Your clinician's advice comes first."

## 8. Adversarial review log (GPT-6 Sol)

**Round 1** (`docs/audit/research/2026-09-23-dietary-map-r1-gpt6-sol.md`): VERDICT BLOCK (19),
plus 16 FIX. All 19 BLOCKs were fixed in the JSON:

| # | Finding | Fix |
|---|---|---|
| 1 | `contains_allergen:<name>` "absent" could clear a named allergy | Rubric now counts generic terms ("spices", "natural flavours") and missing ingredient lists as possible presence. Policy: `unverified` unless a complete ingredient list exists. |
| 2 | "allergic to nuts" / "shellfish allergy" narrowed silently | New `ambiguous_phrases` map turns on the broader set until the user clarifies. |
| 3 | Baked milk/egg option too broad | Only the allergist-cleared foods the user lists are allowed. |
| 4 | Oral allergy syndrome was soft | Now hard (allergy basis); cooked forms only with the allergist option. |
| 5 | Celiac: ingredient "absent" cleared processed foods | Processed or restaurant food clears only with a gluten-free claim or certification; otherwise `unverified`. |
| 6 | PKU still allowed ordinary plans | Planner and food ideas disabled; logging only; clinic prescription governs. |
| 7 | Dysphagia: Jev IDDSI guess could clear foods | `texture_level` is a one-directional screen: it can block, never clear. Separate food and drink levels. |
| 8 | Listeria rubric wrong on pasteurized queso fresco | Rubric rebuilt from CDC's list: queso fresco-type cheeses even if pasteurized, deli salads, dry sausages, enoki, 165°F rule. |
| 9 | Pregnancy vs keto/low-carb | Pregnancy and GDM: ≥175 g carbohydrate, 71 g protein, 28 g fibre (ADA 2026 §15). Keto disabled. |
| 10 | CKD protein without stage | Stage and dialysis status required before any protein change. Exceptions for unstable or malnourished users. |
| 11 | Bariatric stage missing | Stage is required; no suggestions until it is known. |
| 12 | Disulfiram window and hidden alcohol | Split into its own profile: sauces, vinegars, cooked-off wine; window while taking + 14 days. Metronidazole is a separate profile with the CDC evidence caveat. |
| 13 | Bisphosphonate timing is drug-specific | Timing per drug (ibandronate 60 min; Atelvia after breakfast). No advice until the product is known. |
| 14 | Linezolid missing | New `linezolid` profile (label: avoid LARGE amounts of tyramine). |
| 15 | Tacrolimus missing | New `immunosuppressant_grapefruit` profile. |
| 16 | Ramadan plan generation for high-risk users | Plan generation blocked for those combinations until the user records a clinician-approved plan. |
| 17 | No paediatric gate | New `minor_under_18` age gate disables adult targets. |
| 18 | Scores used as daily-limit proof | Design rule 7: scores rank; limits come only from measured nutrients; missing = "cannot check". |
| 19 | D0 leaks: per-user template questions and raw reply text | Design rule 6: question sets never depend on the user; templates use a global name list; the reply check pulls food mentions in code. |

FIX items applied: dialysis minerals now lab-driven options; GLP-1 ↔ CKD conflict; fat-loss
protein and calorie framing (general 1.2-1.6; Helms figure limited to fat-free mass in lean
athletes); pregnancy/lactation kcal cited to DGA 2020-2025; vitamin D by age; AHA 2021 → AHA 2026;
EoE profile added; low-fat directive re-cited to NIDDK; alpha-gal gelatin by source
(`gelatin_source`); Whole30/paleo legume and ghee handling; kosher fins-OR-scales rubric, levels
and Passover chametz vs kitniyot; Lent uses the new `land_animal_flesh` facet; Orthodox uses
`contains_finfish` and cites OCA; Sikh kutha rule no longer demands jhatka evidence.
Not changed: `caffeine_free` already had a strict (`never`) option.

**Round 2** (`docs/audit/research/2026-09-23-dietary-map-r2-gpt6-sol.md`): VERDICT BLOCK (8).
Sol confirmed 14 of the round-1 BLOCKs as resolved and found 5 still open, plus 3 new ones. All 8
were fixed in the JSON afterwards. A third Sol round was **not** run (the brief allowed at most
two). The next reviewer should re-check these 8 items first.

| # | Finding | Fix |
|---|---|---|
| R1-01 | A missing warning cannot clear cross-contact | For a user-named non-FALCPA allergen, the best verdict is `unverified` ("not in ingredients; cross-contact not declared by law"). `allowed` only when the user marks that exact product as checked. |
| R1-08 | Deli-sliced cheese missing | Added to the `high_listeria_risk` rubric, with the 165°F exception (CDC pregnancy food-safety page). |
| R1-16 | Insulin/sulfonylurea not captured | New `insulin_or_sulfonylurea` profile. Type 2 diabetes asks the treatment question. An unanswered or unsure answer counts as high risk for fasting gates. |
| R1-17 | Age gate by birth year only | Near 18, the app asks "18 or older?" or collects the full date of birth, and treats the user as under 18 until then. |
| R1-19 | Future D2 path to Jev; rule-filtered candidates | §6 row 4 now proposes no Jev path. Row 3 builds swap candidates without the user's rules and filters them in code afterwards. |
| R2-20 | MAOI list gaps (wine, alcohol-free beer, yogurt, liver, pickled herring) | `tyramine_rich` rubric rebuilt from the phenelzine label. Anything aged, fermented, pickled or smoked, or of unclear freshness, is true. The MAOI profile also hard-blocks alcohol and matches the label list in code; unknown → `unverified`. |
| R2-21 | Atelvia precautions | Per-drug wording: after breakfast, ≥4 oz plain water, swallow whole upright, no lying down for 30 min. Alendronate wording corrected to 6-8 oz. |
| R2-22 | Tuna of unknown species | Counts as possible high-mercury (`unverified` in pregnancy). Albacore is limited to 1 serving/week in code. |

Round-2 FIXes applied: the oral allergy syndrome `jev_design` now matches the hard rule; the
caffeine score gained a "Trace (decaf)" level, and strict caffeine-free blocks Trace or higher.


## 9. Sources

All URLs were resolved on 2026-09-23. DOI and PMID metadata was verified through Crossref and
PubMed.

- `fda_allergens` — FDA. Food Allergies (FALCPA + FASTER Act: 9 major allergens). <https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies>
- `fda_allergen_qa_2025` — FDA. Questions and Answers Regarding Food Allergens, Edition 5 (final guidance, Jan 2025; tree-nut list cut to 12, coconut removed; milk/egg widened to other species). <https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-questions-and-answers-regarding-food-allergens-including-food-allergen-labeling>
- `eu_1169` — EU Regulation 1169/2011, Annex II (14 allergens incl. mustard, celery, lupin, molluscs, sulphites). <https://eur-lex.europa.eu/eli/reg/2011/1169/oj>
- `niaid_fa` — NIAID. Guidelines for Clinicians and Patients for Diagnosis and Management of Food Allergy. <https://www.niaid.nih.gov/diseases-conditions/guidelines-clinicians-and-patients-food-allergy>
- `cdc_alphagal` — CDC. About Alpha-gal Syndrome. <https://www.cdc.gov/alpha-gal-syndrome/about/index.html>
- `fda_gf` — FDA. Gluten-Free Labeling of Foods (<20 ppm). <https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/gluten-free-labeling-foods>
- `fda_sulfite` — 21 CFR 101.100(a)(4): sulfites >=10 ppm must be declared. <https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-G/section-101.100>
- `fda_aspartame` — 21 CFR 172.804: aspartame label statement 'Phenylketonurics: contains phenylalanine'. <https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-172/subpart-I/section-172.804>
- `fda_dv` — FDA. Daily Value on the Nutrition and Supplement Facts Labels (5% low / 20% high). <https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels>
- `fda_fish` — FDA/EPA. Advice about Eating Fish (Best / Good / Choices to Avoid). <https://www.fda.gov/food/consumers/advice-about-eating-fish>
- `fda_at_risk` — FDA. Food Safety for Older Adults and People with Cancer, Diabetes, HIV/AIDS, Organ Transplants, and Autoimmune Diseases. <https://www.fda.gov/food/people-risk-foodborne-illness/food-safety-older-adults-and-people-cancer-diabetes-hivaids-organ-transplants-and-autoimmune>
- `fda_people_at_risk` — FDA. People at Risk of Foodborne Illness (pregnancy, older adults, immunocompromised). <https://www.fda.gov/food/consumers/people-risk-foodborne-illness>
- `fda_raw_milk` — FDA. Raw Milk Misconceptions and the Danger of Raw Milk Consumption. <https://www.fda.gov/food/buy-store-serve-safe-food/raw-milk-misconceptions-and-danger-raw-milk-consumption>
- `fda_grapefruit` — FDA. Grapefruit Juice and Some Drugs Don't Mix. <https://www.fda.gov/consumers/consumer-updates/grapefruit-juice-and-some-drugs-dont-mix>
- `fda_caffeine` — FDA. Spilling the Beans: How Much Caffeine is Too Much? (400 mg/day healthy adults). <https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much>
- `cdc_listeria` — CDC. Preventing Listeria Infection (higher-risk foods and groups). <https://www.cdc.gov/listeria/prevention/index.html>
- `cdc_vibrio` — CDC. About Vibrio Infection (raw/undercooked oysters; liver disease, iron overload). <https://www.cdc.gov/vibrio/about/index.html>
- `dga_2025` — USDA/HHS. Dietary Guidelines for Americans 2025-2030 (released 2026-01-07): protein 1.2-1.6 g/kg/day, sat fat <=10% kcal, sodium <2300 mg (14+), limit highly processed foods and added sugars, no alcohol in pregnancy. <https://cdn.realfood.gov/DGA.pdf>
- `ods_iron` — NIH ODS. Iron fact sheet for health professionals. <https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/>
- `ods_calcium` — NIH ODS. Calcium fact sheet. <https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/>
- `ods_vitd` — NIH ODS. Vitamin D fact sheet. <https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/>
- `ods_b12` — NIH ODS. Vitamin B12 fact sheet (vegans, older adults, metformin). <https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/>
- `ods_vitk` — NIH ODS. Vitamin K fact sheet (warfarin: keep intake consistent). <https://ods.od.nih.gov/factsheets/VitaminK-HealthProfessional/>
- `niddk_celiac` — NIDDK. Eating, Diet, & Nutrition for Celiac Disease. <https://www.niddk.nih.gov/health-information/digestive-diseases/celiac-disease/eating-diet-nutrition>
- `salerno_ncgs` — Catassi C et al. Diagnosis of NCGS: the Salerno Experts' Criteria. Nutrients 2015. doi:10.3390/nu7064966 <https://doi.org/10.3390/nu7064966>
- `niddk_lactose` — NIDDK. Eating, Diet, & Nutrition for Lactose Intolerance. <https://www.niddk.nih.gov/health-information/digestive-diseases/lactose-intolerance/eating-diet-nutrition>
- `acg_ibs_2021` — Lacy BE et al. ACG Clinical Guideline: Management of IBS. Am J Gastroenterol 2021. doi:10.14309/ajg.0000000000001036 <https://doi.org/10.14309/ajg.0000000000001036>
- `monash` — Monash University. About FODMAPs and IBS (3-phase low-FODMAP diet). <https://www.monashfodmap.com/about-fodmap-and-ibs/>
- `niddk_ibs` — NIDDK. Eating, Diet, & Nutrition for IBS. <https://www.niddk.nih.gov/health-information/digestive-diseases/irritable-bowel-syndrome/eating-diet-nutrition>
- `aga_ibd_2024` — Hashash JG et al. AGA Clinical Practice Update on Diet and Nutritional Therapies in IBD. Gastroenterology 2024;166:521-532. PMID 38276922 <https://pubmed.ncbi.nlm.nih.gov/38276922/>
- `ioibd_2020` — Levine A et al. Dietary Guidance From the IOIBD. Clin Gastroenterol Hepatol 2020. doi:10.1016/j.cgh.2020.01.046 <https://doi.org/10.1016/j.cgh.2020.01.046>
- `ccf_diet` — Crohn's & Colitis Foundation. Diet and Nutrition. <https://www.crohnscolitisfoundation.org/patientsandcaregivers/diet-and-nutrition>
- `acg_gerd_2022` — Katz PO et al. ACG Clinical Guideline for GERD. Am J Gastroenterol 2022. doi:10.14309/ajg.0000000000001538 <https://doi.org/10.14309/ajg.0000000000001538>
- `niddk_gerd` — NIDDK. Eating, Diet, & Nutrition for GER & GERD. <https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults/eating-diet-nutrition>
- `aga_divert_2021` — Peery AF et al. AGA Clinical Practice Update on Medical Management of Colonic Diverticulitis. Gastroenterology 2021. doi:10.1053/j.gastro.2020.09.059 <https://doi.org/10.1053/j.gastro.2020.09.059>
- `niddk_divert` — NIDDK. Eating, Diet, & Nutrition for Diverticular Disease. <https://www.niddk.nih.gov/health-information/digestive-diseases/diverticulosis-diverticulitis/eating-diet-nutrition>
- `aasld_nafld_2023` — Rinella ME et al. AASLD Practice Guidance on NAFLD (MASLD). Hepatology 2023. doi:10.1097/HEP.0000000000000323 <https://doi.org/10.1097/HEP.0000000000000323>
- `easl_nutrition_2019` — EASL Clinical Practice Guidelines on nutrition in chronic liver disease. J Hepatol 2019. doi:10.1016/j.jhep.2018.06.024 <https://doi.org/10.1016/j.jhep.2018.06.024>
- `niddk_hemo` — NIDDK. Eating, Diet, & Nutrition for Hemochromatosis. <https://www.niddk.nih.gov/health-information/liver-disease/hemochromatosis/eating-diet-nutrition>
- `kdigo_2024` — KDIGO 2024 Clinical Practice Guideline for the Evaluation and Management of CKD (protein 0.8 g/kg G3-G5; avoid >1.3; sodium <2 g/day). <https://kdigo.org/wp-content/uploads/2024/03/KDIGO-2024-CKD-Guideline.pdf>
- `kdoqi_2020` — Ikizler TA et al. KDOQI Clinical Practice Guideline for Nutrition in CKD: 2020 Update. Am J Kidney Dis 2020. doi:10.1053/j.ajkd.2020.05.006 <https://doi.org/10.1053/j.ajkd.2020.05.006>
- `niddk_ckd` — NIDDK. Healthy Eating for Adults with Chronic Kidney Disease. <https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/eating-nutrition>
- `starfruit_2021` — Yasawardene P et al. Nephrotoxicity and neurotoxicity following star fruit ingestion: a narrative review. Trans R Soc Trop Med Hyg 2021. PMID 33693950 <https://pubmed.ncbi.nlm.nih.gov/33693950/>
- `aua_stones_2014` — Pearle MS et al. Medical Management of Kidney Stones: AUA Guideline. J Urol 2014. doi:10.1016/j.juro.2014.05.006 <https://doi.org/10.1016/j.juro.2014.05.006>
- `ada_soc_2026` — American Diabetes Association. Standards of Care in Diabetes-2026 (Sections 3 and 5). Diabetes Care 2026;49(Suppl 1). <https://professional.diabetes.org/standards-of-care>
- `ada_nutrition_2019` — Evert AB et al. Nutrition Therapy for Adults With Diabetes or Prediabetes: A Consensus Report. Diabetes Care 2019. doi:10.2337/dci19-0014 <https://doi.org/10.2337/dci19-0014>
- `sglt2_edka_2015` — Rosenstock J, Ferrannini E. Euglycemic DKA: a predictable, detectable, and preventable safety concern with SGLT2 inhibitors. Diabetes Care 2015. doi:10.2337/dc15-1380 <https://doi.org/10.2337/dc15-1380>
- `aha_acc_htn_2025` — 2025 AHA/ACC multisociety Guideline for High Blood Pressure in Adults. JACC 2025. doi:10.1016/j.jacc.2025.05.007 (sodium <2300 toward <1500 mg; potassium 3500-5000 mg from food unless CKD/K-retaining drugs; K salt substitutes except CKD/K-retaining drugs). <https://doi.org/10.1016/j.jacc.2025.05.007>
- `nhlbi_dash` — NHLBI. DASH Eating Plan. <https://www.nhlbi.nih.gov/education/dash-eating-plan>
- `aha_sodium` — AHA. How much sodium should I eat per day? (<=2300 mg, ideal 1500 mg). <https://www.heart.org/en/healthy-living/healthy-eating/eat-smart/sodium/how-much-sodium-should-i-eat-per-day>
- `aha_diet_2021` — Lichtenstein AH et al. 2021 Dietary Guidance to Improve Cardiovascular Health (AHA). Circulation 2021. doi:10.1161/CIR.0000000000001031 <https://doi.org/10.1161/CIR.0000000000001031>
- `acr_gout_2020` — FitzGerald JD et al. 2020 ACR Guideline for the Management of Gout. Arthritis Care Res 2020. doi:10.1002/acr.24180 <https://doi.org/10.1002/acr.24180>
- `pcos_2023` — Teede HJ et al. Recommendations from the 2023 International Evidence-based Guideline for PCOS. J Clin Endocrinol Metab 2023. doi:10.1210/clinem/dgad463 <https://doi.org/10.1210/clinem/dgad463>
- `ata_hypo_2014` — Jonklaas J et al. ATA Guidelines for the Treatment of Hypothyroidism. Thyroid 2014. doi:10.1089/thy.2014.0028 <https://doi.org/10.1089/thy.2014.0028>
- `ml_levothyroxine` — MedlinePlus. Levothyroxine drug information. <https://medlineplus.gov/druginfo/meds/a682461.html>
- `ata_low_iodine` — American Thyroid Association. Low Iodine Diet. <https://www.thyroid.org/low-iodine-diet/>
- `bhof_2022` — LeBoff MS et al. The clinician's guide to prevention and treatment of osteoporosis (BHOF). Osteoporos Int 2022. doi:10.1007/s00198-021-05900-y <https://doi.org/10.1007/s00198-021-05900-y>
- `obesity_2013` — Jensen MD et al. 2013 AHA/ACC/TOS Guideline for the Management of Overweight and Obesity in Adults. Circulation 2014. doi:10.1161/01.cir.0000437739.71477.ee <https://doi.org/10.1161/01.cir.0000437739.71477.ee>
- `glp1_2025` — Mozaffarian D et al. Nutritional priorities to support GLP-1 therapy for obesity: joint advisory (ACLM, ASN, OMA, TOS). Obesity 2025. PMID 40445127 <https://pubmed.ncbi.nlm.nih.gov/40445127/>
- `asmbs_2019` — Mechanick JI et al. Clinical practice guidelines for perioperative nutrition... bariatric procedures (AACE/TOS/ASMBS/OMA/ASA 2019 update). Surg Obes Relat Dis 2020. doi:10.1016/j.soard.2019.10.025 <https://doi.org/10.1016/j.soard.2019.10.025>
- `nci_pdq` — NCI. Nutrition in Cancer Care (PDQ), health professional version. <https://www.cancer.gov/about-cancer/treatment/side-effects/appetite-loss/nutrition-hp-pdq>
- `espen_cancer_2021` — Muscaritoli M et al. ESPEN practical guideline: Clinical Nutrition in cancer. Clin Nutr 2021. doi:10.1016/j.clnu.2021.02.005 <https://doi.org/10.1016/j.clnu.2021.02.005>
- `prot_age_2013` — Bauer J et al. PROT-AGE position paper: optimal dietary protein intake in older people. JAMDA 2013. doi:10.1016/j.jamda.2013.05.021 <https://doi.org/10.1016/j.jamda.2013.05.021>
- `acog_caffeine` — ACOG Committee Opinion 462. Moderate Caffeine Consumption During Pregnancy (<200 mg/day). <https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2010/08/moderate-caffeine-consumption-during-pregnancy>
- `cdc_alcohol_preg` — CDC. About Alcohol Use During Pregnancy (no known safe amount). <https://www.cdc.gov/alcohol-pregnancy/about/index.html>
- `cdc_bf_diet` — CDC. Maternal Diet and Breastfeeding (caffeine <=300 mg/day; fish; B12). <https://www.cdc.gov/breastfeeding-special-circumstances/hcp/diet-micronutrients/maternal-diet.html>
- `cdc_bf_alcohol` — CDC. Alcohol and Breastfeeding (not drinking is safest; wait >=2 h after one drink). <https://www.cdc.gov/breastfeeding-special-circumstances/hcp/vaccine-medication-drugs/alcohol.html>
- `maoi_2012` — Flockhart DA. Dietary restrictions and drug interactions with MAOIs: an update. J Clin Psychiatry 2012. doi:10.4088/JCP.11096su1c.03 <https://doi.org/10.4088/JCP.11096su1c.03>
- `ml_phenelzine` — MedlinePlus. Phenelzine (tyramine food list). <https://medlineplus.gov/druginfo/meds/a682089.html>
- `ml_lithium` — MedlinePlus. Lithium (keep salt and fluid intake steady). <https://medlineplus.gov/druginfo/meds/a681039.html>
- `ml_tetracycline` — MedlinePlus. Tetracycline (dairy/calcium/iron separation). <https://medlineplus.gov/druginfo/meds/a682098.html>
- `ml_cipro` — MedlinePlus. Ciprofloxacin (dairy/calcium-fortified separation). <https://medlineplus.gov/druginfo/meds/a688016.html>
- `ml_alendronate` — MedlinePlus. Alendronate (empty stomach, plain water, upright 30 min). <https://medlineplus.gov/druginfo/meds/a601011.html>
- `ml_disulfiram` — MedlinePlus. Disulfiram (avoid sauces, vinegars and all foods/drinks containing alcohol; a reaction may occur up to 2 weeks after stopping). <https://medlineplus.gov/druginfo/meds/a682602.html>
- `ml_metronidazole` — MedlinePlus. Metronidazole (no alcohol during and for 3 days after). <https://medlineplus.gov/druginfo/meds/a689011.html>
- `ml_g6pd` — MedlinePlus Genetics. G6PD deficiency (fava beans trigger hemolysis). <https://medlineplus.gov/genetics/condition/glucose-6-phosphate-dehydrogenase-deficiency/>
- `ml_pku` — MedlinePlus Genetics. Phenylketonuria. <https://medlineplus.gov/genetics/condition/phenylketonuria/>
- `issn_protein_2017` — Jäger R et al. ISSN Position Stand: protein and exercise. JISSN 2017. doi:10.1186/s12970-017-0177-8 <https://doi.org/10.1186/s12970-017-0177-8>
- `morton_2018` — Morton RW et al. Meta-analysis of protein supplementation on resistance-training gains (plateau ~1.6 g/kg/day). Br J Sports Med 2018. doi:10.1136/bjsports-2017-097608 <https://doi.org/10.1136/bjsports-2017-097608>
- `helms_2014` — Helms ER et al. Evidence-based recommendations for natural bodybuilding contest preparation. JISSN 2014. doi:10.1186/1550-2783-11-20 <https://doi.org/10.1186/1550-2783-11-20>
- `acsm_2016` — Thomas DT et al. Position of AND/DC/ACSM: Nutrition and Athletic Performance. J Acad Nutr Diet 2016. doi:10.1016/j.jand.2015.12.006 <https://doi.org/10.1016/j.jand.2015.12.006>
- `iraki_2019` — Iraki J et al. Nutrition Recommendations for Bodybuilders in the Off-Season. Sports 2019. doi:10.3390/sports7070154 <https://doi.org/10.3390/sports7070154>
- `barakat_2020` — Barakat C et al. Body Recomposition. Strength Cond J 2020. doi:10.1519/SSC.0000000000000584 <https://doi.org/10.1519/SSC.0000000000000584>
- `and_veg_2016` — Melina V et al. Position of the Academy of Nutrition and Dietetics: Vegetarian Diets. J Acad Nutr Diet 2016. doi:10.1016/j.jand.2016.09.025 <https://doi.org/10.1016/j.jand.2016.09.025>
- `flexitarian_2017` — Derbyshire EJ. Flexitarian Diets and Health: A Review. Front Nutr 2017. doi:10.3389/fnut.2016.00055 <https://doi.org/10.3389/fnut.2016.00055>
- `predimed_2018` — Estruch R et al. PREDIMED (republished). N Engl J Med 2018. doi:10.1056/NEJMoa1800389 <https://doi.org/10.1056/NEJMoa1800389>
- `mind_2023` — Barnes LL et al. Trial of the MIND Diet (null on cognition). N Engl J Med 2023. doi:10.1056/NEJMoa2302368 <https://doi.org/10.1056/NEJMoa2302368>
- `dii_2014` — Shivappa N et al. Dietary Inflammatory Index. Public Health Nutr 2014. doi:10.1017/S1368980013002115 <https://doi.org/10.1017/S1368980013002115>
- `harvard_antiinflam` — Harvard Health Publishing. Foods that fight inflammation. <https://www.health.harvard.edu/staying-healthy/foods-that-fight-inflammation>
- `keto_2021` — Crosby L et al. Ketogenic Diets and Chronic Disease: Weighing the Benefits Against the Risks. Front Nutr 2021. doi:10.3389/fnut.2021.702802 <https://doi.org/10.3389/fnut.2021.702802>
- `paleo_2015` — Manheimer EW et al. Paleolithic nutrition for metabolic syndrome: meta-analysis. Am J Clin Nutr 2015. doi:10.3945/ajcn.115.113613 <https://doi.org/10.3945/ajcn.115.113613>
- `if_2019` — de Cabo R, Mattson MP. Effects of Intermittent Fasting on Health, Aging, and Disease. N Engl J Med 2019. doi:10.1056/NEJMra1905136 <https://doi.org/10.1056/NEJMra1905136>
- `tre_2022` — Liu D et al. Calorie Restriction with or without Time-Restricted Eating. N Engl J Med 2022. doi:10.1056/NEJMoa2114833 <https://doi.org/10.1056/NEJMoa2114833>
- `hall_2019` — Hall KD et al. Ultra-Processed Diets Cause Excess Calorie Intake and Weight Gain (inpatient RCT). Cell Metab 2019. doi:10.1016/j.cmet.2019.05.008 <https://doi.org/10.1016/j.cmet.2019.05.008>
- `nova_2019` — Monteiro CA et al. Ultra-processed foods: what they are and how to identify them. Public Health Nutr 2019. doi:10.1017/S1368980018003762 <https://doi.org/10.1017/S1368980018003762>
- `ed_ada_2011` — Ozier AD, Henry BW. Position of the ADA: Nutrition Intervention in the Treatment of Eating Disorders. J Am Diet Assoc 2011. doi:10.1016/j.jada.2011.06.016 <https://doi.org/10.1016/j.jada.2011.06.016>
- `histamine_2020` — Comas-Basté O et al. Histamine Intolerance: The Current State of the Art. Biomolecules 2020. doi:10.3390/biom10081181 <https://doi.org/10.3390/biom10081181>
- `iddsi` — IDDSI. The IDDSI Framework (levels 0-7). <https://iddsi.org/framework>
- `regenstein_2003` — Regenstein JM, Chaudry MM, Regenstein CE. The Kosher and Halal Food Laws. Compr Rev Food Sci Food Saf 2003. doi:10.1111/j.1541-4337.2003.tb00018.x <https://doi.org/10.1111/j.1541-4337.2003.tb00018.x>
- `religious_ije_2021` — Chouraqui JP et al. Religious dietary rules and their potential nutritional and health consequences. Int J Epidemiol 2021. PMID 33207368 <https://pubmed.ncbi.nlm.nih.gov/33207368/>
- `lds_wow` — The Church of Jesus Christ of Latter-day Saints. Gospel Topics: Word of Wisdom. <https://www.churchofjesuschrist.org/study/manual/gospel-topics/word-of-wisdom>
- `lds_caffeine_2012` — Deseret News 2012-09-07. Caffeine and controversy (Church statement that D&C 89 does not mention caffeine). <https://www.deseret.com/2012/9/7/20506366/caffeine-and-controversy/>
- `sda_belief22` — Seventh-day Adventist Church. Fundamental Belief 22: Christian Behavior. <https://www.adventist.org/christian-behavior/>
- `idf_dar_2021` — IDF-DAR. Diabetes and Ramadan: Practical Guidelines 2021. <https://www.daralliance.org/daralliance/idf-dar-practical-guidelines-2021/>
- `usccb_lent` — USCCB. Lenten fasting and abstinence (Fasting-Lent-Info). <https://www.usccb.org/resources/Fasting-Lent-Info.pdf>
- `orthodox_2003` — Sarri KO et al. Effects of Greek Orthodox Christian Church fasting on serum lipids and obesity. BMC Public Health 2003. doi:10.1186/1471-2458-3-16 <https://doi.org/10.1186/1471-2458-3-16>
- `fda_allergen_landscape` — FDA. Current Food Allergen Landscape (precautionary 'may contain' statements are voluntary). <https://www.fda.gov/food/conversations-experts-food-topics/current-food-allergen-landscape>
- `acaai_pfas` — ACAAI. Pollen Food Allergy Syndrome (systemic reactions possible). <https://acaai.org/allergies/allergic-conditions/food/pollen-food-allergy-syndrome/>
- `fda_gf_qa` — FDA. Questions and Answers: Gluten-Free Food Labeling Final Rule. <https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/questions-and-answers-gluten-free-food-labeling-final-rule>
- `acmg_pku_2025` — Smith WE et al. PAH deficiency diagnosis and management: 2023 ACMG evidence-based guideline. Genet Med 2025. doi:10.1016/j.gim.2024.101289 <https://doi.org/10.1016/j.gim.2024.101289>
- `ada_soc_2026_preg` — ADA. 15. Management of Diabetes in Pregnancy: Standards of Care in Diabetes-2026 (>=175 g carbohydrate/day; ketogenic diets not recommended). doi:10.2337/dc26-S015 <https://doi.org/10.2337/dc26-S015>
- `ada_soc_2026_s5` — ADA. 5. Facilitating Positive Health Behaviors and Well-being: Standards of Care in Diabetes-2026. doi:10.2337/dc26-S005 <https://doi.org/10.2337/dc26-S005>
- `asmbs_life_after` — ASMBS. Life After Bariatric Surgery (staged diet: liquid, puree, soft, solid). <https://asmbs.org/patients/life-after-bariatric-surgery/>
- `fda_boniva_label` — FDA. Boniva (ibandronate) label: 60 min before food/drink/medicines, upright 60 min. <https://www.accessdata.fda.gov/drugsatfda_docs/label/2007/021455s005lbl.pdf>
- `fda_linezolid_label` — FDA. Zyvox (linezolid) label 2026: avoid large amounts of high-tyramine foods (pressor response >100 mg tyramine). <https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021130s050lbl.pdf>
- `fda_prograf_label` — FDA. Prograf (tacrolimus) label: avoid grapefruit and grapefruit juice. <https://www.accessdata.fda.gov/drugsatfda_docs/label/2021/050708s053%2C050709s045%2C210115s005lbl.pdf>
- `idf_dar_2026` — IDF-DAR. Risk calculator update 2026 (individual pre-Ramadan risk assessment). <https://idf.org/about-diabetes/resources/idf-dar-risk-calculator-update-2026/>
- `cdc_sti_2021` — CDC. Sexually Transmitted Infections Treatment Guidelines 2021 (MMWR RR-70(4)): evidence for a disulfiram-like metronidazole-alcohol reaction is lacking. <https://www.cdc.gov/mmwr/volumes/70/rr/rr7004a1.htm>
- `dga_2020` — USDA/HHS. Dietary Guidelines for Americans 2020-2025 (pregnancy +340/+452 kcal; lactation +330/+400 kcal estimates). <https://www.dietaryguidelines.gov/sites/default/files/2020-12/Dietary_Guidelines_for_Americans_2020-2025.pdf>
- `niddk_pancreatitis` — NIDDK. Eating, Diet, & Nutrition for Pancreatitis. <https://www.niddk.nih.gov/health-information/digestive-diseases/pancreatitis/eating-diet-nutrition>
- `niddk_gallstones` — NIDDK. Eating, Diet, & Nutrition for Gallstones. <https://www.niddk.nih.gov/health-information/digestive-diseases/gallstones/eating-diet-nutrition>
- `cdc_alphagal_products` — CDC. Products that may contain alpha-gal (mammalian meat, gelatin, dairy; fish gelatin is not a mammal product). <https://www.cdc.gov/alpha-gal-syndrome/data-research/products-containing-alpha-gal/index.html>
- `whole30_rules` — Whole30. Original program rules. <https://whole30.com/original-program-rules/>
- `ou_fish` — OU Kosher. Fish Q&A (fins AND removable scales required). <https://oukosher.org/blog/industrial-kosher/fish-qa/>
- `ou_primer` — OU Kosher. The Kosher Primer. <https://oukosher.org/nav-test-kosher-food-the-kosher-primer/>
- `ou_passover` — OU Kosher. Glossary of common Passover terms (chametz = five grains; kitniyot a separate custom). <https://oukosher.org/passover/articles/glossary-of-common-passover-terms/>
- `ifanca_gelatin` — IFANCA. Islamic perspective (halal gelatin sources and certification). <https://ifanca.org/app/uploads/2023/02/Islamic-Perspective-XV1.pdf>
- `haf_diet` — Hindu American Foundation. Dietary restriction accommodation examples. <https://www.hinduamerican.org/employee-accommodation-request-dietary-restrictions>
- `usccb_meat` — USCCB. On abstinence from meat (broth, gelatin and meat-derived flavourings are technically permitted). <https://www.usccb.org/es/node/50977>
- `oca_fasting` — Orthodox Church in America. Fasting and fast-free seasons of the Church. <https://www.oca.org/liturgics/outlines/fasting-fast-free-seasons-of-the-church>
- `sgpc_rehat` — SGPC. Sikh Rehat Maryada (English): prohibition of kutha meat and intoxicants. <https://www.sgpc.net/sikh-rehat-maryada-in-english/>
- `typesafe_dpa` — TypeSafe. Data Processing Addendum (sensitive-data safeguards listed as N/A). <https://typesafe.ai/legal/data-processing>
- `aha_diet_2026` — 2026 Dietary Guidance to Improve Cardiovascular Health: AHA Scientific Statement. Circulation 2026. doi:10.1161/CIR.0000000000001435 (supersedes 2021). <https://doi.org/10.1161/CIR.0000000000001435>
- `acg_eoe_2025` — ACG Clinical Guideline: Diagnosis and Management of Eosinophilic Esophagitis. Am J Gastroenterol 2025. doi:10.14309/ajg.0000000000003194 <https://doi.org/10.14309/ajg.0000000000003194>
- `dailymed_phenelzine` — DailyMed. Phenelzine sulfate tablets label (avoid aged cheeses, pickled herring, beer incl. alcohol-free, wine, liver, yeast extract, dry sausage, fava pods, yogurt; excess caffeine/chocolate; alcohol). <https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?audience=consumer&setid=b7ec6ae7-3d76-42aa-9d8a-fc3e187769b5>
- `fda_atelvia_label` — FDA. Atelvia (risedronate delayed-release) label 2026: immediately after breakfast, >=4 oz plain water, swallow whole upright, no lying down 30 min. <https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/022560s013bl.pdf>
- `cdc_preg_foods` — CDC. Food safety for pregnant women (deli-sliced cheese, deli meats, 165°F rule). <https://www.cdc.gov/food-safety/foods/pregnant-women.html>
- `aap_obesity_2023` — Hampl SE et al. AAP Clinical Practice Guideline for Children and Adolescents With Obesity. Pediatrics 2023. doi:10.1542/peds.2022-060640 <https://doi.org/10.1542/peds.2022-060640>

