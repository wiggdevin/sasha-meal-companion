# Primary Astra voice audit

Outcome: voice/composer source corrections and local rendered acceptance complete; **parent integration and release gates remain open**. No independent landing is authorized.

Base: `aa7946c15c6a5754cca7ebc7e47296329c25a342`. Branch: `feat/sasha-tap-composer`. Managed worktree: `/Users/zero-suminc./.codex/worktrees/sasha-composer/meal-companion`. Changes are uncommitted.

## Coordinated scope

Parent chat `01a0ddbb-e834-7da1-b848-d159392fd1b5` owns the 15 Foods/Avoids/Shopping annotations, data fixes, integration and combined final Astra audit. This chat owns voice/composer only. Feedback chat `01a0e51e-9d66-72f3-98dc-de0624a77d9a` owns reusable outcome-feedback primitives. No Foods implementation, target/schema changes, provider pin changes or new speech-output architecture were added here. Port 3105 and the recipe worktree remain outside this work.

## Resulting interaction

Tap Record to start; tap Stop to finish; review/edit and explicitly Send. A red Stop indicator pulses, with an explicit reduced-motion override. Editing retains a reachable Send action and allows Record again. Enter sends except Shift+Enter or active input-method composition.

Automatic completion, cancellation or failure with retained words shows Review recording first. Acknowledging Review never sends. Manual Stop still settles to Send. The live controller state and a synchronous review flag prevent a delayed React render from turning an intended Stop into a new recording or a send.

Pointer guards preserve the touch pointerup/leave/blur/click order. Active drag-off or a captured touch released outside the button clears the guard and suppresses a trailing pointer click; a fresh Send gesture or assistive click remains usable. These rules have DOM regressions. The rendered Chromium touch check observed implicit capture followed by pointercancel on pan; the draft survived and a fresh Send worked. The outside-pointerup geometry branch is covered by DOM tests. Physical iOS/Android behavior remains unverified.

Typed whitespace and visible dictated words survive stop, error and page-hide cancellation. Speech arriving after Stop accumulates until recognizer end or the existing finalisation deadline. Interim phrases survive recognizer restarts. Two empty native endings terminate without a sticky recorder downgrade; later recording retries the preferred listener.

## Verification

- Focused implementation checks passed 328 tests across six files, followed by 20/20 composer DOM tests after the final two-regression cancellation correction. Counts overlap. TypeScript and targeted lint passed after the final code change. `implementation-checks.md` records commands, results and hashes.
- The full local suite ran once: 7,174 passed, 962 skipped, three failed. Two unchanged subprocess specs passed targeted reruns; the stale Send-button assertion was replaced with a stronger retry/blocked-new-send assertion and its spec passed. See `full-suite-disposition.md`. This is not a claim that a second full suite passed.
- Repository lint and the 156-row documentation check passed before the final narrow event correction; final changed source files passed targeted lint afterward.
- Opus reviews found and drove multiple corrections. The final corrective review returned YES for captured touch drag, stale Stop restart, and cancelled activation recovery, with no new concrete defects. Canonical model: `claude-opus-5-5`, firstParty. This approval is source-only and does not close browser/device or parent release gates.
- Fresh Jev `jev-1.13.0` returned YES to five narrow source checks, with reported confidence 0.95–1.00: Review does not send, Stop checks current state and releases, tap settlement keeps the draft, IME/Shift guards exist, and reduced-motion animation is explicitly disabled. `jev-final-review.md` defines the limited scope.
- Final Gemini and independent primary Astra visual reviews passed all stated visual checks across eight final 390 px screenshots, with no concrete defects. See `gemini-final-visual-review.md` and `astra-final-visual-review.md`. Gemini was invoked explicitly as `gemini-3.8-flash-low`; its envelope does not echo a canonical model ID, and the provenance file records that limit. This is the user-approved replacement for Kimi.
- `primary-audit-source-hashes.json` freezes the current source/tests. Real speech providers, hardware, real IME, physical devices and production remain unverified.

## Rendered verification and integration handoff

The user confirmed audio permission. Resumed the same Ego task space 6, page p1. A real audio track opened and was immediately stopped; `microphone-permission-proof.json` records the live → ended state. That permission probe recorded/uploaded no audio. It does not establish transcription quality.

The actual Composer and toolbar then ran with a synthetic SpeechRecognition transport. The rendered checks prove typed-prefix preservation, visible recording, manual Stop/finalising/explicit Send, automatic Review acknowledgement without sending, Enter and Shift+Enter, synthetic permission-error recovery, cancelled touch drag followed by fresh Send, and no horizontal overflow at 320/390/430/1024 px. Recording animation advanced, while emulated reduced motion set animation name to none. Receipts: `rendered-manual-checks.json`, `rendered-auto-keyboard-checks.json`, `rendered-touch-layout-checks.json`.

This was an unauthenticated local fixture with a deliberately invalid Supabase URL. Auth retry errors are fixture limitations. An earlier real recorder fallback attempt hit AccountNotBound before upload; fallback/provider end-to-end success is not claimed. The final UI flows use synthetic transcripts and do not establish real speech quality. Some raw status observations include a 1Password extension live-region message; those are unrelated to product copy. The permission-error state captured the composer's own status.

The browser task space was finished and its temporary page closed. The owned port-3106 server was stopped. The temporary `app/auth/composer-proof/page.tsx` route was removed, with an exact fixture copy saved as `composer-proof-fixture.txt`. No test-only auth route will ship from this work.

Parent coordinates integration, combined final audit, CI, landing and deployment verification. Source/test identities remain in `primary-audit-source-hashes.json`; the browser cleanup changed no production source. Real provider recognition, physical devices, real IME and production remain unverified. These are reported limits, not a claim of deployed readiness.

No commit, push, PR, merge or deployment was performed for this work.
