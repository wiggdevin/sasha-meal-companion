# Independent Opus source review

Model returned: `claude-opus-5-5`; provider `firstParty`; `is_error=false`; duration 164.2 s. Existing Max OAuth lane, API-key and endpoint overrides cleared. Reviewer had no tools, no delegation, no writes. Session `fc565b2a-acd7-4c9c-9c23-c821aaaffe08`.

Frozen packet: `opus-review-packet.txt`. Exact 13-file source hashes and packet SHA-256: `opus-review-source-hashes.json`. Raw provider envelope: `opus-review.raw.json`; complete parsed result: `opus-review.result.json`.

Frozen-packet source review only. I ran no tools and no tests, and I made no edits. I did not verify the parent's report of 303 passing tests, typecheck and ESLint. No physical device, real microphone, speech provider, IME or deployed build was checked.

These are source-review findings for triage. Browser-specific claims were not independently reproduced by this reviewer. The reviewer made no claim that all ten annotations were accepted.

| Criterion | Outcome | Primary reason |
|---|---|---|
| V1 | YES | CoachMic.tsx:126-133: pointerup and pointercancel only clear the blur guard. Only a click calls hold.toggleTap(). In tap mode, press() calls begin() at once, with no 300 ms timer (hold.ts:74-75). release() needs the keyboard pointer id, and tap mode always uses it (hold.ts:65, 91). Test: tap-dictation.test.ts:44-57. |
| V2 | NO | B2: A provider can end a recording without a second tap. The Safari recogniser gets only one restart.; B4: The main control changes from Stop to Send at once. A double tap or a repeated Enter sends text the user has not reviewed. |
| V3 | YES | CoachMic.tsx:116-119 picks one mode: busy, then stop, then send (when readyToSend), then record. readyToSend is draft && !editing (use-composer-input.ts:53). Tests: tap-control.test.tsx:20-37 (the same element goes Record → Stop → Send) and toolbar.test.tsx:44-61. |
| V4 | NO | B1: With reduced motion on, the pulse does not stop. It flickers. |
| V5 | YES | B7 (low): withDraft trims the draft, which drops trailing newlines and spaces.; B3: Leaving the page loses the spoken words (graded under V7). |
| V6 | NO | B6: On desktop Safari and Firefox, pressing the editing Send button can remove it before its click arrives, so the tap is lost. |
| V7 | NO | B3: Cancelling on visibilitychange or pagehide writes the old typed draft over the words already dictated. |


## Findings

- **B1 — medium**, `app/globals.css:381-388, app/globals.css:454-460`: The reduced-motion reset sets animation-duration to 0.01ms but does not change iteration-count. The pulse is infinite, so each frame lands at a random point in the cycle and the ring flickers between 4px and 8px instead of standing still. Suggested correction: Add @media (prefers-reduced-motion: reduce) { .coach-recording-button { animation: none; } }, or add animation-iteration-count: 1 !important to the global reset.

- **B2 — medium**, `lib/coach/hold.ts:189-204 (also dictation.ts:117-124)`: In tap mode, Safari ends a continuous session after a pause. Only one restart is allowed (restarts < 1). The second onEnd auto-stops the recording and applies 'fallback', which switches the rest of the page load to the recorder. A no-speech error during a pause also auto-settles. Tap mode makes pauses more likely, so recording often ends without the user's second tap. Suggested correction: In tap mode, keep restarting while holding. Allow unlimited restarts, or cap them by elapsed time rather than count. Treat mid-recording no-speech as a restart, not a settle. Add a test for repeated onEnd.

- **B3 — medium**, `components/CoachMic.tsx:105-112 → lib/coach/hold.ts:124-140, 331-333`: cancel() on visibilitychange (hidden) or pagehide calls abandon(null), which writes this.typed. The live transcript already in the box is replaced by the pre-recording draft. Switching apps during a recording loses the spoken words. This conflicts with the F-131 promise that newer drafts are not overwritten. Suggested correction: When the page hides in tap mode, stop and keep withDraft(transcriptOf(state)) instead of restoring typed.

- **B4 — medium**, `components/CoachMic.tsx:129-133, lib/coach/hold.ts:106-108`: When every segment is final, Stop settles synchronously and the same button becomes Send. touch-action: manipulation removes the double-tap delay, so a double tap on Stop sends at once without review. A repeated Enter keydown on the focused button does the same. Suggested correction: Ignore Send activation for about 300-500 ms after a stop, or require a new pointerdown or keydown after the mode change.

- **B5 — low**, `components/CoachMic.tsx:129-133`: The old onKeyDown guard against e.repeat was removed. Holding Enter on a focused button repeats clicks, which toggles Record/Stop repeatedly or reaches Send. Not verified in a browser. Suggested correction: Add onKeyDown={(e) => { if (e.repeat) e.preventDefault(); }}.

- **B6 — medium**, `components/coach/Composer.tsx:39-43, components/coach/use-composer-input.ts:31-35`: The blur guard covers only Record's pointerdown. In Safari and Firefox on macOS, a click on a button does not focus it, so relatedTarget is null. On mousedown the textarea blurs, editing becomes false, and the editing Send unmounts before the click. The click is lost. iOS behavior is not verified. Suggested correction: Give the editing Send the same guard (onPointerDown → recordPointerDown), or call preventDefault on mousedown. Add a test with relatedTarget null.

- **B7 — low**, `lib/coach/hold.ts:325-328`: withDraft trims the typed draft, so leading or trailing whitespace and newlines are lost after a recording. Suggested correction: Keep typed as it is and add a separator only when needed.

- **B8 — low**, `components/coach/use-composer-input.ts:56-59 with lib/coach/hold.ts:366-371`: Every publish with locked=false calls setEditing(false). This includes notice expiry and an idle cancel on visibilitychange. A user typing within about 3 s of a notice sees the controls flip to Send-main until the next keystroke. Suggested correction: Call setEditing(false) only on a true→false change of locked.

- **B9 — low (doc drift)**, `docs/features.md F-154 row`: The row still says 'a hold' and 'release sends them'. F-131 and AGENTS.md now describe tap and explicit Send. Suggested correction: Change the F-154 row to tap-to-record and no auto-send.

## Required unexecuted checks

- iOS Safari tab and installed PWA: Record/Stop, permission sheet, recogniser restart after pauses, the live socket route, and a 30 s recorder clip
- Android Chrome: keyboard Enter and the reachable Send while the keyboard is open
- A real IME (Japanese or Chinese) committing with Enter
- Reduced-motion rendering and the actual pulse motion
- Blur and click order when pressing the editing Send in desktop Safari and Firefox

The reviewer independently included held-Enter autorepeat (B4/B5), including the exact concern raised after the packet was frozen. No additional review call was necessary.
