# T7 — Voice for the coach: hold to talk — 2026-09-18

Program: `docs/plans/2026-09-17-fab-coach-program.md` (T7). Size M. Needs T6 (landed 1daa136).
Coder: Opus 5. Panel holds AC1–AC8 outside the repo. Adversary: Grok 4.6.
Cap (2026-09-18): two Grok passes, two panel rounds, then land and list the rest as follow-ups.
Voice-to-voice (the coach speaks back, barge-in, hands-free) is a separate spec after this one.

## Why

Sasha talks to the coach; she does not want to type on a phone with wet hands between sets.
The FAB already records a voice note for logging (`components/VoiceCapture.tsx`: MediaRecorder,
30 s, upload, the propose route reads the audio). The coach composer (`components/CoachChat.tsx`)
has only a textarea and a Send button. T7 gives the composer a hold-to-talk button: hold, speak,
see the words appear, let go, the turn is sent. Everything after the transcript is T6 unchanged.

## Design

### 1. Hold to talk on the composer — on-device first

- A mic button sits left of Send in the composer, 44 px tap target, `aria-label="Hold to talk"`.
  Pointer down starts listening; pointer up, pointer cancel, or leaving the button stops it. A tap
  shorter than 300 ms does not listen: the button shows the hint "Hold to talk" for 2 s.
- Listening uses the browser's `SpeechRecognition` (`webkitSpeechRecognition` on Safari), created
  at press time, never at load: `lang` from `navigator.language`, `interimResults = true`,
  `continuous = true`, `maxAlternatives = 1`. Feature detection happens at press time so a phone
  that lost the API mid-session falls to §2 on the next press.
- While held, the textarea shows the live transcript: final segments joined, then the current
  interim segment. The textarea is read-only while listening and editable again after release.
- Release ends recognition. When the final result lands (or 800 ms after release if the API sends
  nothing more), the transcript is sent as one turn through the same `send()` the typed path
  uses. The wire body is identical to a typed turn; the server does not learn it was spoken.
- An empty transcript on release sends nothing and shows "I did not catch that. Hold and try
  again." under the composer for 3 s. The textarea keeps whatever she had typed before the press.
- The mic button and the textarea share the composer's disabled states (offline, restoring,
  typing). While listening, Send is disabled; a turn in flight disables the mic.
- Timing: `mark("coach-turn", "dictation")` from press to the final transcript, filed with the
  turn's other steps through `lib/timing.ts` (T0). `pnpm timings --path coach-turn` prints it.

### 2. Fallback — record and transcribe on the server

Used when `SpeechRecognition` is absent, or after a `network` / `service-not-allowed` /
`audio-capture` error (switches the session to the fallback; a page reload tries on-device again).

- The same hold gesture records with `MediaRecorder` (`pickAudioMimeType`, 30 s ceiling, the same
  countdown and mic-error classification as `VoiceCapture`; reuse its helpers, do not copy them).
- Release uploads the clip the way the FAB voice path does (sign → upload to the capture bucket,
  same object lifecycle and 24 h deletion) and calls `POST /api/coach/transcribe` with `{ path }`.
- The route (JWT, 8 KB body, rate-limited like the other coach routes) reads the object, runs
  `validateAudio`, sends the bytes to the pinned flash model with a transcription-only prompt
  ("write exactly what is said, her language, no commentary, no punctuation cleanup beyond
  sentences"), logs an `ai_calls` row with purpose `coach-transcribe`, and returns `{ text, ms }`.
  The text is not stored anywhere on the server. Failures map like the coach route: 401, 415 for
  a non-audio object, 422 for a clip over 30 s, 503 `provider` / `timeout`.
- The transcript lands in the textarea and is **not** auto-sent: server transcription is slower
  and less certain, so she sees it and taps Send. Budget 8 s through `fetchWithDeadline`
  (new key `transcribe`); on timeout the copy is "Transcribing is slow right now. Type it, or
  try again." and the box stays editable.

### 3. Errors and copy (one line each, coach voice, no exclamation marks)

| Event | What she sees |
|---|---|
| `not-allowed` / `NotAllowedError` | "Microphone access is off. Allow it in Settings, then try again." (VoiceCapture's copy) |
| `no-speech` | "I did not hear anything. Hold and try again." |
| `network`, `service-not-allowed`, `audio-capture` | switch to §2 silently; the next press records |
| no `SpeechRecognition` and no `MediaRecorder` | mic hidden; the textarea placeholder is unchanged |
| clip over 30 s | recording stops at 30 s and sends what it has (same as the FAB) |

### 4. Budgets (p95, phone, 10 runs)

| Step | Budget |
|---|---|
| On-device: release → turn sent | ≤ 1.0 s |
| Fallback: release → transcript in the box (10 s clip) | ≤ 8 s |
| Coach turn after that | T0/T6 budgets, unchanged |

### 5. Safari facts the coder plans for

`webkitSpeechRecognition` exists on iOS Safari 14.5+, needs a user gesture, delivers interim
results, and is known to fail in some home-screen (standalone) PWA builds and on `continuous`
mode after long pauses. The spec therefore detects at press time, treats a `network` error as
"use the fallback", and never relies on `continuous` beyond one hold. Recognition on iOS may go
through Apple's servers; "on-device" here means "no call to our server", which is what the
program promised.

### 6. Files (each ≤ 400 lines)

- `lib/coach/dictation.ts` — pure state machine: `idle → listening → finalising → sent | empty
  | error`, with the 300 ms tap rule and the 800 ms finalise timer as injected clocks. Unit-tested
  without a browser.
- `lib/coach/speech-api.ts` — feature detection and a thin adapter over `SpeechRecognition`
  (start, stop, onresult, onerror) so tests and the panel can stub it.
- `components/CoachMic.tsx` — the button, the live-transcript wiring into the textarea, the copy.
- `lib/coach-transcribe-client.ts` — §2 record → sign → upload → post, reusing
  `lib/capture-client.ts` helpers.
- `lib/server/coach-transcribe.ts` + `app/api/coach/transcribe/route.ts` — §2 server side.
- `components/CoachChat.tsx` mounts the mic; if it passes 400 lines the composer moves to
  `components/CoachComposer.tsx`.
- `docs/features.md` row for coach voice; `docs/architecture.md` coach section; `AGENTS.md`
  module table if it lists the coach files.

## Out of scope

The coach speaking (TTS), barge-in, wake words, hands-free turns, voice for the FAB (exists),
streaming text, any change to `runTurn`, the prompt, or the wire.

## Acceptance criteria (the panel's, hidden from the coder)

- **AC1** With a stubbed `SpeechRecognition` that emits two interim results then a final, holding
  the mic shows the interim text in the textarea, and release sends exactly one `POST /api/coach`
  whose body equals a typed turn with the final transcript (same keys, `now`, `tz`, `threadId`).
- **AC2** A tap under 300 ms sends nothing and shows "Hold to talk"; a hold with an empty final
  sends nothing and shows "I did not catch that. Hold and try again."; text typed before the press
  is still there after.
- **AC3** With `SpeechRecognition` absent and `MediaRecorder` stubbed, the same hold records,
  signs, uploads, and posts `{ path }` to `/api/coach/transcribe`; the returned text appears in the
  textarea and no `POST /api/coach` happens until Send is tapped.
- **AC4** `POST /api/coach/transcribe`: 401 without a JWT; 415 for an image object; 422 for a
  clip over 30 s; for each of the three T6 sentences rendered to audio (`say` → m4a and wav,
  10–12 s), the real model returns the sentence with word error rate ≤ 10 % ("4th"/"fourth" and
  "Chobani" spellings allowed) within 8 s p95 over 5 runs; one `ai_calls` row per call with
  purpose `coach-transcribe`; no table holds the transcript afterwards.
- **AC5** Errors: `not-allowed` shows the permission copy; `no-speech` shows the no-speech copy; a
  `network` error switches the session to the fallback (the next hold records); a fallback
  timeout shows the slow copy and leaves the box editable; with neither API the mic is absent.
- **AC6** Phone (ego-browser, local stack, real model): the three T6 sentences delivered through
  a scripted `webkitSpeechRecognition` stub each produce the same card as T6's typed proof
  (add_to_avoid, compose, set_slot_meal); screenshots of the live transcript and the card.
- **AC7** `client_timings` receives a `dictation` step on path `coach-turn` for each spoken turn;
  `pnpm timings --path coach-turn` prints it; budgets in §4 hold on the phone runs.
- **AC8** No regression: tsc, lint (incl. `lint:docs`), targeted tests once; every touched file
  ≤ 400 lines; the T6 panel's typed-path cases (`ac07-no-server-writes`, `ac06-tz`) still green.

## Proof folder — `~/Desktop/proof/t7-coach-voice/`

`acceptance-criteria.md`, `AC1..AC8.txt`, phone screenshots (transcript + card per sentence),
`grok-review.md`, `production-evidence.md` (deploy sha, `/api/coach/transcribe` answers 401 on
production, timings table). The live proof with her own voice on production is Devin's, on his
phone.
