# Meal Companion design kit — "Harvest" (2026-10-03)

One rule per layer. DESIGN.md holds the tokens (and the full motion table); this file holds the
rules and the interactions that sit on top of them. Every number here is enforced where a test
can see it (`tests/design/*`); the rest is a rule to read before touching a component. Primitives
live in `components/ui`; `/design` (`app/design/DesignGallery.tsx`) shows the primitives and the
newer composite pieces listed in §12.

This file described "Motion" (a black ground, liquid-glass surfaces) until this pass. Motion was
retired 2026-10-01 for "Harvest" — an oat ground, ivory cards, a matte charcoal meal card and dock,
olive as the one action colour (DESIGN.md §Overview) — and this file had not been brought forward
since. Nothing below describes glass, a black ground, or a white primary action; where the old
text is quoted in a test comment (§1's opacity scale) the *numbers* still hold even though the
surfaces they're mixed into changed colour.

## 1. Ground and surfaces

- The ground is `.harvest-ground`: oat `#E0DCD1`, a soft lighter wash at the top, a static 3 %
  grain. Nothing else paints a background.
- Ivory cards (`.surface`, `#F6F2E9`) carry an ink hairline at 6 % and `--shadow-card`; panels are
  the section hue at 7 %; trays and wells are beige `#EAE5D9`. The meal card and the dock are matte
  charcoal with the same grain, remapped text tokens (`.matte`), and the inset bevel. Sheets are
  ivory, 32 px top-and-bottom radius, over a 45 % charcoal scrim (§8 — no bottom placement, no
  drag handle; they anchor beside what opened them). No drop shadow doubles as a glow.
- **Opacity scale** (unchanged by the Harvest move; `tests/design/scale.test.ts` enforces these
  numbers against any component, regardless of what they're mixed into). White alpha:
  5 · 8 · 12 · 20 · 40 · 70 %. Black alpha: 5 · 12 · 20 · 30 · 50 · 80 %. Element opacity: disabled
  40 %, pending 60 %; a primary button over a dark surface (`.btn-primary` on charcoal, or
  onboarding's `btn-ink`) stays readable disabled at 70 %. Nothing else fades.

## 2. Colour

Tokens and the full rationale live in DESIGN.md §Colors; this is the cross-reference so a reader
does not have to hold both files' colour sections as separately true.

- One section hue per tab (olive, slate-teal, brick, plum, stone), tinting panels, hairlines,
  headings and the coach bubble — unchanged in shape from the old rule, just olive-family now
  instead of OKLCH blue/teal/rose/violet.
- Olive is the one **action** colour: primary buttons, the dock's active lens, chosen chips, the
  user's chat bubble, the eaten tick. ~~No warm hue anywhere (no orange, coral, gold).~~ That line
  described Motion's palette and is false today: Dijon yellow, persimmon orange and a muted warm
  orange rim are all load-bearing tokens (DESIGN.md §Colors, 2026-10-01 and 2026-10-03). **The
  current rule:** warm hues are allowed, but each one carries a fixed meaning and never doubles as
  the action colour — persimmon is calories/energy, Dijon is the warning role (fat, pending,
  "needs a look"), warm orange `#D4843E` is a thin rim only (never body text), sage is the
  "verified" / source-tag colour, pomegranate red is alerts and destructive actions. Never more
  than one of the three warm/alert hues in a single control.
- Calorie figures are the one exception to "small text stays ink or cream": every number before
  "kcal" is persimmon and one weight step bolder, via `components/ui/KcalText.tsx` and the shared
  `.kcal` class (§12). Wrap any line that prints a calorie figure in it rather than hand-rolling the
  colour.
- Newer tokens worth knowing by name: `orange-warm` (the muted rim, not a text colour), `sage` /
  `sage-ink` / `sage-wash` (renamed 2026-10-03 from an earlier green so it reads as its own token,
  not "the legacy green" — used for the USDA source tag and other "verified" marks), and `field`
  (the soft off-white of a text field or an in-card tray, lighter than `beige`).
- No colour literal in a component — ESLint rejects a hex or tinted `rgb()` outside the token files.
- **Contrast (2026-10-04, DESIGN.md §Contrast):** body and small text ≥ 4.5:1, large text (≥ 24 px,
  or ≥ 18.66 px bold) and icons ≥ 3:1, on every surface the text can sit on.
  `tests/design/contrast.test.ts` computes every text role × surface pair from the token hex values
  (ivory, oat, beige, field, the washes, the olive fill, the charcoal matte, `.olive-panel`, `.well`,
  `.surface`, `.notice`, `.matte` and `.matte-reset`); `tests/design/contrast-scan.test.ts` rejects the
  class combinations known to fail. In practice: ink on every light surface (`.olive-panel` included —
  its text is ink, never `text-on-olive`); cream (`text-on-primary`, `text-on-selected`) only on the
  olive fill; never `text-on-olive` in a component (inside `.matte`, `text-charcoal` is already cream);
  gauge hues (`.macro-*`, `text-gauge-*`, `text-yellow`, `text-sage`, slate, the warm rim) for fills
  and dots only, with `.macro-ink-*` for macro figures; `text-text-faint` on ivory and field only. A new
  surface or text role joins the table in `tests/design/contrast-table.ts` before it ships.

## 3. Type

Seven steps and no others: **12** label and meta · **14** caption and buttons · **16** body and row
titles · **20** section and card titles · **28** numerals and sheet titles · **40** screen titles ·
**64** the calories dial. Weights: display 400 (Fraunces), body 400 (Plus Jakarta Sans), labels and
row titles 500, titles 500–600, eyebrows 600 uppercase tracked. Tabular numerals for every number.

## 4. Shape and space

- Radii: **12** tiles · **16** wells, fields, bubbles · **24** cards · **32** sheets and the meal card ·
  pill for every button and chip. Nothing else (`tests/design/scale.test.ts`).
- 4 px rhythm. One column at 390 px, 16 px gutters. Card gap 12 px, section gap 20 px.
- **Every card surface has 16 px padding; rows inside a card have 12 px.** Tap targets ≥ 44 px.
- **No scrollbars** (2026-10-04, owner request): `app/globals.css` hides the indicator on html, body
  and every element (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`). Scrolling by
  touch, wheel and keyboard stays; never re-enable an indicator (`scrollbar-width: thin`, a styled
  `::-webkit-scrollbar`) — `tests/design/scrollbars.test.ts` fails on one.

## 5. Buttons (`components/ui/Button`)

The button system of 2026-10-04 (DESIGN.md §Buttons holds the full rule and the outcome table).

| Variant | Use | Look |
|---|---|---|
| `primary` | the one action that completes a flow (Save, Log it, Send) | olive fill, cream label, inset bevel |
| `secondary` | the action on a card (Plan, Add a food, Connect) | faint ink tint, ink hairline 20 %, hairline drop |
| `tertiary` | the second action beside a secondary (Log what you ate, Cancel) | beige well |
| `ghost` | an inline word in a row (Undo, Edit) | text only |
| `danger` | delete, sign out, clear | red ink on a faint wash; the confirm step fills red |

Sizes `sm` 36 (44 hit) · `md` 44 · `lg` 52 (sheet and panel primaries). Rules: one primary per view; a
card shows at most two buttons side by side; labels 14 px / 500, sentence case, the verb first, never
wrapped; disabled is 40 % and keeps its size. **Outcomes live in the button** — pending dots, then the
tick and its verb ("Saved", "Logged") for 1.6 s, or one shake and "Try again" — driven by
`useButtonStatus` or `useActionFeedback`; no success toasts. Chips (`Chip`) choose one of a small set; a
chosen chip is the olive fill with cream text. No `pill-in` buttons, no inline heights, no button class
strings outside `components/ui`.

## 5a. Text fields (DESIGN.md §Text fields)

Three tiers: **lookup** (`SearchField`: paper, magnifier, clear, no send), **component AI** (the ask box:
the same paper with the AI rim and the spark, "+" attach, olive send; acts on its card), **master AI**
(the dock's charcoal bar: page-aware, opens the chat overlay). One field look for bare and wrapped
fields; text ≥ 16 px; focus is the olive caret and a warmed hairline, never a ring.

## 6. Cards and their states

- **Elevation (DESIGN.md §Elevation & Depth):** E0 inset (wells, trays, fields, a card inside a card),
  E1 every card on the ground (`Surface`, `.shell`), E2 floating (pop-ups, the chat overlay, the dock).
  A card on the ground is never flat; a shadow never sits inside a shadow.

- Pending (the default card) → **eaten** (the card settles — `opacity-70` on its surface — and the
  calorie figure's own control marks it toggled) → **logged extra** (between the two, the same
  settle without the dim). A **selected** option card is the olive-14 %-equivalent selection tint.
  A **missed** slot carries a red dot on the day strip (`--color-alert`), not a red card.
- Only the focus slot (now or next) shows the full card with both actions; every other unplanned
  slot is one row with one "Plan" action. A card with nothing in it is an `EmptyState` (icon, title,
  one line, one action), never an empty slab.
- Titles: one screen title (40 px) at the top; section titles (20 px, section hue) only when a
  screen holds more than one kind of thing; a card title (20 px) only when the card is not itself
  the section. **Never a title that repeats the screen title** ("Foods" then "My foods").
- Destructive actions on a meal card do not sit on the card's face any more: see §9 and §12's
  meal-card swipe tray.

## 6a. Selectors (`components/ui/GlassSelect`)

Use `GlassSelect` for single-choice fields. Pass the stored string `value`, `onChange(value)`,
`options: { value, label, disabled? }[]`, and an `aria-label`. Optional `id`, `name`, `disabled`,
`className`, and `aria-describedby` preserve form and help-text semantics. Choices render in a
scrollable list above the page or sheet overflow, olive hairline focus ring, the selected option in
the shared selection tint with dark text. Arrow keys, Home/End, Enter/Space, Escape, touch, and an
outside tap work without changing the option values. Disabled options cannot be chosen. (The
component's own name predates Harvest; it is not a glass surface today, just a floating list.)

## 7. Expanding (`components/ui/Disclosure`)

One shared, animated disclosure everywhere (2026-10-03): the header is a real button (title left,
an optional `aside` such as a count, the chevron right) with `aria-expanded` / `aria-controls`.
Opening, the height springs open on `SPRINGS.smooth`, then the content fades and lifts in; closing,
the content fades first, then the height folds; the chevron turns on the same spring. Only height
moves, so card corners stay crisp and nothing below jumps. Closed content stays in the page
(`hidden="until-found"`, so find-in-page opens it) unless `keepMounted={false}`. Reduced motion:
instant. Props: `title`, `aside`, `size`, `divider`, `open` / `onOpenChange`, `keepMounted`,
`bodyClassName`; `DisclosurePanel` and `DisclosureChevron` are exported for custom headers.
`card` on a screen, `row` inside a card. No custom expanders, no native `<details>`, no "▶" text.
Pickers are `GlassSelect` (spring-animated); there is no native `<select>`.

**Tags** (`components/ui/Tag.tsx`): the one small coloured label (tones neutral, sage, olive, yellow,
red; sizes sm, md). Source tags (USDA sage), Eats/Avoid, "Check kcal" (yellow), off-plan (red) and
recipe fit tags all use it; never hand-built pill markup.

**No hard-coded presentation:** font size, weight, letter spacing, colour and borders come from the
type utilities (`text-title`, `text-section`, `text-overline`, `text-body-*`, `text-caption`,
`text-tiny`) and colour tokens, never inline style objects. `tests/design/inline-style.test.ts`
fails on a new one; the only allowlisted case is the swipe tray's labels, whose colour follows
the swipe.

## 8. Sheets (`components/Sheet.tsx`)

**Retired 2026-10-03: there is no bottom sheet left, and no drag handle.** A tap opens an ivory
card right next to the thing that was tapped (`lib/dom/popover-place.ts`): centred with a gutter,
below the trigger when it fits there, above it when it fits there instead, otherwise on the
roomier side, clamped into the usable area; with no trigger (or none still connected) it centres on
the screen. The card scales out of, and back into, the trigger's own centre. It is a modal dialog
(`role="dialog"`, `aria-modal`, focus trapped inside, Escape and an outside tap close it, focus
returns to the trigger) over a scrim that locks background scroll — not the old rubber-banded
bottom drawer. `AttachedSheetHost` is the one exception: inside it, every `Sheet` renders as a panel
joined to the bottom of the card that opened it (no scrim, no scroll lock, no modal pop-up) — Today
wraps meal-card flows in it, and the recipe hub's "Build my own" editor uses it, so an action
started on a card stays on that card.

## 9. Gestures

- **Meal card:** sticky left swipe reveals Clear, then Delete, each a rounded pill standing on the
  page background, with a catch (sticky detent) at each stage and a tick on arrival
  (`lib/today/swipe-detents.ts`, `components/MealCardActions.tsx`, §12). Keyboard and screen-reader
  users reach the same two actions through a More control that only takes the visual surface on
  focus. Tap → the editor. The calorie figure is its own target and never opens the editor. Drag
  along the timeline still reschedules (a preview time appears while held).
- **Day strip:** horizontal scroll, snap per day; tap a day; the date picker on the title.
- **Water (overview dial, board tile):** tap → one step (one cup, 8 oz or 237 ml); hold ~350 ms and
  slide → a scrub bar that counts faster the farther the finger travels, writing once on release
  (`lib/today/water-scrub.ts`, `components/today/WaterTile.tsx`, §12).
- **Tip tile:** tap the tile (or its glyph) to grow it, in place, into the tip's full view; tap
  again, or the close control, to shrink it back (§12, `components/today/tips/*`). No swipe.
- **Plan composer "+":** tap grows an attach tab out of the pill's own edge, holding a camera and
  an attach button; a second tap, a chosen file, Escape, or a tap outside puts it away on the same
  spring reversed (§12, `components/plan/PlanComposer.tsx`).
- **A Foods row (`components/MyFoods.tsx`, U13 2026-10-04):** a partial left swipe brings Remove in
  over the row's right end (it overlays; nothing in the row moves for it), a full swipe removes; a
  tap on a swiped-open row closes it. Remove also shows for keyboard focus on the row's face or on
  itself. The card's Edit toggle is the tap equivalent. A tap on the favourite star never reveals
  Remove: the star toggles every time and stays where it is. Eats role cards, Other foods and Avoid
  share the row.
- No other swipes. A gesture always has a visible tap equivalent.

## 10. Motion

The full spring table, easing curves, durations and the **fluid interface rules** (identity, direction,
order, speed by size, interruptibility, gesture follow, morph limits, height, lists, feedback timing,
reduced motion) and **AI scope** live in DESIGN.md §Motion — read that copy, not a second one here, so
the two files cannot drift against each other again. Scroll ownership (one scroller per screen) is
DESIGN.md §Layout. In short: four named
springs (`smooth`, `snappy`, `bouncy`, `gentle`, `lib/design/motion.ts`) carry every state change;
nothing changes state by appearing, it grows, slides or morphs; reduced motion turns every spring
into an instant arrival. `components/today/useDayCardMotion.ts` holds the Day board's own timeline
constants (`BOARD_MORPH`) for the tip and explainer in-place grow/shrink (§12) — new springs for a
similar "grow in place" interaction belong there, not as one-off numbers in the component.

## 11. Copy

The coach's voice: short, plain, no exclamation marks. Sentence case everywhere. A button says the
verb ("Add a food", not "Add"). An empty state says what will be here and the one way to start.
A failure, an empty answer or an alert is a `Notice` (§12), never a bare line of grey or red text: the
title says what happened, the body the one next step, and a retryable failure carries the action.

## 12. Newer shared pieces (since 2026-09-22; `/design` shows the ones that render without a network
call or a device store)

- **Thinking (`components/ui/Thinking.tsx`)** — the one "the AI is working" indicator, used
  everywhere a reply, a photo read, a file or recipe link, or an applied action waits on a model.
  Three harvest-coloured orbs (olive, sage, wheat) orbit and breathe inside an SVG goo filter so
  they melt together and part, with a slow shimmer on the label; past `hintAfterMs` (6 s default) a
  second line says the wait is expected. `size="inline"` for a panel or sheet, `size="compact"` for
  a chat bubble, status chip or button. `role="status"`, `aria-live="polite"` by default — pass
  `announce={false}` inside a parent that is already the live region. Reduced motion: one calm
  pulsing dot, still words. A plain save stays plain words; do not reach for Thinking there.
- **`.kcal` / `components/ui/KcalText.tsx`** — wraps every digit run immediately before "kcal" in
  the shared persimmon colour and one weight step bolder (§2). Use `<KcalText text="…kcal…"/>` for
  any line that prints a calorie figure rather than colouring it by hand; the component is a pure
  regex split, no state.
- **Sheet as an anchored pop-up** — §8. An optional `header` replaces the visible title block (the
  close button stays, `title` still names the dialog); the Plan panel uses it.
- **Notice (`components/ui/Notice.tsx`, 2026-10-04)** — the one inline message card: a wash card
  (16 px corners, 12 px padding) with a 24 px round tone mark, a title and/or body, an optional action
  button and an optional dismiss, growing in on `SPRINGS.smooth` (instant under reduced motion). Tones:
  `info` sage wash, `attention` Dijon wash, `error` red wash, `success` sage wash with a filled tick,
  `neutral` beige. `error` is `role="alert"`, every other tone `role="status"`. Recipes live in
  `globals.css` (`.notice[data-tone]`); its text is ink in any scope. In use: the Plan panel (save
  pending, failures with "Try again", the coach's fixed no-cards lines via
  `components/plan/plan-notices.ts`, the empty answer), `PhotoResult`, `DocumentPlan` and `HubAnswer`.
  `.notice-attention` (the older "needs a look" block) predates it; new code uses `Notice`.
- **The Plan / Log panel header (`components/plan/PlanSheetHeader.tsx`, 2026-10-04)** — overline
  ("PLAN · MEAL 1", section hue, tracked caps) → a 28 px serif meal-type title from the slot's clock
  time with the time beside it → target chips (`.kcal`, `.macro-ink-protein|carbs|fat` on a white-70 %
  pill). A 12 % wash band and a 40 px glyph tile take the meal type's tint: breakfast wheat, lunch sage,
  dinner olive, snack plum (`.plan-head[data-meal]`). Same header in log mode.
- **The dock and Sasha (2026-10-04, U18–U22; DESIGN.md §Components › Dock, Chat header,
  Conversations)** — `components/dock/ChatOverlay.tsx` is the chat over a dock page (it reuses
  `components/coach/CoachConversation.tsx`, the same chat /coach shows, and `CoachFrame fill="parent"`);
  `chat-scope.ts` derives the scope every turn carries; `chat-history.ts` makes Back close it;
  `inert-outside.ts` makes everything but the overlay and the dock inert. `CoachHeader` + `SashaMark`
  are the header and its living mark on both. `WeighInField` logs through
  `components/coach/attachments/weigh-in.ts` (the coach's `applyLogWeight`/`undoLogWeight`).
  `ConversationPicker` + `conversations/*` are the chat list over `lib/coach/threads-client.ts`.
  The transcript has 16 px gutters (`Transcript`), so bubbles and cards never meet the screen edge.
- **The ask box family (`components/dock/AskShell.tsx`)** — the one composer skin, focus ring, pop-
  in control and cream-on-charcoal text that the dock's `AssistantField` and every meal-card panel's
  `PlanComposer` draw from, so they read as one surface. Exports `AskSkin`, `AskPop` (a round
  control that pops in/out on the house press spring) and `AskIconButton`.
- **`PlanComposer` and its gooey "+" tab (`components/plan/PlanComposer.tsx`,
  `components/plan/composer/*`)** — the Plan panel's ask box: an ivory pill, "+" on the left, words,
  Send. "+" grows a tab out of the pill's own top edge (one continuous material,
  `composer/ComposerShape.tsx` + `tab-shape.ts`) holding a camera button and an attach button; "+"
  turns into "×" while the tab is out. `cameraFirst` swaps in a full-width camera button above the
  box (log mode) and drops the tab's own camera option, so there's one way in, not two a thumb's
  width apart. `onDocument` swaps the attach target from the photo library to the document picker
  (a plan, recipe or menu as an image, PDF or text file). No variant has a drag handle or bottom
  placement; it is an inline composer, not a sheet.
- **`PhotoResult` (`components/plan/PhotoResult.tsx`)** and **`DocumentPlan`
  (`components/plan/DocumentPlan.tsx`)** — what the Plan panel shows after a photo or an uploaded
  file. A plate offers a portion adjuster (½× / 1× / 1½×) and "Log it"; a menu shows up to three
  dishes with an ordering tip and a one-tap log; a `SwitchLine` under either lets the same photo be
  re-read another way without a second upload. A matched meal plan previews its days and the one
  meal matched to this slot, with the foods it will place and the ones left out (never guessed),
  behind one "Use for this meal" — nothing writes until that tap. Both are pure presentational
  components (static props, no I/O); the gallery shows representative states.
- **The meal card swipe tray (`components/MealCardActions.tsx`,
  `lib/today/swipe-detents.ts`)** — §9. The tray fills exactly the room the card leaves as it
  slides: Clear first, a faint see-through olive deepening to full colour as it opens, then Delete
  the same way in red; past the second catch Delete takes the whole width and says a release
  deletes. Always a rounded pill standing on the page background, never a square block behind the
  card's corner.
- **The ingredient stepper (inside `components/SlotCardDetail.tsx`)** — a 28 px glyph button with a
  44 px hit area on each side of the amount, so the row stays one line; the step size follows the
  unit (25 g, ¼ cup, or 1 of a count food). Internal to the slot detail editor, not exported on its
  own, so it is documented here rather than shown standalone in the gallery.
- **`CatalogSearch` result rows (`components/CatalogSearch.tsx`)** — slim list rows, each with a
  small source tag on the second line (USDA sage, your own foods olive, Open Food Facts neutral —
  text only, never the USDA mark itself) and an add glyph. The results sit in a soft off-white tray
  lifted on a shadow, not a rim, so the list reads as its own card inside the ivory one. A row whose
  source and computed calories disagree by more than 10 % carries a small warning glyph. Reads from
  the catalog over the network, so the gallery does not mount it live; §2 already carries its tag
  colours.
- **Tip tile and the in-place tip (`components/today/TipTile.tsx`, `components/today/tips/*`)** — a
  tile that cycles the day's tips (app or coach-sourced) with a quote mark and a dot rail past
  `MAX_DOTS` (7) tips; tapping it grows the tile, in place, into the tip's full view on the Day
  board's own morph timeline (`useDayCardMotion.ts` `BOARD_MORPH`, shared with the explainer
  player) — no pop-up, no portal, the other board tiles stay mounted underneath, inert, and fade
  out rather than disappearing on the first frame. Closing runs the same timeline backwards.
- **`WaterTile` / `WaterLiquid` (`components/today/WaterTile.tsx`,
  `components/today/WaterLiquid.tsx`)** — §9 for the gesture. The liquid is two layered sine waves
  over a pale blue-green fill (the water gauge hue leaned toward sage), with an idle swell, a level
  that springs to each new amount and sloshes, small rising bubbles, and a surface that leans with
  the phone (device-motion permission asked on the first tap, never on load). Reduced motion: still
  and level. `WaterLiquid` alone (`level`, a `tilt` ref, `animate`) is pure SVG and safe to mount in
  the gallery without the tile's scrub bar or device-motion wiring.
- **The in-place explainer (`components/today/ExplainerPlayer.tsx`)** — the same grow-in-place
  pattern as the tip tile, predating it: a poster pin on the board grows into a player filling the
  board (a real video, or a captioned storyboard drawn in the app's own shapes), sharing
  `useDayCardMotion.ts`'s `BOARD_MORPH` timeline.
- **Foods category cards (`components/MyFoods.tsx`, `components/MyFoods.list.tsx`, U14
  2026-10-04)** — each card ends in ONE footer row under a full-width hairline: "Show all N" on the
  left half, Add on the right, split by a hairline; Add alone while nothing is hidden. "Show all N"
  opens the rest in place (§7); never a nested scroll area.
- **Settings cards (U16/U17, 2026-10-04)** — no card grows past the Body profile & units card
  (about 767 px at 375 px). Data & account is one card: export, sync (Sync now confirms "Synced" in
  itself) and sign out as rows split by hairlines; Sign out's second step is the danger button
  armed. Calendar reminders is the last row of the meal-times card. "Food preferences" (two links
  back to Foods), "Working around a job" (it repeated "Shift the whole day") and the duplicate
  "Redo setup" link are gone: the profile card's Edit profile opens the same onboarding flow.
- **The recipe hub (`components/recipes-hub/*`)** — `RecipeHub` is what the Foods page's "New
  recipe" button opens, in place below the Recipes header (no bottom sheet, and since U15 no morph
  out of the button: the button stays put, shows it is open, and closes the hub; the hub grows and
  folds on the gentle spring, `Fold` + `AutoHeight`): quick chips, `RecipeCarousel` (a swipeable
  catalog of ivory cards, each with calories in `.kcal` and a "Fits today" sage tag or an
  over-target Dijon one), and an ask box built on `PlanComposer`. A tap opens `RecipeDetails` (the
  redesigned, colour-coded, skimmable recipe view: hero photo, at-a-glance chips, a per-serving
  macro strip in the four gauge colours, an ingredient checklist, numbered method steps, a muted
  provenance footer) in place under the row, and `PutInMeal` grows a day-and-slot picker, also in
  place, so "Put it in a meal" never leaves the card. `HubAnswer` renders the ask box's results —
  catalog matches, the coach's composed meals, a log confirmation, or a photo result reusing
  `PhotoResult`. All of it reads from the local plan/catalog or the network, so the gallery does not
  mount these live; this entry is the authoritative description until it does.
- **Settings › Water (`components/settings/WaterSection.tsx`)** — the unit every water readout uses
  (oz / cup / ml) and the daily goal, auto from body weight or the account's own per-day-type goal;
  already in `tests/cards/manifest.ts`, unaffected by this pass's gallery additions.
- **Unread weekly review (`components/ui/UnreadDot.tsx`, `components/coach/unread-threads.ts`,
  2026-10-05)** — an 8 px Dijon dot (the "needs a look" role: yellow ink on ivory, yellow inside
  `.matte`) that grows in and out on snappy, instant under reduced motion; always `aria-hidden`, the
  control says it in words. It marks the dock's bubble and Chat tile ("Ask Sasha, new weekly review"),
  /coach's Conversations button, and the review's own row in Conversations ("New" for assistive tech),
  which sits first under "Reviews" with the same swipe and "…" actions as a chat (rename, clear,
  delete; clearing or deleting drops its dot). The dock asks the cheap count
  `GET /api/coach/threads/unread` when the account opens and on each return to the foreground (at most
  once per 30 s, never hidden), and lists the threads only when it is above 0 (a 404, the coach off,
  shows nothing); lists apply in the order they were asked for. Opening the thread hides every mark at
  once, pending the transcript's read; it comes back if that read fails or the server says its clear
  did not hold (`cleared: false`). The review opens under its own heading and takes replies like any
  chat, and reloads when a new review lands in it; any other chat shows "Your weekly review is ready."
  ("Read it" moves focus to the review's heading).

## 13. Nutrition (`components/nutrition/`, gallery `/design/nutrition`)

One system for every calorie and macro on screen (owner, 2026-10-04; two adversarial Kimi K3 review
rounds). `components/nutrition/spec.ts` is the only place a nutrient is named and coloured; every form
below reads it.

- **Colour.** Calories persimmon, protein plum, carbs sage, fat Dijon, always. Figures use the ink
  (`.kcal`, `.macro-ink-*`); fills, arcs and dots use the gauge hue (`macro-* bg-current` or
  `stroke-current`). Over target is said in words ("10g over"), never by switching hue.
- **Text (the standard).** Calories first, then protein, carbs, fat. Figure bold in its ink with the
  unit tight ("508 kcal", "51g"), the label quiet: `PRO` / `CAR` / `FAT` in cards and rows, the word in
  detail views, always spoken in full ("51 grams protein"). Separators are a quiet " · ". No bare
  P/C/F letters, no "≈" sign: an estimate is spoken ("estimated"), not drawn. Use `MacroFigure` /
  `MacroLine`.
- **Icons.** `MacroIcon`: the orbit's food forms (apple, fried egg, wheat, avocado) in the ink; the
  droplet stays water. An icon always sits beside its figure, never alone. `DietBadge`: high protein,
  vegan, vegetarian, gluten-free, dairy-free, contains gluten, contains dairy; labelled by default
  (an icon-only badge is named for assistive tech, for tight rows only). Badges come from
  `lib/recipes-hub/diet.ts`: high protein from the macros (protein ≥ 30 % of calories), vegan and
  vegetarian from the catalog's dish tags, gluten and dairy only from ingredient evidence: "free"
  needs every ingredient's evidence absent, so missing evidence never reads as safe.
- **Graphs: one job each.** `TargetMeter` / bars: progress toward a target, the only meaning a
  nutrition bar has (a day view stacks what is eaten, lighter, under the serving). `MacroDonut`: the
  split of one serving's calories, in detail views, with values beside it; never progress. `MacroSplit`:
  the thin split bar (meal card). Vertical bars: one metric across days (week). `MacroGauge`
  (half circle): wide layouts only, never four across at phone width.
- **Recipe facets.** `RecipeFacets`: cuisine olive, time slate, servings rosewood (`[data-facet]` in
  `globals.css`), hues kept apart from the macros. On cards the `line` variant: coloured glyph, graphite
  words, "Serves 3" in words. Times past an hour read in hours (`displayMinutes`).
- **Recipe card.** Serving calories sit in the title row (`ServingKcal`); `RecipeNutrition` holds the
  three macro columns, diet badges at its head, and a "Per serving | Your day" switch that changes what
  the columns are measured against, never the layout. Without a target revision the bars show each
  macro's share of the serving's calories and the switch is absent.

## 14. Meal-card hierarchy (`lib/design/meal-type.ts`)

Owner, 2026-10-05: "titles have to be bigger than subtitles, bigger than sections, definitely bigger
than bodies … they should have design roles." The role table came from three independent proposals
(Gemini 3.1 Pro, Gemini 3.8 Flash, GPT-6 Sol) that agreed on every row below; where they split
(compact title 16 or 20), the 184 px tile decided it. Every card that shows a meal, a recipe or a
suggested plate takes its text from these roles, so a change to one role changes every card.

| Role | Purpose | Type | Hero / standard / compact |
|---|---|---|---|
| Meal title (`MEAL_TITLE`) | What the person can eat; the card's anchor and its appetite | Fraunces 500 | 28 / 20 / 16 |
| Calorie numeral | The energy at a glance | Fraunces 500, calorie ink (`ServingKcal`, the meal card's divider) | 28 / 20 / line figure |
| Section (`CARD_SECTION`) | Divides a card's detail: Ingredients, Method, Preparation | Sans 600, sentence case | 16 |
| Summary (`CARD_SUMMARY`) | What is in it, at a glance | Sans 400, muted | 14 |
| Body (`CARD_BODY`) | Instructions, ingredient names | Sans 400, ink | 14 |
| Amount (`CARD_AMOUNT`) | A column to scan | Sans 500, graphite, tabular | 14 |
| Meta (`CARD_META`) | Cuisine, time, servings, counts, provenance | Sans 400, muted | 12 |
| Eyebrow (`CARD_EYEBROW`) | Where the meal sits in the day | Sans 600, uppercase, 0.08em | 12 |
| Step (`CARD_STEP`) | A method's sequence | Sans 600, primary ink, tabular | 12 |

Densities: **hero** is Today's meal card and an opened recipe; **standard** a list, discovery or plan
card and an opened suggestion; **compact** a closed 184 px carousel tile, a logged-food row and a coach
card. A compact card shows fewer roles, never smaller ones.

Rules (`tests/design/meal-type.test.ts` holds them):

1. A meal or recipe title is Fraunces 500 at its density's size. It is never sans and never on a
   card without a name (a coach-composed plate says "Your meal").
2. On every card, title > section > summary and body > meta. The calorie numeral is a metric, not a
   title, and sits beside the title rather than above it.
3. Ingredients, Method, Preparation and the like are always the section role: never a tiny tracked
   eyebrow, never serif.
4. Nothing on a card is under 12 px, and every size is one of KIT §3's seven steps.
5. Fraunces is only for the meal's name and its calorie numeral on a card. Sections, summaries,
   meta and eyebrows are Plus Jakarta Sans.
6. Numbers are tabular. Macro figures keep their ink and their muted abbreviation (§13).
7. Colours are roles (`text-charcoal`, `text-muted`), so the charcoal meal card's `.matte` turns
   them cream.
8. **Close on a photo card.** The × sits over the photo's top-right corner, 8 px in, as
   `CloseButton onPhoto`: a 44 px target holding a 32 px nearly solid ivory disc with a faint keyline
   (`.photo-close`). It never sits in the title row.
9. **Fill the space.** A card sits on its panel, not inside a recessed tray around a carousel: an
   opened suggestion card fills the panel's width.

## 15. Liquid glass and the live widget (`app/globals.css` glass classes, `components/today/LiveWidget.tsx`)

Owner, 2026-10-05: the calendar's dark foot becomes a live widget seen "through a liquid glass", with
the readings as 3D pieces on a black floor under the glass; the Overview is rebuilt the same way, with
no icons or images. Synthesised from Gemini 3.1 Pro, Gemini 3.8 Flash and GPT-6 Sol.

- **Three layers.** `.glass-floor` (the charcoal well, inset cavity shadow) → `.glass-raised` (each
  reading: a lit top edge, a darker underside, a cast shadow; meters are `.glass-channel` with a
  `.glass-bead` fill) → `.glass-lid` (never takes a tap: a rim light, one soft reflection from the upper
  left, a thickness shadow along the bottom, and a blur confined to the rim so the middle stays sharp).
  WebKit cannot refract through an SVG backdrop filter, so the lens is drawn, never displaced.
- **On ivory**, `.glass-well` is the same glass as a pane: a translucent fill, a white upper rim, an
  inner bottom shadow and a soft reflection. The Overview's wells and the widget's edit tray use it.
- **The widget** starts collapsed (one raised strip, the current panel's headline) and, once opened,
  stays open until closed — remembered per account on the device (`lib/today/widget-prefs.ts`). A swipe
  moves one panel, open or closed, and springs back at the ends; Left/Right arrows do the same. A press
  squishes it on the snappy spring. Long-press, or Edit when open, lifts the lid and folds open the
  arrange tray: move up/down, remove (one always stays), add; a panel whose backend has not landed shows
  "Coming soon". Panels: calories left (default), calories eaten, protein/carbs/fat, water.
- **The Overview** reads top to bottom: calories eaten against the target with what is left; protein,
  carbs and fat; water with Add a cup; active burn and recovery, which say "Off" with Connect health when
  the body source is off — never an unmeasured zero.
- **Accessibility.** The widget is a labelled carousel ("Calories left, 1 of 3"); the pager dots keep
  44 px targets; nothing auto-advances. `prefers-reduced-transparency` drops the blur and reflections;
  reduced motion swaps travel for a fade. Numbers stay in ink roles (`macro-ink-*`, text roles); gauge
  hues are fills only (`bg-gauge-*`).

### 15.1 The glass well and Sprout (2026-10-06)

Owner: the glass looks liquid and slightly 3D, the bed under it sunken, the pieces in it jelly, HD and
vibrant, and a fuzzy pet lives there. Three design rounds with Kimi K3 and Gemini 3.1 Pro (art
direction) and GPT-6 Sol (code and Safari review). Gallery: `/design/well` (dev only).

- **Stack, bottom to top** (`components/today/island/Well.module.css`): the recess carved into the
  ivory card (overhang shadow, far-lip catch light, a chisel highlight outside) → the liquid
  (charcoal-olive, an olive light pool on the floor, 14 % overlay grain, two slow neutral caustics,
  transform-only) → the jelly pieces and Sprout → the lid (rim, sheen, one hot spot that drifts as the
  well opens, an edge caustic line, and a 7 px refraction band — a masked backdrop blur — that rests
  while the well changes height). One light, from the upper left, everywhere.
- **Jelly** (`Island.module.css`): the island is smoked neutral glass lifted off the bed; colour
  lives in the pieces. A bubble is a gummy drop in its panel's gauge colour; rings are tubes (a carved
  groove, the arc with one colour bloom, a gloss line drawn with it); the active dot is a pearl; Add a
  cup is slate jelly (the primary), Edit is smoked glass (the secondary), both with a glint and a press
  squish. The day's mood is only a whisper in the island's rim and bloom, never a fill.
- **Goo** merges only while there is something to merge — collapsed, or mid-morph. Over a settled open
  island it cost frames and banded the glass.
- **Sprout** (`components/today/island/Sprout.tsx`, `lib/today/pet-mood.ts`, art in `public/pet`,
  sources in `docs/design/meal-card-image-sources.md`): collapsed, the whole pet stands small at the
  island's head; open, it stands in the liquid above the island with a contact shadow, a light pool and
  a wet reflection, breathes, leans toward a touch and hops on a tap or a cup (house springs). Mood:
  joyful when calories, protein and water keep pace with the hour; content; a little low only after
  14:00, never on a partly measured day or a day past its calories; asleep 21:00–06:00. A past day is
  judged whole, a future day not at all. Unknown measures are left out, never scored. The copy observes;
  it never shames and never tells anyone to eat. The care bar's colour follows its value (persimmon,
  Dijon, sage). v1 stores nothing; upgrades and streaks need a backend contract.
