# Liquid Day card and motion — three-way design rulings (2026-10-01)

Devin (2026-10-01): "go through with Google Gemini 3.1 Pro and yourself again and also Jev to make some
extra design upgrades and decisions … as premium as possible, think iPhone 18 Pro Max … everything should
look like it's moving smoothly into its next form", and: combine the calendar card and the orb's second
card into one card that can be a calendar, a quick view, and a bulletin board for tips, actionable tasks,
analytics and explainer videos; optimise for mobile with Apple HIG and Material 3 spacing.

Process: Claude wrote a brief with screenshots of the branch at 440 × 956 (iPhone Pro Max class) and its
own proposal. Gemini 3.1 Pro (High, via `agy`, plan mode, read-only) critiqued it and proposed its own.
Jev (TypeSafe System One, `jev-1.13.0`) judged every point where they differed, with no user data in the
payload. Branch `feat/nutrition-look`; Devin can reverse any row.

| Decision | Claude | Gemini | Jev (probability) | Ruling |
|---|---|---|---|---|
| Moving between faces | Header segments, orb shortcut | Swipe the card, pagination pill | Segments 55 %, morphing pill 41 %, swipe 3 % | A header pill like the dock: glyph segments, the chosen one opens into a labelled olive lens. No swipe: the week strip owns horizontal gestures |
| Board layout | Snap carousel | Bento grid | Bento 82 % | Bento, everything in view |
| Opening the overview | Rings fly out to become entities, orb glides | Shared layout ids for orb and rings | Shared identity 60 % | Rings become their entities and fly home on close; the orb rises to the centre |
| Selected day | Red compass tick | Olive circle behind the date | Olive lens 95 % | Olive capsule fixed at the strip's centre; days slide under it; today in red outside it |
| Meal card expand | Container transform | Container transform | Container transform 99 % | In place, photo grows from the thumbnail into the hero without stretching |
| Board tips | App tips | "Eating protein first flattens glucose spikes" | App tips plus a nutritionist slot 95 % | App usage tips now; `source: "coach"` tips lead once the nutritionist writes them. No nutrition claims written by the app |
| Header while on Overview or Board | Viewed date | Face name | Viewed date 78 % | The viewed date ("Today", "Yesterday", or the weekday) |
| Explainer video pin | Grow inside the card | Fill the board via View Transitions | Grow in card 81 % | Grows into a player filling the board (shared layout id); real videos via `src`, a captioned storyboard until then |
| Sticky shrinking card on scroll | — | Proposed | Yes 27 % | Not built |
| Orbit track | — | Soft continuous line | Soft line 65 % | One continuous 1 px track; the dotted ring is gone |
| Macro ring wash | — | 10 % tint | Yes 54 % | 10 % wash of each macro's colour |
| First board pin | — | Next meal | Next meal 83 % | Next meal with one "mark eaten" action |
| Face when Today opens | — | — | Calendar always 70 % | Calendar |

Adopted from Gemini's list of fixes: the month grid's weekday names once (each cell keeps its name for
screen readers); drag-to-dismiss spring sheets; haptic on a face change (`selectionHaptic`); a page
entrance between tabs (built as `app/template.tsx`, not the View Transitions API, so the dock and fixed
sheets stay untouched). Not adopted: a WebGL noise ground (cost on a phone for little gain), scroll-bound
font weight, dominant-colour skeletons.

Spacing and sizing: card corners 32 px, concentric with the device's corners 16 px away; inner tiles
16 px (32 − the 16 px inset); 12 px gaps; every control at least 44 × 44 px (the face switch's glyphs
are 36 px inside a 44 px track, with the hit area on the full height); type stays on the seven steps of
`tests/design/scale.test.ts`.
