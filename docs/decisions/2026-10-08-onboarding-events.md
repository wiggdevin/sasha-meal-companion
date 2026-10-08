# Onboarding analytics: `onboarding_events` (Followups #18)

Date: 2026-10-08. Decided by: Orchestrator + GPT-6 Sol high review (`followups-decisions.md` item
18, FINAL). Recorded when the backend lane built it.

## Problem

Phase 18 W15 (the onboarding question ablation) needs to tell which pilot arm an account landed
in, how far it got through the conversational onboarding flow, and where it dropped off. No
analytics hook existed for onboarding before this change, so W15 could not accrue data.

## Decision

Add a privacy-safe, append-only event log, `onboarding_events`, with a fixed, closed vocabulary —
never answer content, never free text:

- `kind` is exactly one of `pilot_arm_assigned`, `step_entered`, `step_left`, `step_abandoned`,
  `question_entered`, `question_left`. Nothing else is accepted by the wire contract
  (`lib/profile/onboarding-events.ts`), the RPC's own filter, or the table's check constraint
  (`onboarding_event_shape_valid`, duplicated in SQL and TypeScript so the two can never silently
  drift — a test holds them equal).
- `step`, `question` and `pilot_arm` are each a closed, named list — a numbered flow screen or
  question id, never the screen's copy, the user's answer, or anything typed.
- `duration_ms` is bounded (0–86,400,000 ms) and only carried by the `_left` / `_abandoned` kinds.
- `flow_version` is checked against a short closed list (today just `onboarding_v2`); a new flow
  version is a migration, not a client-supplied string.
- Idempotent on the phone's own event id (`client_event_id`), unique per `(user_id,
  client_event_id)`, same pattern as `food_signal_events` (20261219090000).

## Why stricter than `food_signal_events`

`food_signal_events` grants `authenticated` both insert and select of its own rows. This table
grants **insert only** — no `authenticated` select policy exists at all, so even the account that
wrote a row cannot read it back from the client. Only `service_role` (the W15 report job) ever
reads. This is tighter than the FINAL decision strictly required ("no answers/free text") because
the data is pilot-arm and step timing — material the owner specifically wants withheld from the
client surface to avoid leaking experiment assignment back to the account.

## Retention

Purged after 90 days by `at` (`onboarding_events_purge`, service_role only, bounded batches,
`SKIP LOCKED`), run by the `/api/jobs/onboarding-events-purge` cron (`vercel.json`, same
cron-secret bearer check as every other job route). These rows are W15 analytics inputs, not the
user's own record — losing them on account deletion (cascade) or after 90 days loses only the
ablation report's data, never anything the user relies on.

## Where it lives

| Path | What |
|---|---|
| `supabase/migrations/20261226090200_onboarding_events.sql` | Table, `onboarding_event_shape_valid`, `record_onboarding_events`, `onboarding_events_purge`. Live-safe: new table only, no ALTER. Down: `supabase/migrations/down/20261226090200_onboarding_events.down.sql`. |
| `lib/profile/onboarding-events.ts` | The wire contract: `OnboardingEventBatch` (zod), the same fixed vocabulary the SQL checks, `ONBOARDING_EVENTS_BODY_MAX_BYTES`. |
| `lib/server/onboarding-events.ts` | `recordOnboardingEvents`, `OnboardingEventStoreError` — calls the RPC, never logs event detail on failure (error code only). |
| `app/api/onboarding/events/route.ts` | `POST`, 1–20 events per batch, at most 16 KB, 202 whatever the insert does (never blocks onboarding), rate limited (120/min/IP pre-auth, 60/min/account). |
| `app/api/jobs/onboarding-events-purge/route.ts` | Cron route, `CRON_SECRET` bearer check, calls `onboarding_events_purge`. |
