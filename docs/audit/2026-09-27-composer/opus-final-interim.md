# Opus final interim-word delta

Returned canonical model `claude-opus-5-5`, provider `firstParty`, success, duration 24.67 s. Continued the same frozen review session, no tools or delegation.

Outcome: **YES**. No remaining delta defects were reported.

- **counterexample resolved:** Trace with the final source. toggleTap sets holding and phase 'listening'. The interim 'one' sets interim='one', resets restarts to 0 because it is non-empty, and writes 'one' to the box. The ordinary onEnd reaches handleSessionEnd with holding still true. The new tap-only block applies segment{final:true, 'one'} while the phase is still 'listening', which gives finals=['one'] and interim=''. restarts is 0, so the recognizer restarts as speech[1]. The final 'two' gives finals=['one','two'], and the box shows 'one two'. toggleTap then moves to 'finalising' and starts the timer, because heard is true. speech[1].onEnd reaches handleSessionEnd with holding false and phase 'finalising', which applies 'finalised' and settles to 'one two' with no send. In the prior source, the first final segment of the next session cleared interim, so 'one' was lost.
- **no speech preserved:** The tap no-speech branch still requires holding, sets active=false, aborts, and calls handleSessionEnd. handleSessionEnd now does the same promotion, under the same condition (holding true), before the same restart or termination logic. The order and the result match the previous inline promotion. On the termination path, the promoted final and the old unpromoted interim both reach settle through transcriptOf. The existing no-speech test traces to 'first second'.
- **legacy hold preserved:** The new block is gated on interaction === 'tap', and hold-mode onError is unchanged. Hold-mode handleSessionEnd behaves exactly as before.
- **finalising tail preserved:** The promotion sits after the !holding early return, so onEnd after Stop still settles directly from 'finalising' through 'finalised'. transcriptOf already includes any interim, and the promotion never runs in 'finalising', which avoids nextDictation's settle-on-final branch there.
- **bounded restart safety:** The promotion calls apply() directly and does not pass through the onSegment handler. It therefore does not reset `restarts`; that reset happens only in onSegment when real text arrives. Two consecutive empty ends still terminate after one restart, so no new loop is possible. On the recorder path, carried = transcriptOf(state) gives the same string before and after promotion.
- **box consistency:** The promotion changes only the state, not the box. The box already shows withDraft(transcriptOf(state)), and transcriptOf gives the same string before and after the promotion, so no duplicate or missing text appears.

This covers only `opus-final-interim-delta.diff`, with final hashes in `opus-final-interim-source-hashes.json`. Raw response: `opus-final-interim.raw.json`; complete parsed result: `opus-final-interim.result.json`.

## Limits

- Static trace of the supplied diff only. I did not run the reported 248 tests or tsc.
- Not checked: whether a real recognizer can deliver a late final for the same phrase after onend, which would duplicate the promoted interim. Browser behavior normally rules this out; no device proof exists.
- Hold mode still drops an interim phrase across a native restart. That behavior is older than this change and outside this delta.
- R1-R5 remain pending, device, browser and production behavior are unverified, and none of the ten annotations is approved.

Source changed after this narrow packet: none at receipt time.
