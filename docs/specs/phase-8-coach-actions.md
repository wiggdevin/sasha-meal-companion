# Phase 8 — Coach actions: the coach logs and edits on her behalf

Approved contract for `/goal coach-actions` (Devin, 2026-09-15, in chat: "make it so the AI coach
can create and log meals on the user's behalf … clarify quantity then literally create the meal
card reflected in the UI and log it … add, move, edit, increase/decrease"). Supersedes the
Phase 7 rule "the coach may propose, never commit" — see
`docs/decisions/2026-09-15-coach-applies-actions.md`.

## Goal
Sasha tells the coach what she ate or what she wants changed. The coach asks for a missing
quantity, then does the thing: the entry lands in her log or the plan slot changes, the Today
screen shows the resulting card without a reload, and the chat shows an action card with Undo.

## Scope
In:
1. `log_meal` — log a meal she already ate: date (default today), slot, items (name + grams, or
   qty + unit resolved to grams), optional note. Lands as a `StoredDay.extras` entry through the
   existing `/api/log/commit` path (off-plan foods are flagged, never refused — ruling 2026-09-14).
2. `add_slot_item` — add a food to a plan slot on a date.
3. `remove_slot_item` — remove a food from a plan slot on a date.
4. `set_slot_item` — change one slot item's grams (absolute, or "increase/decrease by N g or by a
   factor"). The other items on the card are NOT resized (ruling 2026-09-14). Protein is never
   moved by a calorie change; a direct "less chicken" instruction is a portion edit and is allowed.
5. `move_slot` — set the slot's clock time for that date (HH:MM).
6. Undo — every applied action card offers Undo; Undo restores the previous state through the
   same client write paths (delete the extra / restore the previous override).
7. Quantity clarification — when the model cannot state grams for an item it asks ONE question
   and emits no action. It never invents a gram figure and never logs a placeholder.

Out: coach writes to targets, constraints, user foods; editing or moving an entry logged days
ago (Undo covers the entry it just logged); recipes; multi-day batches.

## Design
- Server (`lib/coach/*`, `lib/server/coach.ts`): the model's `final` step may carry `actions[]`
  (schema in `lib/coach/actions.ts`). Server GROUNDS them (food name → `foodRefId` + per-100 g
  macros via the existing `searchFoods` port; an ungrounded food downgrades the whole action to a
  clarification, never an invented ref), policy-checks each item (blocked items are flagged in the
  action, not removed — logging marks, never refuses), and returns `actions: CoachAction[]` in
  `CoachTurnResponse`. The server writes NO `log_entries`/`plan_days` rows during a turn — the
  existing invariant test stays green.
- Client (`lib/coach/apply-client.ts`): `applyCoachAction(action)` performs the write using the
  existing paths only — `commitLogEntry`/`buildCommitRequest` (log), `saveMealEdit` +
  `lib/plan/slot-override.ts` helpers (slot edits, move). Returns an `UndoToken`; `undoCoachAction`
  reverses it. Both paths end in the store save / `sasha:synced` hooks the Today screen already
  listens to.
- UI (`components/CoachChat.tsx`, new `components/CoachActionCard.tsx`): the turn reducer gets
  `actions` and per-action status `pending | applied | failed | undone`; the card shows the meal
  (items, grams, kcal/P/C/F strip) and Undo. Actions apply automatically on receipt; her chat
  message is the confirmation, the card + Undo is the safety net.
- Prompt: rule text for when to act vs ask; examples: "I ate steak and eggs for breakfast" →
  asks "How much steak and how many eggs?" → "6 oz steak, 3 eggs" → `log_meal` (grams from
  household portions via search).

## Success criteria (each has one deterministic proof command)
- **C1** Server contract. `pnpm vitest run tests/coach` exits 0 and includes new tests proving:
  an action with an ungrounded food becomes a clarification (no action, no invented ref); a
  `log_meal` item without grams is refused by the wire schema; a full turn producing an action
  changes zero `log_entries`/`plan_days` rows (existing invariant kept).
- **C2** Client apply. `pnpm vitest run tests/coach/apply-client.test.ts` exits 0, covering:
  `log_meal` → one `commitLogEntry` call with the grounded items, date and slot; `add/remove/set`
  → `saveMealEdit` called with the expected component list and no other item resized; `move_slot`
  → `saveMealEdit` called with the time; undo reverses each.
- **C3** Chat UI. `pnpm vitest run tests/coach/chat-state.test.ts tests/coach/action-card.test.ts`
  exits 0: reducer carries actions and statuses; card copy shows items + grams + Undo.
- **C4** Quantity clarification rule is in the prompt and enforced by schema:
  `pnpm vitest run tests/coach/prompt.test.ts tests/coach/turn.test.ts` exits 0 with the new
  assertions.
- **C5** Gates once: `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build` exit 0.
- **C6** Live: with `COACH_ENABLED` on and a real model, in the browser at `/coach`, sending
  "I ate steak and eggs for breakfast" gets a quantity question; answering it produces an action
  card and the Today screen shows the logged meal without reload. Proof: screenshots + console
  log saved under the run's proof dir. If no model key is available locally this criterion is
  proven by the route-level integration test with a stubbed model instead, and the summary says so.
- **C7** Docs: `docs/features.md` F-094 amended (new F-119 "Coach actions" — F-101..F-118 were taken), `docs/specs/phase-7-coach.md`
  carries a supersession note, `AGENTS.md` phase table row 8 updated. Proof: `git diff --stat main`.
- **C8** Landed: PR merged to `main` via `~/bin/zs-land` (production deploys from main). Proof: PR URL + merge sha.
