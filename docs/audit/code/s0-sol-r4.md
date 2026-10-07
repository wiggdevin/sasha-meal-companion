**DO NOT SHIP.**

Scope: branch `feat/p13-s0-call-registry` against `origin/main` (merge-base to HEAD,
commit `02eb3d5` plus the account-binding test fix in `e6399a5`), re-reviewing the two
findings round 3 (`docs/audit/code/2026-09-23-p13-s0-r3-gpt6-sol.md`, commit `a3b95c1`)
left open, after `9db1f00`, `f121015` and `76f7505` claimed to close them, and after the
branch's merge/rebase onto `origin/main` (phase 9 slice 1 account binding, phase 14 slice 1
live dictation).

**Round 3 finding 1 (unbounded serving label) — CLOSED.** The only caller
(`lib/log/serving-identity.ts`) passes candidate fields straight through to
`servingIdentityPayload` (`lib/ai/payloads.ts:189`), which caps candidates at eight
(`MAX_SERVING_OPTIONS`), collapses whitespace, and truncates each label to 80 characters
(`SERVING_LABEL_MAX`), and narrows `source` to the closed `"catalog" | "history"` set.
Verified in code and confirmed by `tests/ai/payloads.test.ts`'s "bound serving option
text" case, which is green.

**Round 3 finding 3 (discovery counts, not resolved aliases) — still OPEN.**
`ENTRY_ALIASES` (`lib/ai/call-registry.ts:159`) closes the specific alias shape r3 named
(`const send = systemOne`), and `tests/ai/call-registry.test.ts`'s "declares every local
alias of a provider entry point" test enforces that every binding the `BINDING` regex can
see is declared. But the regex only recognizes an identifier or a dotted-prefixed
identifier on the right-hand side of `const`/`let`/`var` (or an `import ... as` alias). A
bracket-indexed initializer evades it entirely:

```ts
const send = [systemOne][0];
await send(existingPayload);
```

Independently verified against the actual regex in the current test file: `BINDING`
matches nothing for this snippet, and `INVOCATION` (the call-counter) counts only the
direct `systemOne(...)` call, not the `send(...)` call. In an already-registered file this
adds a second, undeclared provider call while `ENTRY_INVOCATIONS`, `BUILDER_CALLS`, and the
alias-declaration test all stay green. The mechanism remains textual/regex-based, not
AST-based, so it detects only the alias shapes it was written to look for.

1. **[BLOCK] Discovery still does not resolve arbitrary local aliases of a provider entry
   point.** [call-registry.test.ts:87-92](/Users/zero-suminc./projects/clients/Sasha/mc-p13-s0/tests/ai/call-registry.test.ts#L87-L92),
   [call-registry.ts:159](/Users/zero-suminc./projects/clients/Sasha/mc-p13-s0/lib/ai/call-registry.ts#L159).
   Failure scenario: a second call site is added inside an already-registered file via
   `const send = [systemOne][0]; await send(unregisteredOrMutatedPayload);` — the contract
   test (`tests/ai/call-registry.test.ts`) passes unchanged, so an unregistered or
   provenance-bypassing call ships undetected. Fix direction: resolve bindings from the
   TypeScript AST (or a stricter allowlist of binding forms) instead of pattern-matching
   source text, so any expression that evaluates to a provider entry point is caught, not
   only the specific shapes the regex enumerates.

**New merge-related findings: none.** Traced the origin/main merge's touch points against
this branch's Phase 13 surface — `lib/coach/role-advice.ts`'s resolved import conflict (both
`rolePayload`/`JevPayload` and `accountHandle` are used, no leftover markers), the phase 9
account-binding requirement now on `lib/capture-client.ts` (`signAndUpload`/`captureText`
read the bound device account), and the phase 14 live-dictation stream
(`lib/server/voice-ears.ts`, gated on `geminiAttested()`, declared under `DIRECT_STREAMS`
and covered by its own contract-test case). No regression found in any of these. One
pre-existing test gap surfaced by the merge (`tests/capture/routes.test.ts` never bound a
device account, so `signAndUpload`'s new account read threw `AccountNotBound`) was fixed as
a test-only change in `e6399a5` before this round ran; it is not a Sol finding.

**Verification:** full, not static-only — `pnpm -s tsc --noEmit -p .` passed, and the
targeted Vitest command (coach, capture, tenancy, voice, device suites) ran and passed in
this round's sandbox (no `EPERM` on Vite's temp dir, unlike r3).

**Overall verdict: DO NOT SHIP.** One BLOCK survives from round 3 (finding 3, discovery
completeness); no new BLOCK/WARN was found beyond it.
