# Rulings — waves 3 and 4 open items (2026-09-11)

Devin delegated every open decision to the planning session ("use your best judgment, use Grok as an auditor").
Rulings below were drafted by the session, audited by Grok 4.6 (SuperGrok subscription, document-only review,
no repository access), and adjusted where Grok disagreed. Anything marked **Devin** is a setup step only he can
perform; none of those gates a build. Authority order is unchanged: architecture > spec > contracts > this file.

## Wave 3 (Phases 3 + 4)

| # | Item | Ruling | Audit |
|---|---|---|---|
| W3-1 | `FDC_API_KEY` | **RESOLVED 2026-09-11 21:15.** Devin signed up; the key is in ZS Vault as `fdc_api_key` (env name `FDC_API_KEY`), in `.env.local` of the main checkout and the J3 integration worktree, and on Vercel for production, preview and development. Smoke tested live: `GET /fdc/v1/foods/search?query=cheddar` answered 200 with 19,269 hits. `lib/catalog/fdc.ts` sends it as an `x-api-key` header, never a query parameter, so it cannot leak into a URL or an access log. The FDC Branded fallback is live. | agree |
| W3-2 | Barcode negative-cache window | **Superseded 2026-09-11 by W3-1's resolution: the shipped `NEGATIVE_CACHE_DAYS = 7` stands unchanged and no conditional is needed**, because the key is now permanently set and the 48-hour branch could never run. Original ruling, kept for the reasoning: while `FDC_API_KEY` is unset the miss TTL is 48 h, not 7 days, and the lookup ledger is cleared when the key first appears (an OFF-only miss must not stay dark for a week after FDC arrives). 7 days once both providers are live. Integration implements the two constants in `lib/server/barcode.ts`. | Grok's better ruling adopted |
| W3-3 | Capture caps | Soft 30 / hard 100 proposes per local day; the soft cap warns in the sheet. | agree |
| W3-4 | Photo grams | Stepper opens focused; `was_edited` flips only on a real edit. | agree |
| W3-5 | Label duplicates | A second scan creates a second `user_foods` row. Dedupe only if it bothers her. | agree |
| W3-6 | Nous retention | Unobtainable by the session. Gemini serves every AI path, coach included, until **Devin** has Nous's written answer in `docs/ai-data-handling.md`. Not gating. | agree |
| W3-7 | Relevance gate AC8 | **Stays OPEN** at top-1 83.6 % / top-3 100 %. The written 85/95 gate is not lowered. `NEXT_PUBLIC_CATALOG_SEARCH=1` goes on the preview now and on production after Devin's phone check, because the ranked list (top-3 100 %) is strictly better for her than the 40-food bundled list. Auto-resolve (Phase 4 grounding) stays effectively off until top-1 ≥ 85 % including `eggs` and `white rice`; those two are the follow-up synonym tweak. | Grok's better ruling adopted |
| W3-8 | Phase 4 eval | Invalid as measured (no provider key). Rerun `scripts/ai-eval.ts` with the real key at integration; no capture method in production before that. Text-only on the preview meanwhile. | agree |
| W3-9 | Media sweep | Daily on Vercel Hobby is accepted; commit already deletes media. No plan upgrade. | agree |
| W3-10 | Contract addenda | All accepted and written into the Phase 3–4 contracts: (a) `LogItemInput.confidence?: number`; (b) `StructuredArgs.maxOutputTokens?`; (c) `labelFood` documented as the label-method field on `ProposeResponse`; (d) **commit re-runs `evaluatePolicy` on every item server-side and refuses a `blocked` item** (closes the client-bypass gap; required before any production capture flag, with gluten/dairy/apple fixtures on the commit path). | agree |
| W3-11 | Integration scope | The storage bucket lock-down (select-only after the phone upload path is verified) stays in the integration PR. The food-star affordance and the "log one serving" fast path for favorited recipes move to a **follow-up PR** after integration, so wave 4 is not delayed. | Grok's better ruling adopted |
| W3-12 | Production flags | Off until Devin's phone gate. Preview: `NEXT_PUBLIC_CATALOG_SEARCH=1`, `NEXT_PUBLIC_FEATURE_SCAN=1`, `CAPTURE_METHODS=text`, `NEXT_PUBLIC_CAPTURE_METHODS=text`. Production search needs the versioned USDA import run against production first (wave-2 Stage 3) or the flag serves an empty catalog. | agree |

## Wave 4 (Phases 5–7)

| # | Item | Ruling | Audit |
|---|---|---|---|
| W4-1 | Oura app registration | **Devin** registers the OAuth app and sets `OURA_CLIENT_ID/SECRET/REDIRECT_URI` before the Phase 5 gate. Lane P builds now. | agree |
| W4-2 | Health export path | Health Auto Export gets the manual gate; the hand-built Shortcut is documented only. | agree |
| W4-3 | Proposal approver | Sasha only. | agree |
| W4-4 | Qualified day | `energyCoverage ≥ 0.95`, `kcal ≥ 1000`; `kcal_min` stays 1650. | agree |
| W4-5 | Units and tabs | Pounds on screen, kilograms stored; no Body tab (Settings row + Today chip); Coach is the fifth tab. | agree |
| W4-6 | Second pending proposal | The newer Sunday proposal auto-rejects the older pending one. | agree |
| W4-7 | Coach streaming | No. Single JSON turn; policy scores the whole answer. | agree |
| W4-8 | Medical deflection | False positives reviewed after the manual gate. **Added gate (Grok):** the injection corpus gains ≥ 10 *must-deflect* cases (flare advice, steroids, "stop mesalamine", diagnosis/treatment) that fail CI on a false negative, before the coach flag goes to production. | agree + addition |
| W4-9 | Wave 4 start | After the wave-3 integration PR is on `main`. | agree |
| W4-10 | RLS proof | Two-user denial proof on food, health, Oura and weight rows is a Phase 5 lane gate before any biometrics are written to the shared project (already in Lane P's plan; recorded here as a release gate). | Grok addition |

## Other

| # | Item | Ruling | Audit |
|---|---|---|---|
| O-1 | Magic-link mailer | Keep Supabase's built-in mailer (2 emails/hour **per project**) for development. Because the cap is per project, first logins are coordinated: nobody else requests a link in the hour Sasha signs in. **Devin** adds SMTP (Resend free tier or similar) before Sasha's onboarding; not gating any build. The sign-in code form now accepts the project's 8-digit codes (it accepted only 6). | Grok's better ruling adopted |
| O-2 | Phase 8 native shell | Deferred. Expo when needed; fud-ai's iOS app is reference only. | agree |
| O-3 | Phase 0 release B (#18) | Stays on hold until Sasha has signed in once and the backfill dry run is clean. | agree |
| O-4 | Wave-2 Supabase branch `p1-catalog` | Kept for the integration tests; deleted the moment the integration PR lands. | agree |

Audit record: `~/Inbox/notes/sasha-rulings-grok-2026-09-11.json` (Grok's raw verdicts, model `grok-4.6-build`).
