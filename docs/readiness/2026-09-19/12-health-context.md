# 12 — Health-context minimization (F10)

**Outcome:** unverified / blocked  
**Severity:** medium

## Deterministic evidence

Command:

```text
pnpm exec vitest run tests/coach/context.test.ts
```

Result: 1 file passed, 21 tests passed, 300 ms.

The focused test proves that:

- a plain question, `what should I eat next?`, omits the profile line and raw weight;
- weight/target/profile intents include the profile only when needed;
- context is fenced as untrusted data;
- planted closing delimiters and URLs are stripped;
- the context stays within its token cap.

The implementation gates the profile read in `needsProfileContext` (`lib/server/coach-context.ts:80-88`) and skips it entirely for an ordinary food question (`lib/server/coach-context.ts:143-154`). The generated prompt is assembled in memory, while the error path explicitly forbids logging the prompt, response, user id, or health context (`lib/server/coach-turn.ts:490-498`).

## Blocked live spot check (resolved 2026-10-17)

Resolved by W087: the live F10 check ran on the `coach-eval` branch with a branch test user. See `docs/evals/2026-10-17-coach-live-pass.md`, section F10. The text below is the original 2026-09-19 finding.


The requested branch coach turn would invoke an external provider using the repository's configured production credential. L2 explicitly forbids use of Devin's production keys. No real AI turn was sent, and static/unit evidence is not being mislabeled as the requested live prompt-log spot check.

## Owner step

Provide a dedicated non-production provider credential and an approved branch test identity, then send one plain question and inspect the provider-observability/prompt fence to confirm no raw weight. Retain the focused 21-test result as the deterministic regression gate.
