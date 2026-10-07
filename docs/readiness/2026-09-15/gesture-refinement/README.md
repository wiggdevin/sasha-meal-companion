# Today gesture refinement — 2026-09-15

## Behavior

- One glass card contains the centered date strip and nutrition progress. No persistent month/arrows. Contextual month/date picker on interaction, a red center underline, day snapping and automatic selection. Quick touch flicks advance exactly seven calendar days. The heading returns to today on other dates.
- Uneaten cards are light; eaten cards charcoal with light strikethrough. Tap edits; swipe right opens the existing swap builder. Keyboard users retain a focus-visible swap action; the editor also offers Choose a different meal, saving draft notes/time/portions first.
- Long press opens a dimmed, quarter-hour timeline with smaller meal preview. Edge holding scrolls all 96 time positions. Release saves through the existing normalized plan queue; normal cards sort chronologically. Cancel leaves the saved time unchanged. Ordinary vertical touch scrolling stays native.
- Floor Day is not a rest-day alias: it replaces three meals with authored backup meals, keeping training/rest classification. Renamed Quick meals and moved into Day type; nutrition rules, targets, avoidance filtering and data fields are unchanged.
- Optional haptic pulses use `navigator.vibrate(8)` on supported devices. iPhone/Safari physical haptics are not verified or promised. Browser compatibility: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate .

## Verification

Local full suite: **2,347 passed, 264 explicitly skipped** (database-backed suites run in required CI). Lint, TypeScript and production build passed. After the calendar fix, all 22 targeted calendar/card/timeline tests passed. Independent review found one calendar inertia race; it was fixed and the exact browser reproduction passed.

EGO Chromium, isolated Supabase, synthetic account and records, 390×844 and 320×740 mobile emulation:

- Slow native touch scrub selected two days ahead automatically; fast swipe selected exactly seven days ahead; selected day centered within 0.4 CSS px.
- Back to today while a smooth scroll was moving remained on today after one second. External navigation replaces the old scrolling element to cancel compositor inertia.
- Long hold +88px previewed +30 minutes. Touch cancel did not save.
- Native held drag reached 23:45, then 00:00, with no text selection. Release/reload retained midnight and the existing note; Coffee sorted first.
- Ordinary vertical touch pan scrolled the page with no editor or timeline. Right swipe opened Build Meal 1.
- Tap editor → new note → Choose a different meal → reload preserved the draft note.
- Eaten card rendered dark with a light strike. Quick meals toggled on/off inside Day type without changing its training-day classification.
- 320px width has no horizontal page overflow and retains 44px day targets.

Screenshots are synthetic local development UI, not production or physical iPhone evidence. Native iPhone tactile feedback remains a physical-device limitation. Production login and real synthetic AI replies were verified in the preceding readiness pass; this change does not alter those paths, and final deployment smoke checks cover authenticated app/Coach access.

## Release

Pending protected-main CI and Vercel deployment verification; see the final task response for release identifiers.
