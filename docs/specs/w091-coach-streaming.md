# W091 — Coach streaming (OD06), as built 2026-10-17

Owner decision OD06 (`docs/decisions/2026-10-12-owner-decisions.md`): build streaming now; stream
the final call's text as a draft until verification passes, release cards once validated, and cut
serial model round trips. Measurement: `docs/readiness/2026-10-11/w065-coach-capture-speed.md`
(first-text p95 13.7–14.2 s; the whole reply was the first text).

## What the person sees

Before: the coach bubble showed only the thinking animation until the whole turn finished, usually
6–14 s.

After: once the model starts writing its final reply, the words appear in the bubble, muted, with
"Checking this answer" under them. When the turn finishes, the saved reply replaces the draft, and
any cards and actions appear then, never in the draft.

## How

- **Wire** (`lib/coach/stream-events.ts`). `POST /api/coach` with `Accept: application/x-ndjson`
  answers one JSON event per line: `draft` (the reply so far; `""` clears it), then `turn` (the
  exact body a plain request gets) or `error` (the status and body a plain request would answer).
  Sign-in, the rate limit and body checks still answer plainly before any stream starts. A request
  without the header is unchanged, so PlanSheet, attachments and older phones keep working.
- **Route** (`app/api/coach/route.ts`, `lib/server/coach-stream.ts`). The turn runs exactly as
  before, with one more dependency, the draft sink. The 38 s response deadline ends the stream with
  the same retryable 503; work still running finishes and saves, and the phone's retry replays it.
- **Providers** (`lib/ai/openrouter.ts` `readOpenRouterStream`, `lib/ai/gemini-stream.ts`). With
  `onText`, the coach's call streams (OpenRouter SSE with `stream: true`; Gemini
  `generateContentStream`). Everything else about the call is unchanged: callModel's gates, spend
  reservation, attempts, deadline and the one `ai_calls` row, billed from the last chunk's usage.
  The reply is still parsed and judged whole, once. A mid-stream provider error is a
  `ProviderHttpError` with its status only, like a non-2xx.
- **Draft** (`lib/server/coach-turn/draft.ts`, `lib/coach/draft-text.ts`). Each chunk is read for
  the top-level `text` of a `kind: "final"` step (a tool step's text never shows), cleaned by the
  same `sanitiseReply` as the saved reply, and sent at most every 80 ms. A new model step (a
  correction round, a fallback model) clears the draft.
- **Phone** (`lib/coach-client.ts` `postTurn(…, { onDraft })`, `components/coach/CoachDraftBubble.tsx`).
  The body is bounded by what is left of the coach's 40 s budget; a stream that ends without its
  turn is the retryable 503. `first-text` in `client_timings` is now the first draft on screen.
  Draft words are hidden from screen readers; the saved reply is announced as before.

## Safety: when no draft is shown

The saved reply passes the reply check (`lib/server/reply-check.ts`) and coach-verify before anyone
reads it as an answer; a draft arrives before them. `lib/coach/draft-guard.ts` holds drafts, which
is always safe because the checked reply still arrives:

- for the whole turn when the account has a confirmed dietary-profile hard rule, a stated
  condition or a custom rule (none can be judged from text cheaply);
- from the moment a draft names an avoided allergen (the allergen scan's own whole-word keywords),
  or a food this turn looked up that the policy blocks; the draft is cleared and no other draft
  is sent that turn.

A draft can still say something the final checks change (a claim with no action, a food the full
catalog scan catches). That is the "draft until verification passes" OD06 accepted; it is labelled
as being checked and is replaced within seconds.

## Not in this change

- **Fewer model round trips.** Most model turns make two calls: a tool step (often a card-building
  tool) and the final reply. Cutting the second call means the server writing the reply for card
  turns, which changes what the coach says. That needs the per-tool trace from production
  (`coach_intent_events`, `ai_calls`) to pick the safe cases; a Mac session with read access runs
  it. Streaming already covers the final call's writing time.
- **`Server-Timing` on the route** (W065 item 3): a stream sends its headers before the work, so
  the turn body's `timings` remains the server's report.
- No migration, no environment change. Nothing new is stored.
