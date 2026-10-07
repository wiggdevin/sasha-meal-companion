# Opus corrective interaction review

Canonical returned model `claude-opus-5-5`; provider `firstParty`; success (`is_error=false`); duration 63.049 s. Existing Max OAuth with API-key and endpoint overrides cleared. Session `b8f990f0-66c4-4874-8ede-04384106b9e8`. No tools, delegation, browser or code edits.

Scope: corrections to the residual captured-touch/stale-Stop findings and the fresh-activation-after-cancel follow-up only. Source identities: `opus-corrective-source-hashes.json`. Frozen packet: `opus-corrective-review-packet.txt`. Raw provider receipt: `opus-corrective-review.raw.json`. Complete parsed review: `opus-corrective-review.result.json`.

| Corrective case | Resolved |
|---|---|
| Captured touch drag leaves stale guards | YES |
| Stale Stop restarts recording and mis-tags it as manual | YES |
| Cancelled pointer activation blocks later fresh/assistive Send | YES |

**Concrete new defects: none reported in this delta.**

## Evidence

- **captured touch drag:** Implicit touch capture delivers pointerup to the pressed button with the finger's real clientX/clientY. use-composer-input.ts:77-86 compares that point with currentTarget.getBoundingClientRect(). If the point is outside, it clears recordPointerDown and sets cancelledPointerClick. CoachMic.tsx:152-154 then clears activationMode, and Composer.tsx:43 wires the same handler onto the secondary Send. The later buttons=0 pointerleave is still ignored, but the guard no longer depends on it. The textarea blur that follows sees recordPointerDown=false and exits editing. Both residual findings are closed: prior #1 (recordPointerDown stuck) and prior new-bug #2 (activationMode stuck after touch drag-off). The test at tap-control.test.tsx:179-207 now fires a realistic captured sequence: down inside, move outside, up outside, then leave with buttons=0 and no active leave.

- **trailing click suppression:** onActionClick (use-composer-input.ts:71-76) consumes the cancel flag once and suppresses only when detail>0. A trailing pointer click after an outside release or a pointercancel is dropped. The flag is always reset afterwards, so it never applies twice.

- **stale stop restart:** The Stop branch (CoachMic.tsx:182-185) now reads live hold.view().listening and calls hold.release() rather than toggleTap(). A Stop click landing after auto-end but before the React commit sees listening=false and does nothing. It does not press() and does not set manualStop, which removes the chained manual-mis-tag path. release() with no id matches the KEYBOARD_POINTER that press() stored (hold.ts:62,87). The Record branch uses press(), which is a no-op while the controller is already busy (hold.ts:59), and it is also gated on locked and reviewPending. The test at :263-280 dispatches the click inside act, before the commit, and asserts that no second handler starts and that Review still appears.

- **review ref ordering:** publish writes reviewPending synchronously (CoachMic.tsx:106) before setState. The Send, Review and Record branches read the ref, not the lagging prop. A stale 'send' or 'record' closure therefore cannot bypass Review, and a stale 'review' closure cannot acknowledge anything once the ref is already false.

- **fresh activation recovery:** Every fresh pointerdown resets the cancel flag: main via onActionStart (:148) and secondary via onRecordPointerDown (use-composer-input.ts:62-65). Enter or Space keydown resets it on both buttons (CoachMic.tsx:163, Composer.tsx:46-48). A detail=0 assistive-technology or keyboard click is never suppressed by a stale flag. Tests at :209-238 cover a fresh pointer Send and an assistive-technology Send after an outside release with no trailing click.

- **mode vs live predicate:** Stop mode is derived from view.listening, and the click gate uses the same live predicate, so the gate cannot block a Stop that the UI legitimately offers.

## Limits

- Review only. I executed nothing. The reported 20/20 DOM, tsc, lint, the 328 focused tests and the full-suite results are not verified by me.
- No device proof. The following are assumed from the Pointer Events spec, not observed: iOS Safari's click-after-pointerup ordering and coordinates while the software keyboard is up, Android pointercancel on pan, and whether a real browser emits a click at all after a captured outside release.
- Behavioral note, not a defect: mouse or pen press, leave with buttons held, then re-enter and release inside now cancels the click, because the flag was set on leave and pointerup inside does not clear it. A native button would click. This matches 'leave cancels' semantics.
- Hit geometry is the bounding box. On the round 44px button, corner releases count as inside. This is harmless.
- jsdom returns zero rects when coordinates are unmocked (:36, :248-253, :306-308). Those tests pass because 0,0 counts as inside a zero box, not because the geometry is exercised.
- The act()-wrapped stale-click test models the commit lag but not real scheduler timing against a native SpeechRecognition 'end' task.
- Out of scope and not assessed: TTS, Kimi, land, full-history approval.

Source drift since packet: none at receipt time.

This disposition supersedes the corresponding open residual interaction findings only. It does not establish rendered-browser, physical-device, production, TTS or complete annotation acceptance. Kimi was not called; the user-approved Gemini plus primary Astra replacement is outside this Opus receipt.
