# Coach ideas parked for later

One row per coach idea that was cut or deferred, with where its audit lessons live. Nothing here
is scheduled. Before any row starts, a fresh spec is written in its own file under `docs/specs/`
and passes the usual audit; the "Later" sections linked below are the starting lessons, not a
design. Numbers in the phase 12 column follow the order of its "Later" list.

Standing guards that apply to every row:

- The coach never writes targets, weight or profile fields through a path the checked target
  writer does not cover (phase 12 Later 1 and 2).
- A guarantee must hold independent of the model's own choice to call a tool or what its prose
  says. Verify on the server, and discard the whole turn's dependent output on a failed check.
- No safe background-write primitive exists (`lib/server/after-response.ts` is best-effort), so
  nothing is written for the user without an explicit action and an Undo.
- Jev is never on the allergy, diet or religious rule path (see AGENTS.md).
- Anything that adds a vendor, a cost or a new data flow to a model needs the owner's approval first.

| Idea | Status | Revisit when | First spec file | Lessons live in |
|---|---|---|---|---|
| Close the other target and input write paths (old `write_target_revision*` writers, direct table writes, profile plus target in one transaction) | Parked; partly shipped as service-role-only target writers | The checked writer is the only path and a readiness check counts headerless clients | `docs/specs/coach-target-writes-close.md` (new) | `phase-12-coach-tools.md` Later 1 |
| Retire or confirm coach target, weight and planned-meal writes | Parked; tried in revisions 5-11 and dropped | A server-owned confirm flag exists and cached Retry and Undo are handled | `docs/specs/coach-write-confirm.md` (new) | `phase-12-coach-tools.md` Later 2 |
| Calendar tools (`get_calendar`, `plan_range`) | Parked | A range write can refuse while any device has unsynced edits to those dates, or field-level intent exists | `docs/specs/coach-calendar-tools.md` (new) | `phase-12-coach-tools.md` Later 3 |
| Planned meals over a range and the 4-week plan | Parked | Calendar tools ship and a transactional multi-date write with apply-time rules recheck exists | `docs/specs/coach-plan-range.md` (new) | `phase-12-coach-tools.md` Later 4 |
| Meal-entry edits (`edit_entry`) and recipe edits (`edit_recipe`) | Parked | Entry ids, revisions and the outbox path are available to the coach context | `docs/specs/coach-edit-entry-recipe.md` (new) | `phase-12-coach-tools.md` Later 5 |
| Insights and placements with typed facts and a number check | Parked | Reply verification can check numbers deterministically | `docs/specs/coach-insights.md` (new) | `phase-12-coach-tools.md` Later 6 |
| Plateau adjustment (7 %) | Parked | `clampFactor` is exported and the proposal lock order is settled (`base_revision_id` checked after the advisory lock) | `docs/specs/coach-plateau-adjust.md` (new) | `phase-12-coach-tools.md` Later 7 |
| Sleep-driven carbohydrate timing, and re-engagement | Parked | Sleep data is trusted and the nudge is informational or one atomic paired action; re-engagement stamps and event are atomic | `docs/specs/coach-sleep-reengage.md` (new) | `phase-12-coach-tools.md` Later 8 |
| Stored files, PDF, push notifications, the action audit log | Parked; push prerequisites are in `docs/features.md` F-114 | the owner approves the vendor or cost, and a privacy review is done for push | `docs/specs/coach-files-push-audit.md` (new) | `phase-12-coach-tools.md` Later 9 |
| Exports from chat | Parked | Every consumer, including `ExportCard`, checks truncation against the 1,000-row cap | `docs/specs/coach-chat-exports.md` (new) | `phase-12-coach-tools.md` Later 10 |
| Meal times and display name from chat | Parked | The schedule write path has a single owner | `docs/specs/coach-schedule-name.md` (new) | `phase-12-coach-tools.md` Later 11 |
| Web research | Parked | Mode-first routing, two-source evidence and isolation from history and memory are specified together | `docs/specs/coach-web-research.md` (new) | `phase-12-coach-tools.md` Later 12 and "Design lessons from web research" |
| Account memory (schema, writes, reads, Settings, export) | Parked as one unit | A safe atomic write primitive exists and the client can show a proposal | `docs/specs/coach-account-memory.md` (new) | `phase-11-conversations-memory.md` Later and section 2 |
| Coach-driven recall (`recall_conversations` and its verifier) | Parked | Retrieval is verified independent of tool-call observation and "historical, not current" is enforced in code | `docs/specs/coach-recall.md` (new) | `phase-11-conversations-memory.md` Later and section 3 |
| Forgetting a fact inside a thread's rolling summary | Parked with account memory | Account memory ships | `docs/specs/coach-account-memory.md` (new) | `phase-11-conversations-memory.md` Later |
