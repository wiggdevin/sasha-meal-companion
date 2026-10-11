# Rules

Thirty checkable rules for a one-thumb phone app, merged from the Claude Design Blueprint ship checklist, Steve Krug's *Don't Make Me Think* and ASD-STE100. Tags: **[BP]** blueprint, **[K]** Krug, **[STE]** ASD-STE100, **[S]** already a Sasha rule, **[new]** proposed. Check at 390 × 844 CSS px first, then 320 and 430.


**Thumb and layout**
1. **One job per screen.** The owner can state the screen's job in 10 words or fewer; the spec for the screen has that sentence. Check: one-screen test #1. [BP, K]
2. **One filled primary per view.** Exactly one olive `primary` button in view, at least 44 px tall; never two primaries side by side. Check: count `variant="primary"` in the render. [S, BP]
3. **Targets.** Every tap target is at least 44 x 44 CSS px with at least 8 px between neighbours. Check: automated bounding-box scan over all `button, a, [role=button], input` in Playwright. [S, BP; WCAG 2.5.8 minimum is only 24]
4. **Thumb zone.** The screen's main action sits in the lower 40% of the viewport (centre y at or below 506 px at 844 px high) or in the dock. Destructive and rare actions go in a sheet or the top bar, never next to the primary. Content has bottom padding of at least the dock height (92 px) plus `env(safe-area-inset-bottom)`. Check: screenshot with a 40% overlay. [new]
5. **No sideways scroll.** Zero horizontal overflow at 320, 360, 390, 430 px and at 200% text zoom; the viewport tag never blocks zoom. Only a declared carousel scrolls on x. Check: `document.scrollingElement.scrollWidth <= innerWidth`. [BP, S]
6. **One scroller.** The page is the only vertical scroller; inline lists cap at six rows then "Show all". Check: `tests/design/scrollbars.test.ts` plus a nested-overflow scan. [S]
7. **Tap budget.** Proposed: at most 3 taps from the dock to finish each of the three most common jobs (tick a planned meal, log water, log a food). The count is written in the screen spec and re-counted in review. Owner to ratify the numbers. [K, new]
8. **Five-second test.** A stranger (or a fresh agent shown a screenshot for 5 seconds) can say what the screen is, what is next, and what to do. Today's first view at 390 x 844 shows calories left and the next meal with no scroll. Check: one-screen test #2 on every tab's first view. [K, BP]

**Type**
9. **Seven sizes only** (12, 14, 16, 20, 28, 40, 64) and two families (Fraunces, Plus Jakarta Sans), at most three weights. Check: `tests/design/scale.test.ts`. [S, BP]
10. **Readable body.** Text a person must read to act (coach replies, notes, explanations, onboarding copy) is 16 px or larger. 14 px is for secondary labels and dense meal data, 12 px for captions and eyebrows only. Text inputs are 16 px or larger so iOS does not zoom on focus. Check: font-size scan by role. Note: today's `body-md` token is 14 px, so this rule needs an owner decision (see drift note 6). [BP #4, new]
11. **Line height and length.** Body line height 1.5 or more (Sasha uses 1.7); display 1.0-1.2; prose blocks (coach messages, notes) capped at 65 ch on wide screens, 45-75 characters on a phone. Left-aligned, never justified. [BP]
12. **Labels.** Every field has a visible label (placeholder is never the label); buttons start with a verb and name the result ("Log it", "Save plan", never "Submit"); sentence case; labels never wrap. [BP, K, S]

**Colour and states**
13. **Contrast.** Text 4.5:1, large text and icons and focus rings 3:1, on every surface the role can sit on; colour is never the only signal (over-target, alert and macro states also carry an icon, a word or a shape). Check: `contrast.test.ts` plus a greyscale screenshot. [S, BP]
14. **Olive is the only action colour.** At most one of yellow/orange/red in a single control; gauge hues are fills, never small text (except `.kcal`). [S]
15. **Tokens only.** No hex or `rgb()` literal in `app/` or `components/`; no inline `style` for type, colour or border. Check: ESLint and `inline-style.test.ts`. [S, BP #12]
16. **Five states.** Every control has default, hover (pointer devices only), focus-visible (ring at least 2 px, at least 3:1), pressed, disabled; plus pending, success and error shown inside the button. [S, BP #13]
17. **Designed empty, loading, error.** Every list and screen has all three. Loading shows a skeleton (or the held-width pending dots) never a blank. Empty says what goes here and the next step. An error sits next to its field, says what went wrong and how to fix it, and never clears what the person typed. Check: force each state in the gallery. [BP #14, simplify-form]
18. **Clickable looks clickable.** Only pressable things look pressable (chips, pills and buttons have a fill or hairline; plain text and gauge labels do not). [K]

**Flows and forms**
19. **Ask only for today.** In onboarding and forms, every field has a written reason it is needed now; anything that can wait is asked later and marked "(optional)". Multi-step flows show "Step 2 of N". Check: the `flow-teardown.md` field count (before/after) is in the PR. [BP, K]
20. **Right keyboard.** Every input sets `type`/`inputmode` and `autocomplete` (numeric for weight, calories; email for email). Validate on blur, not on every key. [BP #19]
21. **Show the answer, not the sum.** Show "calories left", not target and eaten for the person to subtract; show units the person chose (oz, cups, ml; lb or kg) beside every number. Check: per-screen review. [K, S]
22. **Mindless choices.** Where a step has a choice, 2 to 4 clear options with a pre-selected sensible default (Sasha's "Steady" pace chip is the model); never an open question where a chip works. [K, S]

**Copy (STE-style)**
23. **Sentence size.** Instructions up to 20 words per sentence, descriptions up to 25, paragraphs up to 6 sentences. One idea per sentence, active voice, present tense for UI actions ("Moving..."). Check: a word-count script over `messages`/copy files. [STE, S]
24. **One word, one meaning.** A short glossary names each thing once: meal, food, plate, plan, target, Favored, Avoid. No synonyms for the same thing in UI strings. Spell "Supportive Assistant for Smart Health Awareness" at most once (About or onboarding); everywhere else the name is "Sasha". Check: glossary lint. [STE, new]
25. **Voice limits.** No exclamation marks, no emoji, no em dashes in UI copy; none of the AI-tell words in the blueprint list (seamless, unlock, elevate, effortless, cutting-edge, journey, game-changer); no shame words (cheat, guilty, bad food), no instruction to eat. Check: banned-word grep in CI. [S, BP #12, new]
26. **No invented numbers.** Every nutrition figure, percentage and claim traces to a source row or is not shown; unknown is "-" or "Unknown", never 0. [S, BP]

**Motion, speed, PWA**
27. **Motion budget.** Small UI motion 150-300 ms, ease-out, only transform and opacity, at most three things moving at once, text never moves while it is being read, and reduced-motion removes all of it (Sasha's four springs are the only allowed timings). Check: grep for durations outside `lib/design/motion.ts`; run with reduced-motion on. [S, BP #15]
28. **Speed on a mid-range phone.** LCP 2.5 s or less, INP 200 ms or less, CLS 0.1 or less; images carry width/height or aspect-ratio; first-route JS about 300 KB gzip or less (budget to confirm against today's bundle before it becomes a gate). Check: Lighthouse mobile in CI or `pnpm timings`. [BP #16-17, S]
29. **PWA layer.** `theme-color` = the ground colour, maskable icon set, manifest name "Sasha", safe-area insets honoured, one `h1` per screen, real landmarks, keyboard-only path works, offline state says what still works. [BP #18, #20, S]

**Process**
30. **Evidence before "done".** Every UI change ships with a 390 px screenshot, passes the repo's design tests, and gets one fresh-context critic pass (pass/fail against a written `bar.md`, judging the render, not the code); a model from the other family reviews non-trivial diffs. Every owner correction becomes one dated line in a corrections list or a numbered Ban in DESIGN.md. Reference screens are named, openable and credited in a code comment. [BP #9-10, #15; house rules]

