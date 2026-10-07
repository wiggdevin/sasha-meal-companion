# Rulings 2026-09-19 (evening) — GPT-5.6 Sol on D1–D12 and the follow-ups, with the driver's disposition

Devin asked (2026-09-19): "Use gpt 5.6 sol to give best answers to all of those questions and if you agree with the
answers then let's please go with them." Sol (xhigh, read-only, repo-aware at main 54db447) answered every item;
the full text is `~/.claude/goal-state/sasha-ai-first/lanes/rulings/answers.md`. This file records what is adopted.

| Item | Sol | Disposition | Reason |
|---|---|---|---|
| D1 targets authority | CHANGE (L): server target revision is canonical; `activeTargetProfile` a synced cache | **Adopt, bounded (M)**: derived profile and pins persist server-side through the existing targets path; coach and dials read the same revision; local derivation is the cache | Removes the silent disagreement Sol found (onboarding did not sync the field; `set_targets` local-only; coach reads `target_profiles`). The versioned-revision redesign is deferred. |
| D2 formulas | CHANGE (M): rest multiplier `1 − 0.10 × training/rest` (−13.33 % on 4/3), per-day floors incl. 100 g carbs; keep protein 1.8–2.0 | **Adopt** | The ±10 % cycling did not average to the target on an asymmetric week; floors were not enforced per day. |
| D3 migration | KEEP + tweak: unique weekdays 0–6, `diet_prefs` must be an object, automated omit/null contract test | **Adopt** (follow-up migration + integration test) | Production already has the original migration; the checks are additive. |
| D4 Jev | KEEP + tweak: privacy-safe telemetry (latency, fallback reason, confidences, apply failure, Undo); rephrase "cannot hallucinate a type" | **Adopt** | Needed before any threshold is called validated (F9). |
| D5 fast path | CHANGE (M): 0.95 mutating / 0.90 suggestions; every argument ≥ 0.90 or deterministic; no past-tense copy before apply | **Adopt thresholds and argument rule; copy becomes present-tense ("Moving…") with the action card carrying the applied state**; the pending/success reply pair is a follow-up | Surgical; the card already shows applied/undo. |
| D6 suggestions | KEEP + tweak: fit × plausibility, drop < 0.50, canonical dedupe, honest "built around your Eats foods" | **Adopt** | |
| D7 exclusivity | CHANGE (L): canonical food identity + transactional op + backfill | **Adopt, bounded (M)**: one transactional server operation keyed by the normalized name across catalog and user refs; a contradiction audit script; the data-integrity loop proves zero contradictions | Enforces the stated invariant without a new identity model; canonical identity deferred. |
| D8 onboarding | CHANGE: forced flow only for new accounts; existing authored-target users get a non-blocking invitation; label advisory prefs | **Adopt** (F8) | Sasha must not be blocked by a prompt. |
| D9 actions | CHANGE (L): route through D1 services; sync before copy; explicit pin clearing; neutral membership | **Adopt within D1/D7 scope**; `remove_from_eats` becomes neutral (row cleared server-side, local `neutral` status, not in rotation) | Two lists plus "neither" matches Devin's mental model better than forcing Avoid. |
| D10 deploy | KEEP + tweak: receipts (SHA, drift, env names, unauth, restore readiness) | **Adopt** — produced by the production-readiness loop | |
| D11 lanes | CHANGE: Sol reviews, another lane implements | **Not adopted** | Sol executes and Grok audits — two independent models already; the house `/goal` skill pins these lanes. |
| D12 suggestion fast path | KEEP + tweak: 8 s executor budget; partial cards or honest retry; never silently start Gemini | **Adopt** | |
| F1 one derivation service | DO NOW | Adopt (in D1) | |
| F2 sync-contract test | DO NOW | Adopt (in D3) | |
| F3 cycling tests all goals × 0–7 days | DO NOW | Adopt (in D2) | |
| F4 `no_nuts` → "no peanuts" | DO NOW | Adopt, with backward-compatible parsing | No tree-nut key exists. |
| F5 neutral membership | DO NOW | Adopt (in D7/D9) | |
| F6 delete `p1-catalog` | DO NOW after a dependency check | **Owner step**: dependency check recorded; deletion left to Devin | Destroys a data copy; it was Devin's open question on 2026-09-12. |
| F7 flaky trio | LATER | Adopt (later) | |
| F8 grandfather existing accounts | DO NOW | Adopt (in D8) | |
| F9 telemetry, then review after 100 eligible turns | DO NOW | Adopt | |
| F10 minimize health context | DO NOW: no raw weight every turn | Adopt | |
| Q1 tidy | consolidate target/profile authority | Adopt as the first tidy task, plus a #041 housekeeper pass | |
| Q2 loops | data-integrity > production-readiness > coach-quality > performance > dependency > docs | Adopt the top three, run after the tidy | |
