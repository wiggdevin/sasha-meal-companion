Sasha tells each person what to eat and when, builds every meal from their own foods and rules, and lets them tick meals off. The look is **Harvest**: a good restaurant menu, not a fitness cockpit. Oat stone ground, ivory cards, one matte charcoal hero (the meal card) with true-colour food photography, one olive action colour, a soft serif voice over a clean sans. Nothing glows.

Sasha is also the name of the in-app assistant. The name stands for *Supportive Assistant for Smart Health Awareness*; spell the expansion at most once (About, onboarding). Everywhere else write **Sasha**.

## Content fundamentals

- **Voice:** a thoughtful friend who cooks. Calm, specific, warm. Never preachy, never diet culture, never clinical.
- **Person:** the app speaks to *you*. The assistant speaks as *I* only inside the coach chat.
- **Casing:** sentence case for everything, including buttons and titles. Uppercase only for `eyebrow` labels.
- **Sentences:** one idea each. Instructions 20 words or fewer, descriptions 25 or fewer (ASD-STE100). Active voice. Present tense while an action runs ("Moving…"), past tense once it is done ("Moved").
- **Buttons start with a verb and name the result:** "Log it", "Swap meal", "Save plan". Never "Submit", "OK" or "Click here".
- **Show the answer, not the sum:** "620 kcal left", not "1,800 target, 1,180 eaten".
- **Unknown is "Unknown" or "–", never 0.** No invented numbers.
- **Banned:** exclamation marks, emoji, em dashes in UI copy; seamless, unlock, elevate, effortless, journey, game-changer; cheat, guilty, bad food, earn your meal. Never tell anyone to eat.
- **One word, one meaning:** meal, food, plate, plan, target, Favored, Avoid. No synonyms for these in UI strings.

Real copy from the app, kept as the model:

> Suggestions need a connection.
> Checking against your updated food rules.
> No food rules yet.
> Reading the label…

## Visual foundations

**Colour.** Ground `oat` with a 3 % matte grain; cards `ivory`; trays `beige`; fields `field`. `olive` is the **only** action colour, always with `cream` content and the `shadow-bevel` inset. `charcoal` is reserved for the meal card and the dock; inside them text turns `cream`. Macro hues are fills, never body text: calories `persimmon`, protein `plum`, carbs `sage`, fat `dijon`, water `water`. Status pairs come as base, ink and wash (`sage-ink` on `sage-wash`, `dijon-ink` on `dijon-wash`, `brick-ink` on `brick-wash`) and always carry a word or icon. Text: `ink` → `ink-2` → `ink-muted` → `ink-faint` (ivory only).

**Type.** `display` (Fraunces, opsz and SOFT axes) for one hero numeral and titles; `sans` (Plus Jakarta Sans) for everything you read and tap. Seven sizes only: 12, 14, 16, 20, 28, 40, 64. Macro figures in the sans use `font-variant-numeric: tabular-nums`; Fraunces has no tabular figures, so a counting `display-lg` numeral needs fixed digit widths. Reading text a person must act on is 16 px; inputs are 16 px so iOS never zooms.

**Space and shape.** 4 px rhythm (`space-1`…`space-5`), 16 px screen gutter, 20 px card padding, 12 px gaps. Buttons and chips are pills (`radius-full`); cards and sheets `radius-lg`; the meal photo carries one sweeping `radius-photo` curve. Every control is at least `tap-min` (44 px).

**Depth.** Ivory cards sit on oat with `shadow-card`; the dock and the coach button float on `shadow-float`; the open meal card uses `shadow-hero`. Borders use `hairline` and are decoration only.

**Imagery.** True-colour food photography on matte charcoal stoneware, top-down at about 30°, soft window light, oat linen. No stock smiles, no gym imagery, no glossy macro shots. Unknown dishes get the app-owned olive art, never a guess.

**Motion.** Nothing appears or vanishes in a cut. Four springs only (see `MOTION.md`): `snappy` for controls, `smooth` for containers, `gentle` for big shape changes, `bouncy` for things with weight. Content fades in with `dur-base` and out with `dur-quick`, ease-out `cubic-bezier(0.16, 1, 0.3, 1)`. Reduced motion: everything simply arrives.

**Layout.** One column, 390 px phone first, one job per screen, the main action in the lower 40 % or in the dock, one scroller per page. The dock has five items.

**Focus.** A 2 px solid `olive` ring offset 2 px on ivory and oat (5.8:1 on oat); on olive and charcoal the ring is `cream`.

## Iconography

Phosphor Icons (MIT), **Regular** weight at 24 px for everything, **Fill** only for the active dock item and a chosen state. Icons take the text colour of their role (`ink` on light grounds, `cream` on olive and charcoal). Food and nutrient glyphs come from Phosphor's food set (`bowl-food`, `fork-knife`, `egg`, `avocado`, `carrot`, `grains`, `fish`, `drop`, `orange`). No emoji as icons. Flaticon and Icons8 free assets need visible attribution, so the app does not use them. The logo is never used as an icon.

## Logo

The mark is **Steam**: an olive bowl with a geometric S rising from it as steam, and a small `persimmon` diamond as the seasoning. The S is the assistant; the bowl is the meal; the diamond is the same ◆ that sits on every meal card. See `LOGO.md` for the system, sizes and misuse. Files live in `public/brand/`.

## Using this system

- Build screens from `tokens.json` names. Never paste hex values into components.
- Copy the files in `public/brand/`; never redraw the mark.
- Check every screen against the 30 rules in `RULES.md` before calling it done.
- References that shaped each pattern are listed in `REFERENCES.md`, by screen.
