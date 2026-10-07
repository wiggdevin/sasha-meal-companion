# Coach root-cause analysis, 2026-09-14

Devin: "fix the coach ... returning normal helpful responses". Three failures were observed in
the 2026-09-13 production smoke; a fourth (reply degeneration) was found while verifying the
fixes. Every root cause below was reproduced against the running app on a local Supabase stack
with the project's own Gemini key, not inferred from code reading.

## RC1 — a provider call had no deadline (the 3-minute hang)

`lib/coach/turn.ts` consults `wallClockMs` only BETWEEN turn steps, so it can never interrupt a
request that is in flight. `lib/ai/adapter.ts` created no `AbortController` and passed no signal,
while `RETRIES = 2` makes three attempts. A provider that stalls therefore hangs the turn for as
long as it likes — the UI sat on "Thinking" for 3+ minutes with no response, ever.

`AiStatus` already had a `"timeout"` member and `classifyFailure` already mapped `AbortError`
onto it. Nothing ever produced one.

**Fix.** `withDeadline()` in the adapter wraps every attempt: a real `AbortSignal` (honoured by
`@google/genai` 2.21.0 via `config.abortSignal`) cancels the request, and a timer guarantees the
promise settles even if a transport ignores the signal. The coach passes
`PER_CALL_TIMEOUT_MS` (20s), or whatever is left of the turn if that is smaller.
A regression test asserts a never-settling provider rejects instead of hanging.

## RC2 — the wall clock was shorter than a successful turn

Measured against the pinned `gemini-3.6-flash` on 2026-09-14, a turn that SUCCEEDED spent
3,994 + 10,301 + 8,752 = **23,047 ms** in the model alone across three calls, before any tool or
database time. The budget was 30,000 ms, so an ordinary four-call turn aborted as "that took too
long" on requests that were not slow, only normal.

**Fix.** `wallClockMs` 30s → 75s. This is a runaway-loop ceiling, not a latency target; RC1's
per-call deadline is what actually bounds the wait.

## RC3 — the tool-call cap fired on healthy turns

`maxToolCalls` was 6, and `planTurn` deliberately refuses a WHOLE batch that would cross the cap
(a half-executed batch would give the model a partial view). An ordinary "what should I eat" turn
wants `get_day`, `get_targets`, `get_constraints`, two or three `search_foods` and a
`draft_log_entry` — six to seven. The user was told "I looked things up too many times" for
asking a normal question.

**Fix.** `maxToolCalls` 6 → 10. Batch-refusal behaviour is unchanged.

## RC4 — a throwing tool destroyed the whole turn (the stale-thread 404)

`lib/server/coach.ts` called `executors[name](userId, validated.args)` with no `try`/`catch`. A
tool that threw — `NoActiveCatalogVersion` (503) is the real case — propagated out of `runTurn`,
past every write, and became a 503 response. The thread row is created at the top of the turn, so
the result was a thread with **zero messages** that the client could not load again.

Reproduced exactly: one turn left `coach_threads` with 1 row (`last_message_at: null`) and
`coach_messages` with 0 rows, while the model itself had answered fine (two `ok` `ai_calls`).

Note the validation-failure path immediately above already handled errors gracefully by pushing
an error `ToolResult`. The pattern existed; it was simply not applied to executor exceptions.

**Fix.** The executor call is wrapped. A failure becomes a tool error result in the same shape a
validation failure uses, so the model is told the lookup failed and answers from what it has.
Verified live: with the catalog deactivated the coach replied "Currently the catalog search is
unavailable, but these are solid options" and the turn persisted normally.

## RC5 — reply degeneration (found while verifying RC4)

With the catalog down, the coach produced a correct first sentence and then recited its own
instructions for hundreds of words:

> ... zero exclamation marks anywhere in reply. clean valid format. standard json. ... parse
> done. fine output json structure clean single block exact array suggestions valid text ...

The prompt contains "7. Keep replies short and plain. No exclamation marks." and the model echoed
it. The cause is `temperature: 0`: a model that slips into a repetitive state at temperature 0
cannot leave it, because the top token never changes.

**Fix, two layers.**
1. Temperature is now per-call. Extraction purposes (label, photo, text-to-items) stay at 0,
   where a deterministic reading is the point. The coach uses `COACH_TEMPERATURE = 0.3`.
2. `sanitiseReply()` cuts a reply at the point its sentences stop being distinct, so Sasha cannot
   see that text even once. Distinctness, not length, is the test: a long genuine answer is
   untouched.

## Verified live, against the running app

| Request | Before | After |
|---|---|---|
| "What should I eat for meal 2 today?" | — | suggestion cards, items correctly flagged Unverified |
| "Can I have a bagel with cream cheese and an apple for meal 1?" | hung 3+ minutes | "No. Bagel contains gluten, cream cheese contains dairy, and apple is on your avoid list ... Do you want to look for allowed alternatives for meal 1?" |
| "Find me a high protein option for meal 3" (catalog down) | 503, thread orphaned | answers, says the catalog is unavailable, turn persists |
| "Find me a high protein option for meal 3" | degenerate scratchpad | "Options for meal 3 include canned albacore tuna, drained and sirloin steak, cooked. Both are high in protein and fit your constraints. Do you want to draft a log entry for one of these?" |

Gate: 2,106 tests pass, lint clean, tsc clean.

## Not changed

No calorie or macro number (R2). `DESIGN.md` untouched (R3). No production Supabase write (R11a):
every reproduction ran against a local Supabase stack seeded with six test foods.
