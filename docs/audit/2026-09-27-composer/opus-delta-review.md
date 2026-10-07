# Opus revised-source review

Returned canonical model `claude-opus-5-5`, provider `firstParty`, success (`is_error=false`), duration 144.07 s, Max OAuth route. Session `f964904e-7f14-4826-8c66-785a35203b2d`. No tools or model delegation were permitted.

Raw envelope: `opus-delta-review.raw.json`. Complete result: `opus-delta-review.result.json`. Frozen source/packet identities: `opus-delta-review-source-hashes.json`; input packet: `opus-delta-review-packet.txt`.

Static review of the frozen source and supplied tests only. I did not run the 317 tests, tsc or lint, and I did not use a browser, device or production. Talk-to-talk (V8) is out of scope. None of the ten missing annotations is approved.

**This is not a clean approval:** V1–V7 each received YES within static source/test scope, but R1/R2 remain actionable and B2 remains unresolved. Physical-device claims remain unproven.

| Criterion | Source/test outcome |
|---|---|
| V1 | YES |
| V2 | YES |
| V3 | YES |
| V4 | YES |
| V5 | YES |
| V6 | YES |
| V7 | YES |

| Prior finding | Resolved | Reason |
|---|---|---|
| B1 | YES | globals.css:455 sets animation:none on .coach-recording-button inside prefers-reduced-motion, so the ring stays at its static 4px shadow. |
| B2 | NO | The bounded restart part is correct: the budget resets on non-empty speech (hold.ts:160), no-speech is a restart (174-183), and repeated empty ends terminate, which prevents a hot loop. But termination still applies {type:'fallback'} (hold.ts:221-224). That sets fallback:true for the rest of the page load, so every later tap uses the server recorder. When nothing was heard, quiet() also shows no notice. The original B2 complaint about the page-wide fallback switch therefore remains. The deliberate contract asks for termination, not a capability downgrade. See R2. |
| B3 | YES | Tap-mode cancel() and abandon() re-read the box before restoring it (hold.ts:127, 334), so pagehide/visibilitychange keep the visible transcript. Test: tap-dictation.test.ts:148-158. |
| B4 | YES | Stop now enters 'busy' (disabled) until onEnd or the timeout, so a second tap usually lands on a disabled button. Send also ignores click.detail>1 (CoachMic.tsx:134) and keydown repeat (129-131). No arbitrary delay is added. The effect of detail on iOS touch double-taps is unverified. |
| B5 | YES | CoachMic.tsx:129-131 calls preventDefault on repeated Enter/Space keydown in every mode. Test: tap-control.test.tsx:88-110. |
| B6 | YES | The editing Send now sets the same pointer guard (Composer.tsx:41-43), and relatedTarget=null is tested (tap-control.test.tsx:129-142). This covers the desktop order pointerdown -> blur -> pointerup. The iOS order is not covered (R1). |
| B7 | YES | Tap-mode withDraft keeps typed text untrimmed. Test: '  another draft\n' + 'spoken'. |
| B8 | YES | use-composer-input.ts:57-61 clears editing only when locked changes from true to false. Notice expiry no longer flips the control. Test: tap-control.test.tsx:112-127. |
| B9 | YES | The F-154 row now describes one tap to start, a second tap to stop and an explicit Send, with no auto-send. This matches F-131. |

## Final transcript tail

YES: After Stop, tap mode sets phase='finalising' directly (hold.ts:103) and never applies the hold release rule, so an all-final state does not settle at once. Each final segment in finalising is added through a 'listening'-phase transition and then forced back to 'finalising' (163-165), so the first final does not trigger settle(). Settlement happens only on onEnd (handleSessionEnd:207-208) or when the finalise timer fires with session?.finaliseMs ?? FINALISE_MS (119-122). That preserves the live session's longer deadline. A non-aborted error after Stop with words present settles through failed() -> settle -> settleSpeech; 'aborted' is ignored. Tests: the multi-final batch (tap-dictation.test.ts:79-92), the timeout flush (94-110), the live multi-final (hold-live.test.ts:203-216) and a slow live token beyond 800 ms (218-233).

## Remaining findings

- **R1 — medium-high (source-derived; needs device proof)**, `components/coach/use-composer-input.ts:32-36, 55-56; components/CoachMic.tsx:126-128; components/coach/Composer.tsx:41-43`: The blur guard depends on pointerdown -> blur -> pointerup, which is the desktop mouse order. On iOS touch, the compatibility mousedown that moves focus off the textarea fires after pointerup/touchend. By then onRecordPointerDone has cleared the flag. The button usually does not take focus, so relatedTarget is null and editing becomes false. With a typed draft, readyToSend becomes true and React commits a re-render before the click. Tapping Record can then run the 'send' branch and submit the draft instead of recording. The editing Send can also unmount before its click. The tests encode only the desktop order. Suggested fix: Keep focus in the textarea by calling preventDefault on mousedown for [data-composer-action] buttons. Alternatively, clear the guard in the click handler or after it, not on pointerup. Add a test in the order pointerDown, pointerUp, blur(relatedTarget:null), click that asserts Record starts and nothing is sent.

- **R2 — medium**, `lib/coach/hold.ts:221-224 with lib/coach/dictation.ts:153-158`: In tap mode, two consecutive empty session ends (onEnd or no-speech) terminate through {type:'fallback'}. This sets fallback:true for the page load, so later taps skip on-device or live recognition and record to the server. When nothing was heard it also stops silently, with no NO_SPEECH notice. An ordinary long silence therefore downgrades capability. That contradicts dictation.ts, where no-speech and max-duration are explicitly not fallback reasons. Suggested fix: In tap mode, terminate without setting fallback. Settle if words exist; otherwise show the no-speech notice. Reserve fallback for listen()===null and FALLBACK_ERRORS. Add a test that the next tap calls listen() again.

- **R3 — low**, `components/CoachMic.tsx:138`: The main control is disabled while busy/settling, so a keyboard user whose focus is on Stop loses focus. Browsers move it to body. The user must re-navigate to reach Send. Suggested fix: Use aria-disabled and ignore clicks in the handler while busy, keeping the button focusable.

- **R4 — low**, `components/CoachMic.tsx:139`: The busy label says 'Transcribing voice message' during on-device or live finalise, not only during server transcription. Suggested fix: Use a neutral label such as 'Finishing recording' while view.settling is true and view.busy is false.

- **R5 — low (test gap)**, `tests/coach/tap-dictation.test.ts:127-146`: The silent-termination test asserts only unlocked and does not check the fallback flag, the next listener choice or the notice, so R2 is not detected. No test checks that reduced-motion CSS applies. Suggested fix: Assert that the next toggleTap calls listen() again and that a no-speech notice is shown.

## Source-version boundary

While this frozen review ran, a narrow interim-word-preservation change was made to: `lib/coach/hold.ts`, `tests/coach/tap-dictation.test.ts`. Its exact diff, hashes and separate follow-up are recorded in the `opus-final-interim-*` artifacts. This review does not silently cover that later source.
