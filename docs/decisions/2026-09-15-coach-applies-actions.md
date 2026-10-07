# Ruling 2026-09-15 — the coach may act, with Undo

Devin, 2026-09-15, in chat: the AI coach must be able to create and log meals on Sasha's behalf,
clarify quantity first, and add / move / edit / increase / decrease her plan.

This supersedes Phase 7's "propose, never commit" (`docs/specs/phase-7-coach.md` goal and
out-of-scope §, acceptance criteria 1 and 3) and features.md F-094's "always requires user
confirmation" for the actions listed in `docs/specs/phase-8-coach-actions.md`.

What stays:
- The server still writes nothing during a coach turn. Actions are grounded and returned; the
  phone applies them through the same client write paths she uses by hand.
- Logging marks, never refuses (2026-09-14). A blocked or off-plan item is flagged on the card.
- A calorie change never moves protein (`lib/scaling.ts`); a direct portion instruction is an
  edit, not a scale.
- No invented quantities. Missing grams → one question, no action.

What changes: her chat instruction is the confirmation. The action card with Undo replaces the
confirm sheet for coach-originated writes.
