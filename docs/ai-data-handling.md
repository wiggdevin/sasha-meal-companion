# AI data handling

Verified 2026-09-13 by `pnpm ai:canary` and the Coach injection canary. Re-run before any
model or SDK change. architecture.md §6.

## Pinned

| What | Value |
|---|---|
| SDK | `@google/genai` 2.21.0 |
| Text → items | `gemini-3.8-flash` |
| Voice → items | `gemini-3.8-flash` |
| Label → nutrients | `gemini-3.8-flash` |
| Photo → items | `gemini-3.8-flash` |
| Coach | `gemini-3.6-flash` |
| Weekly review | `gemini-3.6-flash` |

## Gemini

- Structured call: passed in 29980 ms.
- Production-enablement canary, 2026-09-13: the paid the user key passed the basic structured call
  on `gemini-3.8-flash` in 19225 ms, but 3.8 then exhausted all three application retries with
  `503 high demand` on the first Coach injection case; `gemini-3.7-flash` also returned 503.
  The Coach-only pin moved to stable `gemini-3.6-flash`, which passed a 3025 ms structured probe
  and the full live injection corpus, 42/42. See `docs/coach-canary-2026-09-13.md`.
- Cost ledger, 2026-09-13: Google Standard paid-tier pricing is recorded as $0.75/M input and
  $3.75/M output for 3.8 and 3.6 through 2026-12-31. This replaces the old placeholder values so
  `AI_DAILY_SPEND_CAP_USD` does not undercount Coach or capture spend.
- Coach turn schema, live 2026-09-12: `turnStepWireSchema` (T4's flat wire form) ran through the real
  `generateStructured` against `gemini-3.8-flash` and came back as a tool step and as a final step,
  both transformed to the union inside the adapter's `safeParse` (a wire-valid, union-invalid reply
  is recorded as `schema_invalid`). A one-off probe with a local admin stub and a
  prompt carrying none of the user's data — no `ai_calls` row, no Supabase. The same probe measured two 400s
  the converter now refuses locally: `const` (Zod `.literal()`) and `exclusiveMinimum`
  (Zod `.positive()`), so no schema with those keywords reaches the provider.
- Billing: **paid tier, attested in the console 2026-09-12** — see *Attestation (2026-09-12)* below for
  the project, the billing account and the logging switches. The earlier line read "DISPUTED — treat as
  free tier until confirmed in the console", which was right to distrust the Phase 0 canary (it reported
  "paid" by inferring from the *absence* of a free-tier signal, which cannot distinguish a paid project
  from a quiet one) and the 2026-09-12 `RESOURCE_EXHAUSTED` naming quota
  `generate_content_free_tier_requests, limit: 20` on `gemini-3.8-flash` — positive evidence of the free
  tier at the time. A successful probe is still not proof of the tier, and **there is no build-time
  check** either way; the console attestation is what closed the question.
- Prompt logging and data sharing: **this canary does not check it.** There is no API for it;
  confirm it is off for this key manually in the console at https://aistudio.google.com/apikey.
- Files API: every uploaded file is deleted in a `finally` block; a daily sweep is the backstop.

## Attestation (2026-09-12)

Read from the AI Studio console by the driver on 2026-09-12 — a human reading the console, not a canary
inference, because no API exposes the billing tier or the logging switches:

| What | Value |
|---|---|
| Project | Dedicated production Gemini project — `gen-lang-client-0354187532` |
| Billing | **prepay billing account** (paid tier) |
| Log storage — GenerateContent | **OFF** |
| Log storage — Interactions | **OFF** |
| Routing | Gemini only (T4); Nous rejected (ruling 1), code removed 2026-10-01 |

This settles R4's precondition: health-context coach turns may go to **Gemini on the paid tier**, and the
switch that lets them is `HEALTH_CONTEXT_PROVIDER=gemini` together with `GEMINI_BILLING_ATTESTED=1`.

Repository default and deployed value are two different things, and the difference is load-bearing:

- **Repository:** `.env.example` ships both R4 variables **unset** (commented out, lines under `--- AI`).
  A checkout, a CI run, or any preview environment that copies that file keeps the old refusal for
  health-context turns.
- **Production configuration:** both R4 variables and both Coach flags were re-saved in Vercel
  production on 2026-09-13. They apply only to a new deployment; the first `main` deployment
  containing this record activates them together with the Coach-only 3.6 pin. Deployment status
  must be verified separately instead of inferred from this file.

## OpenRouter

Owner request 2026-10-02 (Devin: "can we use open router? wire up my api key please and that way
we can use any model we like"), prompted by Gemini returning 429 "exceeded your current quota" and
back-to-back 503s on both pinned Gemini models (2026-09-16, 2026-09-24), which failed coach turns
outright with no second provider to try.

- **Transport:** `lib/ai/openrouter.ts`, OpenAI-compatible chat completions at
  `https://openrouter.ai/api/v1/chat/completions`, governed by the same `callModel` path as
  Gemini (provenance, registry, circuit breaker, spend cap, one `ai_calls` row per call, provider
  `openrouter`). OpenRouter model ids are pinned in `lib/ai/lanes.ts`; changing one requires a PR.
  The provider switch, key and attestation remain deployment settings.
- **Attestation:** mirrors Gemini's R4 pair exactly, under its own name —
  `OPENROUTER_ATTESTED=1` — checked in the payload builder (`lib/ai/openrouter-payloads.ts`,
  before anything is serialised) and again in `callModel` before the first provider attempt. D0
  (food-only) is exempt; the coach purpose is always D2. **Unset in `.env.example` by default**,
  same as Gemini's pair: a checkout, CI run, or preview environment never sends user content to
  OpenRouter until this is set deliberately, in writing, the same way the Gemini attestation
  above was.
- **Retention:** OpenRouter forwards each request to whichever model the slug names (Google,
  OpenAI, Anthropic, or another vendor on its catalog) and is itself a data processor in that
  path; its own privacy terms (https://openrouter.ai/privacy) govern what it and the underlying
  model vendor do with the request. Read 2026-10-02 (https://openrouter.ai/privacy): OpenRouter
  states it "does not use your Inputs or Outputs for model training"; whether a request is retained
  or trained on is the routed provider's practice, and the policy points to provider routing to
  avoid training-permitted providers. Every request therefore sends
  `provider: { data_collection: "deny", zdr: true, require_parameters: true }`
  (`lib/ai/openrouter.ts`) — `data_collection: "deny"` covers TRAINING (routes only to providers
  that do not train on prompts), and `zdr` is OpenRouter's own storage-side Zero Data Retention
  switch, covering STORAGE (routes only to a provider under OpenRouter's zero-retention terms); a
  model with no such provider fails the call instead of leaking. Both flags were live-tested OK
  2026-10-02 for `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash` and
  `google/gemini-3-flash-preview`.
- **Attestation, 2026-10-02:** the owner (Devin) asked in writing to use OpenRouter for the coach
  ("wire up my api key please and that way we can use any model we like"). On that instruction,
  with the policy read above and the deny routing in place, `OPENROUTER_ATTESTED=1` is set in
  Vercel production and preview. The fallback model is `google/gemini-3-flash-preview` (served by
  Google Vertex through OpenRouter under deny + zdr routing — a separate capacity pool and key
  from the app's own Gemini API project). Tried and rejected live on 2026-10-02:
  `anthropic/claude-haiku-4.5` ignores the step schema's array limits (more than 6 tool calls →
  schema_invalid on every turn); `openai/gpt-5-mini` has no deny-eligible provider.
- **Two lanes, one attestation:** the pinned OpenRouter fallback lets a Gemini coach turn that
  is out of capacity — the pinned model, then its same-key fallback (F-130), or a key-quota 429,
  which skips that same-key fallback entirely because a second Gemini model meets the identical
  quota wall — retry once on the named OpenRouter model instead, since OpenRouter authenticates
  with a different key and is a different outage domain. `COACH_PROVIDER=openrouter` instead
  routes the coach's PRIMARY turn there, with the pinned `google/gemini-2.5-flash` slug. The
  fallback pin is `google/gemini-3-flash-preview`; each path still requires the OpenRouter key and
  attestation. Without them, the coach uses the Gemini pins.
- **Usage and cost:** every request sends `usage: { include: true }`; the `ai_calls.cost_estimate`
  for an OpenRouter row is the provider's own reported `usage.cost` in dollars, never a local
  per-model price guess (`lib/ai/models.ts`'s price table is Gemini-only and does not cover an
  arbitrary catalog model) — zero when the provider does not report it, never estimated.

## TypeSafe (Jev)

Jev is an optional classifier, ranker and verifier; it is not a generative model and no user flow
depends on it. Its output is shape-constrained; a classification, confidence or ranking can still
be wrong. The integration sends only the data needed for the question being asked:

- coach message text for intent and argument routing;
- candidate meal names and macros for suggestion ranking;
- dietary-preference text for onboarding classification;
- taste text for confirmable like, dislike and cuisine chips (Phase 18 W5b, purpose
  `profile-taste`), only after the local safety check (`lib/profile/taste-safety.ts`) found no
  allergen, condition, medicine, rule, symptom or unsure wording — that text is never sent to Jev
  or any model; the dietary field's raw text is still saved to the user's own account
  (`diet_prefs.text`), as on main — sent as typed with the food family names it contains and
  nothing else; and
- reply text, action summaries and successful tool names for claim-without-action verification
  (only once `JEV_HEALTH_ATTESTED=1`; see "Health gate" below).

Application-held identity, email, health conditions, gut data and stored notes are never attached to
a Jev request.

### Health gate (OD12, 2026-10-17)

TypeSafe's policy above names no health-data terms and no retention period, so free text that may
carry health context does not reach Jev until the owner records TypeSafe's written answer here and
sets `JEV_HEALTH_ATTESTED=1` (manual, never inferred; `lib/ai/jev-health.ts`). Text counts as
health text unless the local check (`mayReachJev`, `lib/profile/taste-safety.ts`) clears it as
plain likes, dislikes or a whole app command. With the variable unset:

- coach intent, dietary text and taste text reach Jev only when cleared (unchanged since W5b);
- a suggestion wish the check does not clear is left out of the ranking payload (`wish: null`);
- reply verification never reaches Jev (a coach reply is always health-bearing) and uses the
  deterministic heuristic;
- food names, brands and ingredient text (role advice, log sanity, facet warming) are food data
  and are not gated; a custom food name that spells out a condition is the accepted residual;
- the adapter (`lib/ai/typesafe.ts`) refuses any payload a builder marked health-bearing before a
  request is made, with no `ai_calls` row. Tests: `tests/ai/jev-health-gate.test.ts`.

The email to TypeSafe (privacy@typesafe.ai) asking whether dietary and health text is allowed under
the standard terms or needs the zero-data-retention DPA is Devin's to send. Settings lists every
third-party processor under "Who handles your data" (`components/settings/ProcessorsSection.tsx`);
keep it in step with this file.

Retention was checked on 2026-09-19 against TypeSafe's [privacy policy](https://typesafe.ai/legal/privacy-policy),
last updated 2025-11-19. The page says TypeSafe collects API prompts and other input, does not train
or fine-tune models on that input, and discloses input only to service providers. It gives no numeric
retention period: personal data is kept as long as reasonably necessary to provide the service or
support business purposes, then deleted or de-identified on request when no longer necessary unless
law requires longer retention.

Every Jev call is optional. A missing key, timeout, provider error (including exhausted 429/529
retry) or malformed answer returns `null`: intent continues through the normal Gemini turn,
suggestions keep deterministic fit order, dietary chips remain user-controlled, and reply
verification uses the existing deterministic heuristic. Usage-ledger failures are logged without
discarding an otherwise valid Jev answer.

### Intent telemetry

Each classified coach turn writes provider usage to `ai_calls` for the Jev call as before, plus one
server-side `coach_intent_events` row with only:

- `intent`, `winning_confidence`, and `min_argument_confidence`;
- `fast_path_taken`;
- `fallback_reason`: `none`, `below_threshold`, `missing_arg`, `grounding`, `jev_down`, or
  `clarifying`; and
- classifier `latency_ms`.

The row never contains the utterance, parsed argument values, food names, health fields, or model
reply. A fast-path action that fails to apply and a successful Undo are recorded on the phone as the
`action-failed` and `action-undone` steps in the existing `client_timings` stream; those rows likewise
carry no action payload. Revisit the 0.95 mutating and 0.90 suggestion thresholds only after 100
eligible production turns are available for review.

## Nous Portal

- Server-to-server call: passed in 1494 ms (2026-09-11). Nothing calls it: its adapter code, env
  reads and price rows were removed on 2026-10-01, and `scripts/ai-canary.ts` no longer probes it.
- Retention and data use: **settled 2026-09-12 — REJECT.** The 2026-09-11 canary run recorded this
  as "unconfirmed — ask"; the retention record below closes that question with the answer, in
  writing, from Nous's own published policy and terms. The route never names Nous, so it is not a
  dependency for the coach, the weekly review or any capture purpose.

## Nous Portal retention record (2026-09-12)

REJECT. See `docs/decisions/2026-09-12-wave4-rulings.md` ruling 1 for the full reconciliation.

- **Privacy policy (portal.nousresearch.com/privacy, 2026-06-11):** prompts and outputs are
  retained and used to train by default.
- **Terms (portal.nousresearch.com/terms):** §9.2 keeps data for six months after account
  termination; §12.3 grants Nous a training licence over submitted content.
- **Privacy Mode:** prospective-only (does not cover data already sent), unaudited, carries no
  numeric retention ceiling, and states no health-data carve-out.
- **Verdict: NOT approved for gut or condition notes.** Revisit only if Nous publishes a
  zero-retention tier.
- Health-context coach turns (profile `conditions.length > 0` or non-empty `notes`) call no model
  at all **unless both R4 variables are set**, in which case they go to Gemini on the paid tier
  (Attestation above). With either unset they return `503 nous_unconfirmed` before any provider is
  reached (`lib/server/coach.ts`, decided by `lib/ai/attestation.ts`). Non-health coach turns and the
  weekly review go to Gemini either way.
- R4 policy switch: `HEALTH_CONTEXT_PROVIDER` unset keeps the refusal for every health-context
  turn. `HEALTH_CONTEXT_PROVIDER=gemini` lets them through **only** when
  `GEMINI_BILLING_ATTESTED=1` is also set — a manual attestation the reviewer wrote after confirming
  billing and prompt logging in the console, never inferred by a canary. **Both ship unset in
  `.env.example` and are set in Vercel production** (Attestation above).

## Data sent

- Text food logs are retained by us.
- Gut and condition notes reach no model by default: a coach turn carrying them is refused
  (`503 nous_unconfirmed`) instead of being sent anywhere, Gemini included.
- Under R4 (the reviewer, 22:05Z), once billing is attested and `HEALTH_CONTEXT_PROVIDER=gemini` is set,
  a health-context turn may reach **Gemini on the paid tier** — the switch plus the attestation is
  the only path. Never a Nous call, never an unpaid project. The repository default (`.env.example`)
  leaves both unset; **Vercel production has both set**, so the path is live there for every
  health-context turn that reaches `runTurn`.
- Weekly review sends only seven days of nutrition totals and the advisory expenditure estimate;
  it does not load the constraint profile, gut log, condition list, or notes. It still uses the
  paid Gemini key and remains behind `COACH_ENABLED` plus the scheduled-job secret. The provider
  may return only two bounded nutrition-category enums; application-owned copy renders the review,
  so free model prose cannot name a food, supplement, symptom, condition, or medication.
- Medical questions are classified and replaced with the fixed `MEDICAL_DEFLECTION` in
  `lib/server/coach.ts` before any model call. The model pin therefore cannot weaken that refusal.

## Production rollback

Disable `COACH_ENABLED` and `NEXT_PUBLIC_COACH_ENABLED` together and redeploy. Keep the paid-tier
R4 settings and corrected price ledger in place; do not roll Coach back to a model that failed its
live capacity canary. Threads, messages, and audit rows remain for recovery.

## This file is human-maintained

`scripts/ai-canary.ts` reports to stdout and exits non-zero on a failed probe; it does not write
here. A canary run must never overwrite the retention record.

## Audio container canary

Open question 1 of the Phase 4 spec: Safari's `MediaRecorder` emits `audio/mp4`, and Gemini's
documented audio types list `audio/aac` but not `audio/mp4`. Settle it at integration, from the
repository root, with a real clip recorded on the user's phone:

```bash
pnpm exec tsx -e "import { runCapture } from './lib/ai/capture.ts'; \
import { adminClient } from './lib/server/admin.ts'; \
import { readFileSync } from 'node:fs'; \
const bytes = new Uint8Array(readFileSync(process.argv[1])); \
runCapture('voiceToItems', { slot: 'meal-1', localDate: new Date().toISOString().slice(0,10), \
  media: { bytes, mimeType: 'audio/mp4' } }, { userId: process.argv[2], admin: adminClient() }) \
  .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });" \
  scripts/eval/fixtures/voice-01-eggs-avocado.m4a
```

- Result: **run 2026-09-12 07:03 UTC, against Supabase branch `p1-catalog`, MIME declared
  `audio/mp4`.** No phone clip exists yet (`scripts/eval/fixtures/` is empty of audio); the clip
  used was a **synthetic stand-in**, not a real device recording: an AAC-in-M4A file produced with
  macOS `say` (spoken meal description) piped through `afconvert` to `audio/mp4`/AAC, matching the
  container Safari's `MediaRecorder` declares — not Safari's actual encoder output. The call
  returned items (`scrambled eggs` 100 g qty 2, `avocado` 75 g qty 0.5, `olive oil` 5 g qty 1 tsp,
  with a note flagging the estimated oil amount), so the `audio/mp4` declaration round-trips
  through Gemini for this synthetic container. **This does not settle open question 1**: repeat
  this canary with a real device clip before `voice` is enabled for the account, since a
  `say`/`afconvert` file does not prove Safari's own encoder output is accepted.
- If it fails, the fallback is the spec's: re-mux client-side to 16 kHz mono WAV, which fits 30 s
  inside the 4 MB inline-bytes budget. `lib/media/validate.ts` already accepts `audio/wav`.

## Plan-sheet photos on OpenRouter (2026-10-02)

Owner request 2026-10-02: "for Google Gemini we should be using OpenRouter now." The plan sheet's
photo reader (`photoToIdeas`, D1: one JPEG/PNG the user chose, no free text) goes through
`lib/ai/openrouter.ts` as an `image_url` data URL under the same `OPENROUTER_ATTESTED=1` gate and the
same `provider: { data_collection: "deny", zdr: true, require_parameters: true }` routing as the
coach. Model: the `plan` lane pin in `lib/ai/lanes.ts` (`google/gemini-3-flash-preview`). Live-tested 2026-10-02
with a public Wikimedia photo (no user data): deny + zdr routing accepted the image and the strict
JSON schema on `google/gemini-3-flash-preview` and `google/gemini-2.5-flash`. Without the key or the
attestation the route answers 503 "Photo ideas aren't available right now" and calls nothing.
On a provider failure, the registered `photoToIdeas-gemini` twin uses the pinned Gemini capture
model within the same 20 s reader budget. It uses the same prompt, schema and D1 class. The
Gemini attestation gate still applies; a schema or governance refusal does not trigger fallback.

## Capture on OpenRouter first (2026-10-03)

Owner request 2026-10-02 ("Gemini calls go through OpenRouter"), backed by the 7-day `ai_calls`
report (`docs/audit/2026-10-03-ai-call-success.md`): direct-Gemini `textToItems` on
`gemini-3.8-flash` answered 0 of 3 (all about 19 s timeouts), while `google/gemini-2.5-flash` through
OpenRouter answered 44 of 46 coach calls (96 %, p50 2.4 s).

- **What moved:** text, photo and label capture. When `OPENROUTER_API_KEY` and
  `OPENROUTER_ATTESTED=1` are both set, `lib/ai/capture.ts` asks OpenRouter first, as purposes
  `textToItems-openrouter` (D2), `photoToItems-openrouter` (D1) and `labelToNutrients-openrouter`
  (D1) — the same data class as each Gemini twin. The builder (`captureOpenRouterPayload`,
  `lib/ai/openrouter-payloads.ts`) sends the twin's own system prompt and `data` envelope; a photo
  or label goes as one `image_url` data URL, after the same `validateImage` checks (JPEG/PNG,
  size and dimension caps) as before. Same `deny` + `zdr` + `require_parameters` routing as the
  coach. Model: `google/gemini-2.5-flash`, pinned in `lib/ai/lanes.ts`.
- **Fallback:** OpenRouter gets one attempt inside 8 s of the 20 s capture budget. Any provider
  failure (an HTTP error, a quota, no answer, an open circuit) falls back to the Gemini capture
  pair (`gemini-3.8-flash`, then `gemini-3.6-flash`) with the rest of the budget. A reply our
  schema refuses, or the spend cap, does not fall back. Without the key or the attestation,
  capture is the Gemini pair exactly as before.
- **What stays on Gemini:** `voiceToItems` and `coach-transcribe` (audio — the OpenRouter
  transport here sends text and images only). They still need the Gemini attestation pair above.
  `coach-transcribe` retries a provider failure once on the capture lane's Gemini backup pin;
  there is no pinned OpenRouter audio model. Both calls share the server's 7.5 s budget.
- **Ledger:** the OpenRouter row records the Gemini payload's input hash, so the ten-minute
  duplicate probe (`lib/server/capture.ts`) finds a repeat whichever provider answered.
- **Unreadable labels:** the label schema requires `labelReadable`. The prompt makes it `false`
  when no nutrition panel is clearly visible (live 2026-10-03: a blank image had come back as an
  invented "Organic Whole Milk"). Both transports refuse that reply at parse time
  (`UnusableReply`, no retry), so the `ai_calls` row reads `schema_invalid` with its tokens still
  billed. The duplicate probe therefore never blocks a retry of the same photo. The user gets the
  existing 422 `schema_invalid`, with no draft, on either provider.


## Plan-panel documents on OpenRouter (2026-10-03)

Owner request 2026-10-03: the meal card panel's "+" uploads a meal plan, recipe or menu. The reader
(`documentToPlan`, **D2**: a plan from a dietitian can carry clinician directives) goes through
`lib/ai/openrouter.ts` under the same `OPENROUTER_ATTESTED=1` gate and the same deny + zdr routing
as the photo reader. A photo is an `image_url` part (resized, through the media pipeline); a PDF is
a `file` part read natively by the model (`plugins: file-parser, engine "native"`, so no separately
billed OCR engine); a `.txt`/`.csv` file is fenced as data inside the prompt. Model:
the `plan` lane pin in `lib/ai/lanes.ts` (`google/gemini-3-flash-preview`), shared with the photo reader. On a provider failure,
the registered `documentToPlan-gemini` twin uses the pinned Gemini capture model with the same
prompt, schema, D2 class and its own attestation gate. A schema or governance refusal is final;
both calls share the 40 s reader budget. Limits: PDF 3 MB (it rides in the JSON body:
the media bucket admits no PDFs and Vercel caps a request body at 4.5 MB) and 10 pages; photos
10 MB before the resize; text 256 KB, 30,000 characters sent. Word files are refused (no parser,
no new dependency). The account's rules never reach the model: a matched meal is grounded and
screened on the server (`lib/plan/document-ground.ts`), and nothing is placed without a tap.
