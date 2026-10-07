# Root implementation rulings

- Opus plan review is in opus-plan-review.md; it is not a source audit or implementation pass.
- Scope is per-account plans; no household/shared-plan subsystem is requested or assumed.
- A11 Ask Sasha uses existing supported context entry; do not modify composer-owned files. Explicit date/slot IDs, user confirmation and current eligibility apply to replacements.
- Keep actual intake immutable. Affected includes today-unconsumed and future using account-local dates, not past or consumed.
- Fuzzy matching assists discovery; never fuzzily execute deletions or resolve target meal numbers without explicit IDs and preview.
- Optional shopping location works without prices. Store prices/provider is externally blocked if no approved existing API. No made-up stores/prices or new account billing.
- A09 remains assigned to rules/AvoidRules for explicit submit then shared feedback; parent will send API when available.
- UI selector shared components/ui/GlassSelect. No second selector implementation.
- Reviewer Kimi credits exhausted; user explicitly approved Gemini plus another available reviewer. Use actual rendered evidence with Gemini and independent available vision reviewer; no credit purchases.
