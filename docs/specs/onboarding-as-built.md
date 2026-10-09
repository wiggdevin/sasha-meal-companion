# Onboarding, as built (2026-10-08)

Written to reconcile `docs/specs/phase-10-conversational-onboarding.md` (the 1983-line draft never
built as written) against what actually ships. Every claim below cites a file; nothing here is
invented. Where a feature is on an open PR and not yet in `main`, that is stated explicitly.

## Which flow a real account sees today

`app/onboarding/page.tsx` picks one of two screens with no third option:

```ts
if (process.env.NEXT_PUBLIC_CHAT_ONBOARDING === "1") {
  return <OnboardingErrorBoundary><ConversationalOnboarding /></OnboardingErrorBoundary>;
}
return <OnboardingFlow />;
```

**`OnboardingFlow` (`components/Onboarding/OnboardingFlow.tsx`), the existing 6-step form, is the
current production default.** `NEXT_PUBLIC_CHAT_ONBOARDING` was flipped to `1` in production on
2026-10-07 (10:41 PT) and rolled back to `0` the same evening (~22:16 PT) after an owner
walkthrough found issues; new accounts get the six-step form until the owner re-tests the onb3
rework on a preview and the flag returns to `1`. Any value other than the literal string `"1"`
falls back to `OnboardingFlow`, so a bad or missing flag never strands a new account.

If the chat shell throws during render, `OnboardingErrorBoundary` (`components/Onboarding/
OnboardingErrorBoundary.tsx`) catches it and falls back to `OnboardingFlow`, pre-filled from
whatever the chat path had already drafted.

## The chat onboarding v2 shell (`ConversationalOnboarding.tsx`), behind the flag

`components/Onboarding/ConversationalOnboarding.tsx` is one full-screen scroller with Sprout as
the only progress indicator and a morphing input dock (`components/Onboarding/dock/
OnboardingDock.tsx`) — no page transitions between beats. The beat sequence
(`type OnboardingBeat`, line ~123) is:

```
"opener" | "facts" | "minor" | "week" | "safety" | "pace" | "day" | "foods" | "reward"
```

- **opener** — goal pills (`GoalPillRow`).
- **facts** — one fact at a time (age, height, weight, sex), played back as a recap sentence
  above a real editor (`components/Onboarding/facts/FactQuestion.tsx`).
- **minor** — a stop screen if the account is under 18 (`MinorStop.tsx`).
- **week** — training/rest weekdays (`WeekBeat.tsx`).
- **safety** — allergies and conditions (`SafetyRound.tsx`), gated by `onboardingSafetyCheck`
  (`lib/coach/onboarding-safety.ts`) so a health or allergy detail typed anywhere else in the flow
  is redirected here, never read by a preference parser.
- **pace** — rate-of-change chips (`PaceBeat.tsx`), shown only when `paceBeatNeeded` applies.
- **day** — daily macro/calorie preview (`YourDayBeat.tsx`).
- **foods** — the falling food pile (`FallingFoodPile.tsx`) plus top-pick chips
  (`FoodsTopPickChips.tsx`), gated by `useOnboardingFoodAccess`/`useStarterStep`.
- **reward** — the plan preview card (`RewardPlateCard.tsx`, built from
  `lib/onboarding/plan-preview.ts`'s `onboardingPlanPreview`), then `handleComplete()` persists the
  account (`lib/profile/onboarding-client.ts`'s `persistCompletedOnboarding`) and routes to Today.

A draft of in-progress answers is saved locally (`components/Onboarding/v2/draft-store.ts`) so a
reload resumes mid-flow.

## The onb3 rework — open PRs, not yet in `main`, as of 2026-10-08

Three branches extend the chat shell above. None is merged; cite the branch, not production,
until the PR lands:

- **PR #36 `fix/onb3-inputs-foods`** ("typed age, height and weight; slower food pile with a
  pick-from-list grid"): replaces stepper inputs with one free-typed text box per fact, parsed by
  `lib/profile/height-parse.ts` ("70", "5 10", "5'10\"", "170 lb", US units only, stored metric).
  Adds a new beat, `PrefsBeat.tsx` (food practices, foods to avoid, favored cuisines), parsed by
  `lib/profile/onboarding-prefs-parse.ts`; its "Just pick from the list" link opens the shared
  `TileGrid` so a typed answer and a tile tap write the same selection. Health/allergy text typed
  here is deflected to the safety round via the same `onboardingSafetyCheck` gate, never read as a
  preference.
- **PR #39 `fix/onb3-plan-today`**: orders starter-food candidates by plate part
  (`lib/foods/starter-variety.ts`) so the plan preview shows more than meat-and-rice, and lets a
  stated cuisine rank plates in both the preview and Today (`lib/meals/cuisine.ts`,
  `lib/profile/cuisines.ts`).
- **PR #37 `feat/onb3-app-tour`**: a first-run "How Sasha works" overview
  (`components/tour/AppTour.tsx`, `TourOffer.tsx`, `TodayTour.tsx`) offered from a bubble beside
  Sprout on first open (`components/today/island/Sprout.tsx`) rather than opening automatically;
  `components/tour/tour-seen.ts` tracks whether an account has seen it.

## What is NOT built

The original `docs/specs/phase-10-conversational-onboarding.md` (1983 lines, revision 27) describes
a structurally different system: `onboarding_drafts` rows with a live `coach_threads` reference
(`kind = 'onboarding'`), build-time Playwright/Preview flags for `NEXT_PUBLIC_INVITE_SIGNUP`, and
an invite-gated signup this shell never required. None of that shipped — see the supersession note
at the top of that file. Treat this document, not the Phase 10 draft, as the behavioral reference
for what a real account experiences.
