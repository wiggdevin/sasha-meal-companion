# T0 — Foundations for "snappy": measure, bound, parallelise, warm — 2026-09-17

Program: `docs/plans/2026-09-17-fab-coach-program.md` (T0). Size M.
Coder: Opus 5. Panel holds AC1–AC10 outside the repo. Adversary: Grok 4.6.
Needs the paid Gemini tier (D1) for AC7–AC9; everything else runs on the free key.

## Why

"They are slow" has no number behind it yet. Nothing in the client measures a capture or a coach
turn; no capture fetch has a timeout; nothing is written locally before the server answers;
grounding runs one DB round trip at a time; every route is `force-dynamic`. T0 makes speed a
measured property with budgets, then removes the four structural causes the recon found, so T2–T7
each start from a floor and are proven against it.

## Design

### 1. Measure — `lib/timing.ts` (new), `client_timings` table (new)

- `mark(path, step)` / `measure(path, runId)` around `performance.now()`, batched and posted to
  `POST /api/timings` (JWT, 8 KB, 60/min) → `client_timings (user_id, run_id, path, step,
  ms, at, device)`. Paths: `barcode`, `label`, `photo`, `voice`, `text`, `search-log`,
  `meal-log`, `coach-turn`, `coach-action`. Steps are the real hops: `decode`, `lookup`, `sign`,
  `upload`, `propose`, `model` (server-reported), `ground`, `confirm-shown`, `commit`,
  `card-visible`; coach: `sent`, `first-text`, `reply-done`, `action-applied`.
- The server adds its own `model` and `ground` ms to the propose/coach response so the client
  can store one row set per run. `ai_calls.latency_ms` stays the provider-side truth.
- `pnpm timings [--path X] [--days N]` prints p50 / p95 / n per path and step from
  `client_timings` (service-role read via the existing admin client, scripts only).

### 2. Bound — every client fetch has a deadline and a visible state

- `lib/fetch-with-deadline.ts`: `AbortController` wrapper with per-call budgets: sign 5 s,
  upload 20 s, propose 25 s, barcode 8 s, commit 10 s, coach 40 s, search 6 s. A timeout is a
  typed error the sheet copy already handles ("Capture is resting, try search").
- After 2 s on any step the sheet shows what it is doing ("Reading the label…", "Finding
  matches…", "Saving…") — one component, `components/WorkingLine.tsx`, no new dependency.

### 3. Optimistic local write for commits

- `commitLogEntry` writes the entry to the local store and the IDB mirror **first**, marks it
  `pending`, posts, then reconciles (`rev`, `totals`, `flagged`). The outbox already handles the
  failure path; this makes it the normal path. Today's stack shows the card at once with the
  existing pending treatment (`LoggedExtraCard` has `pending`).
- Coach actions already apply locally first; unchanged.

### 4. Parallelise the server hot paths

- `lib/server/capture.ts` grounding: `Promise.all` over items; inside an item, portions,
  ingredients and the alternative refs in parallel. Result order preserved.
- `lib/server/barcode.ts`: matches resolved with `Promise.all`; the post-write cache re-read
  replaced by building the match from the revision just written.
- Media: the client uploads to the signed URL and calls propose with the path as today, but the
  server passes the Storage object to Gemini by URL (Files API `fileData` from a signed read
  URL) instead of download-then-reupload when the SDK accepts it; fallback to today's path.
  **Amended 2026-09-17: not implementable, and not implemented.** The Gemini Developer API — which
  `@google/genai` uses with an API key — accepts `fileData.fileUri` only for a URI its own Files
  API returned, plus YouTube URLs; an arbitrary HTTPS URL such as a Supabase signed read URL is
  refused. `gs://` works on Vertex AI, which this app does not use. `lib/server/capture.ts` keeps
  today's download-then-send path, which this bullet already named as the fallback.
- Sequential provider fallback (OFF → FDC) becomes a race with a 3 s head start for OFF.

### 5. Warm routes

- `app/api/log/propose`, `app/api/foods/barcode`, `app/api/coach`, `app/api/log/commit`,
  `app/api/foods/search`: keep `nodejs` runtime, add Vercel fluid-compute/function config for
  the smallest cold start the plan allows (`maxDuration`, region pin to the Supabase region), and
  a `GET /api/warm` no-op pinged by the PWA on foreground so the first tap after opening the app
  does not pay the cold start. Measured, not assumed — AC10.

### 6. Budgets (p95, phone on Wi-Fi, 10 runs each, warm)

| Path | Budget |
|---|---|
| Barcode, cached product | ≤ 1.5 s tap-to-confirm-sheet |
| Barcode, cold product | ≤ 6 s |
| Label (photo → confirm sheet) | ≤ 5 s |
| Plate photo (photo → confirm sheet) | ≤ 6 s |
| Search → Log (warm) | ≤ 2 s |
| Commit → card visible | ≤ 100 ms (optimistic) |
| Coach: first visible text | ≤ 3 s |
| Coach: action card applied | ≤ 5 s |

These are T0's floors; T2/T3/T6 may tighten them, never loosen.

## Out of scope

Grounding *quality* (T2), label commit wiring (T3), coach memory/streaming (T6 — streaming lands
there; T0 only measures first-text). Any model change.

## Acceptance criteria (the panel's, hidden from the coder)

- **AC1** `client_timings` receives one row per step for a barcode run and a search-log run made
  on the phone; `pnpm timings --path barcode` prints p50/p95 for `decode`, `lookup`, `commit`.
- **AC2** Every client fetch in `lib/capture-client.ts`, `lib/barcode/client.ts`,
  `lib/log-client.ts`, `lib/coach-client.ts`, `lib/catalog-client.ts` runs through
  `fetchWithDeadline`; a stubbed 60 s server makes each surface its timeout copy within budget + 1 s.
- **AC3** A search-log commit shows the card in Today in ≤ 100 ms with the pending mark, then
  clears it on the server reply; with the server down, the card stays pending and the outbox
  drains on reconnect with no duplicate.
- **AC4** Grounding of a 5-item propose issues its DB calls concurrently (the panel's stub
  records call start times; max overlap ≥ 4) and returns items in model order.
- **AC5** Barcode cold path: OFF and FDC are raced; an OFF 5 s timeout with FDC answering in 1 s
  resolves in ≤ 4 s.
- **AC6** No regression: `pnpm test` once green, tsc, lint, design lint.
- **AC7** (paid tier) Label p95 ≤ 5 s, 10 runs, real labels, phone.
- **AC8** (paid tier) Plate p95 ≤ 6 s, 10 runs, real plates, phone.
- **AC9** (paid tier) Coach first-text p95 ≤ 3 s, action card ≤ 5 s, 10 turns.
- **AC10** Cold vs warm: first call after 15 min idle vs second call, per route, measured 5×;
  the warm ping cuts the first-tap latency by ≥ 50 % or the report says why not.

## Proof folder — `~/Desktop/proof/t0-speed-foundations/`

`acceptance-criteria.md`, `AC1..AC10.txt`, `timings.md` (the p50/p95 tables before and after),
phone screen recordings for AC3/AC7/AC8/AC9, `grok-review.md`, `production-evidence.md`.
