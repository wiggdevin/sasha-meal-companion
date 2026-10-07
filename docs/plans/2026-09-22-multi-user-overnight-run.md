# Multi-user program — overnight run contract (2026-09-22)

Approved by Devin in chat on 2026-09-22 ("write me a /goal prompt … so we can run it all night").
This contract drives one unattended `/goal` run. Program context: the four-part multi-user program
agreed in chat the same day — Phase 9 tenancy and blank slate, Phase 10 conversational onboarding,
Phase 11 conversations and memory, Phase 12 coach tools.

## Devin's rulings (2026-09-22) the run must respect

- Order: tenancy first, then onboarding, conversations and memory, coach tools.
- Every spec and every plan is audited by a non-Anthropic model before it lands. Auditor: GPT-6 Sol
  through Codex (`codex exec -m gpt-6-sol -c model_reasoning_effort=xhigh -s read-only`), run from
  this checkout so it can read the code. Save each audit verbatim to
  `docs/audit/specs/<date>-<phase>-<round>-gpt6-sol.md` (plans: `docs/audit/plans/…`).
- Approach A (per-user day templates); Sasha's account keeps exactly her current plan.
- Sign-up by invite code. One-tap Apple Shortcut now; a native iOS app later (keep Health behind a
  `HealthConnector` interface). Neutral coach identity. Jev thresholds 0.85 / 0.50. Gemini key is
  paid. Rewards and discounts are out of the program.
- Everything must be testable by Devin and Sasha on a preview build, not only in CI.

## Inputs on the branch `docs/multi-user-specs`

- `docs/specs/phase-9-tenancy-blank-slate.md` + audit round 1
  `docs/audit/specs/2026-09-22-phase-9-gpt6-sol.md` (verdict DO NOT SHIP: 11 BLOCK, 4 FIX, 1 NIT).
- `docs/specs/phase-10-conversational-onboarding.md` (decisions confirmed; not audited).
- `docs/specs/phase-11-conversations-memory.md` (draft; PROPOSED lines unconfirmed; not audited).
- Phase 12 has no spec yet. Its requirements, from Devin's message of 2026-09-22: the coach can do
  web research and browse; change and update any setting; edit meal cards; change the calendar days,
  weeks and months ahead; create files the user can download, print or send; after analytics,
  surface findings in the most fitting place in the UI (text, buttons, a fetched article, an image,
  a component) or prompt the user to act; later coach behaviors from his script — a 4-week plan
  after onboarding, a sleep-driven carbohydrate-timing suggestion, a weigh-in plateau adjustment
  ("reduce calories by 7% to meet your goal"), a re-engagement message after days away. Rewards and
  discounts are out.

## Tasks, in order

1. **Phase 9 spec:** apply every BLOCK and FIX from round 1 (judge the NIT; record the reason if
   declined). Add a "Resolution of audit round N" section mapping each finding to the change. Re-audit.
   Repeat until the verdict has **zero BLOCK** findings, at most 3 rounds; if round 3 still has a
   BLOCK, record it as open with the smallest safe cut and move on. Finding 1 (device state crossing
   accounts on one device) is a live production bug: make it the first implementation slice.
2. **Phase 10 spec:** reconcile with the final Phase 9 model (templates, defaults, sync), then the
   same audit loop.
3. **Phase 11 spec:** the same loop. Decide each PROPOSED item with a one-line reason
   (decide-don't-ask), mark it **DECIDED (run)** so Devin can override.
4. **Phase 12 spec:** draft from the requirements above, reusing the existing coach registry, action
   and UI-block patterns (read `lib/coach/*` through a subagent). Mark choices **DECIDED (run)**.
   Same audit loop.
5. **Land the specs:** one docs PR (specs + all audit files + resolutions) through `~/bin/zs-land`.
6. **Phase 9 implementation plan** with `superpowers:writing-plans`, saved to
   `docs/plans/2026-09-22-phase-9-tenancy/`, split into PR-sized slices, each with its tests and
   its Preview test steps for Devin. Audit it with GPT-6 Sol (same loop, same bar). Land it as a
   docs PR.
7. **Implement Phase 9 slices** in plan order, each on its own `feat/`/`fix/` branch, TDD, targeted
   local tests only, CI as the gate, an independent non-Anthropic code review saved to
   `docs/audit/code/`. Open the PR and leave it **unmerged** for Devin's morning review. Continue to
   the next slice while CI runs. Stop starting new slices at 06:00 local time.

## Hard limits (the run stops or skips, never works around these)

- **No production changes of any kind:** no migrations applied to production, no hosted auth-hook
  activation, no production Vercel env changes, no production data writes, no deploys by merge of
  code PRs. Read-only production SQL is allowed.
- Code PRs are opened, never merged. Only docs PRs (specs, audits, plans) land.
- At most one Supabase preview branch, named `p9-tenancy`; record it in the handoff.
- Never run a full test suite twice (house rule); never `just ci`-style local full runs as a gate.
- At most 4 external agent processes at a time (house cap).
- No destructive git; no force-push; no amend of another writer's commit.
- PR #241 (`feat/tdee-rate-goals`) stays untouched; new migrations are timestamped after
  `20261029090000` and plans note the dependency.

## Success criteria (each needs a captured proof in the goal proof directory)

1. `docs/specs/phase-9…`, `phase-10…`, `phase-11…`, `phase-12…` are on `main`, each with a final audit
   file whose verdict line contains no BLOCK findings, or with every remaining BLOCK listed under
   "Open for Devin" in that spec. Proof: `git show origin/main:<path>` and a grep count of
   `[BLOCK]` in the final audit.
2. The Phase 9 plan is on `main` with a final audit with zero BLOCK. Proof as above.
3. At least one Phase 9 implementation PR is open with every required CI check green, and its code
   review file exists. Proof: `gh pr checks <n>` output and the file path.
4. Production is untouched: the production migration list and Production env var names are the same
   at the end as at the start. Proof: before/after captures of the Management API migration list
   and `vercel env ls production` (names only, never values).
5. A morning handoff exists at `~/Inbox/notes/handoffs/2026-09-23-multi-user-overnight.md` with:
   what landed, open PRs with Preview test steps, every decision the run made with its reason, and
   one batched list of the things only Devin can do (hosted auth hook, production migrations,
   Sasha's check of her account, PR #241's migrations).
