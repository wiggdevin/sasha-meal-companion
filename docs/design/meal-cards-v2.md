# Meal cards v2 and v3 (2026-10-08)

Owner ask: "go through the meal cards … understand exactly what the user needs at first glance and
then when they're going through … then upgrade the design." The design stays Harvest (DESIGN.md);
this note records what changed on the Today meal card (`components/SlotCard.tsx`) and why.

Review gallery: `/design/meal-cards` (static fixtures, every state). It opens without an account
only under `next dev` with `NEXT_PUBLIC_DESIGN_GALLERY_OPEN=1` (`app/design/gallery-access.ts`);
otherwise it is a normal signed-in page, and a production build answers 404.

## What the person needs

| Moment | Needs |
|---|---|
| First glance, scrolling Today | Which meal is now or next, and when; what it is (photo, name); its calories **and protein**; whether it is done; one obvious way to tick it off. |
| Working through a meal | The ingredients and their amounts (adjust, add, remove); swap it; say they ate something else; ask Sasha; see a rule or a target miss in context. Rare, destructive actions (clear, delete) stay behind the swipe. |

## Audit (375 × 812, before)

1. The card never showed "Now" / "Next": Today passed `focusLabel`, the card ignored it.
2. Ticking a meal off, the most frequent action, was a hidden tap on the calorie number.
3. Eaten was 70 % opacity plus a small tick: weak, and it dimmed the photo and text.
4. The time chip "2 · 12:30 PM" led with a bare slot number.
5. Compact cards showed calories but no protein, the macro the plan protects.
6. Swap had no visible control (swipe right or a screen-reader button only).
7. The plan-miss line sat outside the card on the ground; "Preparation" opened to a line that only
   said "Ask Sasha"; "Share of daily target" truncated; footer pills truncated without the inline
   editor ("Sear…", "Ate som…").
8. Empty slots said "Plan with the coach" where everything else says Sasha.

## Design input

Independent proposals from Gemini 3.1 Pro, Gemini 3.8 Flash and Kimi K3 (OpenRouter), each given
the audit, the screenshots and DESIGN.md's tokens. All three ranked the same first change: a real,
labelled eaten control. All three asked for a status word with the time, protein on every card, a
visible Swap, eaten without the dim, and the plan miss inside the card. They split on the olive
spec panel (Kimi and Gemini Pro would remove it); it is the owner's Premium Meal Card reference, so
it stays.

## Decisions

1. **Action strip.** The beige hinge becomes the card's action row on every planned card:
   `[✓ Eaten]` (olive primary, words and glyph) · `[Swap]` (secondary, when the slot can swap and is
   not eaten) · the details chevron at its end. The calorie numeral is a figure again, not a control.
   Eaten, the button reads "Eaten" with a filled tick; a tap undoes it. Its accessible name starts
   with the words on it ("Mark eaten, Meal 2" / "Eaten, Meal 2. Undo", WCAG 2.5.3 label in name),
   so it is an action button whose name says the state, not an `aria-pressed` toggle (a pressed
   toggle must keep one name; review round 1).
2. **Status chip.** The photo chip reads `Next · 12:30 PM`, `Now · 12:30 PM`, `Eaten · 8:00 AM`, or
   `Meal 3 · 6:30 PM` — a word first, never a bare number. At 370 px and below a compact later card's
   chip keeps only its time (the photo is ~110 px wide and the slot name overran the title); Now,
   Next and Eaten always show, and the chip's spoken label always names the slot.
3. **Eaten** keeps full colour and contrast; the chip and the button carry the state. The dim is gone.
4. **Protein on the compact card:** `433 kcal · 36 g protein` beside the photo (the split bar stays
   as texture under it).
5. **Featured card** drops the ornament (the spec panel keeps the hairline split); the photo is
   168 px. The next meal comes higher on the screen.
6. **Open card:** the footer's second row holds Ask Sasha and Ate something else, two pills that fit
   at 375 px; Preparation offers a real "Ask Sasha how to make it" button; "Share of daily target"
   is "Daily share".
7. **Plan miss** moves into the tray under the rule mark, as a "needs a look" line.
8. **Empty slots** say "Plan with Sasha"; the empty focus card carries the same status word.

Not in this change (noted for later): a relative time ("in 40 min"), a tappable time chip as a
visible reschedule path, and bringing the Plan, coach and swap suggestion cards onto one figure
format (inventory in this branch's PR description).

## v3 (owner round, same day, on the live v2 cards)

Owner: the cards are far too big; delete the macro bar; the action strip is too tall and unbalanced —
three equal thirds, icons not pills; add a heart; once a card is open the ingredients are what matter.

1. **Smaller.** Featured photo 132 px (was 168), title 24 px (was 28), a tighter spec panel; compact
   cards 116 px tall (was 152), photo 34 % (was 38 %), title and calories 17 px. The compact chip moves
   off the narrow photo to the top of the text column, so its status word shows at every width.
2. **No macro bar** anywhere. The featured panel keeps the gram counts; a compact card says its
   numbers through its figures (calories and protein, spoken in full).
3. **Strip:** one 44 px row of three equal icon zones — eaten | swap | details — told apart by tone
   (olive wash, the tray, ink 4 %), hairlines between, each zone its whole third as the tap target.
   Eaten: an open ring, then a solid olive zone with a filled tick, which undoes. The swap zone stays
   (empty) when the meal cannot swap, so the thirds never shift. Names unchanged.
4. **Heart** (`components/MealFavoriteHeart.tsx`): outline / filled on the photo. On saves the plate as
   a favorite meal (`favorites_meals`) and marks its foods Favored; off removes only the saved meal, so
   it never takes a food out of a plan. Hidden until the page passes `favorite` — the writer
   (`saveFavoriteMeal` / `removeFavoriteMeal` / `undoSaveFavoriteMeal`) is the backend lane's
   feat/favorite-meals-save; wiring it into Today follows that.
5. **Opened card:** the card keeps its compact header when open — thumbnail, title, calories, and P · C ·
   F inline — with no spec panel, so the ingredients sit near the top. A focus card grows back to its
   featured form once the tray has folded.
