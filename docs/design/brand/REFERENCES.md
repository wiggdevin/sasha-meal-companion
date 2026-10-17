# References

The patterns in this kit were taken from real apps, found through Mobbin and Refero and the galleries in the Claude Design Blueprint. The 102 screenshots are kept as an internal reference library only (never shipped, never published): `research/design-system-2026-10/assets/references/` in the planning archive (outside this repo). Copy mechanisms, never pixels, logos or copy.

## The twelve mechanisms Sasha adopts

1. **Floating capsule dock with five labelled tabs.** Active tab = filled capsule holding icon + label in the section hue; ~10 to 16px above the safe area; content scrolls under it, so reserve about 96px of bottom inset (Crouton, Klarna, Oura). Flat cream bar with a green filled active tab is the quiet fallback (komoot).
2. **State sentence first, number second.** One serif line that changes with state ("Getting started", "Making progress") sits above a thin arc gauge; the kcal figure is secondary (Oura).
3. **"Remaining" is the big number, with a Consumed | Remaining switch.** One ring, flanking totals, three 1-line macro bars (MacroFactor 1502 left of 2041; Yazio 1,476 remaining).
4. **Hour rail for the meal timeline.** Hour chips down the left, each row carries its own kcal/P/F/C total, and a 7-pill week strip with tiny macro bars sits above (MacroFactor).
5. **Photo carries the card's controls.** Heart plus overflow as two 28px translucent chips on the photo's top-right, time pill on the bottom-left, 2-line title and kcal below (Mindtrip, Noom).
6. **One sheet anatomy for Swap.** Handle, 28px title, one sentence stating the constraint, an editable chip row, rows with a 40 to 56px thumb, sticky Reset + Save pair, skeleton rows while loading (Flighty, Google Photos, ElevenReader).
7. **Hierarchy by tint, not shadow, and deltas in plain ink.** Pastel-tinted 32px-radius cards with no border (Loom); "Below target -835 kcal" in a soft coral, never an alarm red (Bevel).
8. **Week as seven calm rows or seven ring glyphs.** Date tile left, status line, check circle right, rest days in grey (Garmin); ring strip M T W T F S S with today as a capsule (Apple Fitness); day cards with a "+" (Crouton).
9. **Coach replies carry actions.** An inline card at bubble width (Lyft), suggestion chips under the last reply only (Agoda, Noom), a collapsed "Thought for 16 seconds" line, and the reply quotes the user's own number (Bevel).
10. **Typed numbers, not wheels.** Large numerals on hairline underlines with a unit switch (cm | ft/in), numeric keypad open, the Next pill riding directly above the keyboard, one grey "why we ask" line (Yazio, Cosmos).
11. **Square photo tiles with a top-left check.** Edge-to-edge 2-column grid, 24px outer radius, empty circle becomes a filled check, step counter "2/5", "change anytime in Settings" (SmartThings); ring-plus-check badge variant for round plates (Grab).
12. **Every state keeps the frame.** Empty, error and 404 keep the dock and header, show one 120 to 180px illustration, one headline, one sentence and one 36 to 48px pill; offline and error name what still works (Klarna, Plenty of Fish, Clue). Success is a toast, not a modal (Noom).

## By screen

### 01 Bottom nav / dock (7 images)

Folder: `01-bottom-nav/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-crouton-floating-dock-5-labelled.webp` | Crouton | [Mobbin 020218c7](https://mobbin.com/screens/020218c7-97d2-4f0e-9a71-eca91123b5c1) | 5 labelled tabs (Meal Plan, Recipes, Groceries, Discover, Settings) in one translucent capsule ~10px above the home indicator; active = grey capsule behind icon + blue label; needs ~96px bottom inset. |
| `mobbin-klarna-floating-dock-capsule.webp` | Klarna | [Mobbin f363dff4](https://mobbin.com/screens/f363dff4-92cd-424c-97c2-9bb8a0e8eb3c) | Floating dock where the active tab is an oval capsule holding icon + label; inactive tabs stack icon + 10px label; avatar photo replaces the Profile icon; content fades under the dock. |
| `mobbin-komoot-cream-bar-green-active.webp` | komoot | [Mobbin 0a24ef32](https://mobbin.com/screens/0a24ef32-c81f-45af-8ef0-783658b2735e) | Cream flat bar, 5 equal tabs: active = filled deep-green icon + green label, inactive = 24px grey outline + 10px grey label; no pill, hairline top edge. Closest to the oat/olive palette. |
| `mobbin-mesh-light-floating-pill.webp` | Mesh | [Mobbin 199f5615](https://mobbin.com/screens/199f5615-5824-4048-b57a-ae7c14653a20) | White floating pill ~280x48px, 5 line icons, no labels; active tab = darker icon + 2px teal underline dash; ~16px above the safe area, 1px soft shadow. |
| `mobbin-oura-floating-dock.webp` | Oura | [Mobbin f861b807](https://mobbin.com/screens/f861b807-74b7-4bcb-a194-853f10408071) | Translucent pill dock with 3 tabs; active tab is a lighter capsule; a separate 56px round AI button sits beside it; both float ~16px above the safe area over scrolling content. |
| `mobbin-shop-floating-pill-dock.webp` | Shop | [Mobbin 0e391631](https://mobbin.com/screens/0e391631-71a9-4259-99a5-55e8d34e16c1) | White floating pill, 4 icon-only tabs, active tab in a darker round capsule, a separate round back button at its left; ~12px above the home indicator with a soft shadow. |
| `mobbin-whatnot-filled-active-tab.webp` | Whatnot | [Mobbin d3d96f2d](https://mobbin.com/screens/d3d96f2d-2c3e-43bf-910f-9be20874841e) | Standard full-width bar, 5 tabs, 24px outline icons + 10px labels; the active tab flips to a solid filled glyph and black label, no indicator bar. State is shown by fill alone. |

### 02 Today (meal timeline + macro gauges) (8 images)

Folder: `02-today/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-lifesum-remaining-ring.webp` | Lifesum | [Mobbin ba02a832](https://mobbin.com/screens/ba02a832-1a7e-4717-8dae-e96cb104ad78) | 'Remaining' (220) is the big number inside a 270-degree arc, consumed 1480 / burned 480 flank it; 3 macro cards with 4px bars below, then meal cards with 40px thumb and + button. Drop the green gradient. |
| `mobbin-macrofactor-dashboard-toggle.webp` | MacroFactor | [Mobbin f52ef179](https://mobbin.com/screens/f52ef179-c91a-4c7d-952b-9741275c966b) | Segmented Consumed / Remaining switch under one ring (539 consumed, 1502 remaining, 2041 target) with three 1-line macro bars; pager dots below. |
| `mobbin-macrofactor-hourly-log.webp` | MacroFactor | [Mobbin f8d9a64c](https://mobbin.com/screens/f8d9a64c-81dd-46a5-9dbb-42de3013bb37) | Hour rail (7 AM, 8 AM, 9 AM...) turns the log into a timeline; each hour shows kcal/P/F/C at the right; week strip of 7 pills with 3 tiny macro bars above. |
| `mobbin-noom-log-meals-list.webp` | Noom | [Mobbin f8e308a2](https://mobbin.com/screens/f8e308a2-251f-4050-881c-75a9c83a8f97) | Serif page header, one row per meal slot with a 36px pastel round icon and a square + button at right; outlined full-width 'Finish day' pill closes the list. |
| `mobbin-oura-getting-started-arc.webp` | Oura | [Mobbin f6c46e74](https://mobbin.com/screens/f6c46e74-427e-4197-9d63-03ed1f42a114) | One serif sentence ('Getting started') under a thin dotted arc gauge on a full-bleed landscape photo; the sentence leads, the number is secondary; one 'Learn more' pill. |
| `mobbin-oura-making-progress.webp` | Oura | [Mobbin d7d2afa1](https://mobbin.com/screens/d7d2afa1-99ae-4ba4-a8a2-647a28626d6e) | Same hero at 242: arc fills white and the headline changes with state ('Making progress'); 4 round score chips across the top; a content card slides up behind the dock. |
| `mobbin-yazio-today-summary.webp` | Yazio | [Mobbin f1e30311](https://mobbin.com/screens/f1e30311-88df-4e8a-acf5-3077dae43e12) | Summary card: 'Remaining 1,476' in an open ring, Eaten/Burned flanking, 3 thin macro bars; below, meal rows with 44px round plate thumb, per-meal budget '0 / 443 Cal' and a round + at right. |
| `refero-foodnoms-diary-cards.jpg` | FoodNoms | [Refero 4fba8767](https://refero.design/screens/4fba8767-e42b-4224-905d-6177ff5285eb) | Meal-by-meal white cards each with a time label (12:45 PM), food rows with icon+value macro chips (kcal flame, carb, protein, fat as colour-coded numbers) and a floating + at bottom right on Today only |

### 03 Meal card (photo, kcal, macros, tick, swap, heart) (8 images)

Folder: `03-meal-card/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-lifesum-recipe-hero-heart.webp` | Lifesum | [Mobbin 34fafc9c](https://mobbin.com/screens/34fafc9c-a35a-4bb8-86af-02a17fb87a31) | 200px hero photo with heart on the photo's top-right; serving stepper + meal selector row; '495 kcal . 30 min' meta line; 3 macro rings (55/12/33%) in one white card; one TRACK button pinned at the bottom. |
| `mobbin-macrofactor-recipe-summary.webp` | MacroFactor | [Mobbin 7774ef8b](https://mobbin.com/screens/7774ef8b-ee7f-4ff5-b120-8655fe04a862) | 3 black pill chips (30 min prep, 20 min cook, 2 steps) under the title; 2x2 macro grid, each cell with a 4px coloured left tab and 2 small lines (per serving / total). |
| `mobbin-mindtrip-heart-on-photo.webp` | Mindtrip | [Mobbin 2e0845de](https://mobbin.com/screens/2e0845de-b080-4340-9cd1-ed9b186e3e45) | 2-column cards, 12px radius: photo = 70% of card; heart AND overflow '...' as two 28px translucent chips on the photo's top-right; heart fills red when saved. |
| `mobbin-noom-recipe-detail-actions.webp` | Noom | [Mobbin 2fbd2af1](https://mobbin.com/screens/2fbd2af1-99ae-4ba4-a8a2-647a28626d6e) | 200px photo, serif title, one meta line (30 minutes . 2,228 calories . 4 servings), then two equal pills side by side: Save (bookmark) and Log this recipe (+). |
| `mobbin-noom-recipes-photo-grid.webp` | Noom | [Mobbin 7057e0c2](https://mobbin.com/screens/7057e0c2-5e3b-4aec-ac7b-d7efab6c604b) | 2-column cards: ~130px photo, dark time pill ('45 minutes') on the photo's bottom-left, white bookmark chip on its top-right; title (2 lines) + '353 cal' below. |
| `mobbin-yazio-meal-photo-detail.webp` | Yazio | [Mobbin ff17dc7c](https://mobbin.com/screens/ff17dc7c-93f1-407d-a37e-a807db560e0c) | Full-bleed plate photo (top ~45% of screen), then a Nutrition Facts card of 4 rows (Calories 0/443, Carbs 0/54g, Protein 0/22g, Fat 0/14g) each with a thin progress line; floating full-width 'Track now' pill. |
| `refero-blueapron-photo-meal-list.jpg` | Blue Apron | [Refero 03f85757](https://refero.design/screens/03f85757-f8d7-405f-9dfa-2ac88bd066e9) | Full-width plate photo as the card (about 220px tall), meal name white bold bottom-left over a dark gradient, one-line ingredients beneath; photography carries the card, no chrome |
| `refero-foodvisor-food-detail-sheet.jpg` | Foodvisor | [Refero c835c478-80a4-4c5f-950a-0bc719fe7e39](https://refero.design/screens/c835c478-80a4-4c5f-950a-0bc719fe7e39) | Blurred full-bleed dish photo behind a white sheet that overlaps it by ~24px (same radius as cards); dish name in white 28px bold on the photo; 40px round back + favourite buttons in the photo's corners; serving dropdown + Nutrition/Customize tabs inside the sheet. |

### 04 Plan / Swap sheet with chips (7 images)

Folder: `04-plan-swap-sheet/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-elevenlabs-option-rows-selected.webp` | ElevenLabs | [Mobbin 0bda0d41](https://mobbin.com/screens/0bda0d41-4b2c-451e-8423-e4b77a8a0e99) | Chosen row gets a 1.5px dark outline + 14px radius instead of a tick; each row = 40px icon, bold name, 2-line grey description, trailing value; chip row above, floating search pill below. |
| `mobbin-elevenreader-sheet-reset-save.webp` | ElevenReader | [Mobbin 419a6c67](https://mobbin.com/screens/419a6c67-c028-4cf0-9292-aa4408ead21b) | Drag handle + title + round close X; pill chip row (All, Focus, Sleep...); rows with 48px round thumb and trailing check; sticky pair Reset (grey) + Save (black), 50% width each. |
| `mobbin-givingli-warm-sheet-chips.webp` | Givingli | [Mobbin 296ca4de](https://mobbin.com/screens/296ca4de-4414-48b8-a5eb-5e76ad54df74) | Warm sheet: 44px pill search field, then chips (selected = dark fill, others outline), then content under tinted serif section heads; sheet stops at ~90% so the page behind stays visible. |
| `mobbin-googlephotos-chip-row-sheet.webp` | Google Photos | [Mobbin 69c0042b](https://mobbin.com/screens/69c0042b-e94d-4687-b6f5-ee1aebc4325f) | ~28px top radius; one scroll row of filter chips directly under the sheet top (selected = tinted fill + check); 7 rows with 40px square thumb, title and a 'artist . genre . 03:24' meta line. |
| `mobbin-noom-meal-slot-chips.webp` | Noom | [Mobbin f5f057c4](https://mobbin.com/screens/f5f057c4-65ea-454e-9f3a-bb22ad6926af) | Bottom sheet listing each meal slot with two soft cream pill chips (Before / After); an extra 'More options' row of pills; ~28px sheet radius, close X top-right. |
| `mobbin-yazio-kcal-split-by-meal.webp` | Yazio | [Mobbin fc8a8108](https://mobbin.com/screens/fc8a8108-66e6-4afd-afab-49ab5cde5e6a) | Meal budget as 4 plain rows (Breakfast 442 Cal 30%, Lunch 590 Cal 40%, Dinner 368 Cal 25%, Snacks 74 Cal 5%) with chevrons, summing to 100% in the accent colour. |
| `refero-flighty-alternatives-sheet.jpg` | Flighty | [Refero 37ab8898](https://refero.design/screens/37ab8898-e14c-4687-8f6d-31b19ab2c587) | Alternatives sheet anatomy: 28px bold title, one grey sentence saying what a tap does ('Tap to add to My Flights'), 3 light-grey pill chips (origin, destination, date) that edit the constraint, then rows; rows load as 3 grey skeleton lines with a 36px circle, so the sheet height never jumps; top radius ~24px over a dimmed map |

### 05 Week + insights bento (8 images)

Folder: `05-week-insights/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-applefitness-day-ring-strip.webp` | Apple Fitness | [Mobbin efde5767](https://mobbin.com/screens/efde5767-3eb5-492d-b6a1-427e93f0dfc9) | Week header = 7 small ring glyphs under M T W T F S S; today = filled capsule on the letter; past days show full / partial arc / empty ring; a paused day is a grey ring with a one-line reason. |
| `mobbin-bevel-calorie-bars-target-line.webp` | Bevel | [Mobbin e6864af0](https://mobbin.com/screens/e6864af0-fb6d-4ce5-bc0d-04fe84179d48) | Headline '1,057 kcal' with a coral 'Below target -835 kcal' delta (no red alarm); segmented Calories / Fat / Carbs / Protein; 4 bars with a dashed target line labelled 1,892 kcal; date-range pill with prev/next. |
| `mobbin-bevel-nutritional-goals-bento.webp` | Bevel | [Mobbin f453c0f6](https://mobbin.com/screens/f453c0f6-c28e-476b-bee7-3f0c34a1bab1) | 3 macro half-rings in one card (58g left Fat, 189g Carbs, 142g Protein) with dividers; then 2-column small cards (Added Sugars, Fiber), each = name + chevron, 6px bar, '20g left' and '0%'. |
| `mobbin-garmin-week-list-rest-days.webp` | Garmin Connect | [Mobbin 6b9b2400](https://mobbin.com/screens/6b9b2400-174d-42f9-ba44-eebd8ea64f22) | Week as 7 plain rows: 44px date tile left (today filled blue), title + status line ('Completed', 'Next Workout'), check circle at right; 'Rest Day' rows in grey with no chevron; header 'Week 1 of 20' with arrows. |
| `mobbin-macrofactor-coached-week.webp` | MacroFactor | [Mobbin f58205d2](https://mobbin.com/screens/f58205d2-7b7e-4e89-a09a-6d9178a403ce) | Week as 7 stacked columns (kcal chip 2041, then 137 P, 68 F, 219 C) with M T W T F S S under; 'New Program' / 'Edit Program' as two small grey pills. |
| `mobbin-yazio-history-bars.webp` | Yazio | [Mobbin e8d35093](https://mobbin.com/screens/e8d35093-519a-4574-be8d-99d3a0a94074) | 14-day bar chart (axis 0/500, date ticks every 7 days) over a History list: date left, kcal right in the same orange as the bars; one colour ties chart and numbers. |
| `mobbin-zero-trends-segmented.webp` | Zero | [Mobbin eb901262](https://mobbin.com/screens/eb901262-f3c3-4ea2-825d-1b4a0d57ca61) | Week / Month / Year segmented control (selected = white pill on grey track); each chart in its own white card with bold title and small-caps 'SEE MORE' link in the card header. |
| `refero-crouton-week-day-cards.jpg` | Crouton | [Refero 9f1f52d3](https://refero.design/screens/9f1f52d3-d1e6-4eb9-b141-d4ec68f35b55) | Week as a vertical stack of rounded day cards: weekday bold left, date grey (Jun 24) beside it, two 32px round buttons at the right of the header, meal rows with thumbs inside |

### 06 Coach chat with inline cards (7 images)

Folder: `06-coach-chat/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-agoda-chips-above-composer.webp` | Agoda | [Mobbin 70bedca1](https://mobbin.com/screens/70bedca1-6d20-4d84-83ad-10b41b0101bc) | 3 stacked suggestion chips with leading icon + trailing chevron sit directly above the composer; the composer pre-fills the first suggestion as placeholder; a 1-line AI disclaimer sits above the first bubble. |
| `mobbin-alan-health-companion.webp` | Alan | [Mobbin bb35ae60](https://mobbin.com/screens/bb35ae60-cfb8-4bf4-b323-4b08aaf8e57d) | Soft lavender ground; assistant text as white 16px-radius blocks; an inline illustrated info card (title + 2 lines + 80px image) inside the thread; user replies pre-written as right-aligned chips ('I'd like to eat better'). |
| `mobbin-bevel-ai-thought-bubble.webp` | Bevel | [Mobbin fc6d4510](https://mobbin.com/screens/fc6d4510-4d40-424b-9ee4-52b4f0e0e1a5) | Chat opens over a blurred copy of the previous screen; collapsed 'Thought for 16 seconds.' chip above the reply; the answer quotes the user's own number; glass composer with a + at left. |
| `mobbin-lyft-inline-card-in-chat.webp` | Lyft | [Mobbin 11ac09ba](https://mobbin.com/screens/11ac09ba-98ab-49f1-aca8-22bbc514e43f) | A data card inside the thread: tinted header with bold '$11.87, trip to Epic Burger' + meta line, then a ~90px map; same width as bubbles; 5 outlined quick-reply chips wrap under the question. |
| `mobbin-noom-chat-suggestion-chips.webp` | Noom | [Mobbin f3ebca91](https://mobbin.com/screens/f3ebca91-37ea-4846-a830-361415e89670) | Neutral grey assistant bubble, no per-message avatar; thumbs up/down pair under the last reply; 3 outlined pill chips stacked left-aligned ('More snack ideas please'); composer with a leading + square. |
| `mobbin-perplexity-reply-with-media-cards.webp` | Perplexity | [Mobbin 2b456b3e](https://mobbin.com/screens/2b456b3e-7751-49e3-a09d-ea1d293f23ec) | Answer opens with 2 horizontal media cards (160x90, 14px radius) before the text; user message = right-aligned grey bubble; 56px glass composer with mic inside and a separate round compose button. |
| `refero-foodnoms-ask-ai-card.jpg` | FoodNoms | [Refero e905e9f7-3513-4c46-8d77-7a01a30a8241](https://refero.design/screens/e905e9f7-3513-4c46-8d77-7a01a30a8241) | 'Ask AI' sheet anchored to one food: a light-grey rounded card at the top holds the food name (bold), serving (1 serving, 210g) and nutrients as context; the AI thread sits under it, so the assistant always shows what it is looking at. |

### 07 Onboarding (typed numbers, square tiles) (9 images)

Folder: `07-onboarding/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-alexa-square-dietary-tiles.webp` | Amazon Alexa | [Mobbin ba48af43](https://mobbin.com/screens/ba48af43-b54b-42f2-8ef2-b27d896f7971) | 3-column grid of ~92px square grey tiles (12px radius), each 48px icon + 12px label; 'choose all that apply' in the helper line; one full-width Save pill above the tab bar. |
| `mobbin-cosmos-typed-age-calm.webp` | Cosmos | [Mobbin fa58df24](https://mobbin.com/screens/fa58df24-f39c-42a9-95fd-ab0f1e45a44e) | Off-white ground, one 40px number with no field chrome, 14px heading + 2-line grey why-we-ask ('It won't be displayed'); black Continue pill sits on top of the numeric keypad. |
| `mobbin-grab-round-plate-cuisines.webp` | Grab | [Mobbin d094b0f6](https://mobbin.com/screens/d094b0f6-9dfc-4c64-a6f2-7a1a8f8cb106) | 4-column grid of 56px round plate photos with 12px labels; selected tile gets a green ring + 16px check badge and bold green label; Reset (tinted) + Apply (solid) pinned at the bottom. |
| `mobbin-lifesum-reassure-interstitial.webp` | Lifesum | [Mobbin eb57f731](https://mobbin.com/screens/eb57f731-5104-4718-9102-77f80c4d7a1c) | After an answer, a pastel 24px-radius card pops over the dimmed question: 'Great, we've got your starting point' + one sentence on why; no button, advances on tap. |
| `mobbin-lifesum-single-select-card-rows.webp` | Lifesum | [Mobbin fefe3fb3](https://mobbin.com/screens/fefe3fb3-610f-48eb-b4e7-af216df9ab49) | Single-select list as one white 16px-radius card with hairline-divided rows and a right-aligned empty radio; NEXT pill stays disabled until a row is chosen. |
| `mobbin-myfitnesspal-photo-tiles-diet.webp` | MyFitnessPal | [Mobbin 5ed7b34d](https://mobbin.com/screens/5ed7b34d-7d43-4f9b-8292-0ac344719389) | 2-column photo tiles ~165px wide: top 60% food photo, bottom 40% white label with bold name + 2-line grey descriptor; 3-segment progress bar under the back arrow. |
| `mobbin-recime-cream-first-recipe.webp` | Recime | [Mobbin f2bb241c](https://mobbin.com/screens/f2bb241c-473f-4e5b-a232-f169ab4ba1b6) | Cream ground, one 6px rounded progress bar; 2x2 photo cards with a grey source handle above a bold dish name; escape hatches are text only ('Google a different recipe', 'Skip'). |
| `mobbin-smartthings-ingredient-tiles-check.webp` | SmartThings | [Mobbin b8336aeb](https://mobbin.com/screens/b8336aeb-375d-4e17-98b6-a0413ce9359e) | Edge-to-edge 2x4 tile grid, 0px gaps, 24px outer radius; each tile has an empty circle top-left that becomes a white filled check when chosen; '2/5' counter; 'change anytime in Settings' line. |
| `mobbin-yazio-typed-height-unit-toggle.webp` | Yazio | [Mobbin 4db8f470](https://mobbin.com/screens/4db8f470-3e7c-432c-89f3-23ea9438d5aa) | Typed height: two 64px numerals on hairline underlines with a caret; 2-button unit switch (cm / ft/in) under them; numeric keypad open and the Next pill rides directly above it. |

### 08 Food search and barcode scan (7 images)

Folder: `08-food-search-scan/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-bevel-add-food-sheet-recents.webp` | Bevel | [Mobbin 0ce368d9](https://mobbin.com/screens/0ce368d9-daeb-4d48-81e5-9bfc823664b8) | Add-food sheet: Search / My Foods tabs, a dashed 'No items selected' tray that fills as you tick, recents grouped by date headers (Yesterday, 14 September), 28px emoji, outline + square at right. |
| `mobbin-lifesum-search-results-cards.webp` | Lifesum | [Mobbin c41f0f2b](https://mobbin.com/screens/c41f0f2b-6894-4a43-a4f0-a1854591e3cc) | Pill search (40px) with Cancel at right, 'RESULTS' small-caps label, one white card per result: name 16px, brand + verified tick + kcal on one line, serving with pencil icon, 36px round + at right. |
| `mobbin-macrofactor-search-tabs-running-total.webp` | MacroFactor | [Mobbin ebe16794](https://mobbin.com/screens/ebe16794-4bbe-494d-932a-b6d07b0c93c6) | Add-food header holds a live running total pill (430 / 2041) with a ring; tabs Scan / Search / AI / Quick Add; rows = 32px icon, name, 'kcal . P . F . C . serving' on one 12px line, round + at right. |
| `mobbin-noom-describe-voice.webp` | Noom | [Mobbin fa013b41](https://mobbin.com/screens/fa013b41-c500-41e0-9023-c036e4664fae) | One large text box with example placeholder, a 72px teal mic button centred below with 'Tap to record audio'; Done pill stays grey until there is input. |
| `mobbin-noom-search-three-ways.webp` | Noom | [Mobbin f91e550f](https://mobbin.com/screens/f91e550f-97f4-4d29-9ed8-27737fd772d2) | Search field first, then three equal ~88px tiles (Scan meal, Describe meal, Scan barcode) with icon above label; recents below as one-line rows with kcal at right. |
| `mobbin-target-scan-add-to-list.webp` | Target | [Mobbin b0437325](https://mobbin.com/screens/b0437325-ac3f-4219-8c7d-80d621f6a58e) | After a barcode hit: bottom sheet with handle + close X, 80px product image, name, one outlined full-width 'Add to list' pill; the camera keeps running behind it so a second scan needs no navigation. |
| `mobbin-yuka-scan-sheet-over-camera.webp` | Yuka | [Mobbin eee5a97d](https://mobbin.com/screens/eee5a97d-2edb-440a-b8d7-85b477b27da1) | Result as a short bottom sheet (~22% of screen) over the live camera: 56px thumb, bold name, grey brand, score dot + '18/100'; 4 white corner brackets; tab bar stays. |

### 09 Shopping list / pantry (6 images)

Folder: `09-shopping-pantry/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-alexa-list-completed-group.webp` | Amazon Alexa | [Mobbin 5bfa4fd9](https://mobbin.com/screens/5bfa4fd9-0058-4c67-ba77-36d9b7ba7edc) | Checked items move to a COMPLETED group at the bottom (filled check) and keep the 'who/when' meta; Sort and Group-by are two grey chips under the Add Item button. |
| `mobbin-centr-list-recipe-strip.webp` | Centr | [Mobbin 3b5a73a0](https://mobbin.com/screens/3b5a73a0-bb8d-4cab-b9cf-b50686d23303) | A strip of 4 round 56px recipe photos with date labels heads the list (which meals it serves); one white card per category with collapse chevron, circle checkbox, bold quantity right, inline '+ Add custom item' at each card's end. |
| `mobbin-recime-grocery-aisle-groups.webp` | Recime | [Mobbin c7692449](https://mobbin.com/screens/c7692449-3f88-4ae5-9ca6-7d33d7bdf0bc) | Cream ground, serif 'Grocery List', '27 items' + 'Aisle' sort pill; aisle headers in 12px blue small caps over rows of 28px ingredient icon, name, grey quantity, checkbox right. |
| `mobbin-reminders-collapsible-sections.webp` | Reminders | [Mobbin 18651acb](https://mobbin.com/screens/18651acb-c9e7-4579-9148-ee2737350062) | 20px bold category headers with a collapse chevron; each section ends with a dotted empty circle as the add row; an empty section renders at 30% grey; one 56px FAB bottom-right. |
| `mobbin-shopify-inventory-steppers.webp` | Shopify | [Mobbin 78129b1d](https://mobbin.com/screens/78129b1d-65a8-4e90-907f-b112f819f4f6) | Stock counts as rows with minus, a number pill and plus (44px targets); column heads 'Variant' / 'Available' in 12px grey; Cancel / Save chips in the sheet header; sort + search pill above. Use for pantry quantities. |
| `mobbin-target-list-selected-count-cta.webp` | Target | [Mobbin aec81194](https://mobbin.com/screens/aec81194-7c04-4b89-b81a-ee2f1000b343) | '3 items selected' left and 'Sort by Category' right on one line; sticky full-width pill 'Send 3 to cart' carries the live count; each item has 64px image and a Qty dropdown pill. |

### 10 Settings (6 images)

Folder: `10-settings/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-blueapron-settings-title-value.webp` | Blue Apron | [Mobbin b2e79efa](https://mobbin.com/screens/b2e79efa-b3e0-48ff-8237-00e5e5a84106) | Cream ground; each row = 12px letter-spaced small-caps title + current value on the next line ('Email, Text messages') + chevron; Delete account last, in terracotta text (no red button). |
| `mobbin-calm-reminder-time-pills.webp` | Calm | [Mobbin f8a32877](https://mobbin.com/screens/f8a32877-5740-4fe0-94d9-4742c73aae72) | Reminder time as 3 full-width outlined pills (Morning, Afternoon, Night), not a time wheel; 40px bell icon, 20px heading, 3 lines of why-text above. |
| `mobbin-clubhouse-card-groups-delete.webp` | Clubhouse | [Mobbin f33118e7](https://mobbin.com/screens/f33118e7-2249-4f57-95f3-fd9290c74f2e) | 3 cream rounded cards: key/value rows with grey values right-aligned, a toggle group, and a card holding 'delete account' alone in coral text; a green top banner confirms the last change in one sentence. |
| `mobbin-coffeemeetsbagel-units-segmented.webp` | Coffee Meets Bagel | [Mobbin 6f9c7d92](https://mobbin.com/screens/6f9c7d92-7907-431c-8e15-f0de2a3eaf0c) | Units as a 2-segment control (ft/in / m/cm) in a full-width row instead of a nav row; Log out as the one primary pill, Delete account as a text link below, version in 12px grey last. |
| `mobbin-lifesum-personal-details-rows.webp` | Lifesum | [Mobbin ec442d44](https://mobbin.com/screens/ec442d44-95e2-4d5a-a484-69dea2f7f210) | Personal Details as one white card of 5 rows: label left, current value right in grey (68.8 kg, 162.5 cm, 1995 / 2 / 18); deep-green serif banner above with one outlined CHANGE GOAL pill. |
| `mobbin-mimo-sections-reminder-time.webp` | Mimo | [Mobbin bfee415b](https://mobbin.com/screens/bfee415b-e542-45e9-bb43-01735b0074d9) | Tinted section labels on a 12px grey band; a 'Reminders' toggle row followed directly by 'Daily reminder time 10:00 AM'; Danger zone is a separate last section with one red row. |

### 11 Empty / error / success / 404 states (11 images)

Folder: `11-states/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-aboard-404-minimal.webp` | Aboard | [Mobbin 3f5f6e3a](https://mobbin.com/screens/3f5f6e3a-a213-4290-b700-4d6ee8988e92) | Smallest 404: 56px object icon, one 14px bold line, one grey line ('Could not load page'), a 28px outlined 'Back home' button, all in a 300px column. |
| `mobbin-bevel-empty-no-foods-yet.webp` | Bevel | [Mobbin eb480ea9](https://mobbin.com/screens/eb480ea9-479e-4623-994f-0fe0722e45cf) | Inline empty state inside a card list: bold 'No foods yet' + one grey sentence, no illustration, no button; the section header keeps its + at the right. |
| `mobbin-bevel-success-all-set.webp` | Bevel | [Mobbin e9385ef8](https://mobbin.com/screens/e9385ef8-9990-4afa-b7a0-6fe17ef160c9) | Success without confetti: 56px soft grey check badge, 2-line 22px message, one dark pill, 12px grey disclaimer below the button. |
| `mobbin-charma-404-web-illustrated.webp` | Charma | [Mobbin ac63be88](https://mobbin.com/screens/ac63be88-d259-4f46-8846-56301617e894) | Web error on off-white: logo-only header bar, 160px hand-drawn character, 22px headline, 2-line apology + support email, one dark rounded 'Back Home' pill; ~340px column at 1280px. |
| `mobbin-chopt-cancel-confirm-sheet.webp` | CHOPT | [Mobbin f8a25367](https://mobbin.com/screens/f8a25367-e86e-4e6c-8d56-432243f39c79) | Destructive confirm as a short bottom sheet: bold question, one consequence line, then two equal pills side by side: outlined safe one (NEVERMIND) and filled red (YES, CANCEL). |
| `mobbin-clue-error-two-text-actions.webp` | Clue | [Mobbin eb39d007](https://mobbin.com/screens/eb39d007-32c8-48ec-8ad0-8dad8609e95d) | Calm error on near-white: muted illustration, 24px semibold headline, 3-line body with a contact email and what happens to the user's data; actions are two text links ('Try again', 'Copy error information'). |
| `mobbin-headspace-404-we-all-get-lost.webp` | Headspace | [Mobbin f8e16f35](https://mobbin.com/screens/f8e16f35-df5d-4f58-bdd2-cb93ce432ada) | 404 in brand voice: logo centred, 100px illustration, headline 'We all get lost sometimes', one line saying the page does not exist and what to do, small blue 'Go back' pill (36px). |
| `mobbin-klarna-empty-dock-stays.webp` | Klarna | [Mobbin 4cb604c4](https://mobbin.com/screens/4cb604c4-292c-494c-9795-2c9d2b77f858) | Empty state inside the real screen: tabs and floating dock stay; 140px illustration, 22px bold headline, 2-line sentence, ONE compact black pill (36px high). |
| `mobbin-noom-logged-toast.webp` | Noom | [Mobbin ff3844b6](https://mobbin.com/screens/ff3844b6-268f-4ff4-9c68-854912af3da3) | Success toast: dark-green rounded bar with check ('Food was logged successfully!') pinned at the top of the sheet, no modal; the primary pill names the action; a calorie bar shows 5% of daily cals vs a 1200-1840 band. |
| `mobbin-pof-error-serif-illustration.webp` | Plenty of Fish | [Mobbin 23830a73](https://mobbin.com/screens/23830a73-4e4c-459c-a512-22bbc514e43f) | Error on a warm peach ground: 180px hand-drawn line illustration, 20px serif sentence, one full-width black 'Try again' pill 48px high; no red, no icon-in-circle. |
| `refero-flighty-no-results-sheet.jpg` | Flighty | [Refero 7b9d79dd-81a0-4183-97e6-c4cab701f43f](https://refero.design/screens/7b9d79dd-81a0-4183-97e6-c4cab701f43f) | No-results inside the same sheet: title, subtitle and the constraint chips stay; the list area becomes a short explanation of why nothing matched plus blue inline links to widen the search. The constraint chips are never lost. |

### 12 App icon and splash (9 images)

Folder: `12-app-icon-splash/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `appstore-gentler-streak-icon.jpg` | Gentler Streak | App Store id 1576857102 (iTunes Search API artwork, 1024px) | Off-white ground with one soft 3D coral bean shape, ~50% of the icon, a subtle bottom-edge gradient only on the shape; no outline, no text |
| `appstore-headspace-icon.jpg` | Headspace | App Store id 493145008 (iTunes Search API artwork, 1024px) | One flat orange circle with a closed-eye smile on a white ground, no gradient, circle = 70% of the width so the squircle mask crops nothing |
| `appstore-mela-icon.jpg` | Mela | App Store id 1548466041 (iTunes Search API artwork, 1024px) | One tonal object (a white plate) centred on a flat muted red squircle: single glyph, one hue plus white, no gradient, ~55% of the icon width |
| `appstore-oura-icon.jpg` | Oura | App Store id 1043837948 (iTunes Search API artwork, 1024px) | Charcoal near-black ground with a single cream ring + macron mark centred, ~50% width, 1 stroke weight everywhere |
| `appstore-toogoodtogo-icon.jpg` | Too Good To Go | App Store id 1060683933 (iTunes Search API artwork, 1024px) | Flat deep green (#005F5A-like) ground with a white 3-leaf line mark at 60% width and a 6px stroke; the one-colour-plus-white recipe holds from 1024px down to 40px |
| `appstore-whisk-icon.jpg` | Whisk | App Store id 6738133941 (iTunes Search API artwork, 1024px) | Tone-on-tone: ivory squircle with a single clay-brown whisk glyph at 60% width and a faint inner highlight; the glyph is the only dark value, so it reads at 29px |
| `mobbin-pof-splash-serif-peach.webp` | Plenty of Fish | [Mobbin 078461b0](https://mobbin.com/screens/078461b0-bb30-4d6e-8036-28de7202db04) | High-contrast serif wordmark in tone-on-tone peach on a peach ground, plus one hand-drawn black mark and a short dash as the loader; the drawn element is the only dark ink. |
| `mobbin-subway-splash-cream-mark.webp` | Subway | [Mobbin 7ca2f717](https://mobbin.com/screens/7ca2f717-faee-4a54-9ece-7324a04b4987) | Cream (#F8EBD8-like) launch ground with a single ~80px two-colour mark dead centre and nothing else; shows how little a warm-neutral splash needs. |
| `mobbin-toogoodtogo-splash-deep-green.webp` | Too Good To Go | [Mobbin e0b24f83](https://mobbin.com/screens/e0b24f83-2abe-40b5-9ed3-8198764c243c) | Flat deep teal-green ground with a white line mark (~90px) and a circular wordmark under it; optical centre slightly above geometric centre; no tagline, no loader. |

### 13 Marketing landing (web sections) (9 images)

Folder: `13-marketing-landing/`

| file | app | source | the one mechanism to steal |
|---|---|---|---|
| `mobbin-flighty-closing-cta-band.webp` | Flighty | [Mobbin section 5d74747e](https://mobbin.com/sites/sections/5d74747e-85d4-44fd-b176-72ca0e78b9cf) | Closing CTA: centred 36px headline, 2-line reassurance, ONE black pill, then a still-life of the devices the app runs on; no secondary link, no form. |
| `mobbin-headspace-hero-pink-two-col.webp` | Headspace | [Mobbin section 5b44d3ff](https://mobbin.com/sites/sections/5b44d3ff-891d-4add-9f5f-53b903bb1800) | Two-column hero on a pale pink band: left 40px bold headline, 2-line sub, one charcoal pill 'Try for $0'; right 2 overlapping phones; next section starts with 3 outlined link cards. |
| `mobbin-illoca-faq-warm-two-col.webp` | illoca | [Mobbin section 5ad2eb0a](https://mobbin.com/sites/sections/5ad2eb0a-5b35-4e4b-8116-264da3499b3a) | FAQ on warm tan: 3-line 56px heading left with a handwritten tag and mailto chip; right column = accordion rows divided by dotted rules with a 20px square chevron, first row open. |
| `mobbin-jeton-footer-giant-wordmark.webp` | Jeton | [Mobbin section e96309a7](https://mobbin.com/sites/sections/e96309a7-4699-4bdd-8791-9c2cde217746) | Footer where the wordmark is the graphic: a full-width ~190px-tall wordmark in the accent colour closes the page; above it 5 small link columns at 70% tint, store badges and 10px legal. |
| `mobbin-loom-tinted-feature-cards.webp` | Loom | [Mobbin section 4470dfca](https://mobbin.com/sites/sections/4470dfca-a7ae-4a96-a9b4-a33395edbd07) | Feature grid as 3x2 pastel-tinted cards (~220px tall, 32px radius), no border, no shadow: framed screenshot on top, 16px centred label; tint alone separates cards from the white page. |
| `mobbin-superpower-hero-warm-phone.webp` | Superpower | [Mobbin section a66c7229](https://mobbin.com/sites/sections/a66c7229-39c5-4f24-b34c-c09db551575d) | Blush-gradient hero: 2-line ~44px headline with line 2 in the accent colour, one centred phone (~280px) cropped by a white curve, floating pill nav with one orange CTA. |
| `mobbin-wise-three-numbered-cards.webp` | Wise | [Mobbin section 96d6e07b](https://mobbin.com/sites/sections/96d6e07b-b406-4314-b256-23ca5e0d76bc) | How-it-works on a pale grey-green band: heading, one small pill CTA, then 3 equal white cards (~180px, 24px radius) with a 40px light-grey numeral and a 2-line instruction. |
| `refero-kitchenstories-app-page-thumb.jpg` | Kitchen Stories | [Refero c52b5c4b](https://refero.design/pages/c52b5c4b-8467-4dd9-9e22-e742f2151dce) | Full app page (thumbnail only, Refero serves desktop originals to members only): saturated yellow hero with serif title, off-white content bands (#FFF9E8) alternating with yellow section headers, 4-card feature grid, alternating text/phone rows, download CTA; one warm hue plus cream carries the whole page |
| `refero-manus-editorial-serif-phones-thumb.jpg` | Manus | [Refero f29b291d](https://refero.design/pages/f29b291d-fe9f-4e8e-ab39-9eb0e0b18ed5) | Landing on warm off-white (#FBFBF4) with very large centred serif headings, 15px sans body, repeated phone mockups, rounded feature cards, dark pill CTAs and an accordion FAQ; serif headline + dark pill is the closest pairing to a Fraunces-led Sasha page (thumbnail only) |

Total: 102 images in 13 folders.



## Sources

- Motion: LottieFiles, transitions.dev, 60fps.design, Kinetics, Motion Primitives.
- Brand: brandguidelines.net, deck.gallery, logosystem.co, visualjournal.it, rebrand.gallery.
- Fonts and icons: Typewolf, Fonts In Use, WhatTheFont, Fontshare, Flaticon, Icons8, Phosphor.
- Inspiration: navbar.gallery, footer.design, cta.gallery, 404s.design, unsection.com, bentogrids.com, Savee, Mobbin, Refero.
- Rules: Steve Krug, *Don't Make Me Think*; ASD-STE100 Simplified Technical English; the Claude Design Blueprint.
