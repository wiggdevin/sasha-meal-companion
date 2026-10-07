# Root live evidence (in progress)

2026-09-27/28; isolated checkout feat/foods-annotations, localhost3145, Ego taskspace7. Local synthetic account sasha-recipes-onboarding3@example.test only. No production personal-data changes.

## Browser
- Mobile390x844: minutes+effort share row; cuisine row above; search icon inside far right input. Dropdown opens, options visible; screenshot selector-mobile.png.
- Gemini actual-image review: confirmed row/icon; dropdown fully inside viewport. Raised contrast/tap-size concerns to measure. Next.js dev indicator overlaps Today only in dev screenshot, not production defect. Popup overlay is expected.
- Reproduced AddFoodSheet bean empty bug after catalog fallback: sheet discarded all built-in rows. Worker corrected; retest returns black/navy/pinto/refried/green beans with Built in labels.
- Added Black beans, cooked via Add Protein. Reload shows1protein food,232kcal/cup. Edited note to Foods annotation QA note; saved, reloaded, reopened: exact note retained. Moved to Avoid via sheet; Avoids shows1food plusnote. More account-isolation/swipe verification remains.
- Avoids rule loading fails before custom_rules migration applies; do not count this as final regression or pass. DDL remains unapplied pending audit.

## Read-only production diagnosis
Supabase project fivatgdpuenszxxnijpc; SQL transactions BEGIN READ ONLY, aggregate/public catalog rows only.
- Active catalog13694rows; descriptionbean488rows;59recipe ingredient rows lackcatalogrevision.
-29pilotFoodDBidentities all have exact-description matches.22unique,7ambiguous acrossdifferentUSDAseries.
- Sourcejoin yields29fdc_sr_legacy,4foundation,4fndds. Eachof29SRsource_ids exactlymatches originalCSV ~/Backups/usda/sr_legacy/food.csv. Stable source plusID disambiguates; nofuzzy mappingrequired.
-Only1of29mappedfoods hasanycachedfacetrows. Correctmappingalone insufficient; existingcheckedfacet lifecycle needed.
-Private working JSONs in root work/foods-production-pilot-mapping.json, foods-production-pilot-source-ids.json. Publicdataset evidence only; no credentials.

## Shopping manual persistence proof
- New list -> Save blank list with no budget/location/currency supplied succeeded. Added QA shopping apples, renamed QA shopping apples edited, marked Bought, saved note QA note retained. Reload then reopened Shopping: bought=true, name and note retained. Machine receipt shopping-manual-browser.json and screenshot shopping-manual-persisted.png.
- Manual ingredient-lock control was disabled without explanation because freeform item has no food identity. Sent fix to Shopping worker (hide or explain; not claim verified manualingredientlock). Canonicalingredientlock/replan remains toverify.

## Custom rule and diet browser pass (2026-09-27)
- On synthetic localhost3145 account onboarding3, Diet style > select Vegetarian > Review change displayed the confirmation summary; Cancel kept No diet style selected.
- Adding garlic initially failed PUT /api/constraints500, draft retained and failure toast shown. Database logs proved missing authenticated column grant for custom_rules; rule worker added narrow insert/update column grants, preserving protected review flags. Root applied local delta only.
- Browser then added garlic as Guidance only, showed Saved; Edit > Ingredient > Save rule changed it to ingredient exclusion. Direct local DB read confirmed one saved UUID rule with kind ingredient/text garlic. Conditions draft was typed but HMR reset the page before successful save; conditions persistence remains unproven.
- Local authenticated SQL owner test: own constraint row visible1/update1, another existing synthetic owner invisible0/update0; transaction rolled back. Privileged followup confirmed both target rows exist (count2). See custom-rules-owner-db-proof.txt.
- Development HMR from concurrent source edits repeatedly reloads page to Favorites. Browser scenarios requiring durable multi-step drafts are paused until source freeze; this is not treated as production product behavior.

## Recipe error reproduction after exact-identity repair
Root browser localhost3145, synthetic onboarding3, current saved custom garlic exclusion. Cuisine american, Max minutes15, Cooking effort Any, blank query: actual Search returned Lemon chicken, rice and broccoli and Salmon, quinoa and spinach plates. No repeated Cannot check restrictions/preference error. A single click expanded chicken recipe inline and exposed ingredient gram amounts/time/servings. Browser snapshot tool output proves returned cards and expanded ingredients. HMR reset results before screenshot; recipes-placement-mobile.png proves placement only, not search results. These outcomes prove the specific reported search failure is repaired locally under this account; not production deployment or all dietary combinations.

## Stable short browser window: A08/A09
- Custom garlic ingredient exclusion was visible after a full page reload. Remove garlic then full reload and Avoids reopening removed it from UI.
- Conditions field: entered synthetic QA condition, pressed Save conditions, received Saved toast. Full reload and Avoids reopening retained QA condition.
- Cleared Conditions field and pressed Enter: Saved toast appeared. Direct local DB confirmed conditions empty and custom_rules empty again; synthetic test inputs restored.
- Screenshot conditions-saved-mobile.png captured successful Save state. Physical haptic waveform was not measured; code/focused haptic tests cover browser best-effort path only.
- New A11 regression: automatic badge POST400 after source's identity upgrade; root identified nullable catalogFoodId request versus optional-number schema mismatch and sent to rules worker. Final A11 acceptance awaits repair and retest.

## Stable final-source browser pass, continued
- Owner recipe lifecycle: created `QA recipe lifecycle` with Rice cake100g/four servings; Save then full reload showed one recipe at version1. Renamed to `QA recipe lifecycle edited`, Save/reload showed version2. Favorite button changed to `Remove QA recipe lifecycle edited from favorites`. Remove recipe displayed Confirm remove; confirmation plus full reload showed Nothing saved yet. Synthetic QA owner only; original recipe/history records are soft-deleted, not destroyed.
- Final note migration applied locally after clone proof (see note-migration-local-proof.txt). Edited Black beans note to `QA final note sync`, Changes saved rendered, full reload retained text. Cleared note, saved, full reload rendered Black beans without note; DOM `notePresent:false`.
- This browser pass found a real overlapping-dialog bug: an ordinary note edit on an existing Avoid invoked new-Avoid callback and opened the impact modal behind FoodSheet. Assigned focused fix/regression to Foods worker; final retest pending.
- A11 automatic batch and individual impact requests now HTTP200 rather than earlier400. Existing ambiguous synthetic saved slots honestly show `0+ affected` and lower-bound explanation, with no invented zero-complete assertion.
- Root viewed conditions-toast-clear-mobile.png after the feedback fix: toast now clears Sasha FAB; DOM previously measured12px gap. Physical haptic remains unmeasured.
- Combined full suite run once:720passed files/22failed/67skipped,7228passed tests/46failed/962skipped. Targeted repair buckets assigned; this initial run is not a final green claim. Combined lint and tsc exit0 before repair updates.
- A01 actual confirmed change now browser-proven: selected Vegetarian, Review change, Confirm change, full reload and Avoids reopening retained Vegetarian. Reopened, deselected Vegetarian, reviewed/confirmed restored No diet style selected. Earlier cancellation proof stands.
- Final selector browser check: ArrowDown/Enter changed Any to No cooking, closed the listbox and returned focus to Cooking effort; Escape dismissed reopened menu. DOM width390 equals viewport390 (no horizontal overflow). Reset Any through real menu selection.
- Recipe final search under restored neutral diet: american/15min/Any blank dish returned Egg/spinach toast and Lemon chicken/rice/broccoli among results. Expanded chicken ingredients/method visible. Actual screenshot recipes-results-final-mobile.png captured complete ingredient list and timings; root inspected image.
- Final Avoid note modal regression retested after source fix: saved `QA modal regression`, status Changes saved. DOM dialog list was exactly `[Black beans, cooked]`; no second impact dialog. Cleared QA note and saved, then reloaded. New-Avoid impact functionality remains separate.
- All46 initial full-suite failures now have targeted repair receipts: coach108/108; Foods57/57; integration102+6snapshot+9docs-checker; constraints subset105(overlaps coach). No second full-suite run. Final build pending.
- A15 real browser now generated and accepted a7day shop (2026-09-27–10-03) on synthetic onboarding3: four canonical ingredients for Banana yogurt overnight oats, seven dated meal uses, unknown prices/packages explicitly shown. Full reload and Shopping reopen retained generated rows; DOM confirmed existing manual bought flag=true and manual note retained=true. This closes generated-browser/error reproduction gap; separate localDB proof covers replan/pin preservation and isolation.
- Production build completed exit0 with124 dietary profiles validated and GoogleSDK trace2.23.0 matching pin. Existing middleware deprecation warning only.
- A11 real browser manual banana impact check found12+ saved future instances (seven new dates and five existing synthetic later dates), with lower-bound explanation for unknown saved ingredients. Opened modal, selected Sep28 meal3 Remove, confirmed Remove future instance. Row disappeared and count changed12+→11+. Exact synthetic future instance only; immutable actual intake remains covered by separate consumed-history/RLS DB proof.
- A11 Remix actual acceptance proven: Sep29 meal3 Remix offered Lemon chicken/rice/broccoli, selecting opened inline portion editor retaining exact date/meal. Preview displayed1.03servings,606kcal target, ratios/estimate/macro deviation. Accepted approximate portion; old banana row disappeared and affected count11+→10+. No saved banana exclusion was asserted: unsaved impact query exclusion was honored by the offered candidate. Synthetic future plan only. Ask Sasha and inline-settings actions still await final browser checks.
- A11 Ask Sasha initially503 because isolated QA process lacked GEMINI_API_KEY. Reloaded only root3145 server with existing approved Google key mapped in process memory; no secrets persisted or printed. Actual subsequent coach POST200 targeted exact selected date:meal keys, returned honest no-verified-replacement reply and unsaved-exclusion warning; no plan changed. This proves live request/context/error/safety path, not useful suggested options. Root investigating whether deterministic verified Remix candidates should ground this reply.
- Inline Edit food settings here exposes diet, rules, custom rules and Conditions inside the existing affected modal, no route navigation. Earlier failed Ask error was outside modal; assigned small in-modal status fix and direction-aware touch guard to rules owner.
- First Jev broad20k-token evidence-packet review returned NO all15. Preserved raw jev-acceptance-review.json; no acceptance claim made. Root must reconcile stale/contradictory report status and inspect criterion-specific evidence before new verdict, not reinterpret this as approval.

- A01/A06 final integration: confirmed Vegetarian through editor; typed chicken in Recipes and pressed Enter; no complete matching recipe, conflict-with-rules message. Removed Vegetarian through confirmation, same chicken/Enter search returned Chicken chickpea salad and Lemon chicken/rice/broccoli. Diet therefore changes actual recommendation results, not only displayed settings.
- A11 final grounded Ask path: real coach200 now replied with Lemon chicken/rice/broccoli and Salmon/quinoa/spinach without banana. Modal showed verified options per exact selected date:meal key, each Review opens existing portion/accept flow; unverified prose remains separately labelled. This supersedes the earlier unhelpful Ask result.
- A04 browser-generated touch swipe: enabled touch emulation only on QA page, dispatched90px horizontal swipe over measured Black beans row, revealed Remove class without opening a dialog; waited for opacity1 then clicked explicit Remove. This is Chromium touch-input proof, not physical-device hardware proof.
