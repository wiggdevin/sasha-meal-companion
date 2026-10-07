# 07 — 390 px UI sweep

**Outcome:** weak  
**Severity:** medium

## Setup

- Local `pnpm dev` against the existing readiness branch, not production.
- Existing branch test user through the development sign-in path.
- Playwright viewport: 390 × 844.
- Screens: Today, Foods / Eats, Foods / Avoids, Settings, Coach, Onboarding.

## Assertions

| Screen | Horizontal overflow | Primary/tap targets under 44 px | Console errors | Screenshot |
|---|---:|---:|---:|---|
| Today | 0 px | 0 | 10 | [today.png](screenshots/today.png) |
| Foods — Eats | 0 px | 0 | 10 | [foods-eats.png](screenshots/foods-eats.png) |
| Foods — Avoids | 0 px | 0 | 10 | [foods-avoids.png](screenshots/foods-avoids.png) |
| Settings | 0 px | 0 | 12 | [settings.png](screenshots/settings.png) |
| Coach | 0 px | 0 | 10 | [coach.png](screenshots/coach.png) |
| Onboarding | 0 px | 0 | 10 | [onboarding.png](screenshots/onboarding.png) |

All document/body/viewport widths were 390 px. Every measured primary/tap button was at least 44 × 44 px. Visual inspection found no clipping or broken layout.

## Console-error defect

Every screen generated failed-resource console errors from `pingWarm()`. It deliberately sends HEAD to five hot routes (`lib/warm-client.ts:44-51`), but the route contracts answer:

- 405: `/api/log/propose`, `/api/foods/barcode`, `/api/coach`, `/api/log/commit`
- 400: `/api/foods/search`

Settings added two 503 responses from the disabled `/api/health/daily` request. The browser treats these responses as console errors even though `pingWarm` swallows the fetch rejection in JavaScript. Therefore the required “no console errors” assertion failed on all six screens.

The branch server also reported 17 queued `food_membership` sync operations as `malformed food membership result` inside an HTTP 200 batch. Those operations came from the local test-browser state, not production, so they are not presented as a production-data failure. Repeat the UI run in a clean browser context after the branch RPC result shape is checked.

## Required fix

Make warm probes quiet and contract-compatible (for example, explicit no-op HEAD handlers that preserve authentication/data boundaries), do not request disabled health data, and check the `food_membership` RPC result shape. Re-run the same 390 px sweep from clean browser storage with a zero-console-error assertion. No application file was changed in L2.
