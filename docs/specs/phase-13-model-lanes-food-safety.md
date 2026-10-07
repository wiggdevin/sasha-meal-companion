# Phase 13 — Model lanes, dietary profiles and food safety with Jev

Status: rev 4, build-ready (2026-09-23). Spec audits capped at 2 rounds; audit round 2's findings are binding slice requirements (§9). Owner direction: Devin, in chat on 2026-09-23, two messages.
He delegated the decisions to the run, with GPT-6 Sol as the adversary. Run decisions are marked
**DECIDED (run)**; Devin's own rulings are marked **DEVIN**.

## 0. Owner rulings (2026-09-23)

- **DEVIN:** Use the best model per task for speed and accuracy. Two, three or four models are fine.
  Credits exist for Gemini, DeepSeek and TypeSafe (Jev).
- **DEVIN:** DeepSeek V4.1 Flash may be used at runtime for app UI (generated cards, charts,
  buttons, calendar cards). "I really don't think that information is too guarded." After user
  testing, add an opt-in/opt-out notice that names models that may use data for training.
- **DEVIN:** Stay current with Gemini (Gemini 4 is coming). Use the best Flash for search.
- **DEVIN:** Map every dietary need a user may have (allergies, intolerances, conditions such as
  Crohn's or colitis, religious rules, ethical diets and flexible variants like "mostly
  pescatarian but sometimes chicken", goals like muscle gain, "doctor says anti-inflammatory",
  likes and dislikes) to do's and don'ts. Jev should help wherever it can.

## 1. Facts (read 2026-09-23)

- **Providers:** Google Gemini and TypeSafe Jev (`jev-latest` = `jev-1.13.0`). A Nous path exists,
  but nothing routes to it. Production has `GEMINI_BILLING_ATTESTED` and `HEALTH_CONTEXT_PROVIDER`
  set, and has no DeepSeek key.
- **Pins:**
  - Capture uses `gemini-3.8-flash`.
  - The coach and weekly review use `gemini-3.6-flash`. The coach moved to 3.6 after 503s from
    3.8/3.7 in the 2026-09-13 canary.
  - The fallback is 3.8.
- **The coach turn** starts with a Jev intent classification of the raw user message. Mechanical
  intents skip the LLM. All other turns run a sequential Gemini tool loop. The latency root cause
  (sequential `search_foods`, a 75 s server budget against a 40 s client deadline) is fixed
  separately in PR #254.
- **Jev call sites today and what each sends:**

  | Call site | Sends | Class |
  |---|---|---|
  | `intent.ts` | raw user message | D1, may hold D2 |
  | `prefs` route | preference text | D1 |
  | `verify.ts` | coach reply and action summaries | D1 |
  | `suggest.ts` | the wish text and user-sized macros | D1 |
  | `role-advice` | meal components | D1 |
  | `serving-identity` | food candidates | D0/D1 |
  | `sanity.ts` | a draft log item | D1 |
  | `facet-warm.ts` | food names and ingredient text, including user foods | D0/D1 |

- **Policy:** `evaluatePolicy` marks a food unverified when its allergen tags are `null`. An empty
  tag array passes. Being on the Eats list also passes. The 25 facets cannot express every
  account-defined allergen.
- **Research (primary sources):**
  - DeepSeek's fast tier is API id `deepseek-flash` (V4.1 Flash). It is OpenAI-compatible at
    `https://api.deepseek.com`. Data is stored in the PRC, and the training terms are unclear.
  - The newest GA Flash is `gemini-3.8-flash`. Gemini 4 has no model id yet.
  - Google Search grounding works on 3.5–3.8 Flash and is billed per search query: 5,000 free a
    month, then $14 per 1,000. Paid Gemini API data is not used for training.
  - TypeSafe says it does not train on user data. It offers zero data retention only under an
    enterprise DPA, and publishes no health-data statement.

## 2. Data classes and the provider boundary

| Class | Meaning |
|---|---|
| D0 | Food-only: a food name, its ingredients, a generic nutrition question with no user facts |
| D1 | User nutrition and behaviour: meals, targets, weight, plan values, preference text, the user's messages |
| D2 | Health context held as a user fact: conditions, allergies, clinician directives, medications |

Cleared classes per provider:

| Provider | Cleared | Basis |
|---|---|---|
| Gemini (paid, attested project) | D0, D1, D2 | No training on paid data; `GEMINI_BILLING_ATTESTED` |
| Jev | D0, D1 | **DECIDED (run):** TypeSafe does not train on user data. Every live Jev path already sends D1; this states the existing practice. |
| DeepSeek | D0, D1 (UI lane only) | **DEVIN** ruling above |

- **Designed D2 features** (condition and allergy mapping, clinician directives) run on Gemini only.
- **Incidental D2** is health text a user types into a message that also goes to Jev. It is an
  accepted residual (**DEVIN:** "not too guarded"). The run still recommends item 1 in §8.
- **DeepSeek payload minimisation (DECIDED (run)):** a UI-lane request carries only the values the
  block renders, such as labels, numbers and dates. It never carries raw user text, conditions,
  allergies, notes or names. This is a schema-typed request builder, not a filter.
- **Enforcement (closes Sol r1 findings 1 and 2):** every model call site registers
  `{ purpose, provider, dataClass }` in `lib/ai/call-registry.ts`. A contract test finds every
  call site in the source (the same pattern as `tests/tenancy/admin-entry-points.test.ts`). It
  fails when a call site is unregistered, or when its declared class is not cleared for its
  provider. The provider adapters refuse at runtime when the registered class is not cleared.
- **Gemini gate (closes Sol r1 finding 3):** the D2 gate becomes a project attestation checked
  before any call that carries user content, for the coach and capture alike, not only when the
  stored profile holds conditions. With the attestation off, those calls refuse with the existing
  `nous_unconfirmed` path. Production has it on, so behaviour is unchanged there.

## 3. Model lanes

A single lane table in `lib/ai/lanes.ts` absorbs the pins from `models.ts` and `route.ts`. The ids
stay literals, as `models.ts` requires. Each lane records its provider, pinned model, fallback,
budget and cleared classes.

| Lane | Job | Model (initial) | Budget |
|---|---|---|---|
| `route` | classify the turn | Jev (exists) | 3 s |
| `mechanical` | fast-path actions, deterministic blocks | no LLM (exists) | — |
| `converse` | coach tool loop | Gemini Flash (coach pin) | PR #254 budget |
| `ui` | compose a UI block from typed values | **DeepSeek `deepseek-flash`**, fallback: deterministic builder | 4 s |
| `capture` | photo, voice, label and text to items | `gemini-3.8-flash` (exists) | exists |
| `lookup` | web-grounded food and nutrition facts | Gemini Flash + `googleSearch` | 8 s |
| `judge` | facets, safety, sanity, ranking | Jev (exists) | 3 s |

### 3.1 The `ui` lane (DEVIN ruling)

- It serves generated UI that deterministic builders cannot do well: a chart choice and its
  annotations, a comparison card, a plan/calendar card layout, button sets for multi-step choices.
- It runs **in parallel** with the `converse` final step whenever the tool loop has already fetched
  the data. It never adds a sequential hop. If DeepSeek misses its budget, or its output fails the
  block schema (`lib/coach/ui-blocks.ts`), the deterministic builder renders instead. The user
  never waits on it.
- Existing deterministic paths (`show_chart`, `suggest_options`) keep priority where they already
  pass.

### 3.2 Choose models by measurement

`scripts/eval/lane-bench.ts` runs each lane's fixture set against its candidate models. For
`converse` that is `gemini-3.6-flash`, `gemini-3.8-flash` and `deepseek-flash` (D1 fixtures only).
For `ui` it is `deepseek-flash` and `gemini-3.8-flash`. For `capture` it is Gemini 3.8 vs 3.7.

It records p50/p95 latency, schema-valid rate, task accuracy against labelled expectations and
cost. A lane's pin changes only through a PR that attaches the bench report. It never runs in CI,
because it bills real projects. **DECIDED (run):** a model takes a lane when it is at least as
accurate and faster, or clearly more accurate within the latency budget.

### 3.3 The `lookup` lane

- It is a coach tool with a typed argument `{ subject: string }`: a food, dish, brand or
  restaurant item, at most 80 characters.
- `converse` produces the argument. A validator rejects it when the subject:
  - contains a digit sequence other than a product number;
  - contains the user's name or a stored condition or allergy term;
  - contains first-person or medical words (the Phase 10 vocabulary list).

  Rejection tests cover names, weights, conditions and medical notes (closes Sol r1 finding 6).
- A single Gemini call with `googleSearch` then sees only the validated subject and a fixed
  question template.
- Numeric claims are kept only when Gemini's `groundingMetadata.groundingSupports` link them to a
  source segment. Unsupported numbers are dropped. This check is deterministic and adds no model
  hop (closes Sol r1 finding 8; the Jev attribution idea is withdrawn). Source links are shown.
- The tool runs only when the model calls it. Spend counts `webSearchQueries.length × $0.014` as
  its own `ai_calls` cost line (Sol r1 finding 8).

### 3.4 Model freshness

A weekly GitHub Actions job lists the Gemini models the key can see and Jev's `/models`, compares
them with `lanes.ts`, and opens or updates one issue when a newer Flash or Jev version exists. It
never changes a pin. When Gemini 4 Flash ships, that issue triggers a lane-bench run.

## 4. Dietary profile map (adopts docs/research/2026-09-23-dietary-profile-map.md)

The map is the source of truth for profiles and facets; its machine-readable twin
`docs/research/dietary-profiles.draft.json` (124 profiles, 71 new facets, 138 checked sources) is
what code imports. This section states only the decisions that bind the build.

- **Profile instances replace the 12 `PREFERENCE_FLAGS`** one-to-one (map §7.1). Strengths: never,
  avoid, limit, sometimes, prefer. Flexible diets are a base profile plus exceptions with a budget
  or context ("mostly pescatarian, sometimes chicken" = pescatarian + `poultry` sometimes).
- **Hard lists feed `evaluatePolicy`** with its precedence unchanged. Soft and prefer lists feed a
  new pure `rankFoods(profileInstances, facets, nutrients)` that returns a score and reasons and
  never changes a verdict (map §7.2).
- **Hard blocks come only from:** an allergy, celiac, a religious rule the user picks, the user's
  own "never", or a medical safety item the user confirms one by one. A diagnosis alone never
  blocks; `CONDITION_RULES` stays empty.
- **Condition packs (DECIDED (run), amends rev 2):** a condition profile is an opt-in pack
  ("Help me follow my doctor's low-sodium advice") of soft rules plus `user_confirmed_safety`
  items. Each soft rule shows its evidence strength and one source; each pack shows "Your
  clinician's advice comes first." Packs ship behind `CONDITION_PACKS_ENABLED`, off in production
  until Devin reviews the wording on a Preview (ideally with Sasha's nutritionist). Nothing else
  in this phase waits on that review.
- **Religious entries** offer options (e.g. halal strictness, kosher meat→dairy wait) rather than one
  fixed rule, and never certify. Wording review by someone from each tradition is recommended
  (§8 item 4) and does not block.
- **Detecting profiles in the user's words is not Jev** (map §6 row 4): a deterministic synonym
  matcher plus `converse` (Gemini, D2 gate) proposes; a confirm card applies.
- **New facets** are built in the map's value order (§5.2): a user-named-allergen template,
  `red_meat`, `poultry`, `processed_meat`, `high_sodium`, `added_sugar`, food-safety facets,
  `ultra_processed`, allergen splits (fish, crustacean, wheat), `protein_dense`, then the rest. Each
  needs a rubric, a labelled set (≥ 30 % positives for safety facets), threshold calibration and a
  `RUBRIC_VERSION` bump before any rule reads it. The map's §5.4 fixes to existing rubrics ship with
  the first facet slice.

## 5. Allergen safety (revised; closes Sol r1 findings 4 and 5)

- **Three evidence levels per allergen per food:**
  - `listed`: the ingredient text or label names it, or Jev flags it.
  - `not_listed`: a parsed ingredient list is present and names no form of it.
  - `no_evidence`: no ingredient list is available.
- Jev can move a food *to* `listed`. It can never move a food to `not_listed`. Jev is a warning
  signal, never clearance.
- For an active allergen rule:
  - `listed` blocks the food.
  - `no_evidence` is `unverified` and shows a "Check the label" mark.
  - `not_listed` is allowed, with the wording "No <allergen> listed on the label" and never
    "safe". Labels need not warn about cross-contact.
- The Eats-list bypass no longer applies to active allergens.
- Account-defined allergens outside the facet vocabulary match the ingredient text
  deterministically. Otherwise they stay `unverified`.
- **UX:**
  - Suggestions exclude `listed` and `unverified` foods.
  - When exclusions empty a suggestion set, the card shows the verified alternatives it has and
    one line: "Some foods are hidden until their labels are checked".
  - Logging is never blocked: the user can log any food, and the mark shows.
  - Facet warming always asks the same fixed, user-independent question set (§9 R4).
  - Coverage (the share of the user's recent foods with evidence) is logged per warm, so false
    exclusions can be measured.

### 5.1 Plain whole foods (owner decision, Devin, 2026-10-02)

"Yes, plain whole foods should be cleared." Before this, `no_evidence` read `unverified` for
every allergen a food's rule covers, whatever the food actually was: a catalog row with no
ingredient text ("Ahi tuna, cooked", "Chicken breast", "Broccoli" — no brand, no tags, no
category) was unverified for gluten AND dairy alike, so an account avoiding both got zero Eats
protein suggestions.

- `lib/policy/whole-foods.ts` holds a small, explicit table of whole-food classes (fish,
  shellfish, poultry, red meat, egg, dairy, grain — gluten and gluten-free kept separate — legume,
  soy, tree nuts, peanuts, sesame, seeds, vegetables, fruit), each with the allergens intrinsic to
  it. Oats are a special case: their gluten mark is cross-contact risk, not an ingredient word, so
  it clears only when the name itself claims gluten-free.
- A food clears for the fallback `no_evidence` case only: a brand, a multi-item ingredient list,
  or a prepared/compound name (breaded, sauced, canned-with-additives, "chicken and rice", a
  sausage/nugget/mix/bar/drink/powder, a style name like teriyaki) disqualifies it before the name
  table is even consulted. A name outside the table gets no clearance, same as today.
- Precedence is unchanged and this never overrides it: a stored `listed`, a `not_listed` label, or
  the user's own "I checked this label" mark all still win. This only fills the gap below them,
  and only for the allergens NOT intrinsic to that food's class — a plain fish still blocks for
  fish, a plain shellfish still blocks for shellfish/crustacean.
- **Escalation by name, same decision:** the food's own name is now scanned with the same keyword
  table used for ingredient text, so a name that itself states a major allergen resolves `listed`
  with no ingredient text at all — "Protein powder, whey based" blocks a dairy avoid because whey
  is dairy, and a name stating a fish species blocks a fish avoid the same way. A name only ever
  escalates toward `listed`, exactly like a tag or a Jev `present` facet.

## 6. Where Jev helps

Adopt map §6 rows 1–9 as written: Jev answers the same food-facet questions for every user (D0),
and code owns the profile, the rules and the arithmetic. Two amendments:

- **Reply check (map row 5 replaces rev 2's reply `noul`):** code extracts the foods a reply names
  (block food ids first, then a catalog matcher) and checks their cached facets against hard rules;
  only an uncached isolated food name goes to Jev as a normal facet tag. A hard hit replaces the
  reply with a safe re-ask. Runs in parallel with coach-verify.
- **Lookup check:** map row 10 (Jev attribution score) is not adopted; §3.3's deterministic
  grounding-support check stands, so lookup adds no Jev hop.
- **Next best action on Today** (rev 2) stays: one Jev `choice` over a fixed action set from
  deterministic state flags only.

## 7. Slices (each its own PR, TDD, GPT-6 Sol review)

0. **Call registry and data-class contract test**, and the Gemini attestation gate for all
   user-content calls.
1. **Lane table** (no behaviour change) and the **lane-bench** harness. Run the bench and report.
2. **Allergen safety** (§5) and the capture-card warning.
3. **Dietary profile model:** profile instances from the JSON, strengths and exceptions,
   `rankFoods`, the map's rubric fixes, the first facets in value order with calibrated thresholds.
   Condition packs land here behind `CONDITION_PACKS_ENABLED` (off).
4. **Profile capture** with user confirmation, in onboarding and chat.
5. **`ui` lane:** DeepSeek adapter, payload builder, parallel composition, deterministic fallback.
6. **`lookup` lane.**
7. **Reply check, likes and dislikes, next-best-action chip, model freshness workflow.**

**Gates for every slice:**
- Coach turn p95 must not rise. After PR #254 it must stay under 30 s, and the target is 15 s.
- Capture p95 must not rise.
- The bench report is attached when a pin changes.

### 7.1 Slice 0's own gate check (review round 1, sol lens BLOCK: "no before-and-after coach or
capture p95 samples")

Slice 0 changes no model pin, so the bench report gate does not apply to it (§3.2: a report is
attached "when a pin changes"). The p95-must-not-rise gates still do, and are checked by argument
plus real, dated telemetry rather than a fabricated before/after pair:

- **No new I/O on the hot path.** Every check slice 0 adds — `geminiAttested()` (a synchronous
  `process.env` read via `routeConfig()`, no I/O), `callRefusal` (a synchronous object/array
  lookup against `CALL_REGISTRY`/`CLEARED`), `geminiProvenance` (a `WeakMap.get`) — runs in-process
  with no `await`, before the request is even hashed. None of it adds a round trip, a retry or a
  wait, on the coach turn or any capture purpose.
- **The two perf-flagged changes in this branch's history are reductions, not additions**: the
  media builder now copies the caller's bytes once instead of twice
  (`lib/ai/adapter.ts::withMediaPart`, commit `60aa9a3`), and `deepFreeze` no longer walks a
  payload's accessor properties (commit `4f08ca4`). Both remove work from the request path; neither
  can raise its p95.
- **Real coach-turn p95, captured today (2026-09-24) from live `client_timings` telemetry** (read-
  only, `pnpm timings --path coach-turn`, against this project's existing production data — not a
  controlled before/after for this diff, and small-n, so read it as a signal, not the AC9
  acceptance measurement):

  | days | n | `model` p50/p95 (ms) | `first-text` p50/p95 (ms) |
  |---|---|---|---|
  | 1 | 5 | 7223 / 10114 | 13038 / 14843 |
  | 7 | 19 | 5447 / 12359 | 12590 / 20777 |

  The model round trip alone already sits at multi-second p95 — several orders of magnitude above
  the synchronous, sub-millisecond checks slice 0 adds — so this slice cannot be the thing that
  moves that number. (This baseline is itself well over the 3 s AC9 first-text budget in
  `docs/plans/2026-09-17-t0-speed-foundations.md` §6; that gap predates slice 0 and is a coach
  model-routing question, not a call-registry one — worth its own follow-up, not a slice 0 block.)
- **Capture p95, provider side** (`pnpm timings:ai`, `scripts/ai-calls-timings.ts`, added after
  round 1 — reads `ai_calls.latency_ms`, one line per purpose and status, through the same
  `summarize` as `pnpm timings`; `--by-model` splits a purpose by pin, the view for §3.2's bench
  report). Captured 2026-09-24, read-only, same production data, `ok` rows only:

  | purpose | days | n | p50 / p95 (ms) |
  |---|---|---|---|
  | `coach` | 7 | 42 | 2720 / 4643 |
  | `photoToItems` | 30 | 1 | 2826 / 2826 |
  | `labelToNutrients` | 30 | 1 | 4781 / 4781 (plus 2 `timeout` rows at ~19.7 s) |
  | `textToItems` | 30 | 3 | 1834 / 1915 |

  Client-side capture paths are near-empty: `pnpm timings --path photo|voice|label|text|barcode`
  over 30 days finds one `photo` run and nothing else, so the user-felt capture p95 cannot be
  judged from telemetry yet — the capture gate can only be read provider-side today, and a slice
  that changes a capture code path should collect the AC9 phone runs itself. (Note the units when
  comparing the two tables: the client `model` step sums every generate call a coach turn spent,
  fallbacks included, so its p95 sits above the per-call `ai_calls` p95.) None of this is evidence
  that slice 0 regressed capture: its changes to `capturePayload` are the same class of
  synchronous, no-I/O checks described above.
- **The one thing that is not a bare env/lookup check (review round 2, sol lens BLOCK)**: every
  Gemini builder's `gemini()` helper (`lib/ai/gemini-payloads.ts::gemini`) copies media bytes once
  at mint — `new Uint8Array(media.bytes)` — so the frozen payload keeps its own buffer no caller can
  later mutate. This is new in this branch (the whole file is), it is a memory copy rather than an
  env read, and it runs strictly BEFORE `generateStructured`'s own `started = Date.now()`
  (`lib/ai/adapter.ts`), so it sits outside the `ai_calls.latency_ms` window the table above reads —
  the captured provider-side numbers do not, and cannot, measure it. It is argued the same way the
  synchronous checks above are, not measured: a single bounded, in-process `memcpy` of one photo,
  voice clip or label image — the same object `withMediaPart` already reads once more, sized the
  same as any capture request already was — costs low-single-digit milliseconds at most for
  payloads in the low tens of MB, against multi-second network p95s three orders of magnitude
  larger. It is also not new WORK added on top of what capture already did: `withMediaPart`'s own
  pre-slice-0 job (base64-encode or upload the same bytes) already touches every byte at least
  once; this adds one more bounded pass over the same buffer, not a new class of cost. If a future
  slice needs this measured rather than argued, the smallest addition is a `console.time` around
  this one line behind a debug flag, not a new telemetry pipeline.

## 8. Open for Devin

1. Email privacy@typesafe.ai: are dietary and health text allowed under the standard terms, or is
   the ZDR DPA needed? This closes the incidental-D2 residual.
2. The data-use opt-in notice (DeepSeek and others): after user testing (DEVIN).
3. Search grounding cost past 5,000 queries a month: $14 per 1,000, counted in the spend cap.
4. Review condition-pack wording on a Preview (ideally with Sasha's nutritionist), then turn on
   `CONDITION_PACKS_ENABLED`. Optional: a reviewer from each religious tradition for §4 wording.

## Resolution of audit round 1 (GPT-6 Sol, DO NOT SHIP, 5 BLOCK / 3 FIX)

| # | Finding | Change |
|---|---|---|
| 1 | BLOCK: route lane breaks D0 | Jev is cleared for D1, stated as existing practice; incidental D2 is an owner-accepted residual; the vocabulary pre-filter is withdrawn (§2) |
| 2 | BLOCK: Jev paths outside the table | Call registry, contract test and a runtime refusal at the adapter (§2, slice 0) |
| 3 | BLOCK: gate checks stored profile only | The attestation gates every user-content call, capture included (§2) |
| 4 | BLOCK: Jev absence is not evidence | Three evidence levels, Jev only escalates, no Eats bypass, "listed" wording (§5) |
| 5 | FIX: warm has no completion guarantee | Warm only the needed facets, verified alternatives, coverage metric, logging never blocked (§5) |
| 6 | BLOCK: lookup has no D0 argument | Typed `subject` argument, validator with rejection tests (§3.3) |
| 7 | FIX: trigger categories not representable | Concrete items or vocabulary facets only; no inferred categories (§4) |
| 8 | FIX: latency and cost gates | Grounding-support check replaces the Jev hop; reply check runs in parallel; grounding queries costed; per-slice p95 gates (§3.3, §6, §7) |

Sol's view on DeepSeek at runtime was superseded by the DEVIN ruling. The `ui` lane runs in
parallel, with a deterministic fallback, so it cannot slow a turn.

## Resolution of rev 3 (dietary map adoption)

- §4 rewritten to adopt the audited dietary map; condition packs made opt-in and flagged off.
- §6 reply check moved to code-side food extraction (no reply text to Jev); map's Jev lookup check
  not adopted in favour of §3.3.

## 9. Binding requirements from audit round 2 (GPT-6 Sol, DO NOT SHIP, 6 BLOCK / 2 FIX)

Decision (run): no third spec round. Each item below is an acceptance criterion of the named slice,
checked by that slice's tests and its GPT-6 Sol code review.

- **R1 (slice 2) Allergen evidence.** `not_listed` allows a food only for the nine allergens US law
  requires on labels (milk, egg, fish, crustacean shellfish, tree nuts, peanuts, wheat, soy,
  sesame). For any other named allergen, `not_listed` stays `unverified` until the user marks that
  exact product as checked. Cross-contact is never inferred from silence; the card says labels need
  not warn about it. Unspecified tuna is `unverified` for the pregnancy profile.
- **R2 (slice 2) Legacy data.** Evidence is stored per food revision, per allergen, with label
  completeness. Existing empty `allergen_tags: []` and client-created custom foods migrate to
  `no_evidence`. The Eats bypass is removed for active allergens. Tests cover named allergens and
  cross-contact separately.
- **R3 (slice 0) Payload builders.** Each purpose gets a typed payload builder; provider adapters
  accept only builder output (a branded type), never `state: unknown`. The Gemini attestation is
  checked before serialisation or media upload, for coach and capture alike. Tests prove refusal on
  incoming coach text and capture media when the attestation is off.
- **R4 (slice 2/3) Fixed facet questions.** Jev always receives the same question set for every
  food; nothing selects questions from a user's rules. User-authored food records send only the
  name, brand and ingredient fields, trimmed to their schema lengths.
- **R5 (slice 3) Typed rules before import.** Profiles import only after typed rule ids, per-item
  confirmation state, evidence state, expiry and target modifiers exist; the JSON is validated with
  a schema at build time, every profile reference resolves, and table-driven tests cover blocked /
  unverified / allowed, including unconfirmed medical rules. Prose-only behaviour in the draft JSON
  is converted to typed rules or dropped.
- **R6 (slice 3) Drug-specific interactions.** Medication rules are per drug and formulation
  (e.g. phenelzine vs tranylcypromine yogurt/cheese lists differ by label). An unknown drug stays
  `unverified`. Each label list is fixture-tested. The Atelvia card includes separating calcium,
  antacids and iron from the dose.
- **R7 (slice 7, reply check) No unchecked food advice.** A reply that recommends a food must carry
  checked food ids (blocks). When a user has active hard rules and a reply names a food that cannot
  be resolved to a checked id, the reply is replaced with a re-ask. Tests: free-text-only and mixed
  replies.
- **R8 (slices 5, 6) Honest latency.** The lookup `subject` must resolve to a catalog product or a
  controlled brand/food field before any search; grounding never clears a hard rule. Lookup is a
  sequential tool hop and has its own deadline inside the coach budget. The `ui` lane runs in
  parallel only when its block type and inputs are known before the final step; otherwise the
  deterministic block renders and no wait is added. Each path records per-hop p95 against the §7
  gate.
