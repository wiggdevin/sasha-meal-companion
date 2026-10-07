# Opus R1–R5 correction review

Returned canonical model `claude-opus-5-5`, provider `firstParty`, success (`is_error=false`), duration 57.836 s. Existing Max OAuth route with API-key/endpoint overrides cleared. Session `f3022994-fbba-4bd6-8be5-035652117a7f`. No tools, delegation, browser or edits.

Scope: current six client/test files and their delta from the preceding frozen review; R1–R5 corrections only. Raw envelope: `opus-r1-r5-review.raw.json`; exact full parsed review: `opus-r1-r5-review.result.json`; frozen hashes: `opus-r1-r5-source-hashes.json`; packet: `opus-r1-r5-review-packet.txt`.

| Finding | Resolved in requested scope | Evidence |
|---|---|---|
| R1 | YES | CoachMic.tsx:126-127 and 131-132: onPointerUp was removed. The guard is set on pointerdown in record mode and cleared only by onPointerCancel or at the start of onClick. Composer.tsx:41-43: the secondary Send clears the guard inside onClick, before send(). Its onPointerUp was removed. use-composer-input.ts:35: blur keeps editing=true while recordPointerDown.current is true, so readyToSend stays false and the main control stays 'record' through the click. tap-control.test.tsx:61-66 test the Record order pointerDown, pointerUp, blur(null), click and assert Stop with no send. Lines 143-148 test the same order for the secondary Send and assert the same element and exactly one send. |
| R2 | YES | hold.ts:220-229: in tap mode the second empty end returns before apply({type:'fallback'}), so state.fallback is never set and begin() (line 145) calls listen() on the next tap. With no transcript, abandon({text: NO_SPEECH_COPY, ms: 0}) shows the tap-mode line (hold.ts:365-366). abandon() re-reads the box first, so typed text is kept (hold.ts:338-340). With words, the path is finalising, then finalised, then settleSpeech, and it writes the box without calling send (hold.ts:223-227, 323-325). no-speech goes through the same handleSessionEnd (hold.ts:172-177). The interim promotion moved there (hold.ts:206-208), so both the onEnd and no-speech paths keep interim words. |
| R3 | YES | CoachMic.tsx:137-138: busy no longer sets the native disabled attribute (unless the whole composer is disabled). It uses aria-disabled=true. CoachMic.tsx:131-135: in busy mode onClick only clears the guard. No branch runs, so keyboard or pointer activation does nothing. pointerdown in busy mode does not set the guard (line 126). tap-control.test.tsx:36-42 asserts aria-disabled, disabled=false, focus retained, and that a second click is ignored. |
| R4 | YES | CoachMic.tsx:139: when mode is busy the label is 'Transcribing voice message' only if view.busy (clipState==='transcribing', hold.ts:53). Otherwise it is 'Finishing recording', which covers the finalising, opening and flushing states. tap-control.test.tsx:36 and 41 assert 'Finishing recording' for the native finalise. |
| R5 | YES | tap-dictation.test.ts:160-163 (no-speech ×2) and 169-175 (onEnd ×2) assert the notice text, that the next tap calls listen() (speech length 3), and that no recorder is used. tap-dictation.test.ts:177-186 assert retained words, no send, and that the listener is reused. Still open from the original R5: no test proves the reduced-motion CSS applies. globals.css is not in this delta. |

R5 is YES for the added silent-termination/next-listener regression checks. The original reduced-motion rendered-proof gap remains a verification limit, not a newly identified code defect.

## Remaining observations

Both findings below remain **OPEN** for the resumed final interaction/device pass. They are not silently waived, and this source is not labeled clean. Their exact scope is the six-file frozen packet and hashes above. Release remains blocked separately by the missing annotation inventory/voice scope, browser handoff and Kimi HTTP 402.

- **low**, `components/CoachMic.tsx:126-127; components/coach/use-composer-input.ts:35,55-56`. Trigger: The user presses Record or the editing Send (pointerdown), drags off the button and releases, so no click fires. A mouse drag gives no pointercancel. On touch this happens when the finger slides off without a scroll starting. Impact: recordPointerDown stays true until the next click on an action. A later textarea blur that leaves the composer then keeps editing=true. The main control shows Record instead of Send for an idle draft. The secondary Send stays visible, so sending is still possible. This is a stale-state and labelling issue with no data loss. Possible fix: also clear the guard on pointerleave, or on a document-level pointerup that is deferred past the click.

- **low-medium (pre-existing exposure, not introduced; the delta keeps it)**, `lib/coach/hold.ts:219-228 with use-composer-input.ts:57-61 and CoachMic.tsx:116-118,134`. Trigger: A tap recording has words, or a typed draft, and ends by itself after two empty recognizer endings (about two silence timeouts). The user taps Stop at the moment the control changes. Impact: The auto-terminate unlocks the composer. onListening(false) sets editing=false and readyToSend=true, so the main control changes from Stop to Send without user action. A single Stop tap that lands after that re-render sends the draft. The detail>1 guard only covers double taps. The same change occurred before this delta through the fallback path, so R2's change does not make it worse. It remains a concrete risk of an unintended send.

## Limits

- No tests, tsc or lint were executed. The reported 319-test pass was not verified.
- The R1 proof comes from DOM tests. Real iOS Safari, Android Chrome, Firefox and desktop Safari pointer, blur and click ordering is not verified, and neither is the claim that the compatibility mousedown does not focus the button.
- The R3 focus-retention assertion is weak evidence: jsdom does not blur an element when it becomes disabled. The meaningful proof is disabled===false. Real screen-reader announcement of aria-disabled was not verified.
- No DOM test asserts the 'Transcribing voice message' label for the recorder path. Only the controller's busy flag is tested.
- The reduced-motion CSS test gap from the original R5 remains.
- Not reviewed: dictation.ts reducer semantics beyond what the call sites imply (settled or segment events keeping fallback=false); live-listener, recorder or server paths; the hold (non-tap) mode regressions beyond visible diff lines; the other annotations; the release; or browser and physical-device behavior.
- The interim-promotion and final-tail deltas were checked only for defects this change could introduce. None were found: the promotion moved into handleSessionEnd and covers both entry points.

Source changed after this frozen packet: none at receipt time.

No full annotation, physical-device, production or release approval is given.
