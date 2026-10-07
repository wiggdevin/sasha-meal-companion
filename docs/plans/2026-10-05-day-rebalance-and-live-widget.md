# Day rebalance and the live widget (owner request, 2026-10-05)

Status: **captured, not yet specified.** Owner: Devin. The next step is a spec with GPT-6 Sol review,
then owner approval, the same path Phase 18 took. Working name for the action: **"Rebalance my day"**.
The final name is still open.

## The request, in the owner's words (condensed)

1. **A button on the main page** that recalculates the rest of the day's meals and suggestions from
   the calories the user has left.
2. **When the user is over**, for example after ice cream and a burger they did not plan, they can
   reduce the remaining meals or delete one.
3. **Where it lives:** at the bottom of the calendar portion of the Today Day card. That area looks
   odd today.
4. **That area becomes a live widget**, like the iOS Dynamic Island: springy and fluid. The user
   swipes left or right between panels and chooses what it shows:
   - app action buttons;
   - macro rings;
   - calories eaten;
   - calories left;
   - the water tracker or the water button;
   - any combination of these.
   **The default panel is the rebalance button.**
5. **Quick options after a tap**, for example:
   - Change the number of remaining meals to fit the calories left.
   - Remove meal cards the user missed, such as breakfast and the protein shake. Then either
     enlarge the remaining portions, or move the shake to later and enlarge the rest.
   - Lean toward calorie-dense foods that fit the user's rules and available foods, such as nuts or
     shakes, when the window is short and calories are still owed.
6. **Understand why days go off plan first.** The owner names three causes: not eating enough,
   eating too much, and timing (the same calories now have to fit a shorter window).
7. **Choose the options with a decision tree** that starts from the profile and learns the user's
   patterns over time.

## How this fits what exists (to verify in the spec)

- The day's numbers already come from one place. `resolveDay` (`lib/resolve.ts`) gives eaten,
  remaining and per-slot targets. `lib/scaling.ts` moves carbs, then fat, and never protein. The
  rebalance must reuse both, and **must never move the protein portion** (AGENTS.md rule).
- The target revision stays the authority. Rebalancing changes only how the remaining portions are
  shared out today; it never changes calories or macros.
- Slot edits, skips and restores already have per-date overrides with Undo (`lib/plan/*`, coach
  `shift_schedule`, `set_slot_meal`, C4 server Undo). The rebalance should be one Undo-able action
  that writes through those same paths.
- Phase 17 (meal occasion and the `lib/meals` engine) and Phase 18 (open-world foods, `pref-2`,
  pantry and shopping signals) supply the "calorie-dense but allowed" candidates. Phase 18's admitted
  set and safety gate apply unchanged. A rebalance never admits a food the account's rules exclude.
- The Day card is `components/today/DayCard.tsx`, which has Calendar, Overview and Board faces. The
  liquid motion rules in AGENTS.md apply: the four springs, `AutoHeight` and `Disclosure`, and
  nothing appearing or vanishing in a cut.

## Proposed scope for the spec

**Backend (this lane)**
- `rebalanceDay(date)`: a pure planner over `resolveDay`. Given eaten, remaining, the clock, the
  slots left and the user's settings, it returns 2 to 4 ranked options. Each option is a list of slot
  edits with its result: kcal, protein, carbs and fat, and how close it comes to target. Proposed
  option families:
  - **Over:** shrink the remaining carb and fat portions, then drop a snack, then drop a meal. Never
    shrink protein below its floor.
  - **Under, with time left:** enlarge the remaining portions inside portion bands, or add a
    calorie-dense side.
  - **Under, short window:** merge the missed slots into the next ones, move a shake later, and
    prefer calorie-dense allowed foods.
  - **Missed meals:** remove missed cards, then share their calories out over the rest.
- **A decision tree** picks the families to show from the day state (over, under, or timing) and the
  profile. A learned layer comes later and reuses Phase 18 signals; this tree is not ML at first.
- **One coach action** (`rebalance_day`) and one Undo, so the coach can offer the same options.
- **Research step before building:** measure why days drift from the account's own logs, using
  eaten versus planned per slot, skipped slots and late first meals. Also review published evidence
  on common causes. Show the owner the cause mix before fixing the tree.

**UI lane**
- The live widget at the bottom of the Calendar face: swipeable panels, user-customisable, with
  rebalance as the default panel. Springy, fluid motion per the design contract.
- The rebalance sheet: the options, each showing the result, applied in one tap with Undo.
- Choosing which widget panels appear, in Settings or by long-pressing the widget.

## Open questions for the owner

1. The name: "Rebalance my day", "Fix my day", "Catch up", or something else?
2. When the user is over, may a rebalance drop a whole meal by default, or only shrink portions
   unless the user picks "remove a meal"?
3. Should the widget remember its last panel, or always open on rebalance?
4. Should a rebalance ever change tomorrow, for example by carrying a deficit forward? Recommendation:
   no, today only, because the target revision owns the numbers.
