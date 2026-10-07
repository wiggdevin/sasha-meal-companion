# T12b: Body-profile editing and reliable settings sync

Status: approved for implementation by Devin on 2026-09-12. This document is the `/goal` contract for `feat/tdee-lines`.

## Feature

Sasha needs to enter the physiological inputs used by the app's explanatory TDEE formulas without risking lost edits, cross-user disclosure, or an accidental change to her prescribed targets. T11b owns the read-only TDEE lines. T12b adds the body-profile editor and hardens the shared `user_settings` write path used by the profile and water goals.

The measurable outcome is that every valid edit reaches the local mirror and sync queue as one conflict-safe settings generation, survives offline use and concurrent edits, and remains isolated to Sasha. Invalid or unavailable data must fail visibly. Profile values may explain estimates but must never change calorie or macro targets.

## Scope and boundaries

- Add editable Height, Birth year, Body fat, and Sex used in formula fields to Settings > Body data when the health capability is authoritatively enabled.
- Store the four nullable fields in the normalized `user_settings` entity. Do not copy them into the legacy localStorage settings object.
- Use one whole-row, compare-and-swap `user_settings` operation. Profile edits and water-goal edits share this path.
- Preserve T11b's strict profile read validation, three explanatory TDEE lines, provenance labels, and display-only target boundary.
- Preserve unrelated entity queues and all behavior already on `main`.
- Do not send body-profile values to an LLM, analytics service, or application log.
- Do not claim that clearing a current value erases historical sync, audit, export, or backup records. Historical erasure and retention-policy changes are outside this ticket.
- Do not deploy, enable production flags, or modify production data in this ticket.

## Required behavior

### AC1: Capability-gated, accessible editor

When the body-data capability is enabled, Settings > Body data renders accessible controls for Height, Birth year, Body fat, and Sex used in formula. No editor renders while capability state is unresolved or disabled. Save and read failures show an inline explanation and a retry target at least 44 px tall.

### AC2: Fail-closed input semantics

Typing preserves the exact draft. Blur or Enter attempts the commit. Height and body fat may be fractional; birth year must be a whole number from 1900 through the current calendar year. Sex used in formula accepts only `female`, `male`, or an explicit clear. The interface explains that this field is a physiological formula input, not gender identity.

Empty input explicitly clears the nullable field. Unchanged input creates no write. Invalid, non-finite, or out-of-range input remains visible with an inline error and creates no mirror or outbox mutation. Values must not be silently clamped.

### AC3: Coherent reads and refreshes

Every mounted consumer refreshes after a successful local profile save and after the existing sync-settled event. A failed or invalid IndexedDB read is an unavailable, retryable state and is never presented as an empty profile. Refreshes do not overwrite a field Sasha is actively editing or a field whose rejected save is awaiting retry.

### AC4: Atomic local commit

The local `user_settings` mirror, pending operation, revision baseline, and field-intent bookkeeping commit in one IndexedDB transaction. A failure in any part leaves every part unchanged. Concurrent saves to different profile fields preserve both edits.

### AC5: One pending settings operation

All unsent profile and water-goal edits coalesce into one whole-row `user_settings` operation anchored to the last confirmed server revision. Coalescing preserves unrelated fields already present on the authoritative row. Other entity types retain their existing queue behavior.

### AC6: Conflict-safe retry

A compare-and-swap conflict rebases only Sasha's outstanding field intents onto the authoritative server row. Repeated conflicts preserve every outstanding intent. A missing response or transport failure keeps the edit queued for retry. A duplicate or delayed response settles only the immutable generation that was sent and cannot delete, reassert, or acknowledge a newer edit.

### AC7: Immutable send generations

Queue selection and generation freezing are atomic. An edit created after a request is frozen becomes the next generation. The request body, settlement, and retry logic continue to refer to the frozen generation even if the live pending operation changes while the request is in flight.

### AC8: Upgrade recovery

A baseline-less operation created by an older client is parked until a complete pull establishes whether the server row exists. If it exists, the client sends only fields that differ from the authoritative row. If it does not exist, the client issues one create. An older chain of settings operations collapses into the single pending operation allowed by this contract.

### AC9: Database and null contract

The migration adds nullable, checked `height_cm`, `birth_year`, `sex`, and `body_fat_pct` columns and retains RLS, grants, and the `security_invoker` view behavior already required by T11b. Omitted JSON keys preserve stored values. Explicit JSON `null` clears them. The down migration restores the prior sync function and view shape.

### AC10: Authentication, authorization, and export isolation

Sync and export endpoints require an authenticated session. User B cannot read, update, sync, or export user A's profile fields. The typed `body-profile` export returns only the authenticated user's four fields and established export metadata. No service-role credential reaches the client.

### AC11: Honest offline and failure behavior

A successful offline edit means saved locally and queued, not accepted by the server. Existing sync status UI must expose pending, retrying, and failed synchronization without displaying profile values. Reloading offline preserves the mirror and the exact pending generation. Retry remains bounded by the existing sync backoff and cannot create duplicate settings generations.

### AC12: Clinical and AI boundary

Profile values feed only T11b's explanatory formula and activity displays. No target resolver, expenditure estimator, proposal builder, AI adapter, prompt, or model request imports or receives the T12b profile-write module. The editor states that targets change only through the weekly proposal. Unavailable inputs produce missing-data guidance, never a guessed medical or nutrition value.

## Acceptance evidence

Completion requires all of the following at the reconciled branch HEAD:

1. Focused Vitest proof covering AC1 through AC12, including direct unauthenticated and cross-user `body-profile` export cases.
2. Migration, rollback, sync RPC, and RLS integration proof against a disposable Supabase branch. Skipped integration tests do not pass AC9 or AC10.
3. `pnpm lint` and `pnpm exec tsc --noEmit` exit 0.
4. One full `pnpm test` run, performed once after focused tests are green.
5. `pnpm build` exit 0.
6. Authenticated 390 px phone evidence for typing, blur or Enter, clear, invalid input, retry, offline queueing, reload, and post-sync refresh. Screenshots must contain synthetic values only.
7. A source-boundary scan proving that profile values do not enter target, proposal, estimator, AI, analytics, or logging paths.
8. An independent fresh-context review of the reconciled diff covering correctness, security, privacy, accessibility, architecture, clinical safety, and every acceptance criterion. Supported findings must be fixed and re-reviewed.

Proof artifacts go in `/Users/zero-suminc./Desktop/Proof/t12b/`. Every artifact must record the branch HEAD, command or interaction, result, and exit status where applicable. Evidence containing credentials, tokens, real health values, or other PHI must not be captured.

## Completion rule

T12b passes only when AC1 through AC12 each map to reproducible evidence at one reconciled commit. Local unit tests do not substitute for the required Supabase or phone checks. If credentials, a disposable database branch, authentication, or device access prevents those checks, the final verdict is `BLOCKED`, not `PASS`.
