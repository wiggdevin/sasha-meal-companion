# Pantry-from-a-photo privacy boundary (W12)

Date: 2026-10-05. Decided by: Devin (owner). Recorded when W12 started building (2026-10-07),
per `docs/specs/phase-18-open-world-foods.md` §W12.

## Decision

Meal Companion may let a user fill their pantry from a photo, under this boundary:

1. The user starts every photo; nothing is captured or sent automatically.
2. Before the camera opens, one line asks the user to keep medicines, prescriptions and labels
   with names out of the frame.
3. The phone downscales and re-encodes the photo with `resizeImage` (on-device, EXIF dropped).
4. The server strips any remaining EXIF, XMP, GPS or other metadata block before the call, and
   refuses a file it cannot parse.
5. The call goes only through the OpenRouter `photoToIdeas` pin with `data_collection: "deny"` and
   `zdr: true` routing (`lib/ai/openrouter.ts`). If that lane is unavailable, the route fails with
   "Try again later" and never falls back to Gemini, because the zero-data-retention routing is an
   OpenRouter setting Gemini does not carry.
6. The prompt is the fixed `photoToIdeas` prompt with no slot calories. No profile, rule,
   condition, medicine, account id or name is sent.
7. The server keeps only `kind: "ingredients"` food names from the answer.

## Accepted risk

The owner **accepts in writing, on 2026-10-05,** the remaining risk that visible pixels (for
example a prescription label left in frame) reach the provider. No pixel-level redaction is built
in Phase 18.

## Basis

This is the same boundary the Plan sheet's existing photo-to-ideas path already partly meets
(resize + EXIF drop on-device, deny + zdr routing, no account data) — see
`lib/ai/openrouter-payloads.ts:63-70`, `lib/plan/inspire-client.ts:35`, `lib/media/resize.ts:2-3,13`,
`lib/ai/openrouter.ts:97-101`, `lib/server/plan-inspire.ts:11`. W12 adds the two pieces that path
was missing — the pre-capture notice and the server-side metadata strip — and ships them for the
Plan sheet's own photo path too (slice W12-F), so the boundary is now the same wherever a photo
reaches `photoToIdeas`.

## Implementation

- Server metadata strip: `lib/media/strip-metadata.ts` (`stripImageMetadata`), applied in
  `lib/server/pantry-photo.ts` (pantry route) and `lib/server/plan-inspire.ts` (Plan sheet route,
  W12-F).
- No Gemini fallback for pantry photos: `lib/server/pantry-photo.ts` calls `generateOpenRouter`
  only, with no second leg.
- Migration 7 (`supabase/migrations/20261226090000_pantry_photo_source.sql`): `shopping_pantry`
  gains a `source` column so a confirmed photo item is recorded as `source: 'photo'`, distinct
  from a manually typed one.
- Pre-capture notice and the confirm-first draft UI: UI-NEEDS, posted as a CONTRACT in
  `~/.claude/goal-state/sasha-orchestrator/coord.md` (acceptance 8 of W12 is satisfied by that
  hand-off, not by backend-lane code).

## Not decided here

Whether pixel-level redaction is ever built is out of scope for Phase 18 and would need its own
owner decision.
