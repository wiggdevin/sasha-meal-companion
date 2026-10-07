# Sasha composer acceptance evidence

Base: `aa7946c15c6a5754cca7ebc7e47296329c25a342`.
Work: `feat/sasha-tap-composer`, isolated managed worktree.
Original input: `original-composer.png`, copied from the supplied temporary screenshot.

## Coordinated scope

Parent chat `01a0ddbb-e834-7da1-b848-d159392fd1b5` reports that the exact inventory is now 15 Foods/Avoids/Shopping annotations and owns their implementation and root-cause/data fixes. This chat owns voice/composer only; it must not duplicate Foods work. The parent will coordinate integration and the combined Astra audit before landing.

The separate feedback chat `01a0e51e-9d66-72f3-98dc-de0624a77d9a` owns reusable outcome-feedback primitives. This change uses only narrow composer styling. Record → Stop → review → Send remains the reversible interaction interpretation. No new spoken-reply architecture is authorized here.

## Voice requirements

These V identifiers organize the voice prose; the 15 Foods annotations belong to the parent acceptance inventory.

| ID | Acceptance | Verifier 1 | Verifier 2 | Evidence/status |
| --- | --- | --- | --- | --- |
| V1 | One tap starts recording; pointer/key release does not stop it | Opus YES, source scope | Jev initial YES; stale | Implemented and covered by focused tests; final rendered synthetic flow passed |
| V2 | Another tap stops; recorded words remain for review and explicit Send | Opus YES, source scope | Jev J1/J3 YES, narrow source checks | Implemented with final-tail preservation; explicit-send interpretation retained per parent coordination |
| V3 | Empty composer offers Record; manual Stop leads to Send in the main control; automatic completion requires Review first | Opus YES, source scope | Jev initial YES; stale | Implemented; final rendered synthetic flow passed |
| V4 | Recording immediately shows red Stop and gentle pulse; reduced motion disables animation | Opus YES, source scope | Gemini YES for static red Stop only | Runtime animation/reduced-motion checks and Gemini/Astra final visual reviews passed |
| V5 | Typing and recording preserve the draft; adding/editing remains possible | Opus YES, source scope | Jev initial YES; stale | Rendered editing and draft preservation passed; physical-device behavior remains unverified |
| V6 | Enter sends, Shift+Enter keeps a newline, composition does not submit; mobile has a reachable Send | Opus YES, source scope | Jev J4 YES for Enter/IME guards | DOM, rendered Enter/Shift+Enter and final Opus correction review passed; real IME/device proof remains outside these checks |
| V7 | Permission errors, late events, cancellation, disabled state and fallback leave usable controls | Opus YES, source scope | Jev J2 YES for live Stop state/release | Focused tests, rendered synthetic permission-error/cancel recovery and Opus correction review passed; real provider end-to-end proof remains unverified |
| V8 | Preserve existing voice architecture | Source inspected | Parent scope ruling | Dictation exists; no spoken-reply runtime found. No TTS subsystem added. Original spoken-reply question is outside this voice-only implementation scope |

## Review/release gates

Use Jev for discrete evidence questions, Opus 5.5 for complex behavior, Gemini 3.8 Flash and independent Astra (the approved Kimi replacement) for rendered visual checks. Missing/failed reviewer calls do not count as reviews. Two independent outcomes are required per supplied annotation, followed by Astra's final audit before commit/push/merge/deploy. Local component tests and a rendered harness do not establish real-device microphone/provider reliability or deployed behavior.

## Interim evidence (not release approval)

- Latest broad focused gate: 328 tests passed across six files; the final cancellation delta then passed 20/20 DOM tests plus TypeScript and targeted lint. Counts overlap. Exact commands and source hashes: `implementation-checks.md`.
- Additional voice regression run: 14 files, 117 passed, 5 skipped (database integration prerequisites absent); `voice-regression-tests.log`. This overlaps the earlier live-controller file; counts are not unique totals.
- Repository lint and feature-document check: exit 0; 156 documented features, no path problems (`lint.log`).
- Final Gemini and independent primary Astra visual reviews passed six checks across eight screenshots: main control states, reachable editing Send, red Stop, 390 px fit, error legibility and distinct Review/Send. Runtime receipts separately prove animation progress, reduced-motion override and local synthetic flow. The JSON output is fixture scaffolding.
- Fresh Jev `jev-1.13.0` checks J1–J5 all returned YES (reported confidence 0.95–1.00), limited to Review, live Stop, tap settlement, IME guards and reduced-motion source. See `jev-final-review.md`. Earlier broad V1–V7 answers remain stale; no answer replaces behavioral evidence.
- User confirmed microphone permission. Space 6 resumed; a real audio track opened and stopped, followed by synthetic-transcript rendered tests. Browser and owned server were then closed, and the temporary app route was removed. Physical-device and real provider transcription remain unverified.
- Kimi K3's image request returned HTTP 402. The user approved Gemini plus another available reviewer; primary Astra supplied the second visual review against final screenshots. Kimi credit is no longer a blocker.
- Parent owns the 15-item inventory and final combined audit. The full suite ran once: 7,174 passed, 962 skipped, three failed; all three affected specs passed targeted follow-ups. See `full-suite-disposition.md`. No commit, push, PR, merge or deployed verification occurred. Browser handoff is resolved; Gemini/Astra visual reviews are complete. Parent integration remains open.

Opus source-level YES answers are bounded by their frozen packets. The final corrective review passed all three remaining checks (captured touch drag, stale Stop restart, cancelled activation recovery) and reported no new concrete defects. Final rendered evidence is complete for the local synthetic flow; parent integration gates remain open.
