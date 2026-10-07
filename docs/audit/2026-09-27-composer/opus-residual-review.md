# Opus final residual interaction review

Canonical returned model `claude-opus-5-5`, provider `firstParty`, success (`is_error=false`), duration 70.863 s. Existing Max OAuth route; keys and endpoint overrides cleared. Session `032a4bf9-439b-4629-886d-fa604213e863`. Reviewer had no tools or delegation.

Scope: six frozen client/test files and delta from the preceding R1–R5 packet. The packet hashes exactly match the code agent’s final four changed-file hashes. Raw provider receipt: `opus-residual-review.raw.json`; full parsed findings: `opus-residual-review.result.json`; frozen identity: `opus-residual-source-hashes.json`; input: `opus-residual-review-packet.txt`.

| Check | Result |
|---|---|
| Residual drag guard resolved | NO (mouse/pen resolved; touch remains) |
| Autonomous-completion Send risk resolved | YES (new chained timing observation below remains) |
| Activation timing safe | YES within committed-state traces |

**Not a clean approval.** The touch guard remains open; source-derived low-risk timing and stale-activation findings require triage. Real pointer behavior has not been reproduced here.

## Evidence

- **drag guard mouse pen:** Resolved. Mouse and pen give pointerleave with buttons!==0 while the button is held and the pointer leaves. CoachMic.tsx:145-147 and Composer.tsx:43 then clear recordPointerDown, and the main control also clears activationMode.

- **drag guard touch:** Not resolved. Touch has implicit pointer capture, so no pointerleave fires while the finger is down. After pointerup and lostpointercapture, pointerout and pointerleave fire with buttons=0. That is the case the code deliberately keeps. A touch drag-off with no scroll (so no pointercancel) and no click still leaves recordPointerDown=true. The test at tap-control.test.tsx:155-175 fires a touch pointerLeave with buttons=1 before pointerUp. A real touch browser does not send that sequence, so the test proves the mouse case only. The impact is unchanged from the prior finding: low, a label problem only. The secondary Send stays reachable, and the next click on any composer action clears the guard. This follows from the requested trade-off, which keeps the guard on buttons=0.

- **autonomous review gate:** Resolved. publish (CoachMic.tsx:100-103) sets reviewNeeded on every locked→unlocked transition that is not a manual Stop and has text: silence, error, max-duration and pagehide. mode puts review ahead of send (:132). send() refuses while reviewNeeded (use-composer-input.ts:17). The secondary Send is hidden (Composer.tsx:39), which also blocks textarea Enter. Acknowledging Review only moves the control to Send (:163) and never sends in the same click. Tests at tap-control.test.tsx:177-274 cover pointer, keyboard Enter, pointerdown after completion, failure, max-duration and pagehide.

- **manual stop path:** The Stop branch sets manualStop=true (:165). The unlock publish then gives reviewNeeded=false and resets manualStop, so the control goes busy, then Send. The detail>1 guard (:161) and the latch cover the second click of a double tap.

- **latch pointer:** pointerdown records the committed mode. If a re-render between pointerdown and click changes the mode, the click is dropped (:157-160). Stop/busy → Review/Send is blocked, and the latch resets on click, cancel, active leave and blur.

- **latch keyboard:** Enter fires click during keydown, so the latch is set and read in the same task. Space fires click on keyup, so a Stop keydown held across an automatic completion gives a keyup click that the mismatch drops. Repeated keydown is prevented (:152).

- **lifecycle:** pagehide and visibilitychange call hold.cancel(), then abandon, then an unlocked publish, which sets Review when the box has text. Unmount calls cancel as well. The busy/settling state is aria-disabled and no click branch acts on it.

## New concrete observations

- **low**, `components/CoachMic.tsx:130-133,156-165; lib/coach/hold.ts:79-83,219-227`. Trigger: Automatic silence completion runs setState from a non-React SpeechRecognition 'end' callback. That update has default priority and is not flushed until a later task, so a pointerdown, pointerup and click can all land before the commit. Both the latch and the click closure then still see mode 'stop'. Impact: It does not send and does not acknowledge Review. The Stop branch sets manualStop=true and calls toggleTap(). The controller is no longer holding, so press() starts a NEW recording where the user meant to stop. manualStop stays true through that new session. If the new session then ends by itself, the gate treats it as manual: reviewNeeded=false and the control goes straight to Send, so the original risk comes back through a chained case. Possible fix: in the Stop branch, act only when hold.view().listening is true (or derive the mode from hold.view() at click time), and set manualStop only when a release really happens.

- **low**, `components/CoachMic.tsx:61,141-144,149,157-160`. Trigger: A touch drag-off leaves activationMode set, because implicit capture means no buttons!==0 leave arrives and a tap on iOS does not focus the button, so onBlur does not fire either. A later activation arrives with no fresh pointerdown or keydown, for example an assistive-technology click, in a different mode. Impact: The mismatch drops one activation silently, and the next one works. It cannot cause a send or a Review acknowledgement.

## Limits

- I reviewed only the attached source and tests. I ran nothing. The reported 326/326, tsc 0 and lint 0 results are not independently verified.
- There is no browser or device proof of the pointer event order: iOS Safari compatibility focus and click after pointerup, Android Chrome with pointercancel on pan, and Windows or desktop pointerleave. The touch analysis relies on the Pointer Events implicit-capture rules.
- The jsdom tests wrap controller callbacks in act(), which flushes updates at once. They cannot show the render-lag window in the first bug.
- While Review is pending, textarea Enter does nothing and shows no feedback. This follows from the design (acknowledge before Send) and is not treated as a defect.
- Only voice input was in scope. No TTS, no land and no all-annotation approval were assessed.

Source drift since packet: none at receipt time.

No browser, Kimi, code edit, commit, push or land action occurred in this review.
