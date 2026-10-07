# Tap composer implementation checks

Branch `feat/sasha-tap-composer`, base `aa7946c`; checks run 2026-09-27 in the isolated worktree. Source is uncommitted pending independent review.

| Check | Command | Result |
| --- | --- | --- |
| Focused controller, DOM, legacy hold, live voice, toolbar and file-size tests | `mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/coach/composer/toolbar.test.tsx tests/coach/composer/tap-control.test.tsx tests/coach/hold.test.ts tests/voice/hold-live.test.ts tests/speed/file-size.test.ts --reporter=dot` | 6 files, 303 tests passed |
| Type check | `mise exec -- pnpm exec tsc --noEmit` | Exit 0 |
| Focused lint | `mise exec -- pnpm exec eslint --max-warnings 0 components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts lib/coach/hold.ts tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx` | Exit 0 |
| Enforced file sizes | `wc -l lib/coach/hold.ts components/coach/Composer.tsx` | 398 and 52 lines; focused guard passed |

The focused tests cover explicit Send after speech, typed draft preservation, pointer blur, cursor return, IME Enter, permission denial, late callbacks, cancellation, listener max-duration signal, recorder ceiling, and the busy state while a clip transcribes. The browser permission prompt is awaiting user handling; the live microphone flow is not yet browser verified. The full suite and independent review are separate gates.

## Post-review implementation delta

The current focused result supersedes the 303-test result above. Opus review led to fixes for reduced-motion pulse, bounded native restarts after speech, no-speech restart, preservation of visible words on cancel or provider failure, typed whitespace, keyboard repeat, double-click Send, mobile pointer blur, and waiting for the complete final-result batch after Stop. The existing live listener's finalise deadline is retained.

| Check | Command | Result |
| --- | --- | --- |
| Focused controller, DOM, legacy hold, real live-listener rig, toolbar and file-size tests | `mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/coach/hold.test.ts tests/voice/hold-live.test.ts tests/speed/file-size.test.ts --reporter=dot` | 6 files, 317 tests passed |
| Type check | `mise exec -- pnpm exec tsc --noEmit` | Exit 0 |
| Focused lint | `mise exec -- pnpm exec eslint --max-warnings 0 components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts lib/coach/hold.ts tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/voice/hold-live.test.ts` | Exit 0 |
| Enforced file sizes | `wc -l lib/coach/hold.ts components/coach/Composer.tsx` | 398 and 55 lines; guard passed |

Current source and focused-test SHA-256 hashes (`shasum -a 256`):

```text
b3e60fded04eb53226b210cc07d4b7397ba001e010fa4d3d4a0cff75a28403e1  app/globals.css
2051810e91e0c49239c48f593b6e638f18f9425ca621f67c0f24b1033925f5bd  components/CoachMic.tsx
b8779cd43620d0f3e16920bd4e657324ad959534c572712c5c16cb69c78b00fd  components/coach/Composer.tsx
0e9cab79f602b113b897700cf1ccd176d292fb2b09e2dbd0aebe210293a66cc2  components/coach/use-composer-input.ts
e7864dce1835748d5451e495b0a5486521300eee5d94e26aa53679e58632f2f5  lib/coach/hold.ts
14d8d18f542016aac18422f1f9e955313dbf7eb343769536c620eb5382f4a9a4  tests/coach/tap-dictation.test.ts
f9b9d0793113b21c1f59ce8cfa16b7c7a763e38628c85ea895a12a9067b02187  tests/coach/composer/tap-control.test.tsx
f0860f91fe94d781f590f4ec966cfa658f18d5b9194a843a3b4d359e29ebb139  tests/coach/composer/toolbar.test.tsx
b20abb72517c31ea1b307b2b0675297da81de07a2c5365a7991b732536f59437  tests/voice/hold-live.test.ts
```

These checks do not verify physical-device recognition, real microphone permission, Safari or Firefox blur order, or production behavior. The browser prompt still awaits user handling. No spoken-reply subsystem was added.

## Interim restart correction

Tap mode now promotes a pending interim phrase in the shared session-end path, so both ordinary `onEnd` and `no-speech` restarts retain it. New regression: interim “one” → recognizer end → final “two” → explicit Stop/end leaves “one two” in the draft, with no send.

`mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/speed/file-size.test.ts --reporter=dot` passed: 2 files, 248 tests. `mise exec -- pnpm exec tsc --noEmit` exited 0. `lib/coach/hold.ts` remains 398 lines; `components/coach/Composer.tsx` remains 55 lines. This was a targeted delta check; the six-file 317-test result above predates this correction.

Updated SHA-256 hashes for the only changed source and test files:

```text
4e1c6e0db113d82a1f7d7161c91158f2334ef3db51cdeb4e2622ee1889896006  lib/coach/hold.ts
0d63f36eab3a305bf9596fac28bd45b91b133bd1f88f16b701487a116e66c510  tests/coach/tap-dictation.test.ts
```

## Touch order and silent listener delta

The action guard now remains through pointerup and clears on click or pointercancel. DOM regressions cover `pointerdown → pointerup → blur(null) → click` for both Record and the editing Send action. Two consecutive empty native endings now leave the listener eligible on the next tap, show the tap-mode no-speech line, and do not silently switch to the server recorder. The main button stays focusable with `aria-disabled` while finishing; the label distinguishes Finishing recording from Transcribing voice message.

`mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/coach/hold.test.ts tests/voice/hold-live.test.ts tests/speed/file-size.test.ts --reporter=dot` passed: 6 files, 319 tests. `mise exec -- pnpm exec tsc --noEmit` and the focused ESLint command above exited 0. `lib/coach/hold.ts` is 399 lines; `components/coach/Composer.tsx` is 55 lines. These checks supersede the earlier counts.

Updated SHA-256 hashes for this delta:

```text
14c2b2c53e9ae9754700e0f429f183760ddde22f60c898d29ea9568247f61fa5  components/CoachMic.tsx
3e8c3ddd831884a8aff973b39802c8a853ac484223ae72a472617d3caa8b3701  components/coach/Composer.tsx
1449534c40ab7ec46c10bda8e9ca48219c1bf97498311f915165876018559ccd  lib/coach/hold.ts
cc28ffbbb2e7cb84ae136f9b03badd86dcf650865307d290df12f0b66674eb65  tests/coach/tap-dictation.test.ts
4dc875bea3239df865d30ec8519173135f613fbde71f9c459bb4962bd96f365e  tests/coach/composer/tap-control.test.tsx
```

## Final interaction guard delta

An autonomous recording end, cancellation, or error that retains text now exposes a neutral **Review recording** main action. Its first activation acknowledges the retained draft without sending; a later explicit Send submits it. A manual Stop still finalizes directly to Send. The composer also latches the mode at pointerdown or keyboard keydown, so a Stop or busy gesture cannot turn into a Send click if the controller finishes between events. Review remains mandatory if the user edits the retained text before acknowledging it.

The pointer blur guard clears when a pressed pointer drags off either action, but stays through `pointerup → pointerleave` with no buttons while a touch compatibility click is pending. The [W3C Pointer Events pointerup definition](https://www.w3.org/TR/pointerevents/#the-pointerup-event) requires `pointerout` and `pointerleave` after `pointerup` on devices without hover, which is why an unconditional leave reset is unsafe. Tests cover both orders, a late Stop pointer/click and keyboard activation, automatic silence with speech and typed text, network failure, pagehide cancellation, native recording ceiling, and manual Stop. These are DOM/controller proofs; physical touch-browser behavior remains unverified.

| Check | Command | Result |
| --- | --- | --- |
| Focused controller, DOM, legacy hold, real live-listener rig, toolbar and file-size tests | `mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/coach/hold.test.ts tests/voice/hold-live.test.ts tests/speed/file-size.test.ts --reporter=dot` | 6 files, 326 tests passed |
| Type check | `mise exec -- pnpm exec tsc --noEmit` | Exit 0 |
| Focused lint | `mise exec -- pnpm exec eslint --max-warnings 0 components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts lib/coach/hold.ts tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/voice/hold-live.test.ts` | Exit 0 |
| Enforced source sizes | `wc -l lib/coach/hold.ts components/coach/Composer.tsx components/CoachMic.tsx` | 399, 56 and 201 lines |

SHA-256 for the four files changed in this final delta (`shasum -a 256`):

```text
82c92815c8fa051d47931ef7067e3eed7a64a0b20752689eff54dbb043906da4  components/CoachMic.tsx
81641e40ee6251613a93a8071c4ffe0f4a264fa9bd950003877511a8268fbc0b  components/coach/Composer.tsx
29575d268fae369ff6d9e949c1770b82c8102909301ec3e4ab6b43d8c4b72cbd  components/coach/use-composer-input.ts
0b2fdf1772ce230175e464da9152894e729101679a5468529f3d5b6556c91414  tests/coach/composer/tap-control.test.tsx
```

## Full-suite follow-up: history retry assertion

The one full suite run by the primary agent exposed a stale expectation in `tests/coach/history-source-compose.test.tsx`: the composer has no Send control when its draft clears and the microphone is unavailable. The updated boundary test checks the disabled textbox, attempts a different text plus Enter without issuing another post, and verifies Try again reuses the original message ID, null thread ID, and original text. No product code changed in this follow-up.

`mise exec -- pnpm exec vitest run tests/coach/history-source-compose.test.tsx --reporter=dot` passed: 1 file, 4 tests. `mise exec -- pnpm exec eslint --max-warnings 0 tests/coach/history-source-compose.test.tsx` and `git diff --check -- tests/coach/history-source-compose.test.tsx` exited 0. No second full-suite run was made.

```text
5b8e9fbcb0274f9ec4c92b75a0e82dbcca24b161aacf09e634e50eb45673ed07  tests/coach/history-source-compose.test.tsx
```

## Post-Opus touch capture and stale-render correction

The composer now tests the pointer's release coordinates against its action button. An outside release clears the blur guard even when touch pointer capture suppresses an active `pointerleave`; an inside release still preserves the guard through the zero-button leave and compatibility click. An outside release also cancels any trailing click on that action. The same callback serves the main control and the editing Send action. Existing active-leave tests now identify a mouse pointer instead of implying that captured touch emits that event.

The main button checks `hold.view()` at click time. A stale Stop click after an autonomous end cannot call `toggleTap()` and open another recording; manual Stop calls `release()` only while the controller is listening. Record calls idempotent `press()`. A synchronous review-pending ref closes the gap before React commits the Review state, and Send/Review actions refuse a controller that is still locked. Tests exercise an automatic end and native button click in the same React `act`, as well as captured touch moving off, releasing outside, and attempting a trailing click.

| Check | Command | Result |
| --- | --- | --- |
| Focused controller, DOM, legacy hold, live listener, toolbar and file-size tests | `mise exec -- pnpm exec vitest run tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx tests/coach/composer/toolbar.test.tsx tests/coach/hold.test.ts tests/voice/hold-live.test.ts tests/speed/file-size.test.ts --reporter=dot` | 6 files, 328 tests passed |
| Type check | `mise exec -- pnpm exec tsc --noEmit` | Exit 0 |
| Targeted lint | `mise exec -- pnpm exec eslint --max-warnings 0 components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts tests/coach/composer/tap-control.test.tsx` | Exit 0 |
| Whitespace check | `git diff --check -- components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts tests/coach/composer/tap-control.test.tsx` | Exit 0 |
| Source sizes | `wc -l components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts lib/coach/hold.ts` | 220, 60, 95, 399 lines |

Changed-file SHA-256:

```text
e676e0a2de46def8f5a5f0f7cad5aa8b4d69d1b25cdbff787da31e12421f74e0  components/CoachMic.tsx
9e7b303b20acf9ca5f67348c94803c4b929b6f2faba369a9989b6a217dd14aa4  components/coach/Composer.tsx
4dbd46a099ebcdf343e4c0feaa57711a66f1525e175e477a548184845457f122  components/coach/use-composer-input.ts
b89375c96904c73cee093e2a605cc04839e03fff59ca1fb323af7383f94d976c  tests/coach/composer/tap-control.test.tsx
```

This is DOM/controller evidence; physical touch-browser event behavior is still unverified. The once-only full suite was not repeated.

## Fresh activation after a cancelled touch

The outside-release cancellation token now resets on every fresh action pointerdown, including when the main control has changed from Record to Send. A detail-0 assistive or keyboard click is also allowed even if no trailing pointer click arrived after the cancelled touch. The trailing pointer click with detail 1 remains blocked. Two new DOM regressions cover the fresh pointer and assistive activation cases.

`mise exec -- pnpm exec vitest run tests/coach/composer/tap-control.test.tsx --reporter=dot` passed: 1 file, 20 tests. `mise exec -- pnpm exec tsc --noEmit`, `mise exec -- pnpm exec eslint --max-warnings 0 components/CoachMic.tsx components/coach/Composer.tsx components/coach/use-composer-input.ts tests/coach/composer/tap-control.test.tsx`, and the focused `git diff --check` exited 0. The broader 328-test focused result above predates this two-test delta; no full suite was repeated. File sizes are 221, 60, 95, and 399 lines respectively for CoachMic, Composer, use-composer-input, and hold.

Updated SHA-256:

```text
51ca7742e6f7fe2243013108ebea248c3109483e3b4e90ee6bc54fbe6c626497  components/CoachMic.tsx
6ab56567f0744667982accf65cee44fd9557f81d3eff7117cecbb77e10066e41  components/coach/Composer.tsx
c7733bba2a80b1eadb64bd9d4a91cb7a688eef3a8200089abb44f85510098e8f  components/coach/use-composer-input.ts
41cd54b8be18a087d1651f5a0d4133a8c1669f7dc2aa9216e84ccf92746fbe16  tests/coach/composer/tap-control.test.tsx
```

## Post-browser fixture cleanup

The temporary composer-proof app route was removed after preserving its source as `composer-proof-fixture.txt`. The first post-removal typecheck found a stale `.next/dev/types/validator.ts` reference to the removed route; `next typegen` regenerated canonical route types, and the four owned generated dev type files were removed after the server stopped. No source types were edited. Final `mise exec -- pnpm exec tsc --noEmit` exited 0 (`post-harness-typecheck-final.log`). Production source hashes still match the reviewed snapshot. `cleanup-proof.json` records route removal, fixture preservation and port state. No full-suite rerun or commit occurred.
