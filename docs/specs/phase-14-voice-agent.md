# Phase 14 — The voice coach: voice-to-voice and live voice-to-text

Status: DRAFT rev 3 (2026-09-23). Owner direction: Devin, 2026-09-23 — "the in-app AI coach must be
the best possible, with focus on voice-to-voice and voice-to-text". GPT Luna proposed LiveKit
Agents. The run decides whether that fits this app. Run decisions are marked **DECIDED (run)**;
Devin's own rulings are marked **DEVIN**. Adversary: GPT-6 Sol (`docs/audit/specs/`). Rev 2 changed
the architecture after Sol round 1. Rev 3 closes Sol round 2: the whole reply is checked before
any word is spoken. See the last two sections.

## 0. Decision

**DECIDED (run): the voice coach is a checked cascade. The browser runs it, and every word is
checked on the server before it is spoken. It is not a native speech-to-speech model, and it
does not use LiveKit now.**

- **Ears:** the phone streams the mic straight to `gemini-3.5-transcribe-live`. It uses an
  ephemeral token that our Vercel route mints and locks to transcription only. The user's words
  appear as they speak. The same ears power live dictation in the composer (voice-to-text).
- **Brain:** each finished utterance goes to a new streaming Vercel route. That route runs **the
  existing coach turn** to completion, with the same deflection, gates, registry, grounding,
  policy, reply checks and verify. Only the **final, fully checked reply** is released. The
  route's stream carries a neutral "one moment" clip first, then the checked reply.
- **Mouth:** the same route synthesises the checked reply with Gemini streaming TTS
  (`gemini-3.8-flash-lite-tts`, PCM), sentence 1 first. Cards are released with the reply.
- **Done means applied:** "saved" or "done" is spoken only after the **phone** has applied the
  card (a fixed clip on the apply result). Barge-in stops playback on the phone. The server still
  finishes and persists the turn, and an interrupted turn's cards are never auto-applied.

Why not native speech-to-speech (`gemini-3.8-live`): it gives the fastest first audio (about 1 s),
but it speaks before any server check. It also relays tool calls through the browser. Sol round 1
showed that the typed path's allergen, avoid, deflection and claim rules cannot hold for it (§3.2).
It stays an owner option (§12, item 1).

Why not LiveKit: its strengths are WebRTC transport, a semantic turn detector and adaptive
interruption. In this app they save hundreds of milliseconds at most, and the brain turn is
seconds long. LiveKit would also add a long-lived worker that Vercel cannot host. It would add a
new vendor that hears health audio, and about $60 a month. The iPhone lock and background limits
would not change. §3.3 lists the tripwires that would change this call.

## 1. Facts (read 2026-09-23)

### 1.1 What exists in the app

- **Voice-to-text (T7, F-131, landed).** Hold to talk on the coach composer.
  - On-device first: `webkitSpeechRecognition` is built at press time, and the live words go
    into the textarea. Release sends the words through the typed `send()`, so the wire body is
    the same as a typed turn.
  - Fallback: `MediaRecorder` records up to 30 s, then signs and uploads the clip. Next,
    `POST /api/coach/transcribe` runs `gemini-3.8-flash` (purpose `coach-transcribe`, 7.5 s
    call, 8 s client deadline). The text is not auto-sent and not stored.
  - Files: `lib/coach/{dictation,hold,hold-ports,speech-api}.ts`, `components/CoachMic.tsx`,
    `lib/capture-mic.ts`, `lib/coach-transcribe-client.ts`, `lib/server/coach-transcribe.ts`,
    `app/api/coach/transcribe/route.ts`.
- **Voice-to-voice:** none. The T7 plan says "voice-to-voice is a separate spec after this one".
  This file is that spec.
- **The coach turn** (`POST /api/coach` → `runTurn`, `lib/server/coach-turn.ts`).
  - Order: flag, `messageId` idempotency, turn budget, medical deflection (`classifyMedical`, no
    model call), health-context gate (`coachRouteFor`), then the Jev intent pre-pass. A
    mechanical intent takes the fast path with no Gemini call. Any other intent runs the
    `generateStructured` tool loop on `gemini-3.6-flash` (fallback 3.8).
  - After the loop: `groundAndExpandActions`, `applyGroundedActionPolicies`, then `checkReply`,
    which aborts a reply that names a blocked or unverified food from its evidence. Then
    `verifyReply` (claim without action; `claimsAction` plus Jev), and `persist` to
    `coach_messages` (`unique (thread_id, seq)`).
  - One JSON response, **no streaming**.
- **Tools:** `COACH_REGISTRY` is one frozen array, dispatched only through `validateToolCall`.
  `userId` is a closure argument. Actions come in 18 kinds. The server grounds them. The phone
  applies them through `lib/coach/apply-client.ts` with Undo. Blocks are in
  `lib/coach/ui-blocks.ts`.
- **Latency today:**
  - PR #254 measured about 43 s for a 2026-09-23 turn: 9 s setup, 7.1 s model, 16 s of
    sequential searches, 11 s of grounding, verify and persist.
  - After #254: about 30 s, a p95 gate < 30 s, and a 15 s goal (Phase 13 §7).
  - Coach model call median 2.6 s. Jev median 0.4–0.5 s.
  - The Jev fast path answered in 1.0–3.9 s in the 2026-09-19 live check.
- **Limits:**
  - Coach turns: 10 an hour and 60 a day per user (`lib/server/coach.ts` `reserveTurn`). Since
    W035 one turn is one reservation in the shared database limiter (fixed UTC hour and day
    windows, fail closed), whatever provider answers and however many model steps it takes; a
    replay of a saved turn spends none. Transcription: 10 a minute and 200 a day per account.
  - `AI_DAILY_SPEND_CAP_USD`: $2 per user per UTC day. **Fails open on a read error**
    (`lib/ai/spend.ts`).
  - Timings: `lib/timing.ts` `TIMING_PATHS` already uses `voice` for FAB capture. The allowed
    steps are also listed in the database (`20261023092000_client_timings_attach_step`).
- **Runtime:** Vercel Node, `sfo1` (beside the us-west-1 database), `maxDuration` 60 s. `@google/genai` ^2.23.0 is already a
  dependency.
- **Data classes:** Phase 13 §2. `docs/specs/phase-13-model-lanes-food-safety.md` is a draft on the
  `mc-p13` worktree, not yet on main.
  - D0: food only. D1: nutrition and messages. D2: health context.
  - Gemini paid and attested: D0–D2. Jev: D0–D1. **Incidental D2 in text sent to Jev is an
    owner-accepted residual** (DEVIN, 2026-09-23, "not too guarded"; Phase 13 §8 item 1 is still
    open). The call registry and attestation gate are Phase 13 slice 0, **not yet built**.

### 1.2 External facts (primary sources unless marked)

| Fact | Source |
|---|---|
| `gemini-3.5-transcribe-live`: a Live API speech-to-text pipeline, not an agent. `responseModalities: [TEXT]`, 16-bit PCM in. `interim_input_transcription` gives fast partials, and `input_transcription` gives finals on pause. It supports `custom_vocabulary` biasing, language detection, automatic, manual and hybrid VAD, and `SMART` clean-up. About $0.009/min blended. | ai.google.dev/gemini-api/docs/live-api/live-transcribe; /pricing |
| `gemini-3.8-live` (stable, September 2026): output is **audio only**; text comes from output transcription. Async tools are the default. The client must answer tool calls. | ai.google.dev/gemini-api/docs/models/gemini-3.8-live; /live-api/tools |
| **No guaranteed order** between a Live model's output transcription and its audio | ai.google.dev/api/live (Sol r1 #1) |
| Live API billing **compounds**: each turn re-bills every token in the context window, at about 25 audio tokens per second. Transcription text is billed as extra output. | ai.google.dev/gemini-api/docs/live-api/best-practices |
| Ephemeral tokens: the server mints them with `uses` (default 1), `newSessionExpireTime` (default 1 min) and `expireTime` (default 30 min; the window for sending messages). `liveConnectConstraints` locks the model and config. A resumption handle can be non-resumable during generation. | ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens; /api/live |
| A Live connection lasts about 10 min, with a `GoAway` warning first. | ai.google.dev/gemini-api/docs/live-session |
| Gemini TTS: `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` take the verbatim text and stream headerless 24 kHz 16-bit PCM (`stream: true`). Lite is "the fast, cost-efficient workhorse". Output is 25 tokens per second of audio, at $6–12/1M (Lite) and $9–18/1M (Flash) output tokens. | ai.google.dev/gemini-api/docs/speech-generation; /pricing |
| Paid Gemini API: no training. Abuse logs are kept up to about 55 days. ZDR only on Vertex. | ai.google.dev/gemini-api/docs/logs-policy |
| LiveKit Agents: Python 1.8.3, Node 1.9.0. Workers are long-lived processes. Cloud Build (free) gives 1,000 agent-session min, 5 concurrent sessions and cold starts. Ship is $50/mo with 5,000 min, then $0.01/min. The turn detector and adaptive interruption are built in. LiveKit lists Gemini Live Transcription as an STT plugin. Issue #7302 reports friction with Gemini async tools. | pypi, npm, livekit.com/pricing, docs.livekit.io, github.com/livekit/agents/issues/7302 |
| Pipecat Cloud: about $0.01 per agent-minute. Its iOS client is native Swift. | daily.co/pricing/pipecat-cloud; docs.pipecat.ai |
| OpenAI Realtime `gpt-realtime-2.1`: WebRTC, ephemeral keys, tools. About $32/1M audio in and $64/1M audio out (secondary source). | developers.openai.com; forasoft (secondary) |
| iOS Safari: `getUserMedia` works in standalone PWAs since iOS 13.4. `webkitSpeechRecognition` is unreliable in home-screen PWAs (reports, no WebKit bug). Web Audio suspends on lock or background. `AudioContext.resume()` needs a gesture. `navigator.audioSession` exists in Safari 16.4+. Wake Lock in Home Screen apps needed a WebKit fix (254545). | bugs.webkit.org 185448, 254545; developer.apple.com/forums 775699, 774239; caniuse |
| Silero VAD in the browser: `@ricky0123/vad-web` (ONNX, runs on the client, free) | npmjs.com/package/@ricky0123/vad-web |

## 2. Goals and non-goals

**Goals**

1. **Talk mode (voice-to-voice).** Tap Talk and speak. The user sees their words live, hears a
   short acknowledgement at once, then hears the coach's checked answer. They can interrupt at any
   time. The same cards appear as in the typed coach: charts, food ideas, compose cards, and
   action cards with Undo.
2. **Live dictation (voice-to-text).** In the installed PWA, the words appear while the user
   speaks, even where `webkitSpeechRecognition` fails.
3. **Parity.** Every spoken sentence passes the checks the typed reply passes. The medical
   deflection runs before any model call. Writes happen only through grounded action cards with
   Undo.
4. **Solo-operable.** No new always-on server, and no new vendor that hears health data.

**Non-goals (this phase)**

- Talking with the screen locked or the app in the background. A PWA cannot do this; see §12
  item 2.
- A native speech-to-speech "fast mode" (§12 item 1), wake words, phone calls, video.

## 3. Architectures compared

Load for all rows: 10 users × 20 min a day = 6,000 session minutes a month. The user speaks about
40 % of the time and the coach about 30 %. Costs are ESTIMATES; slice 2 and slice 3 measure them.

| | **A. Checked cascade: live transcription → coach turn → TTS** (chosen) | **B. Native speech-to-speech: `gemini-3.8-live` direct + browser tool relay** | **C. LiveKit Cloud Agent** (cascade or Gemini Live plugin) | **D. OpenAI Realtime** |
|---|---|---|---|---|
| First audio after the user stops | A neutral "one moment" clip at ≤ 0.7 s. First useful (fully checked) audio: fast path ≈ 3 s; LLM turn ≈ 5–9 s p50, ≤ 18 s p95 (§7). | ≈ 1 s, with the model's own speech | Same as A when it runs the cascade; same as B with the plugin. Add a hop, plus cold starts on Build. | ≈ 1 s class (vendor claims) |
| Barge-in | Client VAD plus interim transcripts stop playback in ≤ 300 ms, and the stream aborts. No mid-reply understanding. | Server VAD and `interrupted` | **Best**: semantic turn detector, adaptive interruption | Good |
| iPhone PWA | One WebSocket for the ears, plus HTTP streaming. It ends on lock. | One WebSocket, ends on lock | WebRTC (better on bad networks), ends on lock | WebRTC, ends on lock |
| Fit with Vercel | Mint and one streaming turn route (≤ 60 s). No worker. | Mint, relay and persist routes | **Needs a long-lived worker** (LiveKit Cloud or self-hosted) | Mint and relay routes |
| Reuse of tools, policy, persistence | **Same server code, same order**. Tool calls come from Gemini to the server, never through the browser. | A new relay. The server cannot prove a call came from Gemini (Sol r1 #2), and the transcripts are client-reported (Sol r1 #5). | The worker calls our turn route as its LLM node; an extra hop | Same problems as B |
| Parity of spoken words | **Yes**: nothing is spoken that did not pass the checks | **No**: speech precedes every check (Sol r1 #1, #3) | Yes as a cascade; no as speech-to-speech | No |
| Data classes | Gemini only | Gemini only | **New D2 processor** (LiveKit Cloud) | **New D2 provider**, and it needs Devin's own key. The machine policy forbids billed OpenAI for his tooling; the app could use it only if he adds a key on purpose. |
| Monthly cost | Ears 6,000 min × $0.009 ≈ $54. Brain ≈ 9,000 turns × ≈ $0.008 ≈ $72. TTS 1,800 min × 1,500 tok × $6/1M ≈ $16. **≈ $140.** | Audio in 6,000 min ≈ $30, out 1,800 min ≈ $32, plus compounding context re-billing: **≈ $60–150** | A or B plus Ship $50 + overage ≈ $10: **≈ $200** | ≈ $184 (flagship) or ≈ $58 (mini), secondary prices |
| Solo burden | Low to medium: one streaming route and client audio | Low, but carries safety debt | High: worker, deploys, cold starts, a second bill | Medium, plus a new contract |

### 3.1 Why A

It is the only option where the coach's rules hold for speech as they hold for text, and it keeps
all logic in the code that already enforces them. Tool calls never cross the browser. The server
writes every stored message, as it does for typed turns. The cost is latency on turns that use the
tool loop. §7 attacks that with the fast path, the acknowledgement clips, TTS overlap, setup
caching and the shared coach latency work. The honest target is a natural "one moment", then a checked answer a few seconds
later. It is not a sub-second native reply. Rev 1 and rev 2 tried to
start speaking earlier (native audio, then per-sentence streaming). Sol showed that both break
parity with the typed path, so rev 3 speaks nothing that the whole-reply checks have not passed.

### 3.2 Why not B (native speech-to-speech) now

- No order is guaranteed between the transcript and the audio, so a pre-speech guard cannot be
  guaranteed either.
- The medical deflection and the claim-without-action check would run after the audio has played.
- Tool calls and transcripts would reach the server from the browser, so they are not server
  truth.
- Compounding billing makes its cost hard to bound.

B is a product decision about accepting audible allergen risk. It is Devin's call (§12 item 1),
not the run's.

### 3.3 LiveKit tripwires

Move the audio transport to LiveKit Agents, keeping the turn route as its LLM node, if **any** of
these happen:

1. The WebSocket ears break in more than 5 % of sessions on Devin's iPhone on cellular.
2. The app needs phone calls (SIP), a native iOS shell with CallKit, or multi-party sessions.
3. False barge-ins or cut-offs stay above 10 % of turns after the slice 4 tuning. LiveKit's
   semantic turn detector is the fix.
4. A non-Google STT or TTS becomes necessary, and LiveKit is the orchestrator.

The turn route is plain authenticated HTTP, so a LiveKit worker could call it unchanged.

## 4. Architecture

```
iPhone PWA                                     Vercel (sfo1)                              Google
──────────                                     ─────────────                              ──────
Tap "Talk" ─ POST /api/coach/voice/ears (JWT) ─▶ flag, reserve minutes (atomic), mint ─▶ authTokens.create
           ◀─ { earsId, token, expiresAt, vocabulary } ─      (locked: transcribe-live, TEXT)
mic → AudioWorklet 16 kHz PCM ═══ WebSocket (token) ═══════════════════════════════▶ gemini-3.5-transcribe-live
live words (interim)          ◀═══ interim + final transcripts ════════════════════
Silero VAD + finals → end of utterance
POST /api/coach/voice/turn (JWT, messageId, threadId, text, earsId) ─▶ coach_turn_begin (atomic: seq, limits, spend)
                                                              deflect → gates → Jev → fast path | tool loop
                                                              whole reply: sanitise → ground → policy → checkReply → verify → term screen
                                                              released reply → TTS stream ─────────────────▶ gemini-3.8-flash-lite-tts
◀── NDJSON: ack | reply{text,cards} | audio | textonly | beat | done ──  coach_turn_finish (atomic, server truth)
speaker ← PCM queue; cards → apply-client (Undo) → "Done." clip after apply
user speaks during playback → flush audio, close reader → next turn (server still finishes)
```

### 4.1 Ears — `POST /api/coach/voice/ears`

- **Order:**
  1. `VOICE_ENABLED` (404 when off).
  2. Pre-identity limiter, then `requireUser`.
  3. **Minute reservation (fail closed).** One RPC, `rotate_voice_ears(user, prev_id | null,
     minutes)`, handles both the first mint and every renewal, in one transaction:
     - it closes `prev_id` when given (it must be the caller's own);
     - it refuses when **another** ears row is still open (concurrency 1);
     - it refuses when the day's **reserved** minutes plus the new ones pass
       `VOICE_DAILY_MINUTES` (30);
     - it inserts the successor `voice_ears` row: id, user_id, prev_id, reserved_minutes,
       minted_at, expires_at, status `open`.

     Reserved minutes are charged in full, used or not, so a lost client cannot spend more than
     it reserved. A row past `expires_at` counts as closed. A database error refuses the mint.
     The shared spend check, which fails open today, is not relied on here.
  4. **Provider mint:** `authTokens.create`. If Google refuses, the route marks the new row
     `refused` and refunds its minutes in a second statement. If that refund fails, the minutes
     stay charged (fail safe).
- **The token:** `uses: 1`, `newSessionExpireTime` now + 60 s, `expireTime` = now + the reserved
  minutes (**5 min rolling**). `liveConnectConstraints` lock:
  - model `gemini-3.5-transcribe-live`;
  - `responseModalities: [TEXT]`;
  - input transcription with `SMART` mode and automatic VAD;
  - `custom_vocabulary` = up to 100 of the user's food names (D1, Gemini-cleared).

  No system instruction and no tools. The session cannot generate a reply, so no context
  compounds.
- **Rolling renewal:** 30 s before `expireTime`, or on `GoAway`, the client calls the route again
  with `prevId`. The rotate RPC reserves the next 5 minutes, and the client opens a fresh
  connection and closes the old one (closes Sol r2 #7). A transcription session has no
  conversation state to resume, so no resumption handle is needed (closes Sol r1 #10).
- **Bound:** Google rejects messages sent after `expireTime`, so no audio is accepted, and
  therefore none is billed, past the reservation. Ears spend per user per day ≤ 30 min × $0.009 ×
  2 (margin) ≈ $0.54, whatever the client reports. Slice 0 checks this: a socket held open past
  `expireTime` must have its audio frames refused. Turning `VOICE_ENABLED` off stops
  renewals, so at most 5 minutes of transcription remain, and the turn route answers 404 at once.
- **The token is never logged.** It lives only in memory.

### 4.2 Brain and mouth — `POST /api/coach/voice/turn`

A streaming route: Node, `sfo1`, `maxDuration` 60, **cancellation not enabled**, so the function
runs to its own end when the phone disconnects. It returns NDJSON over one `fetch` with a
`ReadableStream` body.

- **Request:** the typed turn's schema (`coachTurnRequestSchema`: `messageId`, `threadId`,
  `text`, `now`, `tz`) plus `{ voice: { earsId, interruptedTurnId? } }`. The text is what the ears
  finalised. Like typed text, it is the user's claim of what they said.
- **Binding:** the turn is accepted only when `earsId` names a `voice_ears` row that is the
  caller's own, not refused, and minted within the last `expires_at + 60 s`. A caller without live
  ears cannot use the voice limits (closes Sol r2 #6).
- **Acceptance is atomic** — RPC `coach_turn_begin(thread_id, message_id, channel, limits)`, in
  one transaction:
  - takes a per-thread advisory lock and allocates `seq` for the user row;
  - inserts the user row with `turn_status = 'pending'`;
  - counts the caller's turns for the hour and the day, **including pending and failed ones**;
  - reserves an estimated spend of $0.03 in `ai_spend_reservations`;
  - refuses when a limit or the spend cap would be passed.

  A database error refuses the turn (fail closed). `messageId` replays return the stored turn.
  **Finish is atomic** — RPC `coach_turn_finish(turn, assistant_row, status)`:
  - allocates the assistant `seq` under the same lock;
  - inserts the assistant row;
  - sets `turn_status` to `completed`, `interrupted` or `failed`;
  - releases the reservation against the actual `ai_calls` cost.

  Two devices, or a retry after an abort, therefore serialise on the thread lock, and no orphan
  user row survives: a turn stuck in `pending` for 2 min is marked `failed` by the next begin on
  that thread (closes Sol r2 #4).
- **`runVoiceTurn` is `runTurn` with begin/finish and a speech sink, not a second loop.** The
  refactor:
  - lifts the setup, the tool batch runner and the post-loop pipeline (sanitise, ground, policy,
    `checkReply`, `verifyReply`) into `lib/server/coach-turn-core.ts`;
  - makes `runTurn` a caller of those functions;
  - adds one parity suite that runs both entries over the coach fixture corpus. The two must give
    the same `actions`, `blocks`, `draft`, final text and persisted content.

  The typed route keeps its own persistence in this phase. Moving it to the RPCs is a follow-up.
- **Same order as typed:** flag; binding and acceptance (limits, spend); `classifyMedical`
  **before any model call** (a hit releases the fixed `MEDICAL_DEFLECTION` text and its
  pre-rendered clip); the health-context gate; the attestation gate once Phase 13 slice 0 lands;
  the Jev pre-pass; then the fast path or the tool loop.
- **Whole-reply release (closes Sol r2 #1–#3):**
  - the final step is validated as today (the full wire schema, `sanitiseReply`);
  - grounding and action policy run;
  - `checkReply` runs over the **whole** reply and can replace it and clear actions, as typed;
  - `verifyReply` runs (`claimsAction` and Jev), including its one correction request and the
    honest fallback, as typed.

  **Only then** does the route emit the reply text, the blocks, the draft and the actions,
  together. Nothing is spoken or rendered from a partial step. There is no streamed final step in
  this phase. It could return later only as a measured gain whose preview is never spoken.
- **Hard-rule term screen (extra to parity).**
  - What it matches: after the typed checks pass, the released reply is screened against the
    user's hard-rule vocabulary — allergen synonyms and inflections, avoid-list names and their
    catalog aliases, and banned-category words — compiled from `getProfile` and the avoid list.
  - What it lets through: policy-template sentences ("X is on your avoid list") and negations
    from the fixed template set.
  - On any other hit, the reply is released as **text only**, with the policy mark, and the
    voice says the fixed clip "I've put that on the screen for you."
  - **Limits, stated plainly:** this is a word list. It cannot prove that an open-vocabulary
    recommendation is safe (a brand name not in the catalog, or a dish that hides an allergen).
    The typed path has the same open-vocabulary gap. The Phase 13 §6 Jev hard-rule reply check
    closes it for both paths when it lands. The test matrix covers aliases, plurals, brands in
    the catalog, split words, negation and policy explanations (closes Sol r2 #2 as far as a
    word list can).
- **No completion claims in speech (closes Sol r2 #3):**
  - The voice prompt addendum keeps the typed rule, present tense for actions ("Moving meal 4 to
    8 pm"), and forbids past-tense completion words.
  - A released reply that still has `claimsAction` true after `verifyReply` is rewritten by a
    deterministic tense template, or falls back to the card's own present-tense label.
  - Completion is spoken **by the phone** after `apply-client` resolves: the fixed clip "Done."
    on success, or "That didn't save — tap retry on the card." on failure.
- **Mouth:**
  - The released reply is split into sentences, and sentence 1 is synthesised first with
    `gemini-3.8-flash-lite-tts` (`stream: true`), in the fixed voice with a style note ("warm,
    brisk coach"). Later sentences are synthesised while earlier ones play.
  - PCM chunks travel in the same NDJSON (base64, about 48 KB per second of audio). Slice 0
    checks whether a compressed format cuts 5G payload without adding latency.
  - The voice prompt asks for at most 3 short sentences (about 20 s of audio). Longer detail goes
    in cards.
- **Stream events:** `{t:"ack", clip}` | `{t:"reply", text, blocks, actions, draft, speak}` |
  `{t:"audio", i, pcm}` | `{t:"textonly", reason}` | `{t:"beat"}` (every 5 s) |
  `{t:"done", turnId, messageIds, timings}` | `{t:"error", code}`.
- **Acknowledgement clips (closes Sol r2 #9):** neutral only ("One moment.", "Okay, one sec.",
  "Mm-hm."). They name nothing and claim nothing. They are rendered once in the chosen voice,
  committed under `public/voice/`, and preloaded into an `AudioBuffer` when Talk opens. The
  server sends `ack` at once for any turn that is not a deflection. The phone plays it only when
  no `reply` has arrived 600 ms after the speech ended.
- **Deadline (closes Sol r2 #5):** the voice route does not rely on the typed constants. The
  typed path's `TURN_LIMITS.wallClockMs` is 75 s on main, and PR #254 would make it 30 s.
  - `VOICE_TURN_BUDGET_MS` = 28 s, counted from the start of the request. It is passed as
    `wallClockMs`, and it covers setup, the loop, grounding, the checks and verify. A turn over
    budget releases the typed "took too long" reply.
  - `VOICE_TTS_BUDGET_MS` = 14 s for the synthesis of the whole reply. Sentences not synthesised
    in time are sent as `textonly`.
  - `VOICE_FINISH_RESERVE_MS` = 8 s for `coach_turn_finish` and the `ai_calls` writes.
  - Total ≤ 50 s, under `maxDuration` 60.
  - The phone's deadline: an idle timeout of 8 s between events (the server beats every 5 s),
    and 55 s overall.
  - A fake-clock test runs a slow multi-tool turn with slow TTS and asserts the order: reply
    released → partial audio → `textonly` → finish persisted, all before 50 s.
- **Barge-in and disconnects:**
  - The phone flushes playback and closes its reader. The server notices the closed stream,
    stops synthesis, and still runs `coach_turn_finish`. The status is `interrupted` if the
    reply had been released, and `completed` otherwise.
  - The cards of an interrupted turn are stored and shown as **"Not applied — tap to apply"**.
    They are never auto-applied.
  - The next request's `interruptedTurnId` records `heardUntil` as a client-reported field.

### 4.3 Client — `lib/voice/*`, `components/coach/TalkSheet.tsx`

- **Start (inside the tap gesture):**
  1. Create or resume the `AudioContext`.
  2. Set `navigator.audioSession.type = "play-and-record"` where it exists.
  3. `getUserMedia` with echo cancellation, noise suppression and AGC.
  4. Request a wake lock (best effort).
  5. Mint the ears, then connect with `@google/genai` `live.connect`.
- **End of utterance:** a final transcript, plus Silero VAD silence ≥ 700 ms. A short "and…"
  pause is extended by the VAD's speech probability. The finalised text is shown in a user bubble
  and posted to the turn route.
- **Playback:** a 24 kHz PCM queue in an AudioWorklet. Captions for the spoken sentence are
  always shown.
- **Barge-in:** while the coach speaks, the ears keep streaming (echo-cancelled). The client flushes
  playback in ≤ 300 ms, closes the stream reader and starts the next utterance when **both** are
  true:
  - VAD speech probability > 0.8 for 250 ms;
  - ≥ 2 interim words that are not in the reply being spoken (an echo check).

  The server still finishes and persists the turn (§4.2).
- **Cards and actions:** the existing components render them inline. Actions of a completed turn
  apply through `apply-client.ts` with the same idempotency and Undo, and the phone plays "Done."
  or the failure clip when apply settles. Actions of an interrupted turn wait for a tap. "Undo that" is an ordinary coach turn
  that the existing Undo path already handles; if it does not, slice 3 adds an `undo_last` fast
  path.
- **Lifecycle:**
  - On `visibilitychange: hidden`, stop the mic and playback **at once** and close the ears. The
    server finishes any turn in flight.
  - On return, a chip says "Talk paused — tap to continue". The thread GET is extended (slice 2)
    to return `turn_status`, plus the stored actions of `completed` and `interrupted` turns.
  - The phone reconciles each action against its own applied index (`smc:coach-action:*`). An
    action from a completed turn that was never applied, because the page was hidden before the
    apply ran, is **shown as "Not applied — tap to apply"**. It is not silently applied late.
  - A `pending` turn shows "Still working…" and is polled every 3 s, up to 60 s.
  - A `failed` turn shows its error line (closes Sol r2 #8).
- **Accessibility:**
  - Every spoken sentence is also text.
  - Cards announce through an `aria-live="polite"` region.
  - All controls are ≥ 44 px with labels.
  - Undo stays a visible button.
  - A "Speak replies" switch turns the mouth off, which gives live dictation plus a text reply.
  - With VoiceOver running, auto-listen after a reply is off: the user taps to talk, so the
    screen reader and the mic do not fight.

### 4.4 Live dictation (voice-to-text) with the same ears

- **In the installed PWA** (`display-mode: standalone`), hold to talk uses the ears first. Interim
  words fill the textarea live. On release the final text is sent, which is T7 §1 behaviour.
- **In a Safari tab,** on-device `webkitSpeechRecognition` stays first. The ears are the fallback,
  and upload-then-transcribe (T7 §2) is the last resort.
- Transcripts are stored nowhere by the ears route, as in T7.
- The hold state machine (`dictation.ts`) is unchanged. It gains one port implementation.

## 5. How voice keeps the coach's rules

| Rule (typed path) | Voice path |
|---|---|
| Registry is the only tool source; `userId` from the closure | Same code in `coach-turn-core.ts`. Tool calls come from Gemini to the server. |
| Medical deflection before any model | Same, before any model. The fixed line is spoken from a pre-rendered clip. |
| Health-context and attestation gates | Same, per turn |
| `evaluatePolicy` on tool results and actions | Same |
| `checkReply` aborts a reply naming a blocked or unverified food | Same check over the **whole** reply, before anything is released. Parity. |
| Hard-rule words anywhere in the reply | **Extra:** the term screen, text only on a hit (§4.2). A word list, with limits stated. |
| Claim without action (`claimsAction`, Jev `verifyReply` with one correction) | Same, before release. Speech never claims completion; the phone says "Done." after apply. |
| Writes only through grounded cards with Undo | Same. Interrupted turns' cards need a tap. |
| Persisted by the server, idempotent by `messageId` | `coach_turn_begin` and `coach_turn_finish` RPCs (atomic seq, turn status, fail closed) |
| Turn limits, spend cap | Voice limits bound to live ears. Atomic counting and spend reservation at begin, fail closed. |

## 6. iPhone realities

- **Lock and background end Talk** (§4.3). The server finishes any turn in flight, so nothing
  is lost.
- **Audio starts from a tap only.** There is no auto-start.
- **Wake lock** is best effort (WebKit 254545). Slice 0 records the behaviour on Devin's iOS
  version.
- **Web Speech in a standalone PWA is unreliable,** which is why the ears lead there (§4.4).
- **Echo:** the browser's AEC plus the §4.3 echo check. After a foreground return, the first
  300 ms of mic input is ignored.
- **Tests on the phone:** AirPods and car Bluetooth route changes, a phone call interrupting Talk
  (it must pause and show the chip), music playing (the session pauses it; the sheet says so on
  first use), and AudioWorklet availability. Slice 0 records each case.

## 7. Latency targets

- **Where they are recorded:** `client_timings` under a new path `coach-voice` (not `voice`, which
  is FAB capture). New steps:
  - `speech-onset`: the first VAD frame above threshold, on the audio clock;
  - `interim-shown`, `speech-end` and `request-sent`;
  - `ack-playback` and `reply-received`;
  - `first-useful-audio`: the first output sample of the reply, from the playback worklet, not
    the ack;
  - `cards-visible`, `apply-settled`, `barge-in-silent` and `turn-done`.

  A migration extends the allowed-step list, and `TIMING_PATHS` and `TIMING_STEPS` gain the
  entries (closes Sol r1 #11 and r2 #8).
- **Clock:** `AudioContext.currentTime` maps to `performance.now()` for audio events. Server
  spans (acceptance, model, ground, checks, TTS first chunk, finish) come back in `done`.
- **Sample:** ≥ 50 turns per class on Devin's iPhone, installed PWA, Wi-Fi and 5G. `pnpm timings
  --path coach-voice`.

| Step | p50 | p95 |
|---|---|---|
| Tap Talk → listening | ≤ 1.0 s | ≤ 2.0 s |
| Speech onset → first interim word on screen | ≤ 0.6 s | ≤ 1.2 s |
| Speech end → ack clip playing (when no reply yet) | ≤ 0.7 s | ≤ 1.0 s |
| Speech end → first useful audio, deflection or fast path | ≤ 3 s | ≤ 5 s |
| Speech end → first useful audio, LLM turn without tools | ≤ 5 s | ≤ 8 s |
| Speech end → first useful audio, LLM turn with tools | ≤ 9 s | ≤ 18 s |
| Speech end → cards visible | = first useful audio − about 0.4 s (released together, before TTS) | |
| Barge-in: speech onset → coach audio silent | ≤ 200 ms | ≤ 300 ms |
| False barge-ins (echo or noise) | — | ≤ 5 % of replies |

These are slower than rev 2's, on purpose: a reply is spoken only after the whole-reply checks.
The LLM rows depend on the typed coach latency work (PR #254 and its follow-ups). Voice inherits
every gain.

**Speed work that is in scope** (slice 5), each measured before and after:
- a per-session **context snapshot** (profile, thread and context reads) held in the
  `voice_ears` row, invalidated when an action is applied or after 2 min. The limits and spend
  are never cached;
- synthesis of sentence *n + 1* overlapping playback of *n*;
- the `/api/warm` ping extended to the voice routes when Talk opens;
- the #254 follow-ups (the parallel setup reads, parallel grounding, `search_foods` round trips),
  landed in the shared core so both paths gain.

**Gate:** Talk leaves Preview when the p95 column holds over the sample. A miss on the brain rows
goes to the coach latency backlog. A miss caused by transport goes to §3.3 tripwire 1.

## 8. Fallbacks

| Failure | Behaviour |
|---|---|
| Ears mint refused (minutes, flag, concurrency) | The sheet shows the reason; typing works |
| Ears socket drops | Re-mint once, within the reservation. On failure: "Voice dropped — your words so far are in the box." The partial text goes to the composer. |
| Turn stream error, or idle > 8 s | The clip "I couldn't finish that — try again or type it" plays. The screen reconciles from the thread GET, since the server may still finish the turn. |
| TTS fails or runs out of budget | The rest of the reply shows as `textonly` with a speaker-off glyph |
| Flag turned off during a turn | The accepted turn finishes and persists. The next turn gets 404, and Talk closes with "Voice is off right now." |
| Gemini transcription unavailable | Talk is disabled with a message. Hold to talk falls back as in T7. |
| Offline | Talk is disabled, like Send |
| Mic denied | T7 copy |

## 9. Privacy, data classes, limits and cost

- **Who hears or reads what:**
  - Audio goes to Gemini only (ears).
  - Checked reply text goes to Gemini only (TTS).
  - The turn is the typed turn: Gemini, plus Jev at the existing practice.
  - **Verify projection (closes Sol r1 #6 as far as the run can, in the shared core, so typed
    gains too):** before `verifyReply` sends the reply and action summaries to Jev, the user's
    **stored** D2 terms are replaced with `[health]`. Those are their conditions, medications,
    clinician notes and allergen names from `getProfile`. The claim check does not need them.
    Incidental D2 that the user speaks and that is not in the profile can still reach Jev. That
    is the owner-accepted residual (DEVIN, 2026-09-23); Phase 13 §8 item 1 (the TypeSafe terms)
    closes it. Voice adds no new class or provider.
  - DeepSeek gets nothing from voice.
  - No raw audio is stored.
- **Call registry (Phase 13 slice 0):** `coach-voice-ears` (google, D1 + incidental D2),
  `coach-voice-tts` (google, D1), and `coach` (unchanged) for the brain. The contract test covers
  them. Until slice 0 lands, the voice routes check `GEMINI_BILLING_ATTESTED` themselves.
- **Limits (DECIDED (run)):**
  - `VOICE_DAILY_MINUTES` = 30 per user (ears, reserved atomically, hard-bounded by token
    expiry).
  - Voice turns: 40 an hour and 150 a day per user, counted atomically at `coach_turn_begin`,
    including pending and failed turns. They are available only with live ears (§4.2 binding).
    Typed turns keep 10/60. **Typed plus voice share one ceiling of 150 a day.**
  - Spend: `coach_turn_begin` reserves $0.03 per voice turn in `ai_spend_reservations`. The cap
    check sums the `ai_calls` cost of the day plus the open reservations, and refuses at the $2
    `AI_DAILY_SPEND_CAP_USD`, failing closed. `coach_turn_finish` settles the reservation against
    the turn's actual `ai_calls` rows, failed provider calls included. A turn that never finishes
    keeps its reservation charged. The typed path's fail-open spend read stays as it is (§12 item 7).
- **Prices:** `gemini-3.5-transcribe-live`, `gemini-3.8-flash-lite-tts` and their audio units are
  added to `PRICE_PER_MILLION_TOKENS` (the table gains an audio column). Ears cost is recorded
  per reservation at mint, as reserved minutes × the published rate. No manual billing
  reconciliation is done (§12 item 5): the `ai_calls` spend log is the control.
- **Expected spend:** ≈ $140 a month at 10 users × 20 min a day (§3). Worst case at the caps: ears
  ≈ $0.54 a day plus brain and TTS under the $2 cap, so ≤ $2.54 per user per day.

## 10. Slices (each one PR, TDD, GPT-6 Sol review, Preview steps for Devin)

**Migration order:** each slice's migration is applied to production **before** its PR merges (the
repo's T1 rule). `voice_ears` and the RPC come in slice 1. The timing steps and the
`coach_messages` columns come in slice 2.

**Slice 0 — Spike (Preview only, `VOICE_ENABLED`).**
- **Build:** the ears mint with a fixed vocabulary, `lib/voice/audio.ts` (capture worklet,
  playback queue, flush), a `/dev/voice` page that transcribes live and plays a TTS sentence from
  a dev-only route, and a VAD barge-in demo.
- **Tests:** mint 401, 404 when off, and the locked config (SDK mocked); the flush unit.
- **Report** (`docs/voice/slice0-report.md`): interim-word latency, TTS first-chunk time, PCM
  versus compressed payload on 5G, barge-in timing, the echo false-trigger rate, wake lock,
  lock/return, AirPods, a phone call interruption, AudioWorklet availability, and `GoAway`
  frequency.
- **Devin (installed PWA on the Preview URL):**
  1. Open `/dev/voice` and tap Start. Speak a sentence; the words appear as he speaks.
  2. Tap "Speak test" and talk over it; it stops within a beat.
  3. Lock for 5 s, unlock; it shows "paused".
  4. Repeat on 5G.

**Slice 1 — Live dictation (voice-to-text ships first).**
- **Build:** the `voice_ears` migration, the reservation RPC (concurrency 1, fail closed), rolling
  renewal, an ears port for the hold machine, and standalone detection.
- **Tests:**
  - T7 AC1–AC5 with the ears port;
  - two concurrent mints → one 409;
  - minutes exhausted → 429;
  - a database error → refused;
  - the token is absent from logs (log spy);
  - the flag off → 404 and no renewal.
- **Devin:** in the installed app, hold the mic for 10 s; the words appear while he speaks and
  send on release.

**Slice 2 — Brain: `coach-turn-core`, turn RPCs and the voice turn route (text only).**
- **Build:**
  - the extraction (the typed tests stay green, unchanged) and `runVoiceTurn`;
  - the `coach_turn_begin` and `coach_turn_finish` RPCs with a per-thread lock, `turn_status`
    and `ai_spend_reservations`;
  - a `coach_messages` migration: `channel text check (channel in ('typed','voice'))`,
    `turn_status`, and `voice_meta jsonb` for `interrupted`, `heardUntil` and
    `clientReported: true`;
  - the ears binding, the voice limits and the shared daily ceiling;
  - the verify projection;
  - the thread GET carrying `turn_status` and the stored actions;
  - the `coach-voice` timing path and step migration;
  - NDJSON with `ack`, `reply`, `beat` and `done` events, and **no audio yet**.
- **Tests:**
  - parity over the coach fixture corpus (typed versus voice: same actions, blocks, draft, final
    text and persisted content);
  - deflection before any model call (a spy);
  - nothing is emitted before the whole-reply checks: a blocked food in the final text releases
    only the abort line, with actions cleared;
  - a term-screen hit → text only;
  - `claimsAction` still true after verify → the rewritten tense;
  - the verify payload holds no stored D2 term;
  - two concurrent turns on one thread serialise with ordered `seq` and no orphan rows;
  - a replayed `messageId` returns the stored turn;
  - a disconnect after release → `interrupted` persisted, and its cards stored as not applied;
  - no live ears → 403;
  - limits counted with pending and failed turns;
  - a spend reservation read error → refused;
  - a fake-clock slow multi-tool turn finishes and persists before 50 s.
- **Devin:** in Talk with "Speak replies" off, say "Add watermelon to my avoid list". The card
  appears, applies, and Undo works. Lock the phone mid-turn, unlock, and the turn is there.

**Slice 3 — Mouth and Talk sheet.**
- **Build:**
  - TTS in the route with its budget, and the `audio` and `textonly` events;
  - the neutral ack clips (a render script plus committed files, preloaded);
  - the PCM queue, captions, cards inline;
  - the "Done." and apply-failure clips on apply settle;
  - the lifecycle chip and reconcile, accessibility, and the "Speak replies" switch.
- **Tests:**
  - the TTS port is called only with released text (a spy across the whole check matrix);
  - an ack plays only when no reply arrives 600 ms after speech end (fake timers);
  - TTS failure or budget → `textonly`;
  - "Done." plays only after `apply-client` resolves `applied`;
  - the component suite with a scripted stream: order, captions, cards, `aria-live`, and restore
    with pending, interrupted and failed turns.
- **Devin:** a 3-minute talk that logs a meal, asks for a chart, and changes meal 4 to beef jerky
  and a Chobani. He hears "One moment", then the answer, then "Done." after the card applies.

**Slice 4 — Barge-in and hands-free turns.**
- **Build:** continuous ears during playback, the VAD + interim-word barge-in rule, the echo
  check, `interruptedTurnId`, and auto-listen after a reply (off under VoiceOver).
- **Tests:** a scripted interrupt goes silent in ≤ 300 ms (fake audio clock); an echo of the
  reply being spoken does not trigger; the server still persists `interrupted`; cards wait for a
  tap.
- **Devin:** ask for "five snack ideas" and cut in during the answer with "just the first one".
  Test with AirPods and on 5G.

**Slice 5 — Speed and the safety corpus.**
- **Build:** the context snapshot, the warm ping, TTS overlap, the shared-core latency
  follow-ups, and the red-team corpus. The corpus is 30 spoken prompts built to draw a blocked
  or avoided food, a medical question or a false claim, from a test account with rules. It is a
  live script, not run in CI.
- **Gates:**
  - the §7 p95 table over ≥ 50 turns per class;
  - **0 violations** in the corpus: no blocked or avoided term reaches the TTS port or the
    released text, and no completion is claimed before apply;
  - term-screen false positives ≤ 5 % on a 50-prompt neutral corpus.
- **Devin:** with a peanut allergen set on a test account, ask "what's a good snack with
  peanuts?". Nothing with peanuts is spoken.

**Every slice:** targeted `pnpm test` green, lint and tsc clean, touched files ≤ 400 lines, the
typed coach p95 does not rise, and the PR lists its Preview steps.

**Rollback:** `VOICE_ENABLED` off hides Talk and the ears. The turn route answers 404 at once, and
open ears die at their ≤ 5 min token expiry. No typed path depends on voice code, apart from the
`coach-turn-core` extraction, which the parity suite guards.

## 11. Rejected alternatives in brief

- **LiveKit Agents now:** §0 and §3.3.
- **Pipecat Cloud:** the same worker trade-off, and its iOS client is native.
- **OpenAI Realtime:** a new D2 provider, it needs Devin's key, and it has B's check problem.
- **Proxying audio through Vercel:** functions cannot hold a long socket. The locked,
  transcription-only token makes a proxy pointless.
- **Browser Web Speech as the only ears:** unreliable in the installed PWA.

## 12. Owner items — decided 2026-09-23

Devin delegated these to the run. The coordinator ruled on them on 2026-09-23. Only item 4 stays
open.

1. **Native "fast mode" (speech-to-speech): DECIDED (run): no.** Checked chain only. Native
   speech-to-speech can say a food on a user's allergen or avoid list before any check, so it is
   not built. §3.2 stands.
2. **Talking with the phone locked: DECIDED (run): deferred to the native iOS app.** The PWA ends
   Talk on lock or background (§6). This is also LiveKit tripwire 2.
3. **Limits: DECIDED (run): accepted.** 30 talk minutes a day; 40 voice turns an hour and 150 a
   day; all under the $2 daily cap (§9).
4. **Voice: open for Devin.** He picks one Gemini voice on the Preview once TTS exists (slice 3).
   The acknowledgement clips are rendered in it.
5. **Weekly billing reconciliation: DECIDED (run): skipped.** The `ai_calls` spend log is the
   control. The weekly manual check in §9 is withdrawn.
6. **Stored voice turns: DECIDED (run): accepted.** Voice turns are saved like typed messages.
   Audio is never stored.
7. **Typed spend check: DECIDED (run): the typed coach stays fail-open.** Voice fails closed
   (§4.1, §9).
8. **Speed: DECIDED (run): accepted for v1.** About 3 s at the median for simple requests and
   5–9 s at the median for look-ups, with "one moment" played first.

## Resolution of audit round 1 (GPT-6 Sol, DO NOT SHIP, 6 BLOCK / 6 FIX) — as of rev 2

| # | Finding | Change in rev 2 |
|---|---|---|
| 1 | BLOCK: the playout-delay guard cannot prevent unsafe speech | Native speech-to-speech is dropped. Only text that passed the checks is spoken (§0, §4.2). B is Devin's call (§12.1). |
| 2 | BLOCK: the bridge cannot prove a tool call came from Gemini | No browser relay. Tools run in the server turn, and Gemini's calls reach the server directly (§4.2). |
| 3 | BLOCK: deflection and claims come too late | Deflection runs before any model call; claims are held before speech (§4.2, §5) |
| 4 | BLOCK: the cost cap is not a cap | Atomic reservation, concurrency 1, fail closed, a Google-enforced token expiry for the ears, server-metered brain and TTS, and no compounding context (§4.1, §9) |
| 5 | BLOCK: server truth overstated | The server persists everything with the typed `persist`. Only `heardSentences` is client-reported, and it is labelled so. A `seq` retry is added (§4.2). |
| 6 | BLOCK: D2 text to a D1 verifier | Voice sends Jev exactly what the typed turn sends: the owner-accepted incidental-D2 residual (§1.1, §9). No new flow. Phase 13 §8 item 1 stays open. |
| 7 | FIX: policy filtering broader than search | The hard-rule term screen covers speech beyond `checkReply`'s evidence map (§4.2 check 2). `checkReply` is no longer described as open-vocabulary. |
| 8 | FIX: reconsider LiveKit | Re-argued against the cascade in §0 and §3, with tripwires in §3.3 |
| 9 | FIX: session end is best effort | Stop at once on hide. The server persists the turn in flight. Resume reads server state (§4.3). |
| 10 | FIX: resumption contract | The ears need no resumption; rolling re-mint within the reservation (§4.1) |
| 11 | FIX: latency cannot be measured | `coach-voice` path, a step migration, paired clocks, ≥ 50 samples per class, first useful audio split from the ack (§7) |
| 12 | FIX: release and accessibility gates | Migration order, concurrent-mint tests, rollback, captions, `aria-live`, VoiceOver behaviour, and dictation moved to slice 1 (§4.3, §10) |

Rev 3 supersedes rows 1, 3 and 5: per-sentence release is gone (round 2 #1–#4), and persistence
moved to the turn RPCs.

## Resolution of audit round 2 (GPT-6 Sol, DO NOT SHIP, 5 BLOCK / 3 FIX / 1 NIT) — rev 3

Round 2 was the last round allowed for this run. Rev 3 applies every finding. No round 3 was run,
so these fixes are **not yet re-audited**. The slice 2 PR review is the next check.

| # | Finding | Change in rev 3 |
|---|---|---|
| 1 | BLOCK: a partial `reply` is not a validated final step | No streamed final step. Text is released only after the full wire schema, `sanitiseReply`, grounding, policy, `checkReply`, `verifyReply` and the term screen (§4.2). |
| 2 | BLOCK: per-sentence checks break whole-reply parity; the term list is not open-vocabulary | `checkReply` runs on the whole reply before anything is released, as typed. The term screen is extra, with its limits stated and a test matrix. The open-vocabulary gap is shared with typed and closed by the Phase 13 §6 reply check (§4.2). |
| 3 | BLOCK: a matching card does not prove completion | Speech never claims completion. The phone plays "Done." only after `apply-client` resolves (§4.2, §4.3). |
| 4 | BLOCK: interrupt persistence is not transactional | `coach_turn_begin` and `coach_turn_finish` RPCs with a thread lock, atomic `seq`, `turn_status` and stale-pending cleanup. Cancellation is not enabled, so the server finishes after a disconnect. Interrupted cards need a tap (§4.2). |
| 5 | BLOCK: the 60 s budget contradicts the code | The voice route's own budgets (28 s turn, 14 s TTS, 8 s finish, ≤ 50 s total), independent of #254. Client idle 8 s with 5 s beats, 55 s overall. A fake-clock test (§4.2, slice 2). |
| 6 | FIX: limits bypassable; the $2 cap not hard | Voice turns bound to live ears. Atomic counting including pending and failed turns. Spend reservation at begin, fail closed, settled at finish. A shared typed + voice ceiling of 150 a day (§4.2, §9). |
| 7 | FIX: renewal versus concurrency 1 | `rotate_voice_ears` closes the predecessor atomically. Reserved minutes are charged in full. The provider-mint failure is refunded. The bound is on audio accepted before `expireTime`, checked in slice 0 (§4.1). |
| 8 | FIX: recovery and timing observability | The thread GET returns `turn_status` and actions; the phone reconciles applied state. Timing steps for speech onset, playback onset, ack versus first useful audio. Lock, network, Bluetooth and flag-off tests (§4.3, §7, §8, slices 2–4). |
| 9 | NIT: ack copy can overclaim | Neutral clips only, preloaded (§4.2) |

Round 1 status after rev 3: #2, #8 and #10 were CLOSED in round 2. #1, #3, #4, #5, #9, #11 and
#12 are addressed by the round 2 rows above. #6 gets the stored-D2 verify projection; the
incidental residual stays an owner decision. #7 is addressed by the stated limits of the term
screen and the Phase 13 dependency.
