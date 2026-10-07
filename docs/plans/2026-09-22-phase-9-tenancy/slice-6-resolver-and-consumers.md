# Slice 6 — The template resolver and every consumer; minimum-client gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every day is resolved from the account's own templates; runtime code never reads Sasha's constants; an account with only the default template gets Breakfast, Lunch, Snack and Dinner everywhere (Today, Week, completion, adherence, water, export, calendar, capture, coach, MCP); an invited account on an old build gets `426` and no templates.

**Architecture:** A pure `resolveDayPlan(date, stored, templates, trainingWeekdays)` replaces `dayTypeFor` and `categoryFor`; `ResolvedDay` carries `templateKey` and `category`; `slotReference` sizes composed slots in `reference` or `share` mode and the existing sizing math runs unchanged. The client fetches `GET /api/plan/templates` on ready and at the end of every sync pass (after push and pull) and stores it in the account DB's `meta` under `templates`. Server code reads templates directly. `lib/meals.ts` leaves runtime. `requireUser` refuses an invited account below `MIN_CLIENT_BUILD` with `426`.

**Tech Stack:** TypeScript, React 19, Next.js routes, `idb` meta store, Zod, Vitest (node and jsdom).

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` 1.5b, 2.2–2.4, 2.6 (pending state, no fallback), 2.8 (client side), 2.9 (every row), 3.6, 3.7, Slices item 6.

**Branch:** `feat/p9-template-resolver`. One PR, unmerged. One migration:
`20261107090000_min_client_gate.sql` (the minimum-client gate in the database; audit plan r4
finding 2). **Merged and deployed after slice 8** (M2 live first; README order).

## Global Constraints

See `README.md`. For this slice:

- **Must not deploy before rollout step 2** (Sasha's seed and the test account's backfill on
  production). No code reads her constants after this slice; an account with no templates sees the
  pending state. Say so at the top of the PR body.
- No fallback to her constants anywhere in runtime (`app/`, `components/`, `lib/`).
- Floor Day behaves exactly as on `main` today (Task 4); no verdicts, no suppression.
- `426 client_upgrade_required` for a `default` (invited) account without `x-smc-client` or below
  `MIN_CLIENT_BUILD`; `manual` accounts are not affected. This check runs **after** PR #248's
  account-header check, which stays: a request with no `x-smc-account` answers
  `401 account_header_required` for every account (audit plan r4 finding 6). So a truly old,
  headerless build gets `401` on every `/api/` route before the build check runs.
- The same minimum is enforced **in the database** for direct PostgREST calls (Task 8b), because
  an old build can call `set_food_membership` and write `user_foods` directly, without any
  `/api/` route (audit plan r4 finding 2).
- Depends on slice 1 (`accountFetch`, account DB `meta`), slice 4 (`TemplatesResponse`, the route,
  the fixture) and slice 5 (`account_claims.seed_policy` values in use).

## Plan decision

- **P7:** the client build number is a constant `CLIENT_BUILD` in `lib/client-build.ts` (an
  integer; start at `9001`), sent as `x-smc-client` by `accountFetch`. Raise it only when a change
  must lock older clients out. `MIN_CLIENT_BUILD` is a server env integer (unset → no gate).
  Reason: deterministic, testable, no build-pipeline dependency.

## Current code (verified at `1d5790d`; every row of spec 2.9 checked, all lines still match)

- `lib/plan.ts:27-38` `dayTypeFor` (weekday 3 → `training-7-fasted`); `:43-47` `SLOT_ORDER`; `:62-84` `BASE_SLOT_TIMES`; `:123` `settings.slotTimes`.
- `lib/targets.ts:5-7` `categoryFor`; `:16-24` `resolveTargets(dayType, settings)`.
- `lib/resolve.ts:62-107` sizing; `:155-159` Avoid slug check; `:168` `resolveDay(store, date, waterCups)`; `:173-217` slots and floor; `:182-184` unsafe floor keeps rotation meal.
- `lib/rotation.ts:14-229`; `lib/meals.ts:79-113,882-925,938-960`.
- `lib/server/day-context.ts:176-200` `serverStoreFor(admin, userId, date)`.
- `lib/server/coach-ports.ts:99-152`; `lib/coach/apply-schedule.ts:18-40`.
- `lib/ics.ts:30-117,289`; `lib/water.ts:11,57-64`; `lib/water-client.ts:78`; `lib/server/export.ts:216-229`; `lib/server/export-water.ts:55`.
- `lib/summary.ts:21-25`; `components/TodayDayStrip.tsx:34`; `components/week/WeekGrid.tsx:9`; `app/page.tsx:12-13,97,543-615`.
- `public/sw.js:22` `CACHE_VERSION = "v2"`; `:44-51` `activate` deletes other caches and `clients.claim()`.
- All other 2.9 rows: see the spec table; the Explore check at `1d5790d` found every cited line still describing the thing it names.

## File structure

Create: `lib/plan/templates.ts` (`resolveDayPlan`, `slotReference`, `composedSlots`, `slotFlags`),
`lib/plan/templates-client.ts` (`fetchTemplates(h)`, `storedTemplates(h)`),
`lib/client-build.ts`, `components/PlanPending.tsx` ("Setting up your plan" + Retry),
`tests/plan/resolve-day-plan.test.ts`, `tests/plan/slot-reference.test.ts`,
`tests/plan/four-slot-account.test.ts`, `tests/plan/floor-day.test.ts`,
`tests/tenancy/fresh-account.test.ts` (DB), `tests/tenancy/no-authored-plan.test.ts`,
`tests/device/min-client.test.ts`, `tests/sw/sw-reload.test.ts`.

Modify: every file in spec 2.9's table; `lib/server/auth.ts` (426); `lib/device/account.ts`
(`x-smc-client`); `lib/sync/client.ts` (fetch templates after push and pull); `public/sw.js` (`v4`; slice 1
already added the navigate-on-activate); `lib/types.ts:12-22` (`DayType`/`SlotId` become branded strings).

## Interfaces

```ts
// lib/plan/templates.ts
export type Category = "training" | "rest";
export type StoredPlanDay = { dayTypeOverride?: string; categoryOverride?: Category };
export function resolveDayPlan(date: string, stored: StoredPlanDay, templates: DayTemplate[],
  trainingWeekdays: readonly number[]): { template: DayTemplate; category: Category };
export function slotReference(slot: TemplateSlot, dayTarget: Macros | null, sizing: "reference" | "share"):
  { protein: number; carbs: number; fat: number; kcal: number } | null;
export class TemplatesMissing extends Error {}
// ResolvedDay gains: templateKey: string; category: Category; slots[i].kind, .countsForAdherence, .requiredForCompletion, .compact
```

---

### Task 1: `resolveDayPlan` (pure)

- [ ] **Step 1: Failing tests** (`tests/plan/resolve-day-plan.test.ts`), using `scripts/fixtures/sasha-plan.json` and a built `everyday` template:

```ts
import { describe, expect, it } from "vitest";
import fixture from "@/scripts/fixtures/sasha-plan.json";
import { resolveDayPlan } from "@/lib/plan/templates";
import type { DayTemplate } from "@/lib/plan/template-types";

const hers = fixture.templates as DayTemplate[];
const everyday: DayTemplate = { key: "everyday", label: "Every day", serves: ["training", "rest"], weekdays: [], sizing: "share", position: 0, slots: [] };
const MON = "2026-09-21", WED = "2026-09-23", SUN = "2026-09-27";

describe("resolveDayPlan (spec 2.2)", () => {
  it("Wednesday is fasted only on a training day", () => {
    expect(resolveDayPlan(WED, {}, hers, [1, 3, 5]).template.key).toBe("training-7-fasted");
    expect(resolveDayPlan(WED, {}, hers, [1, 5])).toMatchObject({ category: "rest", template: { key: "rest" } });
  });
  it("toggling a non-training Wednesday to training gives the fasted template (lib/plan-day.ts:37-40)", () => {
    expect(resolveDayPlan(WED, { categoryOverride: "training" }, hers, [1, 5]).template.key).toBe("training-7-fasted");
  });
  it("a day-type override wins and sets the category when the template serves one", () => {
    expect(resolveDayPlan(MON, { dayTypeOverride: "rest" }, hers, [1])).toMatchObject({ category: "rest", template: { key: "rest" } });
  });
  it("Monday training → training-10; Sunday → rest", () => {
    expect(resolveDayPlan(MON, {}, hers, [1]).template.key).toBe("training-10");
    expect(resolveDayPlan(SUN, {}, hers, [1]).template.key).toBe("rest");
  });
  it("one template that serves both categories keeps the weekday category", () => {
    expect(resolveDayPlan(MON, {}, [everyday], [1])).toMatchObject({ category: "training", template: { key: "everyday" } });
    expect(resolveDayPlan(SUN, {}, [everyday], [1])).toMatchObject({ category: "rest", template: { key: "everyday" } });
  });
  it("throws TemplatesMissing with no templates", () => {
    expect(() => resolveDayPlan(MON, {}, [], [1])).toThrow("TemplatesMissing");
  });
  it("a stored legacy override with no matching template keeps its category (audit plan r6 finding 2)", () => {
    // a kept account backfilled with `everyday`, with an old row that says training-10 on a Sunday
    expect(resolveDayPlan(SUN, { dayTypeOverride: "training-10" }, [everyday], [1]))
      .toMatchObject({ category: "training", template: { key: "everyday" } });
    expect(resolveDayPlan(MON, { dayTypeOverride: "rest" }, [everyday], [1]))
      .toMatchObject({ category: "rest", template: { key: "everyday" } });
  });
  it("an unknown non-legacy override is ignored, never thrown", () => {
    expect(resolveDayPlan(MON, { dayTypeOverride: "zzz" }, [everyday], [1]))
      .toMatchObject({ category: "training", template: { key: "everyday" } });
  });
});
```

**Override with no matching template (audit plan r6 finding 2).** M2 keeps an unchanged old
`day_type_override` (slice 8), so a kept account backfilled with `everyday` can hold
`training-10`, `training-7-fasted` or `rest`. Rule, data-preserving (the row is not changed):
when `stored.dayTypeOverride` names none of the account's templates, it does not select a
template; if it is one of the three legacy keys, it still gives the category (`rest` → rest, the two
`training-*` keys → training), because that is what the user chose; any other unknown value is
ignored. `categoryOverride` still wins over it (spec 2.2 step 1). Slice 8's
`scripts/p9/m2-inventory.sql` lists these rows before deployment.

- [ ] **Step 2:** `pnpm exec vitest run tests/plan/resolve-day-plan.test.ts` — FAIL.
- [ ] **Step 3:** Implement per spec 2.2 steps 1–2.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat: resolve day template and category from the account's templates`.

### Task 2: `slotReference` (both modes)

- [ ] **Step 1: Failing tests** — `reference` returns the three `ref_*` and `kcal = 4P + 4C + 9F` for every fixture slot (equals the spec 2.3 table); `share` with a day target `{ protein: 120, carbs: 200, fat: 60 }` and shares `0.25` returns `{ 30, 50, 15, kcal: 455 }`; `share` without a day target returns `null`.
- [ ] **Steps 2–5** as above (`tests/plan/slot-reference.test.ts`).

### Task 3: `resolveDay` from templates; `lib/meals.ts` out of runtime

**Files:** `lib/resolve.ts`, `lib/rotation.ts`, `lib/plan.ts`, `lib/targets.ts`, `lib/types.ts`, `lib/meals.ts` (moved to `scripts/p9/legacy/meals.ts` for the generator and tests only), `tests/tenancy/no-authored-plan.test.ts`, the existing resolve/rotation tests.

- [ ] **Step 1: Failing tests** — `tests/tenancy/no-authored-plan.test.ts` (spec 3.7; moved here from slice 3): every meal id, option name and ritual slot key in `scripts/fixtures/sasha-plan.json` is absent from `app/`, `components/`, `lib/` sources (comments stripped); and a snapshot test: for 20 dates across her three templates, `resolveDay(store-with-her-templates, date)` equals the committed pre-change `ResolvedDay` JSON (`tests/plan/__snapshots__/her-days.json`). **This fixture is synthetic** (audit plan r14 finding 1): a small generator in this task, run at the base commit, builds a store from `scripts/fixtures/sasha-plan.json` (authored plan data in the repository, not account data) and synthetic stored days (fixed dates, invented swaps, eaten marks and notes, no rows from any database) and resolves them with `main`'s `resolveDay`. It never uses `scripts/p9/resolve-snapshot.ts` or a database; account-data snapshots stay private (slice 7).
- [ ] **Step 2:** FAIL (her constants are in `lib/`).
- [ ] **Step 3:** `Store` gains `templates: DayTemplate[] | null`; `resolveDay` calls `resolveDayPlan`, iterates `template.slots` by `position`, sizes composed slots with `slotReference` then the existing math (`resolve.ts:62-107`), rotates `options` slots by `position` with `rotation_phase` (`rotation.ts:57-78`), de-duplicates in slot `position` order; `resolveTargets` takes `category`. Move `lib/meals.ts` out of runtime; the fixture test from slice 4 switches to a checksum of the committed JSON.
- [ ] **Step 4:** PASS, plus the existing `tests/plan/*`, `tests/today/*`, `tests/week/*` files only.
- [ ] **Step 5:** commit.

### Task 4: Floor Day as on `main` today (audit plan r10; Devin accepted)

Phase 9 does not change Floor Day. The resolver reads floor meals from the template's
`purpose = 'floor'` rows (only Sasha's migrated templates have them; the default template has
none, so a new account has no Floor Day control) and applies them exactly as `main` does today
(`lib/resolve.ts:155-159,173-184`). Today's Avoid check looks up meal slugs in a store keyed by
`user_foods.id` UUIDs, so it never fires (spec Facts); the new resolver keeps that observable
behavior: with Floor Day on, the floor meal is used. No verdict, no session state, no suppression.
The broken Avoid check is a known pre-existing issue (README "Open for Devin") and the safety
verdict is a "Later" feature.

- [ ] **Step 1: Failing tests** (`tests/plan/floor-day.test.ts`): with Sasha's fixture templates,
  Floor Day on → each of meal-1/2/3 shows its floor meal, identical (meal id, components, macros) to
  `main`'s `resolveDay` output for the same stored day (compare with the committed pre-change
  snapshot `tests/plan/__snapshots__/her-days.json`, Task 3); Floor Day off → rotation meals; the
  `everyday` template → no floor meals and no Floor Day control.
- [ ] **Steps 2–5.**

### Task 5: Client templates fetch, pending state, server readers

**Files:** `lib/plan/templates-client.ts`, `lib/sync/client.ts` (`syncOnce` fetches templates after its push and pull complete; the stored copy is used offline), `lib/sync/account-sync.ts` (fetch on ready), `components/PlanPending.tsx`, `app/page.tsx`, `components/week/*`, `app/coach/*`, `lib/server/day-context.ts:176` (`serverStoreFor` reads templates; throws `TemplatesMissing`), `lib/mcp/coach-tools.ts` ("no plan yet"), `lib/server/export.ts`.

- [ ] **Step 1: Failing tests** — `fetchTemplates(h)` stores the response under `meta.templates` of A's DB only; with no network it resolves from the stored copy; with no stored copy Today renders `PlanPending` ("Setting up your plan") whose Retry calls `claim_account` (mock); `serverStoreFor` for a user without templates throws `TemplatesMissing` and the MCP day report answers "no plan yet".
- [ ] **Steps 2–5.**

### Task 6: Every consumer in spec 2.9

Work through the table one row per commit, each with its test first. Rows and their tests:

| Row | Test (new or extended) | Assertion |
|---|---|---|
| Meal-slot test (`isMealSlot` → `kind === "composed"`) | `tests/plan/four-slot-account.test.ts` | all four default slots are composed |
| Coach sizing `lib/server/coach-ports.ts:99-152` | same | a quarter-day suggestion is sized against the pending composed slots, not the whole remainder |
| Coach schedule `lib/coach/apply-schedule.ts:18-40` | same | a shift moves all four slots |
| Targets, water | same | water goal differs on a training vs rest weekday |
| Export | same | the export row uses the resolved category |
| Calendar `lib/ics.ts` | same | events per weekday come from templates and training weekdays; no fixed weekday list |
| Day toggle and chip | `tests/plan/plan-day-client-overrides.test.ts` (extend) | toggle writes `category_override`, clears `day_type_override` |
| Today, Week, summary | same four-slot file | completion uses `required_for_completion`; adherence counts `counts_for_adherence`; compact from `compact` |
| Settings times | `tests/settings/*` (extend) | the union of slot keys with labels |
| Sheets, labels | same four-slot file | labels come from the template |
| Capture, log | same | slot choices = the day's template slots plus `snack` |
| Coach schemas, prompt, intent | same | the coach slot schema is built per request from slot keys |
| Sync | `lib/sync/plan-days*.test.ts` (extend) | runtime validation of slot keys; `category_override` round-trips |
| MCP | `tests/log/mcp-get-day.test.ts` (extend) | the day report uses templates |
| Scripts | `scripts/readiness/new-user-walk.lib.mjs:210-230` | reads account templates |

The acceptance file `tests/plan/four-slot-account.test.ts` (spec 2.9 last paragraph) builds a store
with only the `everyday` template and asserts every row above, then: with no revision,
`needs_profile` and no numbers anywhere; after creating the account's own revision, training
targets on a training weekday and rest targets on a rest weekday; none of the fixture's slot keys,
labels or meal names appear in any rendered or returned string. **Affected-row case** (audit plan
r6 finding 2): the same account with one stored `plan_days` row `day_type_override = "training-10"`
on a rest weekday → Today (resolved day), `serverStoreFor` + `resolveDay` (server day context), the
coach context and the export row all show the `everyday` slots with the training category and no
error.

### Task 7: Fresh-account test (spec 3.6)

- [ ] `tests/tenancy/fresh-account.test.ts` (DB): `createInvitedUser()`; zero rows in every
  manifest table except `account_claims` (1, `default`), `day_templates` (1), `template_slots` (4)
  and `invite_claims` (1: the account's own, `state = 'consumed'`, `user_id` and `hook_user_id` =
  the account; audit plan r7 finding 3); the
  targets route answers `needs_profile`; the coach context builds; none of the fixture's strings
  appear in the coach context JSON. TDD cycle as above.

### Task 8: Minimum-client gate and the service-worker reload (spec 1.5b)

**Files:** `lib/client-build.ts`, `lib/device/account.ts` (`x-smc-client`), `lib/server/auth.ts`, `app/api/plan/templates/route.ts`, `public/sw.js`, `tests/device/min-client.test.ts`, `tests/sw/sw-reload.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/device/min-client.test.ts — every request carries the matching x-smc-account (PR #248)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/server/auth";

vi.mock("@/lib/supabase/server", () => ({ createRequestClient: vi.fn() }));
const U = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function clientFor(policy: "default" | "manual" | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: policy ? { seed_policy: policy } : null, error: null });
  return {
    auth: { getClaims: vi.fn().mockResolvedValue({ data: { claims: { sub: U } }, error: null }) },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
  } as never;
}
const req = (headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/sync/changes", { headers: { "x-smc-account": U, ...headers } });
const headerless = () => new Request("https://app.test/api/sync/changes");

beforeEach(() => { vi.stubEnv("MIN_CLIENT_BUILD", "9001"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("minimum-client gate (spec 1.5b) on top of the account header (PR #248)", () => {
  it("a truly old, headerless build → 401 account_header_required, for any account", async () => {
    for (const policy of ["default", "manual"] as const) {
      vi.mocked(createRequestClient).mockReturnValue(clientFor(policy));
      await expect(requireUser(headerless())).rejects.toMatchObject({ status: 401, code: "account_header_required" });
    }
  });
  it("invited account, account header, no x-smc-client → 426 client_upgrade_required", async () => {
    vi.mocked(createRequestClient).mockReturnValue(clientFor("default"));
    await expect(requireUser(req())).rejects.toMatchObject({ status: 426, code: "client_upgrade_required" });
  });
  it("invited account, account header, build below the minimum → 426", async () => {
    vi.mocked(createRequestClient).mockReturnValue(clientFor("default"));
    await expect(requireUser(req({ "x-smc-client": "9000" }))).rejects.toMatchObject({ status: 426 });
  });
  it("invited account at the minimum → allowed", async () => {
    vi.mocked(createRequestClient).mockReturnValue(clientFor("default"));
    await expect(requireUser(req({ "x-smc-client": "9001" }))).resolves.toMatchObject({ userId: U });
  });
  it("an account with no claim row yet (hooked, unclaimed) is gated like an invited one", async () => {
    vi.mocked(createRequestClient).mockReturnValue(clientFor(null));
    await expect(requireUser(req())).rejects.toMatchObject({ status: 426 });
    await expect(requireUser(req({ "x-smc-client": "9001" }))).resolves.toMatchObject({ userId: U });
  });
  it("manual account with the account header and no build header → allowed", async () => {
    vi.mocked(createRequestClient).mockReturnValue(clientFor("manual"));
    await expect(requireUser(req())).resolves.toMatchObject({ userId: U });
  });
  it("MIN_CLIENT_BUILD unset → no build gate (the account header is still required)", async () => {
    vi.unstubAllEnvs();
    vi.mocked(createRequestClient).mockReturnValue(clientFor("default"));
    await expect(requireUser(req())).resolves.toMatchObject({ userId: U });
    await expect(requireUser(headerless())).rejects.toMatchObject({ status: 401 });
  });
});
```

The route-level cases (a `426` and a `401` write nothing): `POST /api/sync/ops` as an invited
account with the account header and an old build → `426`, and the `apply_sync_op` mock is never
called; the same without any header → `401`, never called.

The reload case is a jsdom test in the same directory
(`tests/device/min-client-reload.test.tsx`): `accountFetch` with a `fetchImpl` answering `426`
calls `window.location.reload` once (replace `window.location` with an object holding a
`vi.fn()` reload, as jsdom forbids spying on it directly).

The old-tab simulation (spec 1.5b last test) is: an invited account; a headerless request (the old
build) to `/api/sync/changes` and `/api/plan/templates` → `401`, no data; a request with the
account header but no `x-smc-client` → `426`, no templates; and the PostgREST case is Task 8b.

`tests/sw/sw-reload.test.ts` (pattern: `tests/sw/sw-api-offline.test.ts`): load `public/sw.js`
in a fake `self`; `CACHE_VERSION` is `v4`; on `activate`, after `clients.claim()`, every controlled
window client gets `navigate(client.url)`.

- [ ] **Step 2:** FAIL. **Step 3:** implement (one indexed read of `account_claims` per request, cached on the request object). **Step 4:** PASS. **Step 5:** commit.

### Task 8b: The minimum-client gate in the database (audit plan r4 finding 2)

An old build signed in to an invited account can skip every `/api/` route and call PostgREST
directly: `set_food_membership` (granted to `authenticated`,
`supabase/migrations/20261023090400_food_membership_v2.sql:127-128`), `get_or_create_food_ref`,
`apply_sync_op`, and table writes such as `user_foods` upserts (`lib/foods/prefs-client.ts:355`).
The gate therefore also lives in the database.

**Files:** create `supabase/migrations/20261107090000_min_client_gate.sql` and its down file;
modify `lib/supabase/client.ts:13-25` (`browserClient` sends `global.headers["x-smc-client"] =
String(CLIENT_BUILD)`), `lib/supabase/server.ts:108-123` (`createRequestClient` copies the incoming
request's `x-smc-client` into `global.headers`, so a route's own PostgREST calls as the user pass
the gate after `requireUser` passed it); tests `tests/tenancy/min-client-db.test.ts` (DB).

Migration:
1. `app_config (key text primary key, value text not null)`, RLS on, no policies, no grant to
   `anon`/`authenticated`. Devin inserts `('min_client_build', '<CLIENT_BUILD>')` at rollout step
   6; with no row there is no build gate (same as `MIN_CLIENT_BUILD` unset).
2. `public.client_allowed() returns boolean` (`security definer`, `stable`, `set search_path = ''`):
   true when `auth.uid()` is null (service role, migrations), or the caller's `account_claims` row
   has `seed_policy = 'manual'`, or there is no `min_client_build` row, or
   `current_setting('request.headers', true)::json ->> 'x-smc-client'` is a number (`^\d{1,9}$`) at
   or above it. Execute: `authenticated`, `service_role`.
   **An account with no `account_claims` row is gated like an invited one** (audit plan r6
   finding 1): between the hook and `claim_account` an invited user has no claim, and an old build
   must not write then. The new build sends `x-smc-client` on every PostgREST call, so its
   `claim_account` call passes. `requireUser`'s `426` rule uses the same test: a missing claim row
   counts as `default`.
3. `public._assert_client_allowed()` raises `42501 'client_upgrade_required'` when
   `client_allowed()` is false. Execute: revoked from `public`, `anon`, `authenticated`.
4. For every table in `tests/tenancy/table-ops.json` whose declared `ops` is not empty (the list is
   written out in the migration, as `20260911000500_rls.sql` does):
   `create policy <t>_min_client on public.<t> as restrictive for all to authenticated
   using (public.client_allowed()) with check (public.client_allowed());`
5. Every `security definer` function in `tests/tenancy/rpc-ops.json` with `"class": "account"` gets
   `perform public._assert_client_allowed(); -- p9_min_client_guard` as its first statement, by the
   same `pg_get_functiondef` + `regexp_replace` technique and marker skip as `20261103090000`.
   **The migration names the functions it patches in an explicit array** (not a query over the
   manifest), and that array never contains `client_allowed()`, `_assert_client_allowed()` or
   `_sync_assert_caller(uuid)` (audit plan r5 finding 4: patching `client_allowed()` would make it
   call itself through `_assert_client_allowed()`). `client_allowed()` reads `account_claims` and
   `app_config` as `security definer`, so the restrictive policy on `account_claims` does not call
   back into it.
6. Run the #249 guard block again at the end (slice 4 Task 0) and the check query in the test.
The down file drops the policies, strips the marker lines by the reverse replacement, drops the two
functions and `app_config`; it destroys no user data, so it has no guard.

- [ ] **Step 1: Failing tests** (`tests/tenancy/min-client-db.test.ts`, local stack; a
  `min_client_build = 9001` row inserted in `beforeAll` and removed in `afterAll`):
  - invited account (`createInvitedUser`), anon client **without** `x-smc-client`: `rpc("set_food_membership", { p_user: own id, … })` → error `client_upgrade_required`; `from("user_foods").upsert({ user_id: own id, … })` → refused; `from("plan_days").select()` → 0 rows and no error leak of other data;
  - the same client with `global.headers["x-smc-client"] = "9000"` → refused; `"9001"` → both succeed;
  - **a hooked but unclaimed user** (sign-up with a nonce, no `claim_account` yet): without the
    header, `rpc("set_food_membership")` and a `user_foods` upsert are refused; with
    `x-smc-client: 9001`, `rpc("claim_account", { p_nonce })` succeeds (audit plan r6 finding 1);
  - a `manual` account without the header → both succeed (Sasha's old tabs keep working through PostgREST; through `/api/` they get PR #248's `401` and reload);
  - service role → succeeds;
  - no `min_client_build` row → the invited account succeeds without the header;
  - `scripts/p9/check-sync-guard.sql` still passes;
  - no recursion (audit plan r5 finding 4): `pg_get_functiondef` of `client_allowed()` and
    `_assert_client_allowed()` does not contain `p9_min_client_guard`; as the invited account with
    a valid header, a direct `rpc("client_allowed")` answers `true`, and a `select` on
    `account_claims` (a table with the restrictive policy, whose check calls `client_allowed()`)
    answers its one row — both without a `stack depth` error; the same select without the header
    answers 0 rows, not an error.
  Add to PR #247's manifests: `rpc-ops.json` → `"client_allowed()": { "class": "account", "case": "client_allowed" }`
  (the case: as B it answers for B only; it takes no argument), and `rls-lint.test.ts`'s no-owner RLS
  list → `app_config`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS (local stack, this file only).
  **Step 5:** commit `feat: enforce the minimum client build in the database for invited accounts`.

### Task 8c: The resolver proof on `p9-tenancy` (spec 2.7 step 3; moved here from slice 7, audit plan r5 finding 6)

Starts from the branch state slice 8 left (restored; M1, seed, backfill and M2 applied;
`ledger-check.sql` passes). Uses slice 7's scripts and its private `~/Backups/supabase/p9-proof/<run-id>/``before.json` (base code).
1. Apply `20261107090000` with `apply-migrations.py` (dry run lists exactly it); `ledger-check.sql`
   and `check-sync-guard.sql` pass.
2. `resolve-snapshot.ts --code-root <this branch's worktree> --target <branch> --user <Sasha>` →
   `~/Backups/supabase/p9-proof/<run-id>/``after.json` (private; the PR gets only the redacted summary, slice 7 rule).
3. `diff-snapshots.ts before.json after.json` → prints nothing. **Exact equality, no allowed
   changes** (audit plan r10): every date × Floor Day off/on × swap must match `main`'s output on
   every field of `main`'s `ResolvedDay` (slice 7 Task 1); the new `templateKey` and `category` are
   checked as slice 7 states. Snapshots stay in `~/Backups/supabase/p9-proof/`; the PR gets only the
   redacted summary (hashes, counts, provenance).
4. The PR is not ready for review until step 3 prints nothing.

### Task 9: Gates and PR

`pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run --changed origin/main`; DB files
(`tests/tenancy/fresh-account.test.ts`) against the local stack only. Push, PR (unmerged), review
to `docs/audit/code/`. PR body top line: "Deploy only after README rollout steps 3 and 5 (seed and
backfill on production; M2 live)." Apply `20261107090000` on `p9-tenancy` with
`apply-migrations.py` (dry run lists exactly it), then run the guard check.

## Preview test steps

Preview uses the `p9-tenancy` database with Sasha's restored data, her seed and the test account's
backfill applied (slices 4, 5 human steps).

1. Sign in as T (test account, default template). If onboarding shows, finish it. Today shows
   Breakfast, Lunch, Snack, Dinner. No coffee, pouches, hot chocolate, "post-refuel" or fasted
   Wednesday anywhere (Today, Week, Settings → times, capture slot picker, Coach "log to…").
2. On a training weekday Today's targets are the training numbers; on a rest weekday the rest
   numbers (use the day toggle to switch; the chip shows the category).
3. Week: completion ticks use the four slots; export (Settings → Export) rows show the category.
4. Calendar subscribe link: the `.ics` has four events per day at 08:00, 12:30, 15:30, 19:00.
5. Sign in as Sasha's restored account (Devin, with her consent, or Sasha herself): Today, Week and
   Floor Day look exactly as on production today.
6. Sasha's Floor Day: switch it on for a day; the floor meals are the same as on production today.
   T has no Floor Day control.
7. **Old-client gate on the preview (audit plan r6 finding 4).** Setup, Devin, Preview only:
   set `MIN_CLIENT_BUILD=9001` on this branch's **Preview** environment (never Production) and
   redeploy it; on `p9-tenancy` run
   `insert into app_config (key, value) values ('min_client_build', '9001') on conflict (key) do update set value = excluded.value;`.
   Then run the probe, which acts as an old client signed in to a fresh invited test account:
   `pnpm exec tsx scripts/p9/old-client-probe.ts --target <preview URL> --project-ref <p9-tenancy ref>`
   (create it in Task 8b: it refuses the production ref like slice 7's scripts; it creates the
   account with `createInvitedUser` on the branch **with the current-build header** — the helper's
   clients send `x-smc-client: <CLIENT_BUILD>` by default, so sign-up's `claim_account` passes the
   gate (audit plan r7 finding 4) — then signs in with its password and prints one line per
   check; only the requests meant as the old client omit the header). Expected output:
   - `POST /api/sync/ops` with no header → `401 account_header_required`;
   - `POST /api/sync/ops` with `x-smc-account` and no `x-smc-client` → `426`, and the op is not in
     `plan_days`;
   - PostgREST `rpc/set_food_membership` and a `user_foods` upsert with no `x-smc-client` → refused,
     no row;
   - the same three with `x-smc-client: 9001` → `200` / applied / row written (current client);
   - the probe deletes its account at the end.
   Then the current client in the browser: sign in as T on the preview, tick Breakfast; Settings →
   Sync shows 0 pending within a minute. Afterwards Devin may delete the `app_config` row on the
   branch.

## Rollback

Revert the merge commit and redeploy. The templates stay in the database unused (additive). The
service worker version goes back with the revert; clients reload once more. Database:
`down/20261107090000_min_client_gate.down.sql` (no user data involved). Before reverting the code,
run the down file or delete the `min_client_build` row, else invited accounts on the reverted
build (no `x-smc-client`) are refused by the database.

## Human steps for Devin

1. Do not deploy before README rollout steps 3 and 5 (seed, backfill, M2 live).
2. When this deploys (README step 6): apply `20261107090000`, set `MIN_CLIENT_BUILD=9001` on
   Production, and insert `('min_client_build', '9001')` into `app_config`.
3. Sasha checks her account on the preview (step 5) before production.
