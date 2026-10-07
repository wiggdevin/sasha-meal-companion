# Phase 4 — AI capture

Spec for the phase named in `docs/architecture.md` §8 row 4. The architecture is the authority; this file
adds only what an implementer needs on top of it. Sections referenced by number are never restated here.

| Item | Value |
|---|---|
| Depends on | Phase 0 (auth, privileged boundary, `lib/ai/adapter.ts` pinned), Phase 1 (catalog + search), Phase 2 (grams, snapshot, `log_entries` / `log_items`), Phase 3 (barcode, favorites) |
| Architecture sections | §3.3, §3.6, §4.1, §4.2, §4.4, §5, §6 |
| Numbers authority | `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md` |
| Exit gate (§8) | Each method: 10-item eval; grounding auto-resolve precision ≥ 90 % |

## 1. Goal

Sasha logs a meal by describing it, saying it, scanning a nutrition label, or photographing the plate, and the
app turns that into a draft she checks and taps to save. The model only proposes; the catalog grounds every
item and the constraint policy (§4.4) judges it, so nothing reaches her day without a database row behind it.

## 2. Scope

**In.** The media pipeline (client resize, EXIF strip, signed upload, server re-validation, provider-side
delete). `ai_calls` with per-call cost and a daily spend cap. `POST /api/log/propose` and `POST /api/log/commit`.
One confirm sheet shared by all four methods. Delivery order inside the phase: **text → voice → label → photo**,
each shipped behind its own flag. Label scan writes a `user_foods` row with `kind = 'label_scan'`. A 40-item
eval set (10 per method) and the runner that scores it.

**Out.** The coach (§4.5, Phase 7) and `coach_threads` / `coach_messages`. Barcode (Phase 3, already shipped).
Recipe extraction from a photo. Multi-plate or video input. Any automatic save: a draft is never written to
`log_entries` without her tap. Streaming responses — one call, one structured object.

## 3. User stories

- **Sasha** types "two eggs, half an avocado and a bowl of white rice", sees three items with grams she can
  nudge, and taps Save. On the pouch aisle she photographs the label and the app stores that product as her own
  food. On a bad signal the sheet tells her capture needs a connection and offers the Phase 2 search instead.
- **Devin** opens the same day over MCP and sees the entry with `method = 'text' | 'voice' | 'label' | 'photo'`
  and per-item `confidence`, so he can tell a typed log from a guessed one when he reads her week.
- **An agent over MCP** never calls propose. The capture routes are JWT-only (§5); MCP keeps the deterministic
  Phase 2/3 log tools. An agent that wants AI capture asks Sasha to use the sheet.

## 4. Data changes

New migrations under `supabase/migrations/`:

**`20260916090000_ai_calls.sql`** — the table in §3.6, with the §2.1 policy pair and the spend-cap helper.

```sql
create table ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('text_items','voice_items','label_nutrients','photo_items')),
  provider text not null check (provider in ('gemini','nous')),
  model_id text not null, sdk_version text not null,
  input_tokens integer, output_tokens integer, latency_ms integer,
  input_hash bytea not null, cost_estimate numeric,
  outcome text not null check (outcome in ('ok','schema_invalid','provider_error','timeout','blocked')),
  created_at timestamptz not null default now());
create index ai_calls_user_day on ai_calls (user_id, created_at desc);
create unique index ai_calls_idem on ai_calls (user_id, purpose, input_hash)
  where outcome = 'ok';
alter table ai_calls enable row level security;
create policy ai_calls_rw on ai_calls for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create function ai_calls_today(p_user_id uuid, p_tz text) returns integer language sql stable as $$
  select count(*)::integer from ai_calls where user_id = p_user_id and outcome = 'ok'
    and (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date; $$;
```

`ai_calls_idem` is the idempotency key the §5 matrix names for `/api/log/propose`. Drafts are never persisted
(architecture §4.2), so a repeat cannot be replayed from the server. Behavior: a second propose with the same
`(user_id, purpose, input_hash)` inside 10 minutes returns **409 `duplicate_request`** with the original
`ai_calls.id`; the client keeps the draft it already holds in IndexedDB (drafts live there until commit or
dismiss) and shows it again. After 10 minutes the request is treated as new and is billed. A retry after a
`provider_error` / `timeout` outcome is not a duplicate (the partial index covers `outcome = 'ok'` only).

**`20260916090100_media_bucket.sql`** — the private bucket §4.2 assumes, plus the owner-path rule that makes
the §4.2 re-check enforceable in the database as well as in the handler.

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media','media', false, 8388608,
          array['image/jpeg','image/png','audio/mp4','audio/aac','audio/mpeg','audio/wav'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
create policy media_own_folder on storage.objects for all to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create table media_objects (
  path text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('image','audio')),
  bytes integer not null, entry_id uuid references log_entries(id) on delete set null,
  created_at timestamptz not null default now(), deleted_at timestamptz);
create index media_objects_sweep on media_objects (created_at) where deleted_at is null;
alter table media_objects enable row level security;
create policy media_objects_rw on media_objects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

No column is added to `log_entries` or `log_items`: `method`, `media_ref`, `confidence` and `was_edited` all
exist from Phase 0 (§3.3). `user_foods.kind = 'label_scan'` likewise already exists (§3.2).

## 5. API changes

All three routes are JWT-only, request-local client, `getClaims()` for identity (§2.1). `user_id` never comes
from the body. Shared types live in `lib/capture/types.ts`.

```ts
// POST /api/media/sign  — 1 KB body, 30/min/user
type SignRequest  = { kind: "image" | "audio"; contentType: string; bytes: number };
type SignResponse = { path: string; uploadUrl: string; expiresInSeconds: 60 };

// POST /api/log/propose — 8 KB body (refs only), 30/day soft, 100 hard
type ProposeRequest =
  | { method: "text";  localDate: string; tz: string; slot: string; text: string }
  | { method: "voice" | "label" | "photo"; localDate: string; tz: string; slot: string; mediaPath: string };

type DraftItem = {
  seq: number; label: string;                   // what the model called it
  foodRefId: string | null;                     // null = ungrounded, she picks
  catalogFoodRevisionId: number | null;
  grams: number; qty: number; unit: string; portionId: number | null;
  confidence: number;                           // 0..1, from the model, clamped
  policy: { verdict: "allowed" | "blocked" | "unverified"; reason?: string };
  alternatives: { foodRefId: string; label: string; score: number }[];  // top 3 when not auto-resolved
  autoResolved: boolean;
};
type ProposeResponse = {
  draftId: string; method: ProposeRequest["method"];
  items: DraftItem[];
  labelFood?: { name: string; brand?: string; per100g: Record<string, number | null>;
                ingredientsText?: string; allergenTags: string[] };  // label method only
  notes: string[];                              // "couldn't hear the amount", never an apology
  spend: { usedToday: number; softCap: number };
};

// POST /api/log/commit — 64 KB body, 60/min/user, idempotent on entry_id.
// Phase 4 adds NO new commit type. It sends the canonical snake_case `LogCommitRequest`
// defined in docs/specs/phase-2-real-logging.md (§API changes), with `draft_id`,
// `method` ∈ text|voice|label|photo, and `save_label_as_food` (label method only).
// The response is Phase 2's `LogCommitResponse` (+ `user_food_id` when a label food was saved).
```

Error cases, every one a JSON `{ error, message }` with no model text echoed back:

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | no session, or `getClaims()` fails |
| 403 | `media_not_owned` | `mediaPath` first segment ≠ `auth.uid()` (§4.2) |
| 413 | `too_large` | body over the §5 limit, or the object over 8 MB / 30 s |
| 415 | `unsupported_media` | MIME, magic bytes, dimensions or duration fail `lib/media/validate.ts` |
| 422 | `schema_invalid` | the model returned a shape zod rejects after the call; logged, no draft |
| 429 | `rate_limited` / `spend_cap` | route limit, or the hard daily cap from `ai_calls` |
| 409 | `stale_revision` | commit names a `catalogFoodRevisionId` that is no longer active |
| 503 | `provider_unavailable` | circuit breaker open (5 failures in 10 minutes) |

Idempotency: propose keys on `(user_id, purpose, input_hash)`; commit keys on `entryId` and returns the existing
entry unchanged on a repeat. `POST /api/jobs/media-sweep` (Vercel cron, `CRON_SECRET`, hourly) deletes objects
older than 24 h whose `deleted_at` is null, and is the backstop for the delete-on-commit path.

## 6. Client changes

| File | Change |
|---|---|
| `components/CaptureSheet.tsx` | new — the one sheet §4.2 requires. Four entry modes, one confirm view. Uses the existing `Sheet` / `Pill` chrome. |
| `components/CaptureConfirm.tsx` | new — the draft list: item, grams stepper, portion picker, swap-to-alternative, policy pill (amber `unverified`, red `blocked`), Save. |
| `components/VoiceCapture.tsx` | new — press-and-hold record, 30 s hard stop with a countdown ring, replay, retry. `MediaRecorder`, best available of `audio/mp4` then `audio/aac`. |
| `components/PhotoCapture.tsx` | new — `<input type="file" accept="image/*" capture="environment">`, then `lib/media/resize.ts`. |
| `components/QuickActions.tsx` | edit — four new actions above the existing water / gut / weight rows. |
| `components/LoggedExtras.tsx` | edit — an entry logged by capture shows its method glyph and, when any item is below 0.6 confidence, a "check this" hint. |

**Offline.** Capture is the one online-only surface in the app. When `navigator.onLine` is false the four actions
render disabled with "needs a connection", and the sheet points at Phase 2 search, which works offline. Media is
never queued for later upload: a 6-hour-old plate photo proposes a meal she has stopped remembering, and the
Phase 3 barcode and search paths already cover the offline case. A commit that fails in flight retries through
the Phase 0 outbox like any other op, because by then it is a plain `log_entries` create.

## 7. Engines and logic

Pure functions, no I/O, all unit-tested:

```ts
// lib/ai/json-schema.ts
export function toGeminiSchema(schema: z.ZodType): GeminiSchema;   // no oneOf/$ref/open additionalProperties
export function assertSupported(schema: z.ZodType): void;          // throws; used by the build-time test

// lib/capture/quantity.ts
export function gramsFor(qty: number, unit: string, portions: DbPortion[], per100g: Per100g): number | null;
export function parseAmount(text: string): { qty: number; unit: string } | null;  // "half an avocado" → 0.5 whole

// lib/capture/grounding.ts
export function pickCandidate(hits: ScoredHit[]): { hit: ScoredHit; autoResolved: boolean } | null;
// auto-resolve only when top ≥ AUTO_RESOLVE_SCORE and margin ≥ AUTO_RESOLVE_MARGIN (lib/search/thresholds.ts, §4.1)

// lib/capture/propose.ts
export function buildDraft(parsed: ModelItems, grounded: GroundedItem[], policy: PolicyVerdict[]): ProposeResponse;

// lib/ai/spend.ts
export function capState(usedToday: number, soft: number, hard: number): "ok" | "warn" | "blocked";
```

`lib/ai/schemas.ts` holds one zod schema per purpose; `lib/ai/prompts.ts` holds the four prompts, temperature 0,
per-purpose `maxOutputTokens`. `lib/ai/capture.ts` is the only impure module: it resolves the model from
`lib/ai/adapter.ts`, sends inline bytes under 4 MB or a Files API upload, deletes the provider file in a
`finally`, re-validates the response against zod (§4.2), and writes one `ai_calls` row per attempt including
failures. `lib/media/validate.ts` checks MIME against magic bytes, image dimensions, and audio duration;
`lib/media/resize.ts` is the client half — 1600 px long edge, JPEG q 0.8, canvas re-encode strips EXIF.

## 8. Security

These rows of the §5 matrix are the ones this phase turns on. Nothing here restates §2.1 or §2.2.

| Route | Identity | Body | Rate | Idempotency | Phase-4 obligations |
|---|---|---|---|---|---|
| `/api/media/sign` | JWT | 1 KB | 30/min/user | — | path is `media/<auth.uid()>/<uuid>`, built server-side; URL expires in 60 s; the requested `bytes` is bound-checked before signing |
| `/api/log/propose` | JWT | 8 KB | 30/day soft, 100 hard | `input_hash` | re-checks the object path's first segment against `auth.uid()`; fetches bytes server-side; provider file deleted in a `finally`; model output re-validated against zod; §4.4 policy runs after the model, before render |
| `/api/log/commit` | JWT | 64 KB | 60/min/user | `entryId` | rejects a non-active `catalogFoodRevisionId`; recomputes every `snapshot` server-side and ignores client macros; deletes our media copy |
| `/api/jobs/media-sweep` | `Bearer $CRON_SECRET` | — | — | per-object | 24 h backstop delete |

Three further rules bind this phase. The model's output is **data, never instruction**: label text and her own
notes are passed in a `data` field and no capture prompt may carry a tool, a URL or a free-text destination.
A `blocked` policy verdict cannot be overridden inside the sheet — she saves it from the Phase 2 search path if
she truly means to, and the entry carries the flag. Gemini stays the only provider on this path until the Nous
retention answer is recorded in `docs/ai-data-handling.md` (§6, §10).

## 9. Test plan

**Unit** — `lib/ai/json-schema.test.ts` (every capture schema converts; an unsupported construct throws),
`lib/ai/schemas.test.ts` (a valid payload parses; a plausible-but-wrong one is rejected),
`lib/ai/spend.test.ts`, `lib/media/validate.test.ts` (a PNG renamed `.jpg` fails; a 31 s clip fails; a 4001 px
image fails), `lib/capture/quantity.test.ts` (fractions, "a handful" → null, oz→g, portion labels),
`lib/capture/grounding.test.ts` (auto-resolve at the threshold, margin refusal, tie), `lib/capture/propose.test.ts`
(blocked item stays in the draft flagged; ungrounded item yields alternatives).

**Integration** (mocked provider, real database): propose→commit round trip writes one entry and N items with
server-computed snapshots; a second commit with the same `entry_id` changes nothing; a repeat propose inside 10 minutes
returns 409 `duplicate_request` and writes no second `ai_calls` row; a `mediaPath` under another user's uid returns 403; a
commit naming a superseded revision returns 409; the hard cap returns 429 and still writes an `ai_calls` row
with `outcome = 'blocked'`; a schema-invalid response opens the sheet with zero items and saves nothing; the
sweep deletes a 25-hour-old object and leaves a 23-hour-old one.

**Eval, outside CI** — `scripts/ai-eval.ts` over `scripts/eval/phase-4-capture.jsonl`: 10 real items per method,
drawn from her food list and her logged days. It reports per-method item accuracy, grounding auto-resolve
precision, and mean absolute gram error, and writes a dated run file under `docs/evals/`. It calls the live
model, so it never runs in CI (§6).

**Manual gate, Devin on the phone.** Install, sign in, then in one sitting: (1) type a three-item meal and save
it; (2) speak the same meal and check the items match; (3) scan a pouch label and save it as a food, then
confirm the ingredient list is stored and an apple-containing pouch comes back `blocked`; (4) photograph a plate
and check the grams are sane before saving; (5) turn airplane mode on and confirm the four actions disable
cleanly and search still logs; (6) open the day over MCP and confirm each entry's `method` and confidence.

## 10. Acceptance criteria

1. Each of the four methods produces a draft from real input and saves exactly one `log_entries` row with the
   matching `method` value.
2. No draft is ever written to the database before her tap: a propose call followed by no commit leaves
   `log_entries` unchanged.
3. Grounding auto-resolve precision on the 40-item eval set is ≥ 90 %, and per-method item accuracy is reported
   for all four methods.
4. A propose with a `mediaPath` whose first segment is another user's uid returns 403 and reads no object.
5. Every provider call writes one `ai_calls` row carrying `model_id` and `sdk_version`; a failed call writes one
   too, with the failure in `outcome`.
6. The 31st successful propose in a user's local day returns the soft-cap warning and the 101st returns 429.
7. A model response that fails zod re-validation opens the confirm sheet with zero items and writes nothing but
   the `ai_calls` row.
8. Our media copy is gone within a second of commit; an abandoned capture's object is gone within 24 h; the
   provider copy is deleted on every Files API call, including the failure path.
9. A food whose ingredients hit `avoid_allergens` renders `blocked` in the sheet and cannot be saved from it.
10. Commit recomputes every snapshot server-side: a tampered client payload with inflated macros stores the
    correct values.
11. With `navigator.onLine` false, the four capture actions are disabled and the Phase 2 search path still logs.
12. Every tap target in the sheet is ≥ 44 px and the sheet follows the dark contract in `AGENTS.md`.

## 11. Rollout and rollback

One env flag, `CAPTURE_METHODS`, a comma list read at module load in `lib/capture/flags.ts`. Ship text alone,
run the 10-item eval and the manual gate, then add voice, then label, then photo — four deploys, one method each,
each with its own gate. A method absent from the flag renders no action and its propose branch returns 404.

Rollback has three levels. Turn a method off in the flag (instant, no deploy code path). Set
`CAPTURE_DAILY_HARD_CAP=0` to stop all provider spend while leaving the sheet's Phase 2 search intact. Revert the
release; the two migrations are additive and stay — `ai_calls` and `media_objects` are orphan tables with nothing
reading them, and entries already committed are plain `log_entries` rows that need no capture code to render.
The only irreversible act in the phase is a committed entry, and she can delete that like any other.

## 12. Open questions

1. **iOS audio container.** Safari's `MediaRecorder` emits `audio/mp4`; Gemini's documented audio types list
   `audio/aac` but not `audio/mp4`. A Phase 4 canary settles it before voice ships. If it fails, the fallback is
   a client-side re-mux to WAV at 16 kHz mono, which fits 30 s inside the inline-bytes budget.
2. **Daily cap numbers.** §5 says 30 soft / 100 hard. For one user that is generous; confirm with Devin whether
   the soft cap should warn her at all or just log.
3. **Photo grams.** A plate photo gives the weakest quantity estimate in the set. Should a photo item default to
   `was_edited = false` with the model's grams, or open with the grams stepper focused so she always confirms?
4. **Label duplicates.** A second scan of the same product should find the first `user_foods` row rather than
   create a near-duplicate. Match on brand + name + per-100 g, or leave it to her?
5. **Constraint policy home — resolved.** Phase 4 owns `constraint_profiles` and `lib/policy/constraints.ts`
   (features.md F-076 / F-077). Phases 1–3 show the Eats/Avoid badge from `user_food_prefs` only; the
   ingredient-level policy (§4.4) ships here and is applied to search results from this phase on.

## Reference implementation
fud-ai (MIT, github.com/apoorvdarshan/fud-ai): lift the shared food-analysis JSON shape and unit/serving-unit prompt instructions (`ios/calorietracker/Services/GeminiService.swift`), the progressive-meal multi-photo scale-reading protocol, and the review-nutrition unlock/lock scaling rule. 1s/2s/4s retry on 503/429/529 matches our adapter. Full review with file paths and excerpts: `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`. Any ported code carries the MIT attribution line in `NOTICE.md`.
