# Voice/composer integration handoff

Worktree: `/Users/zero-suminc./.codex/worktrees/sasha-composer/meal-companion`
Branch: `feat/sasha-tap-composer`
Base: `aa7946c15c6a5754cca7ebc7e47296329c25a342`
State: uncommitted, no PR or deployment. Parent coordinates the combined audit and landing.

## Production change set

- `components/CoachMic.tsx`: combined Record/Stop/finishing/Review/Send, tap-mode controller, accessible labels, focus retention, live-state and gesture guards.
- `components/coach/Composer.tsx` and new `components/coach/use-composer-input.ts`: editable draft, IME/Enter behavior, reachable secondary Send, review gate and pointer cancellation guards.
- `lib/coach/hold.ts`: opt-in tap interaction, explicit Send, transcript preservation, final-result accumulation, bounded native restart and stale-callback protection. Legacy hold remains compatible.
- `app/globals.css`: only a narrow token-based recording pulse and reduced-motion override. Reconcile these additions with the separate feedback chat; no broad theme rewrite.
- `AGENTS.md` and `docs/features.md`: voice behavior documentation only.

Tests changed/added: `tests/coach/tap-dictation.test.ts`, `tests/coach/composer/tap-control.test.tsx`, `tests/coach/composer/toolbar.test.tsx`, `tests/coach/history-source-compose.test.tsx`, `tests/voice/hold-live.test.ts`.

Source identities: `primary-audit-source-hashes.json`. Temporary `app/auth/composer-proof/page.tsx` has been removed; a fixture copy remains as `.txt` evidence only. No schema, account data, Foods/Shopping implementation, provider model pin, TTS architecture or production configuration changed.

## Evidence

Read `primary-audit.md`, `acceptance.md`, `implementation-checks.md`, and `full-suite-disposition.md`. The full local suite ran once: 7,174 passes, 962 skips, three failures resolved in targeted follow-ups; do not claim a second full green run. Final narrow source review: `opus-corrective-review.md`. Jev narrow checks: `jev-final-review.md`. Visual reviews: `gemini-final-visual-review.md` and `astra-final-visual-review.md`.

Native microphone access passed. Final rendered synthetic-transcript flows and touch-cancel/layout checks passed, with JSON receipts and eight final screenshots. The UI fixture has no authenticated server; real transcription quality, physical-device behavior, real IME and production remain unverified. Ego space 6 and the owned 3106 dev server are closed. Parent 3105 was untouched.

The parent owns the 15 Foods/Avoids/Shopping acceptance items, shared integration, final combined Astra audit, CI and deployment verification. This handoff is local voice acceptance, not whole-product release approval.
