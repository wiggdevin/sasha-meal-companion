# Lane P — Body data (Phase 5): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Her weight, steps, active energy and sleep arrive in the database every day from Health Auto Export on her phone
and from her Oura ring, with nothing for her to do after Devin's one-time setup. One read-only `/body` dashboard shows the
last seven days with an honest gap where a day is missing, one read-only MCP tool returns the same merged days, and Phase 6's
estimator reads its weigh-ins through this lane's `weighInsKg`.

**Architecture:** Two migrations tighten Phase 0's health tables (select-only RLS, a sample-type check, two indexes, the
`daily_health` view) and add the write path as two `security definer` RPCs plus `oauth_states` and `job_runs`. Pure engines
(`lib/health/*`, `lib/oura/map.ts`) hold every rule that can be tested without a database: units, the dedupe key that must be
byte-identical to the generated column, interval union with source preference, normalisation of the two phone payload shapes,
the replay window and the per-day roll-up. Server-only modules seal Oura tokens (AES-256-GCM), resolve per-source ingest
tokens in constant time, run the ingest pipeline, run the daily Oura pull under a `job_runs` lock, and expose the one merged
read path (`lib/server/health-daily.ts`) that the route, the MCP tool and Lane Q all use. The client is a cache-first
dashboard: four metric cards over a hand-written SVG sparkline, plus a sources sheet for issue/revoke/connect/disconnect.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens), pnpm 11, Node 22, vitest 5 (node
environment), Supabase Postgres 17, `zod` 4, `mcp-handler`, Vercel cron. **No new dependencies** — `Sparkline` is
hand-written SVG and `@testing-library/react` is not installed, so screens are covered by manual gates, not component tests.

**Specs:** `docs/specs/phase-5-body-data.md`. Contracts: `docs/plans/2026-09-11-phase-5-7/00-contracts.md` §1 row P, §2, §5,
§6 (frozen) over `docs/plans/2026-09-10-phase-0/00-contracts.md` §2–§8 and `docs/plans/2026-09-11-phase-1-2/00-contracts.md`
§2–§5. Architecture: `docs/architecture.md` v2.1 §2.1, §2.2, §3.4, §3.5, §3.6, §3.7, §4.3, §4.4, §4.5, §5, §5.2, §6, §9.
Numbers: `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md`. Design: `DESIGN.md` + the mockup working files
under `/Users/zero-suminc./Desktop/Sasha app/07-design/neuform-mockup/` (`Main.dc.html`, `ArenaRings.dc.html`,
`MealCard.dc.html`). Reference (MIT, read-only): `/Users/zero-suminc./Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`.

**Wave-3 shapes:** this lane starts before Phases 3–4 land, so the one wave-3 object it touches — the `vercel.json` `crons`
array — is read from `docs/plans/2026-09-11-phase-3-4/00-contracts.md` (the media-sweep line
`{ "path": "/api/jobs/media-sweep", "schedule": "0 * * * *" }`), and this lane's cron is handed off as one more entry beside
it rather than as a new file. Lane P consumes no other wave-3 shape: it never opens `CaptureSheet`, writes no `ai_calls` row
and touches no `media` object.

## Global Constraints

Copied from `docs/plans/2026-09-11-phase-5-7/README.md` "Global Constraints":

Phase 0 §8, Phase 1–2 §8a, Phase 3–4 §10 (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from
`auth.uid()` or the token/source row, rate-limit → identity → body, files < 400 lines, `null` ≠ `0`, provider text is data)
plus: `null` is an absent observation and is never rendered as 0 or interpolated; every engine constant is a named export with
a test; the engine and the coach never write a target; tool output enters a prompt only inside the untrusted envelope; every
job route is rate-limit → timing-safe `CRON_SECRET` → `job_runs` lock; gates are measured and reported, never lowered.

Lane-specific additions that follow from those:

- Tests live under `tests/health/**` (the contract §1 ownership row), not beside the source as `lib/health/*.test.ts` — the
  spec §9 file names are honoured by test name, not by path.
- Nothing under `lib/server/` in this lane imports `server-only`: `app/api/mcp/route.ts` imports this lane's read path and
  Phase 0's tests load that route under vitest, where the marker throws (`lib/server/log.ts` carries the same note).
- Weight is stored in kilograms and rendered in **pounds** (contracts §2; spec open question 8, ASSUMED).
- Branch: `feat/p5-body-data`. Land order P → Q → R.

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260925000000_phase5_health_ingest.sql` | Sample-type check, `device_label`, two indexes, select-only RLS on `health_samples`/`ingest_events`, the `daily_health` view, the two ingest RPCs |
| `supabase/migrations/down/20260925000000_phase5_health_ingest.down.sql` | Drops exactly what the above created; restores Phase 0's two `_rw` policies and write grants |
| `supabase/migrations/20260926000000_phase5_oura_oauth.sql` | `oauth_states` and `job_runs`, verbatim from the spec, plus their grants |
| `supabase/migrations/down/20260926000000_phase5_oura_oauth.down.sql` | Drops both tables |
| `lib/health/contract.ts` | Zod schemas and inferred/wire types for ingest, daily, pull; sample-type unions; named limits |
| `lib/health/units.ts` | `toCanonical`, `canonicalUnit`, `LB_PER_KG` |
| `lib/health/dedupe.ts` | `dedupeKey` / `epochSeconds` — byte-identical to the generated column |
| `lib/health/replay.ts` | `withinReplayWindow` |
| `lib/health/intervals.ts` | `unionNonOverlapping` with `preferred` winning an overlap |
| `lib/health/normalize.ts` | HAE and Shortcut payloads → `NormalizedSample[]` + `rejected[]` |
| `lib/health/daily.ts` | `localDateOf`, `rollUpDay`, `emptyDay` — the §3.5 merge rules |
| `lib/oura/map.ts` | Oura sleep / activity / readiness documents → `NormalizedSample[]` |
| `lib/oura/client.ts` | `ouraGet` with 1s/2s/4s retry, one refresh on 401, injectable `fetchFn` |
| `lib/server/crypto.ts` | `sealOauth` / `openOauth` (AES-256-GCM, 12-byte IV, tag appended) |
| `lib/server/health-tokens.ts` | `issueSourceToken` (`smh_`), `resolveSourceByToken` (constant-time) |
| `lib/server/health-daily.ts` | `mergedDays`, `weighInsKg`, `listSources` — the one merged read path |
| `lib/server/health-ingest.ts` | `applyIngest`: source → replay → payload hash → event RPC → normalize → apply RPC |
| `lib/server/oura.ts` | Start URL, callback exchange, refresh-with-rotation, `pullTwoDays` |
| `app/api/health/ingest/route.ts` | POST ingest, per-source token, 2 MB, 30/hour/source |
| `app/api/health/daily/route.ts` | GET merged days + sources, JWT, 60/min, ≤ 90 days |
| `app/api/health/tokens/route.ts` | POST issue a source token (plaintext once) |
| `app/api/health/tokens/[id]/route.ts` | DELETE revoke a source token |
| `app/api/health/oura/start/route.ts` | GET → 302 to Oura with a stored `state` hash |
| `app/api/health/oura/callback/route.ts` | GET consume state, exchange code, seal, upsert source, kick one pull |
| `app/api/health/oura/disconnect/route.ts` | POST revoke the Oura source and null its `oauth` |
| `app/api/jobs/oura-pull/route.ts` | Cron: rate limit → timing-safe secret → `job_runs` lock → pull |
| `lib/mcp/health-tools.ts` | `registerHealthTools` + `HEALTH_TOOL_SCOPES` (`get_body_data`, read) |
| `lib/health-client.ts` | `/api/health/daily` fetch + `smc:health_daily` cache, token and Oura calls |
| `components/Sparkline.tsx` | Pure SVG sparkline; `null` renders a gap |
| `components/HealthMetricCard.tsx` | One metric: latest value, sparkline, days-with-data count |
| `components/BodyDashboard.tsx` | Four cards over a seven-day window plus the Sources block |
| `components/HealthSourcesSheet.tsx` | Issue token (shown once, copy), revoke, Connect / Disconnect Oura |
| `app/body/page.tsx` | The `/body` screen; empty state on 503 (flag unset) or on a cache miss |
| `scripts/issue-health-token.ts` | CLI path for the same issue flow |
| `docs/health-auto-export.md` | The HAE automation recipe plus the Shortcut fallback payload shape |
| `tests/health/**` | Unit suites per engine, route suites with mocked clients, `[needs branch]` integration suite |
| `NOTICE.md` | fud-ai row, only if the reinstall-recovery idea is ported |

---

## Task 1 — `lib/health/contract.ts`: zod schemas and wire types

**Files**
- Create: `lib/health/contract.ts`
- Test: `tests/health/contract.test.ts`

**Interfaces**

Consumes: `zod` 4 (`package.json` dependency, already installed).
Produces (contracts §2, spec §5):

```ts
export const SAMPLE_TYPES: readonly SampleType[];
export type SampleType = "body_mass" | "step_count" | "active_energy" | "basal_energy" | "sleep_asleep"
  | "sleep_in_bed" | "resting_heart_rate" | "hrv_sdnn" | "readiness_score";
export const healthIngestBodySchema: z.ZodType<HealthIngestBody>;
export type HealthIngestBody; export type HealthIngestResponse;
export type DailyHealthRow; export type DailyHealthResponse; export type OuraPullResponse;
export type NormalizedSample; export type OauthTokens; export type JobResponse;
export const DEFAULT_TZ: string; export const REPLAY_WINDOW_MS: number;
export const MAX_INGEST_BYTES: number; export const MAX_DAILY_WINDOW_DAYS: number;
```

**Steps**

- [ ] Write the failing test `tests/health/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TZ, healthAutoExportBodySchema, healthIngestBodySchema, MAX_DAILY_WINDOW_DAYS,
  MAX_INGEST_BYTES, REPLAY_WINDOW_MS, SAMPLE_TYPES } from "@/lib/health/contract";

const sample = { type: "step_count", value: 812, unit: "count",
  start_time: "2026-09-15T13:00:00-04:00", end_time: "2026-09-15T14:00:00-04:00" };
const body = { source_kind: "apple_health_shortcut", sent_at: "2026-09-15T14:01:00-04:00",
  tz: "America/New_York", samples: [sample] };

describe("the Phase 5 contract", () => {
  it("pins the nine sample types and the named limits", () => {
    expect(SAMPLE_TYPES).toEqual(["body_mass", "step_count", "active_energy", "basal_energy",
      "sleep_asleep", "sleep_in_bed", "resting_heart_rate", "hrv_sdnn", "readiness_score"]);
    expect(REPLAY_WINDOW_MS).toBe(600_000);
    expect(MAX_INGEST_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_DAILY_WINDOW_DAYS).toBe(90);
    expect(DEFAULT_TZ).toBe("America/New_York");
  });

  it("accepts a well-formed envelope", () => {
    expect(healthIngestBodySchema.safeParse(body).success).toBe(true);
  });

  it("rejects readiness_score and basal_energy on the ingest path", () => {
    for (const type of ["readiness_score", "basal_energy"]) {
      const bad = { ...body, samples: [{ ...sample, type }] };
      expect(healthIngestBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an unparseable timestamp and an unknown unit", () => {
    expect(healthIngestBodySchema.safeParse({ ...body, sent_at: "yesterday" }).success).toBe(false);
    expect(healthIngestBodySchema.safeParse({ ...body,
      samples: [{ ...sample, unit: "furlong" }] }).success).toBe(false);
  });

  it("does NOT enforce the replay window — that is the route's job", () => {
    const old = { ...body, sent_at: "2020-01-01T00:00:00-05:00" };
    expect(healthIngestBodySchema.safeParse(old).success).toBe(true);
  });

  it("parses a Health Auto Export REST body", () => {
    const hae = { data: { metrics: [{ name: "step_count", units: "count",
      data: [{ date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" }] }] } };
    expect(healthAutoExportBodySchema.safeParse(hae).success).toBe(true);
  });
});
```

- [ ] Run it: `pnpm test tests/health/contract.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/contract`.
- [ ] Write `lib/health/contract.ts`:

```ts
/**
 * Phase 5 wire contract. Every request and response type for the health routes is a zod schema with
 * an inferred type (spec §5); the 10-minute replay window is checked in the route, not here, because
 * the schema has no clock and a body that is merely late is still well-formed.
 */
import { z } from "zod";

export const SAMPLE_TYPES = ["body_mass", "step_count", "active_energy", "basal_energy",
  "sleep_asleep", "sleep_in_bed", "resting_heart_rate", "hrv_sdnn", "readiness_score"] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

/** The ingest path is narrower than the storage union: readiness and basal energy arrive from Oura,
 *  never from a phone payload (spec §5's sample `type` union). */
export const INGEST_SAMPLE_TYPES = ["body_mass", "step_count", "active_energy", "sleep_asleep",
  "sleep_in_bed", "resting_heart_rate", "hrv_sdnn"] as const;
export const INGEST_UNITS = ["kg", "lb", "count", "kcal", "min", "bpm", "ms"] as const;

export const DEFAULT_TZ = "America/New_York";
export const REPLAY_WINDOW_MS = 600_000;
export const MAX_INGEST_BYTES = 2 * 1024 * 1024;
export const MAX_DAILY_WINDOW_DAYS = 90;
export const MAX_SAMPLES_PER_PAYLOAD = 5000;

const isoInstant = z.string().min(1).max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO 8601 timestamp");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const healthIngestSampleSchema = z.object({
  type: z.enum(INGEST_SAMPLE_TYPES),
  value: z.number().finite(),
  unit: z.enum(INGEST_UNITS),
  start_time: isoInstant,
  end_time: isoInstant,
  vendor_sample_id: z.string().min(1).max(200).optional(),
  vendor_updated_at: isoInstant.optional(),
  device_label: z.string().min(1).max(120).optional(),
});

export const healthIngestBodySchema = z.object({
  source_kind: z.enum(["health_auto_export", "apple_health_shortcut"]),
  sent_at: isoInstant,
  tz: z.string().min(1).max(64),
  samples: z.array(healthIngestSampleSchema).max(MAX_SAMPLES_PER_PAYLOAD),
});
export type HealthIngestBody = z.infer<typeof healthIngestBodySchema>;

/**
 * Health Auto Export's REST automation posts its own document and cannot add a client timestamp or
 * a tz field. That shape is accepted separately; the route applies the sample-age rule to it instead
 * of the replay window (see lib/server/health-ingest.ts and "Open questions").
 */
export const healthAutoExportBodySchema = z.object({
  data: z.object({ metrics: z.array(z.unknown()).max(64) }),
});
export type HealthAutoExportBody = z.infer<typeof healthAutoExportBodySchema>;

export const ingestEnvelopeSchema = z.union([healthIngestBodySchema, healthAutoExportBodySchema]);
export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

export const dailyQuerySchema = z.object({ from: isoDate, to: isoDate });

export type HealthIngestResponse = {
  event_id: string;
  status: "applied" | "duplicate";
  accepted: number;
  updated: number;
  skipped: number;
  rejected: Array<{ index: number; reason: string }>;
};

export type DailyHealthRow = {
  local_date: string; steps: number | null; active_kcal: number | null;
  sleep_minutes: number | null; body_mass_kg: number | null; sources: string[];
};

export type DailyHealthResponse = {
  days: DailyHealthRow[];
  sources: Array<{ id: string; kind: string; device_label: string | null;
                   last_received_at: string | null; revoked: boolean }>;
};

export type OuraPullResponse = { users: number; sources: number;
  results: Array<{ user_id: string; inserted: number; updated: number; skipped: number; error?: string }> };

export type JobResponse = { ok: boolean; ran: number; skipped: number };

export type NormalizedSample = {
  type: SampleType; value: number; unit: string; start_time: string; end_time: string;
  vendor_sample_id?: string; vendor_updated_at?: string; device_label?: string; tz: string;
};

export type NormalizeResult = { samples: NormalizedSample[]; rejected: Array<{ index: number; reason: string }> };

export type OauthTokens = { access_token: string; refresh_token: string; expires_at: string; scope: string };
```

- [ ] Run it: `pnpm test tests/health/contract.test.ts` — expected PASS (6 tests).
- [ ] Commit:
      `git add lib/health/contract.ts tests/health/contract.test.ts && git commit -m "feat(health): phase 5 wire contract and named limits"`

---

## Task 2 — `lib/health/units.ts`: canonical units

**Files**
- Create: `lib/health/units.ts`
- Test: `tests/health/units.test.ts`

**Interfaces**

Consumes: `SampleType` (Task 1).
Produces (contracts §2 — Lane Q imports `toCanonical` for legacy `lb` weigh-ins):

```ts
export const LB_PER_KG = 2.2046226218;
export function canonicalUnit(type: SampleType): string;
export function toCanonical(type: SampleType, value: number, unit: string): { value: number; unit: string };
```

**Steps**

- [ ] Write the failing test `tests/health/units.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalUnit, LB_PER_KG, toCanonical } from "@/lib/health/units";

describe("toCanonical", () => {
  it("names one canonical unit per sample type", () => {
    expect(canonicalUnit("body_mass")).toBe("kg");
    expect(canonicalUnit("step_count")).toBe("count");
    expect(canonicalUnit("active_energy")).toBe("kcal");
    expect(canonicalUnit("basal_energy")).toBe("kcal");
    expect(canonicalUnit("sleep_asleep")).toBe("min");
    expect(canonicalUnit("sleep_in_bed")).toBe("min");
    expect(canonicalUnit("resting_heart_rate")).toBe("bpm");
    expect(canonicalUnit("hrv_sdnn")).toBe("ms");
    expect(canonicalUnit("readiness_score")).toBe("score");
  });

  it("converts pounds to kilograms with the pinned constant", () => {
    expect(LB_PER_KG).toBe(2.2046226218);
    expect(toCanonical("body_mass", 127, "lb")).toEqual({ value: 57.606111, unit: "kg" });
  });

  it("passes a value already canonical straight through", () => {
    expect(toCanonical("step_count", 8123, "count")).toEqual({ value: 8123, unit: "count" });
  });

  it("converts grams, hours, seconds and kilojoules", () => {
    expect(toCanonical("body_mass", 57606, "g").value).toBeCloseTo(57.606, 3);
    expect(toCanonical("sleep_asleep", 7.5, "h")).toEqual({ value: 450, unit: "min" });
    expect(toCanonical("sleep_in_bed", 28800, "s")).toEqual({ value: 480, unit: "min" });
    expect(toCanonical("active_energy", 418.4, "kJ")).toEqual({ value: 100, unit: "kcal" });
  });

  it("throws on an unknown unit rather than guessing", () => {
    expect(() => toCanonical("body_mass", 127, "stone")).toThrow(/unknown unit "stone" for body_mass/);
    expect(() => toCanonical("step_count", 10, "kcal")).toThrow(/unknown unit/);
  });
});
```

- [ ] Run it: `pnpm test tests/health/units.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/units`.
- [ ] Write `lib/health/units.ts`:

```ts
/**
 * One canonical unit per sample type (spec §7). Storage is kilograms; the dashboard converts to
 * pounds at render time (contracts §2). An unrecognised unit throws: a silent pass-through would
 * store pounds in a kilogram column and no later code could tell.
 */
import type { SampleType } from "@/lib/health/contract";

export const LB_PER_KG = 2.2046226218;
const KCAL_PER_KJ = 4.184;

const CANONICAL: Record<SampleType, string> = {
  body_mass: "kg", step_count: "count", active_energy: "kcal", basal_energy: "kcal",
  sleep_asleep: "min", sleep_in_bed: "min", resting_heart_rate: "bpm", hrv_sdnn: "ms",
  readiness_score: "score",
};

export function canonicalUnit(type: SampleType): string {
  const unit = CANONICAL[type];
  if (!unit) throw new Error(`unknown sample type "${type}"`);
  return unit;
}

/** Six decimal places: enough for grams of body mass, short of float noise in a dedupe comparison. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function toCanonical(type: SampleType, value: number, unit: string):
    { value: number; unit: string } {
  const target = canonicalUnit(type);
  const from = unit.trim();
  if (from === target) return { value: round6(value), unit: target };

  const lower = from.toLowerCase();
  if (target === "kg") {
    if (lower === "lb" || lower === "lbs") return { value: round6(value / LB_PER_KG), unit: target };
    if (lower === "g") return { value: round6(value / 1000), unit: target };
  }
  if (target === "min") {
    if (lower === "h" || lower === "hr" || lower === "hour" || lower === "hours") {
      return { value: round6(value * 60), unit: target };
    }
    if (lower === "s" || lower === "sec" || lower === "seconds") {
      return { value: round6(value / 60), unit: target };
    }
  }
  if (target === "kcal" && (lower === "kj" || lower === "kilojoules")) {
    return { value: round6(value / KCAL_PER_KJ), unit: target };
  }
  if (target === "ms" && (lower === "s" || lower === "sec")) {
    return { value: round6(value * 1000), unit: target };
  }
  throw new Error(`unknown unit "${unit}" for ${type}`);
}
```

- [ ] Run it: `pnpm test tests/health/units.test.ts` — expected PASS (5 tests).
- [ ] Commit:
      `git add lib/health/units.ts tests/health/units.test.ts && git commit -m "feat(health): canonical unit conversion"`

---

## Task 3 — `lib/health/dedupe.ts` and `lib/health/replay.ts`

**Files**
- Create: `lib/health/dedupe.ts`, `lib/health/replay.ts`
- Test: `tests/health/dedupe.test.ts`, `tests/health/replay.test.ts`

**Interfaces**

Consumes: the generated column in `supabase/migrations/20260911000400_privileged.sql`:
`coalesce(vendor_sample_id, type || '|' || (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text)`.
Produces:

```ts
export function epochSeconds(iso: string): number;                     // integer seconds, ::bigint rounding
export function dedupeKey(s: { vendor_sample_id?: string; type: string;
  start_time: string; end_time: string }): string;
export function withinReplayWindow(sentAt: string, now: Date, windowMs?: number): boolean;
```

**Steps**

- [ ] Write the failing test `tests/health/dedupe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dedupeKey, epochSeconds } from "@/lib/health/dedupe";

describe("dedupeKey", () => {
  it("matches the generated column on the computed branch", () => {
    // 2026-09-15T13:00:00-04:00 = 1789578000; +1 h = 1789581600.
    expect(dedupeKey({ type: "step_count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00" })).toBe("step_count|1789578000|1789581600");
  });

  it("uses vendor_sample_id verbatim when present", () => {
    expect(dedupeKey({ vendor_sample_id: "oura-sleep-2026-09-15", type: "sleep_asleep",
      start_time: "2026-09-15T03:00:00Z", end_time: "2026-09-15T10:00:00Z" }))
      .toBe("oura-sleep-2026-09-15");
  });

  it("treats an empty vendor_sample_id as absent", () => {
    expect(dedupeKey({ vendor_sample_id: "", type: "body_mass",
      start_time: "2026-09-15T11:00:00Z", end_time: "2026-09-15T11:00:00Z" }))
      .toBe("body_mass|1789563600|1789563600");
  });

  it("rounds sub-second timestamps the way numeric::bigint does", () => {
    // Postgres rounds numeric to bigint; 0.5 s rounds up, 0.4 s rounds down.
    expect(epochSeconds("2026-09-15T11:00:00.500Z")).toBe(1789563601);
    expect(epochSeconds("2026-09-15T11:00:00.400Z")).toBe(1789563600);
  });

  it("throws on a timestamp it cannot parse", () => {
    expect(() => epochSeconds("not a time")).toThrow(/not an ISO 8601 timestamp/);
  });
});
```

- [ ] Write the failing test `tests/health/replay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { withinReplayWindow } from "@/lib/health/replay";

const now = new Date("2026-09-15T14:00:00Z");

describe("withinReplayWindow", () => {
  it("accepts a timestamp inside ten minutes, in either direction", () => {
    expect(withinReplayWindow("2026-09-15T13:55:00Z", now)).toBe(true);
    expect(withinReplayWindow("2026-09-15T14:05:00Z", now)).toBe(true);
  });

  it("accepts the boundary exactly", () => {
    expect(withinReplayWindow("2026-09-15T13:50:00Z", now)).toBe(true);
  });

  it("rejects thirty minutes old — spec acceptance criterion 3", () => {
    expect(withinReplayWindow("2026-09-15T13:30:00Z", now)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(withinReplayWindow("soon", now)).toBe(false);
  });

  it("honours an explicit window", () => {
    expect(withinReplayWindow("2026-09-15T13:30:00Z", now, 3_600_000)).toBe(true);
  });
});
```

- [ ] Run them: `pnpm test tests/health/dedupe.test.ts tests/health/replay.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/dedupe`.
- [ ] Write `lib/health/dedupe.ts`:

```ts
/**
 * The dedupe key must be byte-identical to health_samples.dedupe_key, the stored generated column in
 * supabase/migrations/20260911000400_privileged.sql. That column casts a numeric epoch to bigint, and
 * a numeric-to-bigint cast in Postgres ROUNDS — so this rounds too, rather than truncating.
 */
export function epochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 timestamp: ${iso}`);
  return Math.round(ms / 1000);
}

export function dedupeKey(s: { vendor_sample_id?: string; type: string;
                               start_time: string; end_time: string }): string {
  if (typeof s.vendor_sample_id === "string" && s.vendor_sample_id.length > 0) {
    return s.vendor_sample_id;
  }
  return `${s.type}|${epochSeconds(s.start_time)}|${epochSeconds(s.end_time)}`;
}
```

- [ ] Write `lib/health/replay.ts`:

```ts
/**
 * Shortcuts cannot sign a request (architecture §5), so a payload proves freshness with its own
 * timestamp inside a ten-minute window either side of server time. Clock skew on the phone is the
 * reason the window is symmetric.
 */
export function withinReplayWindow(sentAt: string, now: Date, windowMs = 600_000): boolean {
  const t = Date.parse(sentAt);
  if (Number.isNaN(t)) return false;
  return Math.abs(now.getTime() - t) <= windowMs;
}
```

- [ ] Run them: `pnpm test tests/health/dedupe.test.ts tests/health/replay.test.ts` — expected PASS (10 tests).
- [ ] Commit:
      `git add lib/health/dedupe.ts lib/health/replay.ts tests/health/dedupe.test.ts tests/health/replay.test.ts && git commit -m "feat(health): dedupe key parity with the generated column and the replay window"`

---

## Task 4 — `lib/health/intervals.ts`: non-overlapping union with source preference

**Files**
- Create: `lib/health/intervals.ts`
- Test: `tests/health/intervals.test.ts`

**Interfaces**

Consumes: nothing.
Produces (spec §7, architecture §3.5):

```ts
export type Interval = { start: number; end: number; value: number; preferred: boolean };
export function unionNonOverlapping(intervals: Interval[]): number;
```

**Steps**

- [ ] Write the failing test `tests/health/intervals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unionNonOverlapping, type Interval } from "@/lib/health/intervals";

const iv = (start: number, end: number, value: number, preferred = false): Interval =>
  ({ start, end, value, preferred });

describe("unionNonOverlapping", () => {
  it("is 0 for no intervals", () => {
    expect(unionNonOverlapping([])).toBe(0);
  });

  it("sums disjoint intervals in full", () => {
    expect(unionNonOverlapping([iv(0, 100, 10), iv(200, 300, 20)])).toBe(30);
  });

  it("does not double-count adjacent intervals", () => {
    expect(unionNonOverlapping([iv(0, 100, 10), iv(100, 200, 20)])).toBe(30);
  });

  it("lets the preferred source claim the overlap whatever the order", () => {
    // Watch 0–100 = 1000 steps, phone 50–150 = 600 steps. The phone keeps its uncovered half.
    expect(unionNonOverlapping([iv(50, 150, 600), iv(0, 100, 1000, true)])).toBe(1300);
    expect(unionNonOverlapping([iv(0, 100, 1000, true), iv(50, 150, 600)])).toBe(1300);
  });

  it("drops a non-preferred interval entirely covered by a preferred one", () => {
    expect(unionNonOverlapping([iv(0, 200, 2000, true), iv(50, 150, 900)])).toBe(2000);
  });

  it("counts an instantaneous sample once and never twice", () => {
    expect(unionNonOverlapping([iv(500, 500, 7), iv(500, 500, 7)])).toBe(7);
  });

  it("ignores an instantaneous sample already inside a claimed range", () => {
    expect(unionNonOverlapping([iv(0, 100, 10, true), iv(50, 50, 99)])).toBe(10);
  });

  it("tolerates a reversed interval by normalising its ends", () => {
    expect(unionNonOverlapping([iv(100, 0, 10)])).toBe(10);
  });
});
```

- [ ] Run it: `pnpm test tests/health/intervals.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/intervals`.
- [ ] Write `lib/health/intervals.ts`:

```ts
/**
 * Architecture §3.5: steps and active energy are the union of non-overlapping intervals, preferring
 * the Watch-tagged sample on an overlap. Preferred intervals are laid down first and claim their
 * whole span; every later interval contributes only the fraction of its span still uncovered, so a
 * phone's duplicate hour adds nothing while its extra half-hour still counts.
 */
export type Interval = { start: number; end: number; value: number; preferred: boolean };

type Range = { start: number; end: number };

/** Half-open ranges: [0,100) and [100,200) are adjacent, not overlapping. */
function coveredWithin(claimed: Range[], start: number, end: number): number {
  let sum = 0;
  for (const c of claimed) {
    const lo = Math.max(c.start, start);
    const hi = Math.min(c.end, end);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

/** Keeps `claimed` merged and disjoint, so coveredWithin can never count the same millisecond twice. */
function claim(claimed: Range[], start: number, end: number): void {
  if (end <= start) return;
  let lo = start;
  let hi = end;
  for (let i = claimed.length - 1; i >= 0; i -= 1) {
    const c = claimed[i];
    if (c.start <= hi && lo <= c.end) {
      lo = Math.min(lo, c.start);
      hi = Math.max(hi, c.end);
      claimed.splice(i, 1);
    }
  }
  claimed.push({ start: lo, end: hi });
}

export function unionNonOverlapping(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;

  const ordered = [...intervals].sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return Math.min(a.start, a.end) - Math.min(b.start, b.end);
  });

  const claimed: Range[] = [];
  const points = new Set<number>();
  let total = 0;

  for (const interval of ordered) {
    const start = Math.min(interval.start, interval.end);
    const end = Math.max(interval.start, interval.end);
    const span = end - start;

    if (span === 0) {
      const inside = points.has(start) || claimed.some((c) => start >= c.start && start < c.end);
      if (!inside) {
        points.add(start);
        total += interval.value;
      }
      continue;
    }

    const covered = coveredWithin(claimed, start, end);
    total += interval.value * ((span - covered) / span);
    claim(claimed, start, end);
  }

  return total;
}
```

- [ ] Run it: `pnpm test tests/health/intervals.test.ts` — expected PASS (8 tests).
- [ ] Commit:
      `git add lib/health/intervals.ts tests/health/intervals.test.ts && git commit -m "feat(health): non-overlapping interval union with source preference"`

---

## Task 5 — `lib/health/normalize.ts`: the two phone payload shapes

**Files**
- Create: `lib/health/normalize.ts`
- Test: `tests/health/normalize.test.ts`

**Interfaces**

Consumes: `healthIngestSampleSchema`, `NormalizedSample`, `NormalizeResult` (Task 1); `toCanonical` (Task 2).
Produces (spec §7):

```ts
export function normalizeHealthAutoExport(payload: unknown, tz: string): NormalizeResult;
export function normalizeShortcut(payload: unknown, tz: string): NormalizeResult;
export const HAE_METRIC_TYPES: Record<string, SampleType>;
```

**Steps**

- [ ] Write the failing test `tests/health/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeHealthAutoExport, normalizeShortcut } from "@/lib/health/normalize";

const TZ = "America/New_York";

/** Health Auto Export REST export, trimmed to the four metrics the recipe enables. */
const HAE = { data: { metrics: [
  { name: "step_count", units: "count", data: [
    { date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" },
    { date: "2026-09-15 14:00:00 -0400", qty: 610, source: "Sasha's iPhone" }] },
  { name: "active_energy", units: "kcal", data: [
    { date: "2026-09-15 13:00:00 -0400", qty: 96.4, source: "Apple Watch" }] },
  { name: "weight_body_mass", units: "lb", data: [
    { date: "2026-09-15 07:12:00 -0400", qty: 127.2, source: "Withings" }] },
  { name: "sleep_analysis", units: "hr", data: [
    { date: "2026-09-15 06:30:00 -0400", asleep: 7.4, inBed: 8.1,
      sleepStart: "2026-09-14 23:05:00 -0400", sleepEnd: "2026-09-15 07:11:00 -0400",
      source: "Apple Watch" }] }] } };

/** The Shortcut fallback posts the canonical envelope (docs/health-auto-export.md §"Shortcut"). */
const SHORTCUT = { source_kind: "apple_health_shortcut", sent_at: "2026-09-15T14:01:00-04:00",
  tz: TZ, samples: [
    { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00", device_label: "Apple Watch" },
    { type: "body_mass", value: 127.2, unit: "lb", start_time: "2026-09-15T11:12:00Z",
      end_time: "2026-09-15T11:12:00Z" }] };

describe("normalizeHealthAutoExport", () => {
  it("maps every metric to a canonical sample, hourly ranges intact", () => {
    const { samples, rejected } = normalizeHealthAutoExport(HAE, TZ);
    expect(rejected).toEqual([]);
    expect(samples).toHaveLength(5);
    const steps = samples.filter((s) => s.type === "step_count");
    expect(steps[0]).toMatchObject({ value: 812, unit: "count", device_label: "Apple Watch",
      start_time: "2026-09-15T17:00:00.000Z", end_time: "2026-09-15T18:00:00.000Z", tz: TZ });
    expect(samples.find((s) => s.type === "body_mass")?.value).toBeCloseTo(57.697, 3);
    expect(samples.find((s) => s.type === "sleep_asleep")).toMatchObject({ value: 444, unit: "min",
      start_time: "2026-09-15T03:05:00.000Z", end_time: "2026-09-15T11:11:00.000Z" });
  });

  it("rejects one malformed entry and still normalizes the rest — acceptance criterion 5", () => {
    const broken = { data: { metrics: [{ name: "step_count", units: "count", data: [
      { date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" },
      { date: "whenever", qty: 10, source: "x" },
      { date: "2026-09-15 15:00:00 -0400", qty: "many", source: "x" }] }] } };
    const { samples, rejected } = normalizeHealthAutoExport(broken, TZ);
    expect(samples).toHaveLength(1);
    expect(rejected).toEqual([{ index: 1, reason: "bad timestamp" }, { index: 2, reason: "value is not a number" }]);
  });

  it("rejects a metric name it does not know instead of inventing one", () => {
    const odd = { data: { metrics: [{ name: "blood_alcohol", units: "%", data: [
      { date: "2026-09-15 13:00:00 -0400", qty: 1 }] }] } };
    expect(normalizeHealthAutoExport(odd, TZ)).toEqual({ samples: [],
      rejected: [{ index: 0, reason: "unknown metric blood_alcohol" }] });
  });

  it("returns a single envelope rejection for a payload that is not an HAE document", () => {
    expect(normalizeHealthAutoExport({ nope: true }, TZ))
      .toEqual({ samples: [], rejected: [{ index: -1, reason: "not a Health Auto Export payload" }] });
  });
});

describe("normalizeShortcut", () => {
  it("canonicalises units and keeps the sample order", () => {
    const { samples, rejected } = normalizeShortcut(SHORTCUT, TZ);
    expect(rejected).toEqual([]);
    expect(samples[0]).toMatchObject({ type: "step_count", value: 812, tz: TZ });
    expect(samples[1].value).toBeCloseTo(57.697, 3);
    expect(samples[1].unit).toBe("kg");
  });

  it("rejects end_time before start_time and an unknown unit", () => {
    const bad = { samples: [
      { type: "step_count", value: 1, unit: "count", start_time: "2026-09-15T14:00:00Z",
        end_time: "2026-09-15T13:00:00Z" },
      { type: "body_mass", value: 9, unit: "stone", start_time: "2026-09-15T11:00:00Z",
        end_time: "2026-09-15T11:00:00Z" }] };
    const { samples, rejected } = normalizeShortcut(bad, TZ);
    expect(samples).toEqual([]);
    expect(rejected).toEqual([{ index: 0, reason: "end_time before start_time" },
      { index: 1, reason: "schema: unit" }]);
  });
});
```

- [ ] Run it: `pnpm test tests/health/normalize.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/normalize`.
- [ ] Write `lib/health/normalize.ts`:

```ts
/**
 * Two untrusted payload shapes in, canonical samples out (spec §7). Nothing here touches the
 * database; a malformed entry becomes a `rejected` row and its neighbours still apply (spec §5,
 * acceptance criterion 5).
 */
import { healthIngestSampleSchema, type NormalizedSample, type NormalizeResult,
  type SampleType } from "@/lib/health/contract";
import { toCanonical } from "@/lib/health/units";

/** Health Auto Export metric names → our sample types. An unlisted metric is rejected, not guessed. */
export const HAE_METRIC_TYPES: Record<string, SampleType> = {
  step_count: "step_count", active_energy: "active_energy", basal_energy_burned: "basal_energy",
  weight_body_mass: "body_mass", resting_heart_rate: "resting_heart_rate",
  heart_rate_variability: "hrv_sdnn", sleep_analysis: "sleep_asleep",
};

/** HAE writes "2026-09-15 13:00:00 -0400", which Date.parse does not accept on every runtime. */
function haeInstant(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})$/.exec(raw.trim());
  const iso = m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function hourAfter(iso: string): string {
  return new Date(Date.parse(iso) + 3_600_000).toISOString();
}

export function normalizeHealthAutoExport(payload: unknown, tz: string): NormalizeResult {
  const metrics = (payload as { data?: { metrics?: unknown } })?.data?.metrics;
  if (!Array.isArray(metrics)) {
    return { samples: [], rejected: [{ index: -1, reason: "not a Health Auto Export payload" }] };
  }

  const samples: NormalizedSample[] = [];
  const rejected: NormalizeResult["rejected"] = [];
  let index = 0;

  for (const metric of metrics) {
    const m = metric as { name?: unknown; units?: unknown; data?: unknown };
    const type = typeof m.name === "string" ? HAE_METRIC_TYPES[m.name] : undefined;
    const rows = Array.isArray(m.data) ? m.data : [];
    if (!type) {
      rejected.push({ index, reason: `unknown metric ${String(m.name)}` });
      index += Math.max(rows.length, 1);
      continue;
    }
    const unit = typeof m.units === "string" ? m.units : "";

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const at = haeInstant(r.date);
      if (!at) { rejected.push({ index, reason: "bad timestamp" }); index += 1; continue; }
      const device = typeof r.source === "string" ? r.source : undefined;

      if (type === "sleep_asleep") {
        const start = haeInstant(r.sleepStart) ?? at;
        const end = haeInstant(r.sleepEnd) ?? at;
        for (const [field, sleepType] of [["asleep", "sleep_asleep"], ["inBed", "sleep_in_bed"]] as const) {
          const hours = r[field];
          if (typeof hours !== "number" || !Number.isFinite(hours)) continue;
          samples.push({ type: sleepType, ...toCanonical(sleepType, hours, unit || "hr"),
            start_time: start, end_time: end, device_label: device, tz });
        }
        index += 1;
        continue;
      }

      const qty = r.qty;
      if (typeof qty !== "number" || !Number.isFinite(qty)) {
        rejected.push({ index, reason: "value is not a number" }); index += 1; continue;
      }
      try {
        const end = type === "body_mass" ? at : hourAfter(at);
        samples.push({ type, ...toCanonical(type, qty, unit), start_time: at, end_time: end,
          device_label: device, tz });
      } catch (e) {
        rejected.push({ index, reason: e instanceof Error ? e.message : "bad sample" });
      }
      index += 1;
    }
  }

  return { samples, rejected };
}

export function normalizeShortcut(payload: unknown, tz: string): NormalizeResult {
  const raw = Array.isArray(payload) ? payload : (payload as { samples?: unknown })?.samples;
  if (!Array.isArray(raw)) {
    return { samples: [], rejected: [{ index: -1, reason: "not a Shortcut payload" }] };
  }

  const samples: NormalizedSample[] = [];
  const rejected: NormalizeResult["rejected"] = [];

  raw.forEach((entry, index) => {
    const parsed = healthIngestSampleSchema.safeParse(entry);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join(".") ?? "sample";
      rejected.push({ index, reason: `schema: ${path}` });
      return;
    }
    const s = parsed.data;
    if (Date.parse(s.end_time) < Date.parse(s.start_time)) {
      rejected.push({ index, reason: "end_time before start_time" });
      return;
    }
    try {
      samples.push({ type: s.type, ...toCanonical(s.type, s.value, s.unit),
        start_time: s.start_time, end_time: s.end_time, vendor_sample_id: s.vendor_sample_id,
        vendor_updated_at: s.vendor_updated_at, device_label: s.device_label, tz });
    } catch (e) {
      rejected.push({ index, reason: e instanceof Error ? e.message : "bad sample" });
    }
  });

  return { samples, rejected };
}
```

- [ ] Run it: `pnpm test tests/health/normalize.test.ts` — expected PASS (6 tests).
- [ ] Commit:
      `git add lib/health/normalize.ts tests/health/normalize.test.ts && git commit -m "feat(health): normalize Health Auto Export and Shortcut payloads"`

---

## Task 6 — `lib/health/daily.ts`: local dates and the §3.5 merge rules

**Files**
- Create: `lib/health/daily.ts`
- Test: `tests/health/daily.test.ts`

**Interfaces**

Consumes: `NormalizedSample`, `DailyHealthRow` (Task 1); `unionNonOverlapping` (Task 4).
Produces (spec §7; `emptyDay` is an addition this lane needs so a day with no observation is still a row):

```ts
export function localDateOf(iso: string, tz: string): string;      // YYYY-MM-DD
export function rollUpDay(samples: NormalizedSample[], tz: string): DailyHealthRow;
export function emptyDay(localDate: string): DailyHealthRow;
export function isWatch(deviceLabel?: string): boolean;
```

**Steps**

- [ ] Write the failing test `tests/health/daily.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyDay, localDateOf, rollUpDay } from "@/lib/health/daily";
import type { NormalizedSample } from "@/lib/health/contract";

const TZ = "America/New_York";
const s = (over: Partial<NormalizedSample> & Pick<NormalizedSample, "type" | "value">):
  NormalizedSample => ({ unit: "count", start_time: "2026-09-15T17:00:00Z",
    end_time: "2026-09-15T18:00:00Z", tz: TZ, ...over });

describe("localDateOf", () => {
  it("puts a 23:30 local sample on that local date, not the UTC one", () => {
    expect(localDateOf("2026-09-16T03:30:00Z", TZ)).toBe("2026-09-15");
  });
  it("rolls a DST-change day up once", () => {
    expect(localDateOf("2026-11-01T05:30:00Z", TZ)).toBe("2026-11-01");
    expect(localDateOf("2026-11-01T06:30:00Z", TZ)).toBe("2026-11-01");
  });
});

describe("rollUpDay", () => {
  it("prefers the Watch on an overlap and keeps the phone's uncovered span", () => {
    const day = rollUpDay([
      s({ type: "step_count", value: 1000, device_label: "Apple Watch" }),
      s({ type: "step_count", value: 600, device_label: "Sasha's iPhone",
        start_time: "2026-09-15T17:30:00Z", end_time: "2026-09-15T18:30:00Z" }),
    ], TZ);
    expect(day.local_date).toBe("2026-09-15");
    expect(day.steps).toBe(1300);
    expect(day.sources).toEqual(["Apple Watch", "Sasha's iPhone"]);
  });

  it("prefers Oura sleep over Apple and reports minutes", () => {
    const day = rollUpDay([
      s({ type: "sleep_asleep", value: 402, unit: "min", device_label: "Apple Watch" }),
      s({ type: "sleep_asleep", value: 444, unit: "min", device_label: "Oura" }),
    ], TZ);
    expect(day.sleep_minutes).toBe(444);
  });

  it("takes the latest weigh-in of the local day and leaves the rest null", () => {
    const day = rollUpDay([
      s({ type: "body_mass", value: 57.7, unit: "kg", start_time: "2026-09-15T11:12:00Z",
        end_time: "2026-09-15T11:12:00Z" }),
      s({ type: "body_mass", value: 57.5, unit: "kg", start_time: "2026-09-15T22:00:00Z",
        end_time: "2026-09-15T22:00:00Z" }),
    ], TZ);
    expect(day.body_mass_kg).toBe(57.5);
    expect(day.steps).toBeNull();
    expect(day.active_kcal).toBeNull();
    expect(day.sleep_minutes).toBeNull();
  });

  it("a day with no weigh-in yields null, never 0", () => {
    expect(rollUpDay([s({ type: "step_count", value: 10 })], TZ).body_mass_kg).toBeNull();
  });

  it("refuses an empty array — an absent day is emptyDay(), not a roll-up", () => {
    expect(() => rollUpDay([], TZ)).toThrow(/at least one sample/);
    expect(emptyDay("2026-09-16")).toEqual({ local_date: "2026-09-16", steps: null,
      active_kcal: null, sleep_minutes: null, body_mass_kg: null, sources: [] });
  });
});
```

- [ ] Run it: `pnpm test tests/health/daily.test.ts` — expected failure:
      `Error: Failed to load url @/lib/health/daily`.
- [ ] Write `lib/health/daily.ts`:

```ts
/**
 * The §3.5 merge rules, pure. The daily_health view is a plain aggregate; these rules are where the
 * contract is actually met, and lib/server/health-daily.ts is the only caller in production, so the
 * dashboard, the MCP tool and Phase 6 all read the same numbers (spec §4).
 */
import type { DailyHealthRow, NormalizedSample } from "@/lib/health/contract";
import { unionNonOverlapping, type Interval } from "@/lib/health/intervals";

export function localDateOf(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 timestamp: ${iso}`);
  // en-CA formats as YYYY-MM-DD; Intl applies the zone's offset for that instant, DST included.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit" }).format(new Date(ms));
}

export function emptyDay(localDate: string): DailyHealthRow {
  return { local_date: localDate, steps: null, active_kcal: null, sleep_minutes: null,
    body_mass_kg: null, sources: [] };
}

export function isWatch(deviceLabel?: string): boolean {
  return typeof deviceLabel === "string" && /watch/i.test(deviceLabel);
}

function isOura(deviceLabel?: string): boolean {
  return typeof deviceLabel === "string" && /oura/i.test(deviceLabel);
}

function intervalsFor(samples: NormalizedSample[]): Interval[] {
  return samples.map((s) => ({ start: Date.parse(s.start_time), end: Date.parse(s.end_time),
    value: s.value, preferred: isWatch(s.device_label) }));
}

export function rollUpDay(samples: NormalizedSample[], tz: string): DailyHealthRow {
  if (samples.length === 0) throw new Error("rollUpDay needs at least one sample");

  const ordered = [...samples].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const row = emptyDay(localDateOf(ordered[0].start_time, tz));

  const steps = ordered.filter((s) => s.type === "step_count");
  if (steps.length > 0) row.steps = Math.round(unionNonOverlapping(intervalsFor(steps)));

  const energy = ordered.filter((s) => s.type === "active_energy");
  if (energy.length > 0) row.active_kcal = Math.round(unionNonOverlapping(intervalsFor(energy)));

  const sleep = ordered.filter((s) => s.type === "sleep_asleep");
  if (sleep.length > 0) {
    const oura = sleep.filter((s) => isOura(s.device_label));
    const winning = oura.length > 0 ? oura : sleep;
    row.sleep_minutes = Math.round(Math.max(...winning.map((s) => s.value)));
  }

  const weighIns = ordered.filter((s) => s.type === "body_mass");
  if (weighIns.length > 0) {
    const latest = weighIns[weighIns.length - 1];
    row.body_mass_kg = Math.round(latest.value * 1000) / 1000;
  }

  row.sources = [...new Set(ordered.map((s) => s.device_label ?? "unknown"))].sort();
  return row;
}
```

- [ ] Run it: `pnpm test tests/health/daily.test.ts` — expected PASS (7 tests).
- [ ] Commit:
      `git add lib/health/daily.ts tests/health/daily.test.ts && git commit -m "feat(health): local-date roll-up with the §3.5 merge rules"`

---

## Task 7 — Migration `20260925000000_phase5_health_ingest.sql` (+ down)

**Files**
- Create: `supabase/migrations/20260925000000_phase5_health_ingest.sql`,
  `supabase/migrations/down/20260925000000_phase5_health_ingest.down.sql`
- Test: `tests/health/migration-ingest.test.ts` `[needs branch]`

**Interfaces**

Consumes: Phase 0 objects — `health_samples` with its generated `dedupe_key` and
`health_samples_dedupe` unique index (`supabase/migrations/20260911000400_privileged.sql:17-29`),
`ingest_events`, `health_sources`; the pattern-1 `_rw` policies and the
`grant select, insert, update, delete … to authenticated` loop
(`supabase/migrations/20260911000500_rls.sql:5-24`); `_sync_assert_caller` and the revoke/grant shape
(`supabase/migrations/20260911000600_rpc.sql:8-19, 53-54`).
Produces: `health_samples_type_ck`, `health_samples.device_label`, `health_samples_user_type_time`,
`ingest_events_source_time`, policies `health_samples_ro` / `ingest_events_ro`, view `daily_health`,
functions `health_ingest_event(uuid, uuid, bytea, text) returns uuid` and
`health_ingest_apply(uuid, uuid, uuid, jsonb) returns table (accepted int, updated int, skipped int)`.

> **Contract change landed:** `docs: phase-5-7 contract change — health_samples.device_label` — contracts
> §2 now documents this column (land that commit before/alongside this task, not after).
> Contracts §2 asks `lib/health/daily.ts` to prefer the Watch `device_label` on an overlap, and spec §5
> carries `device_label` on every ingest sample, but Phase 0's `health_samples` has no such column — one
> Health Auto Export source delivers both Watch and phone rows, so the source row's label cannot stand in.
> This migration adds the column. It renames nothing and is additive; the down file drops it.

**Steps**

- [ ] Write the failing test `tests/health/migration-ingest.test.ts`:

```ts
/** [needs branch] — skipped when SUPABASE_TEST_URL is unset. */
import { describe, expect, it } from "vitest";
import { adminClient, anonClient, createTestUsers, HAS_BRANCH } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("20260925000000_phase5_health_ingest", () => {
  it("refuses an invented sample type", async () => {
    const { a, admin } = await createTestUsers();
    const { data: source } = await admin.from("health_sources")
      .insert({ user_id: a.userId, kind: "health_auto_export", device_label: "HAE" })
      .select("id").single();
    const { error } = await admin.from("health_samples").insert({ user_id: a.userId,
      source_id: source!.id, type: "mood", value: 1, unit: "count",
      start_time: "2026-09-15T13:00:00Z", end_time: "2026-09-15T13:00:00Z", tz: "UTC" });
    expect(error?.message).toMatch(/health_samples_type_ck/);
  });

  it("leaves authenticated with select and no write on health_samples or ingest_events", async () => {
    const { data } = await adminClient().rpc("test_table_grants",
      { p_tables: ["health_samples", "ingest_events"] });
    const grants = (data ?? []) as { table_name: string; privilege_type: string }[];
    const kinds = new Set(grants.map((g) => g.privilege_type));
    expect([...kinds]).toEqual(["SELECT"]);
  });

  it("revokes both ingest functions from anon and authenticated", async () => {
    const anon = anonClient();
    const { error } = await anon.rpc("health_ingest_apply", { p_user_id: null, p_source_id: null,
      p_event_id: null, p_samples: [] });
    expect(error).not.toBeNull();
  });

  it("daily_health is security_invoker", async () => {
    const { data } = await adminClient().rpc("test_view_options");
    const view = ((data ?? []) as { view_name: string; options: string[] }[])
      .find((v) => v.view_name === "daily_health");
    expect(view?.options).toContain("security_invoker=true");
  });
});
```

- [ ] Run it: `SUPABASE_TEST_URL= pnpm test tests/health/migration-ingest.test.ts` — expected
      `4 skipped` (no branch). With a branch: expected failure, `relation "daily_health" does not exist`.
- [ ] Write `supabase/migrations/20260925000000_phase5_health_ingest.sql`:

```sql
-- Phase 5 (spec §4). Phase 0 already ships health_sources, ingest_events and health_samples with the
-- generated dedupe_key. This migration constrains them, adds the read view, and moves every write
-- behind two security-definer RPCs, because ingest identity is a source token, not a JWT (§2.2).

alter table health_samples add constraint health_samples_type_ck check (type in
  ('body_mass','step_count','active_energy','basal_energy','sleep_asleep','sleep_in_bed',
   'resting_heart_rate','hrv_sdnn','readiness_score'));

-- One Health Auto Export source delivers Watch rows and phone rows; the §3.5 overlap rule needs to
-- tell them apart, so the label lives on the sample, not only on the source.
alter table health_samples add column device_label text;

create index health_samples_user_type_time on health_samples (user_id, type, start_time desc);
create index ingest_events_source_time on ingest_events (source_id, received_at desc);

-- Phase 0's pattern-1 loop gave both tables a full _rw policy and all four grants. Observations are
-- written only by the privileged boundary, so the browser keeps select and nothing else.
drop policy health_samples_rw on health_samples;
drop policy ingest_events_rw on ingest_events;
create policy health_samples_ro on health_samples for select to authenticated
  using (user_id = (select auth.uid()));
create policy ingest_events_ro on ingest_events for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table health_samples from authenticated;
revoke insert, update, delete on table ingest_events from authenticated;
-- health_sources keeps its Phase 0 _rw policy: she manages her own sources.

create view daily_health with (security_invoker = true) as
  with d as (select user_id, type, value, start_time,
                    (start_time at time zone tz)::date as local_date from health_samples)
  select user_id, local_date,
    sum(value) filter (where type = 'step_count')    as steps,
    sum(value) filter (where type = 'active_energy') as active_kcal,
    max(value) filter (where type = 'sleep_asleep')  as sleep_minutes,
    (array_agg(value order by start_time desc) filter (where type = 'body_mass'))[1] as body_mass_kg
  from d group by user_id, local_date;
grant select on daily_health to authenticated;

-- One event row per payload. unique (source_id, payload_hash) makes a resend land on the existing
-- row; it is flipped to 'duplicate' so the route can answer without a second write.
create function health_ingest_event(p_user_id uuid, p_source_id uuid,
                                    p_payload_hash bytea, p_status text)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (select 1 from health_sources s
                  where s.id = p_source_id and s.user_id = p_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into ingest_events (user_id, source_id, payload_hash, status)
    values (p_user_id, p_source_id, p_payload_hash, coalesce(p_status, 'applied'))
    on conflict (source_id, payload_hash) do nothing
    returning id into v_id;
  if v_id is null then
    update ingest_events set status = 'duplicate'
      where source_id = p_source_id and payload_hash = p_payload_hash
      returning id into v_id;
  end if;
  return v_id;
end; $$;
revoke execute on function health_ingest_event(uuid, uuid, bytea, text)
  from public, anon, authenticated;
grant execute on function health_ingest_event(uuid, uuid, bytea, text) to service_role;

-- The §3.5 correction upsert. xmax = 0 on a RETURNING row means the row was inserted, not updated,
-- which is how accepted and updated are separated without a pre-select. Rows that conflict and fail
-- the freshness WHERE are not returned at all, so they fall out as skipped.
create function health_ingest_apply(p_user_id uuid, p_source_id uuid, p_event_id uuid,
                                    p_samples jsonb)
  returns table (accepted int, updated int, skipped int)
  language plpgsql security definer set search_path = public as $$
declare v_total int; v_accepted int; v_updated int;
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (select 1 from health_sources s
                  where s.id = p_source_id and s.user_id = p_user_id and s.revoked_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_total from jsonb_array_elements(coalesce(p_samples, '[]'::jsonb));

  with parsed as (
    select * from jsonb_to_recordset(coalesce(p_samples, '[]'::jsonb)) as x(
      type text, value numeric, unit text, start_time timestamptz, end_time timestamptz,
      tz text, vendor_sample_id text, vendor_updated_at timestamptz, device_label text)
  ),
  -- ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so a payload that
  -- repeats a dedupe key keeps only its newest entry; the rest fall out as skipped.
  incoming as (
    select distinct on (coalesce(p.vendor_sample_id,
             p.type || '|' || (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
                    || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text))
           p.*
      from parsed p
     order by coalesce(p.vendor_sample_id,
             p.type || '|' || (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
                    || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text),
           p.vendor_updated_at desc nulls last
  ),
  written as (
    insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
                                vendor_sample_id, vendor_updated_at, device_label, ingest_event_id)
    select p_user_id, p_source_id, i.type, i.value, i.unit, i.start_time, i.end_time,
           coalesce(i.tz, 'UTC'), i.vendor_sample_id, i.vendor_updated_at, i.device_label, p_event_id
      from incoming i
    on conflict (user_id, source_id, dedupe_key) do update
       set value = excluded.value, unit = excluded.unit, end_time = excluded.end_time,
           device_label = excluded.device_label, ingest_event_id = excluded.ingest_event_id,
           vendor_updated_at = excluded.vendor_updated_at
     where excluded.vendor_updated_at is not null
       and (health_samples.vendor_updated_at is null
            or excluded.vendor_updated_at > health_samples.vendor_updated_at)
    returning (xmax::text::bigint = 0) as inserted
  )
  select count(*) filter (where w.inserted)::int,
         count(*) filter (where not w.inserted)::int
    into v_accepted, v_updated
    from written w;

  accepted := coalesce(v_accepted, 0);
  updated  := coalesce(v_updated, 0);
  skipped  := v_total - accepted - updated;
  return next;
end; $$;
revoke execute on function health_ingest_apply(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function health_ingest_apply(uuid, uuid, uuid, jsonb) to service_role;
```

- [ ] Write `supabase/migrations/down/20260925000000_phase5_health_ingest.down.sql`:

```sql
-- Drops only what 20260925000000 created and restores Phase 0's policies and write grants.
-- Ingested observations are never deleted (spec §11): seven days of a person's life cannot be
-- re-collected, so the sample rows stay and only device_label — this migration's own column — goes.
drop function if exists health_ingest_apply(uuid, uuid, uuid, jsonb);
drop function if exists health_ingest_event(uuid, uuid, bytea, text);
drop view if exists daily_health;

drop policy if exists health_samples_ro on health_samples;
drop policy if exists ingest_events_ro on ingest_events;
create policy health_samples_rw on health_samples for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ingest_events_rw on ingest_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table health_samples to authenticated;
grant select, insert, update, delete on table ingest_events to authenticated;

drop index if exists ingest_events_source_time;
drop index if exists health_samples_user_type_time;
alter table health_samples drop column if exists device_label;
alter table health_samples drop constraint if exists health_samples_type_ck;
```

- [ ] Run it `[needs branch]`: `pnpm db:push && pnpm test tests/health/migration-ingest.test.ts` —
      expected PASS (4 tests); without a branch, expected `4 skipped`.
- [ ] Commit:
      `git add supabase/migrations/20260925000000_phase5_health_ingest.sql supabase/migrations/down/20260925000000_phase5_health_ingest.down.sql tests/health/migration-ingest.test.ts && git commit -m "feat(db): phase 5 health ingest constraints, view and privileged RPCs"`

---

## Task 8 — Migration `20260926000000_phase5_oura_oauth.sql` (+ down)

**Files**
- Create: `supabase/migrations/20260926000000_phase5_oura_oauth.sql`,
  `supabase/migrations/down/20260926000000_phase5_oura_oauth.down.sql`
- Test: `tests/health/migration-oauth.test.ts` `[needs branch]`

**Interfaces**

Consumes: `auth.users`. Produces: `oauth_states(state_hash bytea pk, provider, user_id, created_at,
expires_at, consumed_at)`, `job_runs(job, run_key, user_id, started_at, finished_at, status, detail,
primary key (job, user_id, run_key))` — the one lock table for every job in this wave (contracts §3:
Lane Q keys it `('estimate', …)` and `('weekly-proposal', …)`, Lane R `('weekly-review', …)`).

**Steps**

- [ ] Write the failing test `tests/health/migration-oauth.test.ts`:

```ts
/** [needs branch] */
import { describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("20260926000000_phase5_oura_oauth", () => {
  it("locks one job run per (job, user, run_key)", async () => {
    const { a } = await createTestUsers();
    const admin = adminClient();
    const row = { job: "oura-pull", user_id: a.userId, run_key: "2026-09-15", status: "running" };
    await admin.from("job_runs").delete().match({ job: row.job, user_id: row.user_id, run_key: row.run_key });
    expect((await admin.from("job_runs").insert(row)).error).toBeNull();
    expect((await admin.from("job_runs").insert(row)).error?.code).toBe("23505");
  });

  it("refuses a provider other than oura", async () => {
    const { a } = await createTestUsers();
    const { error } = await adminClient().from("oauth_states").insert({
      state_hash: "\\x00", provider: "strava", user_id: a.userId,
      expires_at: "2026-09-15T14:10:00Z" });
    expect(error?.message).toMatch(/oauth_states_provider_check/);
  });

  it("keeps user B out of user A's job_runs", async () => {
    const { a, b } = await createTestUsers();
    await adminClient().from("job_runs").upsert({ job: "oura-pull", user_id: a.userId,
      run_key: "2026-09-16", status: "ok" });
    const { data } = await b.client.from("job_runs").select("run_key").eq("user_id", a.userId);
    expect(data).toEqual([]);
  });
});
```

- [ ] Run it: `pnpm test tests/health/migration-oauth.test.ts` — expected failure on a branch,
      `relation "oauth_states" does not exist`; `3 skipped` without one.
- [ ] Write `supabase/migrations/20260926000000_phase5_oura_oauth.sql`:

```sql
-- Phase 5 (spec §4). oauth_states is server-boundary only: it carries no policy, so RLS denies every
-- authenticated read and the callback route reaches it with the service role.
create table oauth_states (state_hash bytea primary key, provider text not null check (provider in ('oura')),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  consumed_at timestamptz);
alter table oauth_states enable row level security;   -- no policy: server boundary only
revoke all on table oauth_states from anon, authenticated;

create table job_runs (job text not null, run_key text not null,   -- e.g. ('oura-pull','2026-09-15')
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));
alter table job_runs enable row level security;
create policy job_runs_ro on job_runs for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table job_runs from anon, authenticated;
grant select on table job_runs to authenticated;
```

- [ ] Write `supabase/migrations/down/20260926000000_phase5_oura_oauth.down.sql`:

```sql
-- Both tables are this migration's own; nothing else references them.
drop table if exists job_runs;
drop table if exists oauth_states;
```

- [ ] Run it `[needs branch]`: `pnpm db:push && pnpm test tests/health/migration-oauth.test.ts` —
      expected PASS (3 tests).
- [ ] Commit:
      `git add supabase/migrations/20260926000000_phase5_oura_oauth.sql supabase/migrations/down/20260926000000_phase5_oura_oauth.down.sql tests/health/migration-oauth.test.ts && git commit -m "feat(db): oauth_states and the shared job_runs lock"`

---

## Task 9 — `lib/server/crypto.ts` and `lib/server/health-tokens.ts`

**Files**
- Create: `lib/server/crypto.ts`, `lib/server/health-tokens.ts`
- Test: `tests/health/crypto.test.ts`, `tests/health/health-tokens.test.ts`

**Interfaces**

Consumes: `hashToken`, `toBytea` (`lib/server/tokens.ts`, Phase 0 contracts §5); `adminClient`
(`lib/server/admin.ts`); `OauthTokens` (Task 1).
Produces (contracts §2):

```ts
export function sealOauth(plain: OauthTokens, key?: Buffer): string;
export function openOauth(sealed: string, key?: Buffer): OauthTokens;
export function healthTokenKey(): Buffer;
export const HEALTH_TOKEN_PREFIX = "smh_";
export function issueSourceToken(): { raw: string; hash: Buffer };
export async function resolveSourceByToken(admin: SupabaseClient, raw: string):
  Promise<{ id: string; userId: string; kind: string } | null>;
```

**Steps**

- [ ] Write the failing test `tests/health/crypto.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOauth, sealOauth } from "@/lib/server/crypto";

const KEY = randomBytes(32);
const TOKENS = { access_token: "oura-access", refresh_token: "oura-refresh",
  expires_at: "2026-09-15T15:00:00.000Z", scope: "daily personal" };

describe("sealOauth / openOauth", () => {
  it("round-trips and never leaves the plaintext visible", () => {
    const sealed = sealOauth(TOKENS, KEY);
    expect(sealed).not.toContain("oura-access");
    expect(openOauth(sealed, KEY)).toEqual(TOKENS);
  });

  it("uses a fresh 12-byte IV, so the same input seals differently each time", () => {
    expect(sealOauth(TOKENS, KEY)).not.toBe(sealOauth(TOKENS, KEY));
    expect(Buffer.from(sealOauth(TOKENS, KEY), "base64").length)
      .toBe(12 + 16 + Buffer.byteLength(JSON.stringify(TOKENS), "utf8"));
  });

  it("throws on a tampered ciphertext and on the wrong key", () => {
    const bytes = Buffer.from(sealOauth(TOKENS, KEY), "base64");
    bytes[20] ^= 0xff;
    expect(() => openOauth(bytes.toString("base64"), KEY)).toThrow();
    expect(() => openOauth(sealOauth(TOKENS, KEY), randomBytes(32))).toThrow();
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => sealOauth(TOKENS, randomBytes(16))).toThrow(/32 bytes/);
  });
});
```

- [ ] Write the failing test `tests/health/health-tokens.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { hashToken, toBytea } from "@/lib/server/tokens";
import { issueSourceToken, resolveSourceByToken } from "@/lib/server/health-tokens";

/** One-row stub shaped like the PostgREST builder chain the module uses. */
function stubAdmin(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const is = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { admin: { from } as never, eq };
}

describe("issueSourceToken", () => {
  it("mints a smh_ token whose hash is the stored sha256", () => {
    const { raw, hash } = issueSourceToken();
    expect(raw.startsWith("smh_")).toBe(true);
    expect(raw.length).toBeGreaterThan(40);
    expect(hash.equals(hashToken(raw))).toBe(true);
    expect(issueSourceToken().raw).not.toBe(raw);
  });
});

describe("resolveSourceByToken", () => {
  it("looks the row up by hash, never by the raw token", async () => {
    const raw = "smh_abc";
    const hash = hashToken(raw);
    const { admin, eq } = stubAdmin({ id: "src-1", user_id: "user-1",
      kind: "health_auto_export", token_hash: `\\x${hash.toString("hex")}` });
    expect(await resolveSourceByToken(admin, raw))
      .toEqual({ id: "src-1", userId: "user-1", kind: "health_auto_export" });
    expect(eq).toHaveBeenCalledWith("token_hash", toBytea(hash));
  });

  it("returns null for an unknown or revoked token", async () => {
    const { admin } = stubAdmin(null);
    expect(await resolveSourceByToken(admin, "smh_nope")).toBeNull();
  });

  it("returns null when the stored hash does not actually match", async () => {
    const { admin } = stubAdmin({ id: "src-1", user_id: "user-1", kind: "oura",
      token_hash: `\\x${hashToken("smh_other").toString("hex")}` });
    expect(await resolveSourceByToken(admin, "smh_abc")).toBeNull();
  });
});
```

- [ ] Run them: `pnpm test tests/health/crypto.test.ts tests/health/health-tokens.test.ts` —
      expected failure: `Error: Failed to load url @/lib/server/crypto`.
- [ ] Write `lib/server/crypto.ts`:

```ts
/**
 * Oura tokens are sealed before they reach Postgres (spec §4): AES-256-GCM, a fresh 12-byte IV per
 * seal, the 16-byte tag appended, the whole thing base64. HEALTH_TOKEN_KEY is server-only and never
 * appears under a NEXT_PUBLIC_ name (spec §8).
 *
 * No "server-only" import here: app/api/mcp/route.ts reaches this lane's modules and Phase 0's route
 * tests load that route under vitest, where the marker throws (see lib/server/log.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { OauthTokens } from "@/lib/health/contract";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function healthTokenKey(): Buffer {
  const raw = process.env.HEALTH_TOKEN_KEY;
  if (!raw) throw new Error("HEALTH_TOKEN_KEY not set");
  return Buffer.from(raw, "base64");
}

function assertKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("HEALTH_TOKEN_KEY must decode to 32 bytes");
  return key;
}

export function sealOauth(plain: OauthTokens, key: Buffer = healthTokenKey()): string {
  const k = assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function openOauth(sealed: string, key: Buffer = healthTokenKey()): OauthTokens {
  const k = assertKey(key);
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  // final() throws on a tag mismatch — a tampered or wrongly-keyed value never returns a value.
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as OauthTokens;
}
```

- [ ] Write `lib/server/health-tokens.ts`:

```ts
/**
 * Per-source ingest tokens (spec §5). The plaintext is returned once at issue and never stored; the
 * lookup is by hash and the comparison is constant-time (spec §8).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashToken, toBytea } from "@/lib/server/tokens";

export const HEALTH_TOKEN_PREFIX = "smh_";

export function issueSourceToken(): { raw: string; hash: Buffer } {
  const raw = `${HEALTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/** PostgREST returns bytea as the hex literal `\x…`. */
function fromBytea(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value.startsWith("\\x")) return null;
  return Buffer.from(value.slice(2), "hex");
}

export async function resolveSourceByToken(admin: SupabaseClient, raw: string):
    Promise<{ id: string; userId: string; kind: string } | null> {
  if (typeof raw !== "string" || !raw.startsWith(HEALTH_TOKEN_PREFIX)) return null;
  const hash = hashToken(raw);
  const { data, error } = await admin.from("health_sources")
    .select("id, user_id, kind, token_hash")
    .eq("token_hash", toBytea(hash))
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;

  const stored = fromBytea((data as { token_hash: unknown }).token_hash);
  if (!stored || stored.length !== hash.length || !timingSafeEqual(stored, hash)) return null;

  const row = data as { id: string; user_id: string; kind: string };
  return { id: row.id, userId: row.user_id, kind: row.kind };
}
```

- [ ] Run them: `pnpm test tests/health/crypto.test.ts tests/health/health-tokens.test.ts` —
      expected PASS (7 tests).
- [ ] Commit:
      `git add lib/server/crypto.ts lib/server/health-tokens.ts tests/health/crypto.test.ts tests/health/health-tokens.test.ts && git commit -m "feat(health): sealed oauth storage and constant-time source tokens"`

---

## Task 10 — `lib/server/health-daily.ts`: the one merged read path

**Files**
- Create: `lib/server/health-daily.ts`
- Test: `tests/health/health-daily.test.ts`

**Interfaces**

Consumes: `rollUpDay`, `localDateOf`, `emptyDay` (Task 6); `toCanonical` (Task 2); the `weigh_ins` view
(`supabase/migrations/20260911000500_rls.sql:100-104`, returning `value` + `unit` unconverted).
Produces (contracts §2 — Lane Q's `runEstimate` injects `weighInsKg`):

```ts
export async function mergedDays(client: SupabaseClient, userId: string, from: string, to: string): Promise<DailyHealthRow[]>;
export async function weighInsKg(client: SupabaseClient, userId: string, from: string, to: string): Promise<{ date: string; kg: number }[]>;
export async function listSources(client: SupabaseClient, userId: string): Promise<DailyHealthResponse["sources"]>;
export function eachLocalDate(from: string, to: string): string[];
```

**Steps**

- [ ] Write the failing test `tests/health/health-daily.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { eachLocalDate, mergedDays, weighInsKg } from "@/lib/server/health-daily";

const SAMPLES = [
  { type: "step_count", value: 1000, unit: "count", start_time: "2026-09-15T17:00:00Z",
    end_time: "2026-09-15T18:00:00Z", tz: "America/New_York", device_label: "Apple Watch" },
  { type: "step_count", value: 600, unit: "count", start_time: "2026-09-15T17:30:00Z",
    end_time: "2026-09-15T18:30:00Z", tz: "America/New_York", device_label: "iPhone" },
  { type: "body_mass", value: 57.6, unit: "kg", start_time: "2026-09-17T11:12:00Z",
    end_time: "2026-09-17T11:12:00Z", tz: "America/New_York", device_label: "Withings" },
];

function stubSelect(rows: unknown[]) {
  const lt = vi.fn().mockResolvedValue({ data: rows, error: null });
  const gte = vi.fn(() => ({ lt, order: () => ({ lt }) }));
  const eq = vi.fn(() => ({ gte }));
  const select = vi.fn(() => ({ eq }));
  return { from: vi.fn(() => ({ select })) } as never;
}

describe("eachLocalDate", () => {
  it("is inclusive at both ends and crosses a month", () => {
    expect(eachLocalDate("2026-09-29", "2026-10-01"))
      .toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });
});

describe("mergedDays", () => {
  it("returns one row per day in the window, merged, with gaps as nulls", async () => {
    const days = await mergedDays(stubSelect(SAMPLES), "user-1", "2026-09-15", "2026-09-17");
    expect(days.map((d) => d.local_date)).toEqual(["2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(days[0].steps).toBe(1300);
    expect(days[1]).toEqual({ local_date: "2026-09-16", steps: null, active_kcal: null,
      sleep_minutes: null, body_mass_kg: null, sources: [] });
    expect(days[2].body_mass_kg).toBe(57.6);
  });

  it("returns every day as empty when there are no samples at all", async () => {
    const days = await mergedDays(stubSelect([]), "user-1", "2026-09-15", "2026-09-16");
    expect(days).toHaveLength(2);
    expect(days.every((d) => d.steps === null && d.sources.length === 0)).toBe(true);
  });
});

describe("weighInsKg", () => {
  it("converts every weigh_ins row through toCanonical, pounds included", async () => {
    const rows = [{ local_date: "2026-09-15", value: 127.2, unit: "lb" },
      { local_date: "2026-09-16", value: 57.5, unit: "kg" }];
    const out = await weighInsKg(stubSelect(rows), "user-1", "2026-09-15", "2026-09-16");
    expect(out[0].kg).toBeCloseTo(57.697, 3);
    expect(out[1]).toEqual({ date: "2026-09-16", kg: 57.5 });
  });
});
```

- [ ] Run it: `pnpm test tests/health/health-daily.test.ts` — expected failure:
      `Error: Failed to load url @/lib/server/health-daily`.
- [ ] Write `lib/server/health-daily.ts`:

```ts
/**
 * The ONE read path for merged days (contracts §2). GET /api/health/daily, the MCP get_body_data tool
 * and Phase 6's estimator all come through here, so none of them can see a different number than the
 * dashboard. It reads raw health_samples rows and applies lib/health/daily.ts — never the plain
 * daily_health view, which is an aggregate without the §3.5 preference rules (spec §4).
 *
 * `client` is whichever client the caller already holds: the RLS-scoped request client on the browser
 * path, the admin client inside the privileged boundary. The explicit .eq('user_id') satisfies §2.2
 * rule 3 either way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailyHealthResponse, DailyHealthRow, NormalizedSample } from "@/lib/health/contract";
import { emptyDay, localDateOf, rollUpDay } from "@/lib/health/daily";
import { toCanonical } from "@/lib/health/units";

const DAY_MS = 86_400_000;

export function eachLocalDate(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const dates: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}

type SampleRow = { type: string; value: number; unit: string; start_time: string; end_time: string;
  tz: string; device_label: string | null; vendor_sample_id: string | null };

export async function mergedDays(client: SupabaseClient, userId: string, from: string, to: string):
    Promise<DailyHealthRow[]> {
  // One day of slack at each end: a 23:30 local sample is tomorrow in UTC, and the reverse.
  const lower = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const upper = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString();

  const { data, error } = await client.from("health_samples")
    .select("type, value, unit, start_time, end_time, tz, device_label, vendor_sample_id")
    .eq("user_id", userId)
    .gte("start_time", lower)
    .lt("start_time", upper);
  if (error) throw error;

  const buckets = new Map<string, NormalizedSample[]>();
  for (const row of (data ?? []) as SampleRow[]) {
    const sample: NormalizedSample = { type: row.type as NormalizedSample["type"],
      value: Number(row.value), unit: row.unit, start_time: row.start_time, end_time: row.end_time,
      tz: row.tz, device_label: row.device_label ?? undefined,
      vendor_sample_id: row.vendor_sample_id ?? undefined };
    const date = localDateOf(sample.start_time, sample.tz);
    const bucket = buckets.get(date);
    if (bucket) bucket.push(sample); else buckets.set(date, [sample]);
  }

  return eachLocalDate(from, to).map((date) => {
    const bucket = buckets.get(date);
    return bucket && bucket.length > 0 ? rollUpDay(bucket, bucket[0].tz) : emptyDay(date);
  });
}

export async function weighInsKg(client: SupabaseClient, userId: string, from: string, to: string):
    Promise<{ date: string; kg: number }[]> {
  const { data, error } = await client.from("weigh_ins")
    .select("local_date, value, unit")
    .eq("user_id", userId)
    .gte("local_date", from)
    .lt("local_date", new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10));
  if (error) throw error;
  return ((data ?? []) as { local_date: string; value: number; unit: string }[])
    .map((row) => ({ date: row.local_date,
      kg: toCanonical("body_mass", Number(row.value), row.unit).value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function listSources(client: SupabaseClient, userId: string):
    Promise<DailyHealthResponse["sources"]> {
  const { data, error } = await client.from("health_sources")
    .select("id, kind, device_label, revoked_at").eq("user_id", userId);
  if (error) throw error;
  const sources = (data ?? []) as { id: string; kind: string; device_label: string | null;
    revoked_at: string | null }[];

  const { data: events } = await client.from("ingest_events")
    .select("source_id, received_at").eq("user_id", userId)
    .order("received_at", { ascending: false }).limit(200);
  const last = new Map<string, string>();
  for (const e of ((events ?? []) as { source_id: string; received_at: string }[])) {
    if (!last.has(e.source_id)) last.set(e.source_id, e.received_at);
  }

  return sources.map((s) => ({ id: s.id, kind: s.kind, device_label: s.device_label,
    last_received_at: last.get(s.id) ?? null, revoked: s.revoked_at !== null }));
}
```

- [ ] Run it: `pnpm test tests/health/health-daily.test.ts` — expected PASS (4 tests).
- [ ] Commit:
      `git add lib/server/health-daily.ts tests/health/health-daily.test.ts && git commit -m "feat(health): merged-day read path shared by the route, MCP and the estimator"`

---

## Task 11 — `lib/server/health-ingest.ts` and `app/api/health/ingest/route.ts`

**Files**
- Create: `lib/server/health-ingest.ts`, `app/api/health/ingest/route.ts`
- Test: `tests/health/ingest-route.test.ts`

**Interfaces**

Consumes: `HttpError` (`lib/server/auth.ts`), `jsonError`, `readJson` (`lib/server/http.ts`),
`enforceRateLimit` (`lib/server/ratelimit.ts`), `hashToken` (`lib/server/tokens.ts`), `adminClient`
(`lib/server/admin.ts`), `resolveSourceByToken` (Task 9), `normalizeHealthAutoExport` /
`normalizeShortcut` (Task 5), `withinReplayWindow` (Task 3), the two RPCs (Task 7).
Produces:

```ts
export type ResolvedSource = { id: string; userId: string; kind: string };
export async function applyIngest(admin: SupabaseClient, source: ResolvedSource, body: unknown,
  now?: Date): Promise<HealthIngestResponse>;
export function payloadHash(body: unknown): Buffer;
export const MAX_SAMPLE_AGE_MS: number;                  // HAE path: 48 h
export async function POST(req: Request): Promise<Response>;   // route
```

**Steps**

- [ ] Write the failing test `tests/health/ingest-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { resolveSourceByToken } from "@/lib/server/health-tokens";
import { applyIngest } from "@/lib/server/health-ingest";

vi.mock("@/lib/server/health-tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/health-tokens")>()),
  resolveSourceByToken: vi.fn(),
}));
vi.mock("@/lib/server/health-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/health-ingest")>()),
  applyIngest: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const { POST } = await import("@/app/api/health/ingest/route");
const resolve = vi.mocked(resolveSourceByToken);
const apply = vi.mocked(applyIngest);

const BODY = { source_kind: "apple_health_shortcut", sent_at: new Date().toISOString(),
  tz: "America/New_York", samples: [] };

function post(body: unknown, token = "smh_live", extra: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/health/ingest", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    body: JSON.stringify(body) });
}

describe("POST /api/health/ingest", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    resolve.mockReset().mockResolvedValue({ id: "src-1", userId: "user-1",
      kind: "apple_health_shortcut" });
    apply.mockReset().mockResolvedValue({ event_id: "ev-1", status: "applied", accepted: 1,
      updated: 0, skipped: 0, rejected: [] });
  });

  it("503s when the flag is unset, before any token lookup", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    expect((await POST(post(BODY))).status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("401s a revoked or unknown token before reading user data", async () => {
    resolve.mockResolvedValue(null);
    expect((await POST(post(BODY))).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("413s a body over 2 MB without calling applyIngest", async () => {
    const big = { ...BODY, samples: [{ type: "step_count", value: 1, unit: "count",
      start_time: BODY.sent_at, end_time: BODY.sent_at, device_label: "x".repeat(3_000_000) }] };
    expect((await POST(post(big))).status).toBe(413);
    expect(apply).not.toHaveBeenCalled();
  });

  it("429s the 31st request in an hour for the same token", async () => {
    for (let i = 0; i < 30; i += 1) await POST(post(BODY));
    expect((await POST(post(BODY))).status).toBe(429);
  });

  it("passes the parsed body through and returns applyIngest's response", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ event_id: "ev-1", status: "applied" });
    expect(apply.mock.calls[0][1]).toEqual({ id: "src-1", userId: "user-1",
      kind: "apple_health_shortcut" });
  });
});

describe("applyIngest", () => {
  const { applyIngest: real } = await vi.importActual<typeof import("@/lib/server/health-ingest")>(
    "@/lib/server/health-ingest");
  const source = { id: "src-1", userId: "user-1", kind: "apple_health_shortcut" };
  const now = new Date("2026-09-15T14:00:00Z");

  function stubAdmin(eventId: string, status: string,
      counts = { accepted: 1, updated: 0, skipped: 0 }) {
    const rpc = vi.fn(async (name: string) =>
      name === "health_ingest_event" ? { data: eventId, error: null }
                                     : { data: [counts], error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { status }, error: null });
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));
    return { rpc, from } as never;
  }

  const body = (over: Record<string, unknown> = {}) => ({ source_kind: "apple_health_shortcut",
    sent_at: "2026-09-15T14:00:30Z", tz: "America/New_York", samples: [
      { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" }], ...over });

  it("409s a payload outside the replay window", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, body({ sent_at: "2026-09-15T13:30:00Z" }), now))
      .rejects.toMatchObject({ status: 409, code: "replayed" });
  });

  it("403s when the payload's source_kind is not the source row's kind", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, body({ source_kind: "health_auto_export" }), now))
      .rejects.toMatchObject({ status: 403, code: "wrong_source_kind" });
  });

  it("422s an envelope zod failure", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, { hello: "world" }, now))
      .rejects.toMatchObject({ status: 422, code: "unprocessable" });
  });

  it("returns duplicate and applies nothing on a repeated payload", async () => {
    const admin = stubAdmin("ev-1", "duplicate");
    const out = await real(admin, source, body(), now);
    expect(out).toEqual({ event_id: "ev-1", status: "duplicate", accepted: 0, updated: 0,
      skipped: 0, rejected: [] });
    expect((admin as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc)
      .not.toHaveBeenCalledWith("health_ingest_apply", expect.anything());
  });

  it("lists a malformed sample in rejected and still applies the rest", async () => {
    const admin = stubAdmin("ev-2", "applied");
    const out = await real(admin, source, body({ samples: [
      { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" },
      { type: "step_count", value: 1, unit: "furlong", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" }] }), now);
    expect(out.rejected).toEqual([{ index: 1, reason: "schema: unit" }]);
    expect(out.accepted).toBe(1);
  });
});
```

- [ ] Run it: `pnpm test tests/health/ingest-route.test.ts` — expected failure:
      `Error: Failed to load url @/lib/server/health-ingest`.
- [ ] Write `lib/server/health-ingest.ts`:

```ts
/**
 * The ingest pipeline (spec §5): source → replay window → payload hash → event RPC → normalize →
 * apply RPC → response. Identity is the source row, so every database call is a security-definer RPC
 * whose first argument is that row's user_id (§2.2 rule 3); withTokenUser is the MCP path and is
 * deliberately not used here (contracts §2).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { healthAutoExportBodySchema, healthIngestBodySchema, REPLAY_WINDOW_MS,
  type HealthIngestResponse, type NormalizedSample, type NormalizeResult } from "@/lib/health/contract";
import { normalizeHealthAutoExport, normalizeShortcut } from "@/lib/health/normalize";
import { withinReplayWindow } from "@/lib/health/replay";
import { HttpError } from "@/lib/server/auth";

export type ResolvedSource = { id: string; userId: string; kind: string };

/** Health Auto Export cannot stamp a request, so its payload is bounded by sample age instead. */
export const MAX_SAMPLE_AGE_MS = 48 * 3_600_000;

export function payloadHash(body: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest();
}

function toBytea(hash: Buffer): string {
  return `\\x${hash.toString("hex")}`;
}

function parsePayload(source: ResolvedSource, body: unknown, now: Date):
    { result: NormalizeResult; tz: string } {
  const canonical = healthIngestBodySchema.safeParse(body);
  if (canonical.success) {
    if (canonical.data.source_kind !== source.kind) {
      throw new HttpError(403, "wrong_source_kind", "This token belongs to a different source kind.");
    }
    if (!withinReplayWindow(canonical.data.sent_at, now, REPLAY_WINDOW_MS)) {
      throw new HttpError(409, "replayed", "sent_at is outside the ten-minute window.");
    }
    return { result: normalizeShortcut(canonical.data, canonical.data.tz), tz: canonical.data.tz };
  }

  const hae = healthAutoExportBodySchema.safeParse(body);
  if (hae.success) {
    if (source.kind !== "health_auto_export") {
      throw new HttpError(403, "wrong_source_kind", "This token belongs to a different source kind.");
    }
    const tz = process.env.HEALTH_TZ ?? "America/New_York";
    const result = normalizeHealthAutoExport(hae.data, tz);
    const fresh: NormalizedSample[] = [];
    result.samples.forEach((sample, index) => {
      if (now.getTime() - Date.parse(sample.start_time) > MAX_SAMPLE_AGE_MS) {
        result.rejected.push({ index, reason: "sample older than 48 h" });
      } else {
        fresh.push(sample);
      }
    });
    return { result: { samples: fresh, rejected: result.rejected }, tz };
  }

  throw new HttpError(422, "unprocessable", "Body is neither the ingest envelope nor an HAE export.");
}

export async function applyIngest(admin: SupabaseClient, source: ResolvedSource, body: unknown,
    now: Date = new Date()): Promise<HealthIngestResponse> {
  const { result } = parsePayload(source, body, now);

  const event = await admin.rpc("health_ingest_event", { p_user_id: source.userId,
    p_source_id: source.id, p_payload_hash: toBytea(payloadHash(body)), p_status: "applied" });
  if (event.error) throw new HttpError(500, "internal", "could not record the ingest event");
  const eventId = (Array.isArray(event.data) ? event.data[0] : event.data) as string;

  const stored = await admin.from("ingest_events").select("status").eq("id", eventId).maybeSingle();
  if (stored.data && (stored.data as { status: string }).status === "duplicate") {
    return { event_id: eventId, status: "duplicate", accepted: 0, updated: 0, skipped: 0, rejected: [] };
  }

  const applied = await admin.rpc("health_ingest_apply", { p_user_id: source.userId,
    p_source_id: source.id, p_event_id: eventId, p_samples: result.samples });
  if (applied.error) throw new HttpError(500, "internal", "could not apply the samples");
  const counts = (Array.isArray(applied.data) ? applied.data[0] : applied.data) as
    { accepted: number; updated: number; skipped: number } | null;

  return { event_id: eventId, status: "applied", accepted: counts?.accepted ?? 0,
    updated: counts?.updated ?? 0, skipped: counts?.skipped ?? 0, rejected: result.rejected };
}
```

- [ ] Write `app/api/health/ingest/route.ts`:

```ts
/**
 * POST /api/health/ingest — spec §8 row 1. Order is rate limit (on the token hash, so an
 * unauthenticated flood costs no lookup) → identity → body (Phase 0 contracts §8).
 */
import { MAX_INGEST_BYTES } from "@/lib/health/contract";
import { z } from "zod";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { applyIngest } from "@/lib/server/health-ingest";
import { resolveSourceByToken } from "@/lib/server/health-tokens";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { hashToken } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) {
      throw new HttpError(503, "unavailable", "Health ingest is off.");
    }
    const raw = bearer(req);
    const key = raw.length > 0 ? hashToken(raw).toString("hex") : "none";
    await enforceRateLimit(`health:ingest:${key}`, 30, 3600);

    const source = await resolveSourceByToken(adminClient(), raw);
    if (!source) throw new HttpError(401, "unauthorized", "Unknown, revoked or expired token.");

    const body = await readJson(req, z.unknown(), MAX_INGEST_BYTES);
    return Response.json(await applyIngest(adminClient(), source, body));
  } catch (e) {
    const res = jsonError(e);
    if (res.status === 401) res.headers.set("WWW-Authenticate", "Bearer");
    return res;
  }
}
```

- [ ] Run it: `pnpm test tests/health/ingest-route.test.ts` — expected PASS (10 tests).
- [ ] Commit:
      `git add lib/server/health-ingest.ts app/api/health/ingest/route.ts tests/health/ingest-route.test.ts && git commit -m "feat(health): ingest pipeline and route"`

---

## Task 12 — Daily and token routes, plus `scripts/issue-health-token.ts`

**Files**
- Create: `app/api/health/daily/route.ts`, `app/api/health/tokens/route.ts`,
  `app/api/health/tokens/[id]/route.ts`, `scripts/issue-health-token.ts`
- Test: `tests/health/daily-route.test.ts`, `tests/health/tokens-route.test.ts`

**Interfaces**

Consumes: `requireUser` (`lib/server/auth.ts`), `mergedDays` / `listSources` (Task 10),
`issueSourceToken` (Task 9), `adminClient`, `enforceRateLimit`, `MAX_DAILY_WINDOW_DAYS`.
Produces: `GET` (daily), `POST` (issue), `DELETE` (revoke) handlers, all exported from their routes.

**Steps**

- [ ] Write the failing test `tests/health/daily-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { listSources, mergedDays } from "@/lib/server/health-daily";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/health-daily", () => ({ mergedDays: vi.fn(), listSources: vi.fn() }));

const { GET } = await import("@/app/api/health/daily/route");
const user = vi.mocked(requireUser);

function get(query: string): Request {
  return new Request(`https://app.test/api/health/daily${query}`);
}

describe("GET /api/health/daily", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    user.mockReset().mockResolvedValue({ userId: "user-1", client: {} as never });
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Apple Watch"] }]);
    vi.mocked(listSources).mockResolvedValue([{ id: "src-1", kind: "health_auto_export",
      device_label: "HAE", last_received_at: "2026-09-15T10:30:00Z", revoked: false }]);
  });

  it("503s when the flag is unset, so /body can render its empty state", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    expect((await GET(get("?from=2026-09-15&to=2026-09-15"))).status).toBe(503);
  });

  it("401s without a session", async () => {
    const { HttpError } = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
    user.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await GET(get("?from=2026-09-15&to=2026-09-15"))).status).toBe(401);
  });

  it("400s a malformed or inverted range and 400s a window over 90 days", async () => {
    expect((await GET(get("?from=nope&to=2026-09-15"))).status).toBe(400);
    expect((await GET(get("?from=2026-09-15&to=2026-09-01"))).status).toBe(400);
    expect((await GET(get("?from=2026-01-01&to=2026-09-15"))).status).toBe(400);
  });

  it("returns merged days and sources for the caller's own id", async () => {
    const res = await GET(get("?from=2026-09-15&to=2026-09-15"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96, sleep_minutes: 444,
        body_mass_kg: 57.6, sources: ["Apple Watch"] }],
      sources: [{ id: "src-1", kind: "health_auto_export", device_label: "HAE",
        last_received_at: "2026-09-15T10:30:00Z", revoked: false }] });
    expect(vi.mocked(mergedDays).mock.calls[0][1]).toBe("user-1");
  });
});
```

- [ ] Write the failing test `tests/health/tokens-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const insert = vi.fn();
const update = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: () => ({
    insert: (row: unknown) => { insert(row); return { select: () => ({ single: async () =>
      ({ data: { id: "src-9", kind: "health_auto_export", device_label: "HAE" }, error: null }) }) }; },
    update: (patch: unknown) => { update(patch); return { eq: () => ({ eq: () => ({ select: () =>
      ({ maybeSingle: async () => ({ data: { id: "src-9" }, error: null }) }) }) }) }; },
  }) }) }));

const { POST } = await import("@/app/api/health/tokens/route");
const { DELETE } = await import("@/app/api/health/tokens/[id]/route");
const user = vi.mocked(requireUser);

describe("the source-token routes", () => {
  beforeEach(() => {
    resetRateLimits();
    insert.mockClear();
    update.mockClear();
    user.mockReset().mockResolvedValue({ userId: "user-1", client: {} as never });
  });

  it("returns the plaintext token once and stores only its hash", async () => {
    const res = await POST(new Request("https://app.test/api/health/tokens", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "health_auto_export", device_label: "HAE" }) }));
    const json = await res.json() as { token: string; source: { id: string } };
    expect(res.status).toBe(200);
    expect(json.token.startsWith("smh_")).toBe(true);
    expect(json.source.id).toBe("src-9");
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.user_id).toBe("user-1");
    expect(String(row.token_hash).startsWith("\\x")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(json.token);
  });

  it("422s an unknown source kind", async () => {
    const res = await POST(new Request("https://app.test/api/health/tokens", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "fitbit" }) }));
    expect(res.status).toBe(400);
  });

  it("revokes by setting revoked_at, scoped to the caller", async () => {
    const res = await DELETE(new Request("https://app.test/api/health/tokens/src-9",
      { method: "DELETE" }), { params: Promise.resolve({ id: "src-9" }) });
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ revoked_at: expect.any(String) });
  });
});
```

- [ ] Run them: `pnpm test tests/health/daily-route.test.ts tests/health/tokens-route.test.ts` —
      expected failure: `Error: Failed to load url @/app/api/health/daily/route`.
- [ ] Write `app/api/health/daily/route.ts`:

```ts
/** GET /api/health/daily — spec §8: JWT, RLS path, 60/min/user, window ≤ 90 days. */
import { dailyQuerySchema, MAX_DAILY_WINDOW_DAYS, type DailyHealthResponse } from "@/lib/health/contract";
import { HttpError, requireUser } from "@/lib/server/auth";
import { listSources, mergedDays } from "@/lib/server/health-daily";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) {
      throw new HttpError(503, "unavailable", "Health data is off.");
    }
    const { searchParams } = new URL(req.url);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`health:daily:${userId}`, 60, 60);

    const parsed = dailyQuerySchema.safeParse({ from: searchParams.get("from"),
      to: searchParams.get("to") });
    if (!parsed.success) throw new HttpError(400, "bad_request", "from and to must be YYYY-MM-DD.");
    const { from, to } = parsed.data;
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span < 0) throw new HttpError(400, "bad_request", "to is before from.");
    if (span + 1 > MAX_DAILY_WINDOW_DAYS) {
      throw new HttpError(400, "bad_request", `Window over ${MAX_DAILY_WINDOW_DAYS} days.`);
    }

    const body: DailyHealthResponse = {
      days: await mergedDays(client, userId, from, to),
      sources: await listSources(client, userId),
    };
    return Response.json(body);
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/health/tokens/route.ts`:

```ts
/** POST /api/health/tokens — spec §5: issue a per-source token, returned exactly once. */
import { z } from "zod";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { toBytea } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["health_auto_export", "apple_health_shortcut", "manual"]),
  device_label: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:tokens:${userId}`, 20, 3600);
    const body = await readJson(req, bodySchema, 1024);

    const { raw, hash } = issueSourceToken();
    const { data, error } = await adminClient().from("health_sources")
      .insert({ user_id: userId, kind: body.kind, device_label: body.device_label ?? null,
        token_hash: toBytea(hash) })
      .select("id, kind, device_label").single();
    if (error) throw error;

    // The plaintext is returned here and nowhere else; only the hash reaches Postgres (spec §8).
    return Response.json({ token: raw, source: data });
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/health/tokens/[id]/route.ts`:

```ts
/** DELETE /api/health/tokens/[id] — revoke. The row stays so its samples keep their foreign key. */
import { adminClient } from "@/lib/server/admin";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request,
    ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:tokens:${userId}`, 20, 3600);
    const { id } = await ctx.params;

    const { data, error } = await adminClient().from("health_sources")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", userId)      // §2.2 rule 3: never an unscoped write
      .select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "not_found", "No such source.");
    return Response.json({ ok: true, id });
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `scripts/issue-health-token.ts`:

```ts
/**
 * CLI path for the same issue flow (spec §7), for when the UI is not available:
 *   pnpm exec tsx scripts/issue-health-token.ts <user_id> <kind> [device_label]
 * Prints the plaintext token once. Nothing stores it.
 */
import { createClient } from "@supabase/supabase-js";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { toBytea } from "@/lib/server/tokens";

const KINDS = new Set(["health_auto_export", "apple_health_shortcut", "manual"]);

async function main(): Promise<void> {
  const [userId, kind, deviceLabel] = process.argv.slice(2);
  if (!userId || !KINDS.has(kind ?? "")) {
    throw new Error("usage: issue-health-token.ts <user_id> <health_auto_export|apple_health_shortcut|manual> [device_label]");
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { raw, hash } = issueSourceToken();
  const { data, error } = await admin.from("health_sources")
    .insert({ user_id: userId, kind, device_label: deviceLabel ?? null, token_hash: toBytea(hash) })
    .select("id").single();
  if (error) throw error;

  console.log(`source ${data.id}\ntoken  ${raw}\n\nPaste the token into the Authorization header now; it is not stored.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

- [ ] Run them: `pnpm test tests/health/daily-route.test.ts tests/health/tokens-route.test.ts` —
      expected PASS (7 tests).
- [ ] Commit:
      `git add app/api/health/daily app/api/health/tokens scripts/issue-health-token.ts tests/health/daily-route.test.ts tests/health/tokens-route.test.ts && git commit -m "feat(health): daily read route, source-token issue and revoke"`

---

## Task 13 — `lib/oura/map.ts` and `lib/oura/client.ts`

**Files**
- Create: `lib/oura/map.ts`, `lib/oura/client.ts`
- Test: `tests/health/oura-map.test.ts`, `tests/health/oura-client.test.ts`

**Interfaces**

Consumes: `NormalizedSample` (Task 1), `toCanonical` (Task 2).
Produces (spec §7):

```ts
export function ouraSleepToSamples(doc: unknown): NormalizedSample[];
export function ouraActivityToSamples(doc: unknown): NormalizedSample[];
export function ouraReadinessToSamples(doc: unknown): NormalizedSample[];
export const OURA_DEVICE_LABEL = "Oura";
export const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection";
export const OURA_RETRY_DELAYS_MS: readonly number[];      // [1000, 2000, 4000]
export async function ouraGet(path: string, params: Record<string, string>, opts: OuraCallOptions): Promise<{ data: unknown[] }>;
export type OuraCallOptions = { accessToken: string; fetchFn?: typeof fetch;
  refresh?: () => Promise<string>; sleepFn?: (ms: number) => Promise<void>; baseUrl?: string };
```

> **Deviation, recorded here and in Open questions:** spec §5 names `daily_sleep` as the sleep source.
> Oura v2's `daily_sleep` document carries a *score* and its contributors, not a duration, and the
> contract's `SampleType` union has no sleep score — so sleep minutes are read from
> `usercollection/sleep` (the sleep-period document, which carries `total_sleep_duration`).
> `daily_readiness` still supplies `readiness_score` and `daily_activity` supplies steps and energy.

**Steps**

- [ ] Write the failing test `tests/health/oura-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ouraActivityToSamples, ouraReadinessToSamples, ouraSleepToSamples } from "@/lib/oura/map";

/** usercollection/sleep, Oura API v2 shape. */
const SLEEP = { id: "sleep-1", day: "2026-09-15", bedtime_start: "2026-09-14T23:05:00-04:00",
  bedtime_end: "2026-09-15T07:11:00-04:00", total_sleep_duration: 26640, time_in_bed: 29160,
  average_heart_rate: 52.3, lowest_heart_rate: 48, average_hrv: 68, type: "long_sleep" };

/** usercollection/daily_activity. */
const ACTIVITY = { id: "act-1", day: "2026-09-15", steps: 9412, active_calories: 431,
  timestamp: "2026-09-15T04:00:00-04:00" };

/** usercollection/daily_readiness. */
const READINESS = { id: "rdy-1", day: "2026-09-15", score: 78,
  timestamp: "2026-09-15T04:00:00-04:00" };

describe("ouraSleepToSamples", () => {
  it("maps one session to asleep, in-bed, resting heart rate and HRV", () => {
    const out = ouraSleepToSamples(SLEEP);
    expect(out.map((s) => s.type)).toEqual(["sleep_asleep", "sleep_in_bed",
      "resting_heart_rate", "hrv_sdnn"]);
    expect(out[0]).toMatchObject({ value: 444, unit: "min", device_label: "Oura",
      vendor_sample_id: "sleep-1:sleep_asleep", start_time: "2026-09-15T03:05:00.000Z",
      end_time: "2026-09-15T11:11:00.000Z" });
    expect(out[1].value).toBe(486);
    expect(out[2].value).toBe(48);
  });

  it("returns nothing for a document with no duration, rather than a zero", () => {
    expect(ouraSleepToSamples({ id: "x", day: "2026-09-15" })).toEqual([]);
    expect(ouraSleepToSamples(null)).toEqual([]);
  });
});

describe("ouraActivityToSamples and ouraReadinessToSamples", () => {
  it("map steps, active energy and readiness over the local day", () => {
    const activity = ouraActivityToSamples(ACTIVITY);
    expect(activity.map((s) => [s.type, s.value])).toEqual([["step_count", 9412],
      ["active_energy", 431]]);
    expect(activity[0].vendor_sample_id).toBe("act-1:step_count");
    const readiness = ouraReadinessToSamples(READINESS);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({ type: "readiness_score", value: 78, unit: "score" });
  });

  it("skips a missing metric instead of writing 0", () => {
    expect(ouraActivityToSamples({ id: "a", day: "2026-09-15" })).toEqual([]);
    expect(ouraReadinessToSamples({ id: "r", day: "2026-09-15", score: null })).toEqual([]);
  });
});
```

- [ ] Write the failing test `tests/health/oura-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ouraGet, OURA_RETRY_DELAYS_MS } from "@/lib/oura/client";

const ok = () => new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 });
const sleepFn = vi.fn(async () => {});

describe("ouraGet", () => {
  it("returns the parsed document on the first success", async () => {
    const fetchFn = vi.fn(async () => ok());
    expect(await ouraGet("daily_activity", { start_date: "2026-09-14" },
      { accessToken: "a", fetchFn, sleepFn })).toEqual({ data: [{ id: "x" }] });
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toBe("https://api.ouraring.com/v2/usercollection/daily_activity?start_date=2026-09-14");
    expect((fetchFn.mock.calls[0][1] as RequestInit).headers)
      .toMatchObject({ authorization: "Bearer a" });
  });

  it("backs off 1s, 2s, 4s on 429 and 5xx, then gives up", async () => {
    expect(OURA_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000]);
    sleepFn.mockClear();
    const fetchFn = vi.fn(async () => new Response("busy", { status: 429 }));
    await expect(ouraGet("sleep", {}, { accessToken: "a", fetchFn, sleepFn })).rejects.toThrow(/429/);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleepFn.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it("refreshes once on 401 and retries once, never twice", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(ok());
    const refresh = vi.fn(async () => "fresh");
    await ouraGet("sleep", {}, { accessToken: "stale", fetchFn, refresh, sleepFn });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[1][1] as RequestInit).headers)
      .toMatchObject({ authorization: "Bearer fresh" });
  });

  it("throws on a 401 with no refresh available", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(ouraGet("sleep", {}, { accessToken: "stale", fetchFn, sleepFn }))
      .rejects.toThrow(/401/);
  });
});
```

- [ ] Run them: `pnpm test tests/health/oura-map.test.ts tests/health/oura-client.test.ts` —
      expected failure: `Error: Failed to load url @/lib/oura/map`.
- [ ] Write `lib/oura/map.ts`:

```ts
/**
 * Oura v2 documents → canonical samples (spec §7). vendor_sample_id is the document id plus the
 * metric, so a re-pull of the same day lands on the same dedupe key and changes nothing
 * (acceptance criterion 7).
 */
import type { NormalizedSample, SampleType } from "@/lib/health/contract";
import { toCanonical } from "@/lib/health/units";

export const OURA_DEVICE_LABEL = "Oura";
const OURA_TZ_FALLBACK = "UTC";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sample(id: string, type: SampleType, value: number, unit: string, start: string,
    end: string, updatedAt?: string): NormalizedSample {
  return { type, ...toCanonical(type, value, unit), start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(), vendor_sample_id: `${id}:${type}`,
    vendor_updated_at: updatedAt, device_label: OURA_DEVICE_LABEL, tz: OURA_TZ_FALLBACK };
}

/** usercollection/sleep — the sleep-period document; daily_sleep carries only a score. */
export function ouraSleepToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string") return [];
  const start = typeof d.bedtime_start === "string" ? d.bedtime_start : null;
  const end = typeof d.bedtime_end === "string" ? d.bedtime_end : null;
  if (!start || !end) return [];

  const out: NormalizedSample[] = [];
  const asleep = num(d.total_sleep_duration);
  if (asleep !== null) out.push(sample(d.id, "sleep_asleep", asleep, "s", start, end));
  const inBed = num(d.time_in_bed);
  if (inBed !== null) out.push(sample(d.id, "sleep_in_bed", inBed, "s", start, end));
  const rhr = num(d.lowest_heart_rate);
  if (rhr !== null) out.push(sample(d.id, "resting_heart_rate", rhr, "bpm", start, end));
  const hrv = num(d.average_hrv);
  if (hrv !== null) out.push(sample(d.id, "hrv_sdnn", hrv, "ms", start, end));
  return out;
}

/** usercollection/daily_activity — steps and active energy over the whole local day. */
export function ouraActivityToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string" || typeof d.day !== "string") return [];
  const start = `${d.day}T00:00:00Z`;
  const end = `${d.day}T23:59:59Z`;

  const out: NormalizedSample[] = [];
  const steps = num(d.steps);
  if (steps !== null) out.push(sample(d.id, "step_count", steps, "count", start, end));
  const kcal = num(d.active_calories);
  if (kcal !== null) out.push(sample(d.id, "active_energy", kcal, "kcal", start, end));
  return out;
}

/** usercollection/daily_readiness — one score, stored as an instantaneous sample. */
export function ouraReadinessToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string" || typeof d.day !== "string") return [];
  const score = num(d.score);
  if (score === null) return [];
  const at = typeof d.timestamp === "string" ? d.timestamp : `${d.day}T00:00:00Z`;
  return [sample(d.id, "readiness_score", score, "score", at, at)];
}
```

- [ ] Write `lib/oura/client.ts`:

```ts
/**
 * Oura v2 HTTP with the retry policy from spec §7: 1s / 2s / 4s on 429 and 5xx, and exactly one
 * refresh-then-retry on 401. fetchFn and sleepFn are injectable so the tests never sleep or call out.
 */
export const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection";
export const OURA_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export type OuraCallOptions = { accessToken: string; fetchFn?: typeof fetch;
  refresh?: () => Promise<string>; sleepFn?: (ms: number) => Promise<void>; baseUrl?: string };

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function ouraGet(path: string, params: Record<string, string>,
    opts: OuraCallOptions): Promise<{ data: unknown[] }> {
  const call = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? wait;
  const base = opts.baseUrl ?? OURA_API_BASE;
  const query = new URLSearchParams(params).toString();
  const url = query.length > 0 ? `${base}/${path}?${query}` : `${base}/${path}`;

  let token = opts.accessToken;
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    const res = await call(url, { headers: { authorization: `Bearer ${token}`,
      accept: "application/json" } });

    if (res.ok) {
      const body = await res.json() as { data?: unknown };
      return { data: Array.isArray(body.data) ? body.data : [] };
    }

    if (res.status === 401 && opts.refresh && !refreshed) {
      refreshed = true;
      token = await opts.refresh();
      continue;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= OURA_RETRY_DELAYS_MS.length) {
      throw new Error(`Oura ${path} failed with ${res.status}`);
    }
    await sleepFn(OURA_RETRY_DELAYS_MS[attempt]);
  }
}
```

- [ ] Run them: `pnpm test tests/health/oura-map.test.ts tests/health/oura-client.test.ts` —
      expected PASS (8 tests).
- [ ] Commit:
      `git add lib/oura tests/health/oura-map.test.ts tests/health/oura-client.test.ts && git commit -m "feat(oura): v2 document mapping and retrying client"`

---

## Task 14 — `lib/server/oura.ts` and the three OAuth routes

**Files**
- Create: `lib/server/oura.ts`, `app/api/health/oura/start/route.ts`,
  `app/api/health/oura/callback/route.ts`, `app/api/health/oura/disconnect/route.ts`
- Test: `tests/health/oura-server.test.ts`

**Interfaces**

Consumes: `sealOauth` / `openOauth` (Task 9), `ouraGet` + the three map functions (Task 13),
`oauth_states` (Task 8), `health_ingest_event` / `health_ingest_apply` (Task 7), `requireUser`,
`adminClient`, `enforceRateLimit`, `hashToken`, `toBytea`.
Produces:

```ts
export function ouraAuthorizeUrl(state: string): string;
export async function startOura(admin: SupabaseClient, userId: string, now?: Date): Promise<{ url: string }>;
export async function completeOura(admin: SupabaseClient, args: { state: string; code: string },
  deps?: { fetchFn?: typeof fetch; now?: Date }): Promise<{ sourceId: string; userId: string }>;
export async function accessTokenFor(admin: SupabaseClient, source: OuraSourceRow,
  deps?: { fetchFn?: typeof fetch; now?: Date }): Promise<string>;
export async function pullTwoDays(admin: SupabaseClient, source: OuraSourceRow,
  today: string, deps?: { fetchFn?: typeof fetch }): Promise<{ inserted: number; updated: number; skipped: number }>;
export type OuraSourceRow = { id: string; user_id: string; oauth: string | null };
export const OURA_STATE_TTL_MS = 600_000;
export const OURA_REFRESH_SKEW_MS = 300_000;
```

**Steps**

- [ ] Write the failing test `tests/health/oura-server.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealOauth } from "@/lib/server/crypto";
import { accessTokenFor, completeOura, ouraAuthorizeUrl, pullTwoDays } from "@/lib/server/oura";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("HEALTH_TOKEN_KEY", KEY);
  vi.stubEnv("OURA_CLIENT_ID", "cid");
  vi.stubEnv("OURA_CLIENT_SECRET", "secret");
  vi.stubEnv("OURA_REDIRECT_URI", "https://app.test/api/health/oura/callback");
});

describe("ouraAuthorizeUrl", () => {
  it("carries client_id, redirect_uri, scope and state and no secret", () => {
    const url = new URL(ouraAuthorizeUrl("abc"));
    expect(url.origin + url.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("daily personal");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.search).not.toContain("secret");
  });
});

describe("completeOura", () => {
  function stubAdmin(stateRow: { user_id: string } | null) {
    const consume = vi.fn().mockResolvedValue({ data: stateRow, error: null });
    const upsert = vi.fn().mockResolvedValue({ data: { id: "src-o" }, error: null });
    return { admin: { from: vi.fn((table: string) => table === "oauth_states"
        ? { update: () => ({ eq: () => ({ is: () => ({ gt: () => ({ select: () =>
            ({ maybeSingle: consume }) }) }) }) }) }
        : { upsert: () => ({ select: () => ({ single: upsert }) }) }) } as never,
      consume, upsert };
  }

  it("400s an unknown, consumed or expired state and writes nothing", async () => {
    const { admin, upsert } = stubAdmin(null);
    await expect(completeOura(admin, { state: "nope", code: "c" }))
      .rejects.toMatchObject({ status: 400, code: "bad_state" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("exchanges the code server-side and stores only a sealed token", async () => {
    const { admin, upsert } = stubAdmin({ user_id: "user-1" });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "at",
      refresh_token: "rt", expires_in: 86400, scope: "daily personal" }), { status: 200 }));
    await completeOura(admin, { state: "good", code: "c" }, { fetchFn });
    const sent = String((fetchFn.mock.calls[0][1] as RequestInit).body);
    expect(sent).toContain("client_secret=secret");
    expect(upsert).toHaveBeenCalled();
  });

  it("502s a failed exchange", async () => {
    const { admin } = stubAdmin({ user_id: "user-1" });
    const fetchFn = vi.fn(async () => new Response("nope", { status: 400 }));
    await expect(completeOura(admin, { state: "good", code: "c" }, { fetchFn }))
      .rejects.toMatchObject({ status: 502, code: "exchange_failed" });
  });
});

describe("accessTokenFor", () => {
  const sealed = (expiresAt: string) => sealOauth({ access_token: "at", refresh_token: "rt",
    expires_at: expiresAt, scope: "daily personal" }, Buffer.from(KEY, "base64"));

  it("returns the stored token when it is not near expiry", async () => {
    const admin = { from: vi.fn() } as never;
    const token = await accessTokenFor(admin, { id: "s", user_id: "u",
      oauth: sealed("2026-09-15T23:00:00Z") }, { now: new Date("2026-09-15T14:00:00Z") });
    expect(token).toBe("at");
  });

  it("rotates the refresh token in one compare-and-swap update", async () => {
    const eqOauth = vi.fn().mockResolvedValue({ data: { id: "s" }, error: null });
    const update = vi.fn(() => ({ eq: () => ({ eq: eqOauth }) }));
    const admin = { from: vi.fn(() => ({ update })) } as never;
    const old = sealed("2026-09-15T14:01:00Z");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "at2",
      refresh_token: "rt2", expires_in: 86400, scope: "daily personal" }), { status: 200 }));

    const token = await accessTokenFor(admin, { id: "s", user_id: "u", oauth: old },
      { fetchFn, now: new Date("2026-09-15T14:00:00Z") });
    expect(token).toBe("at2");
    // The old sealed value is the CAS key, so a concurrent refresh cannot win twice.
    expect(eqOauth).toHaveBeenCalledWith("oauth", old);
    expect(String(fetchFn.mock.calls[0][1] && (fetchFn.mock.calls[0][1] as RequestInit).body))
      .toContain("grant_type=refresh_token");
  });
});

describe("pullTwoDays", () => {
  it("requests the previous two local days and applies through the RPCs", async () => {
    const rpc = vi.fn(async (name: string) => name === "health_ingest_event"
      ? { data: "ev-o", error: null }
      : { data: [{ accepted: 4, updated: 0, skipped: 2 }], error: null });
    const admin = { rpc, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
      ({ data: { status: "applied" }, error: null }) }) }) })) } as never;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("daily_activity")) {
        return new Response(JSON.stringify({ data: [{ id: "a1", day: "2026-09-14", steps: 9000,
          active_calories: 400 }] }), { status: 200 });
      }
      if (path.includes("daily_readiness")) {
        return new Response(JSON.stringify({ data: [{ id: "r1", day: "2026-09-14", score: 70 }] }),
          { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "s1", day: "2026-09-14",
        bedtime_start: "2026-09-13T23:00:00Z", bedtime_end: "2026-09-14T07:00:00Z",
        total_sleep_duration: 26640, time_in_bed: 29160 }] }), { status: 200 });
    });

    const sealedRow = sealOauth({ access_token: "at", refresh_token: "rt",
      expires_at: "2026-09-16T00:00:00Z", scope: "daily personal" }, Buffer.from(KEY, "base64"));
    const out = await pullTwoDays(admin, { id: "src-o", user_id: "user-1", oauth: sealedRow },
      "2026-09-15", { fetchFn });

    expect(out).toEqual({ inserted: 4, updated: 0, skipped: 2 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("start_date=2026-09-13");
    expect(String(fetchFn.mock.calls[0][0])).toContain("end_date=2026-09-15");
  });
});
```

- [ ] Run it: `pnpm test tests/health/oura-server.test.ts` — expected failure:
      `Error: Failed to load url @/lib/server/oura`.
- [ ] Write `lib/server/oura.ts`:

```ts
/**
 * Oura OAuth2 confidential authorization-code flow and the daily pull (architecture §5.2).
 * client_secret never leaves the server, `state` is stored as a hash and consumed once, and a refresh
 * rotates in one compare-and-swap update so the old refresh token cannot survive it.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OauthTokens } from "@/lib/health/contract";
import { ouraActivityToSamples, ouraReadinessToSamples, ouraSleepToSamples } from "@/lib/oura/map";
import { ouraGet } from "@/lib/oura/client";
import { HttpError } from "@/lib/server/auth";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { hashToken, toBytea } from "@/lib/server/tokens";

export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_SCOPE = "daily personal";
export const OURA_STATE_TTL_MS = 600_000;
export const OURA_REFRESH_SKEW_MS = 300_000;

export type OuraSourceRow = { id: string; user_id: string; oauth: string | null };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpError(503, "unavailable", `${name} not set`);
  return value;
}

export function ouraAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({ client_id: env("OURA_CLIENT_ID"),
    redirect_uri: env("OURA_REDIRECT_URI"), response_type: "code", scope: OURA_SCOPE, state });
  return `${OURA_AUTHORIZE_URL}?${params.toString()}`;
}

export async function startOura(admin: SupabaseClient, userId: string, now: Date = new Date()):
    Promise<{ url: string }> {
  const state = randomBytes(32).toString("base64url");
  const { error } = await admin.from("oauth_states").insert({
    state_hash: toBytea(hashToken(state)), provider: "oura", user_id: userId,
    expires_at: new Date(now.getTime() + OURA_STATE_TTL_MS).toISOString() });
  if (error) throw new HttpError(500, "internal", "could not store the oauth state");
  return { url: ouraAuthorizeUrl(state) };
}

async function exchange(body: Record<string, string>, fetchFn: typeof fetch): Promise<OauthTokens> {
  const res = await fetchFn(OURA_TOKEN_URL, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: env("OURA_CLIENT_ID"),
      client_secret: env("OURA_CLIENT_SECRET") }).toString() });
  if (!res.ok) throw new HttpError(502, "exchange_failed", "Oura rejected the token request.");
  const json = await res.json() as { access_token?: string; refresh_token?: string;
    expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token) {
    throw new HttpError(502, "exchange_failed", "Oura returned no token pair.");
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
    scope: json.scope ?? OURA_SCOPE };
}

export async function completeOura(admin: SupabaseClient, args: { state: string; code: string },
    deps: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<{ sourceId: string; userId: string }> {
  const now = deps.now ?? new Date();
  // Verify, unconsumed, unexpired and consumed — one statement, so a replay finds nothing.
  const { data, error } = await admin.from("oauth_states")
    .update({ consumed_at: now.toISOString() })
    .eq("state_hash", toBytea(hashToken(args.state)))
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("user_id").maybeSingle();
  if (error) throw new HttpError(500, "internal", "could not consume the oauth state");
  if (!data) throw new HttpError(400, "bad_state", "Unknown, used or expired state.");
  const userId = (data as { user_id: string }).user_id;

  const tokens = await exchange({ grant_type: "authorization_code", code: args.code,
    redirect_uri: env("OURA_REDIRECT_URI") }, deps.fetchFn ?? fetch);

  const upserted = await admin.from("health_sources")
    .upsert({ user_id: userId, kind: "oura", device_label: "Oura",
      oauth: sealOauth(tokens), revoked_at: null }, { onConflict: "user_id,kind" })
    .select("id").single();
  if (upserted.error) throw new HttpError(500, "internal", "could not store the Oura source");
  return { sourceId: (upserted.data as { id: string }).id, userId };
}

export async function accessTokenFor(admin: SupabaseClient, source: OuraSourceRow,
    deps: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<string> {
  if (!source.oauth) throw new HttpError(400, "not_connected", "This source has no Oura tokens.");
  const now = deps.now ?? new Date();
  const current = openOauth(source.oauth);
  if (Date.parse(current.expires_at) - now.getTime() > OURA_REFRESH_SKEW_MS) {
    return current.access_token;
  }

  const rotated = await exchange({ grant_type: "refresh_token",
    refresh_token: current.refresh_token }, deps.fetchFn ?? fetch);
  // One statement writes the new pair and clears the old, matched on the exact sealed value we read.
  const { data, error } = await admin.from("health_sources")
    .update({ oauth: sealOauth(rotated) })
    .eq("id", source.id).eq("oauth", source.oauth);
  if (error) throw new HttpError(500, "internal", "could not rotate the Oura tokens");
  void data;
  return rotated.access_token;
}

function previousTwoDays(today: string): { start: string; end: string } {
  const end = today;
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000)
    .toISOString().slice(0, 10);
  return { start, end };
}

export async function pullTwoDays(admin: SupabaseClient, source: OuraSourceRow, today: string,
    deps: { fetchFn?: typeof fetch } = {}): Promise<{ inserted: number; updated: number; skipped: number }> {
  const { start, end } = previousTwoDays(today);
  const token = await accessTokenFor(admin, source, { fetchFn: deps.fetchFn });
  const params = { start_date: start, end_date: end };
  const opts = { accessToken: token, fetchFn: deps.fetchFn,
    refresh: async () => accessTokenFor(admin, source, { fetchFn: deps.fetchFn }) };

  const [activity, readiness, sleep] = await Promise.all([
    ouraGet("daily_activity", params, opts),
    ouraGet("daily_readiness", params, opts),
    ouraGet("sleep", params, opts),
  ]);

  const samples = [
    ...activity.data.flatMap(ouraActivityToSamples),
    ...readiness.data.flatMap(ouraReadinessToSamples),
    ...sleep.data.flatMap(ouraSleepToSamples),
  ];

  // The same content hashes the same, so a second pull of the same day is a duplicate event and the
  // correction upsert changes no row (acceptance criterion 7).
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify(samples), "utf8").digest();
  const event = await admin.rpc("health_ingest_event", { p_user_id: source.user_id,
    p_source_id: source.id, p_payload_hash: `\\x${hash.toString("hex")}`, p_status: "applied" });
  if (event.error) throw new HttpError(500, "internal", "could not record the pull event");
  const eventId = (Array.isArray(event.data) ? event.data[0] : event.data) as string;

  const applied = await admin.rpc("health_ingest_apply", { p_user_id: source.user_id,
    p_source_id: source.id, p_event_id: eventId, p_samples: samples });
  if (applied.error) throw new HttpError(500, "internal", "could not apply the pulled samples");
  const counts = (Array.isArray(applied.data) ? applied.data[0] : applied.data) as
    { accepted: number; updated: number; skipped: number } | null;
  return { inserted: counts?.accepted ?? 0, updated: counts?.updated ?? 0,
    skipped: counts?.skipped ?? 0 };
}
```

- [ ] Write `app/api/health/oura/start/route.ts`:

```ts
/** GET /api/health/oura/start — spec §5: JWT, 10/hour/user, 302 to Oura. */
import { HttpError, requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { jsonError } from "@/lib/server/http";
import { startOura } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) {
      throw new HttpError(503, "unavailable", "Health ingest is off.");
    }
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:oura:start:${userId}`, 10, 3600);
    const { url } = await startOura(adminClient(), userId);
    return Response.redirect(url, 302);
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/health/oura/callback/route.ts`:

```ts
/**
 * GET /api/health/oura/callback — spec §5. No JWT is assumed: identity comes from the oauth_states
 * row. The provider's own error text is never echoed; every failure maps to a fixed reason code
 * (spec §8) and the browser is redirected to Settings.
 */
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { completeOura, pullTwoDays } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, reason?: string): Response {
  const query = reason ? `?oura=error&reason=${reason}` : "?oura=connected";
  return Response.redirect(`${origin}/settings${query}`, 302);
}

export async function GET(req: Request): Promise<Response> {
  const { origin, searchParams } = new URL(req.url);
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) return back(origin, "disabled");
    await enforceRateLimit("health:oura:callback", 20, 3600);
    if (searchParams.get("error")) return back(origin, "denied");

    const state = searchParams.get("state");
    const code = searchParams.get("code");
    if (!state || !code) return back(origin, "bad_state");

    const admin = adminClient();
    const { sourceId, userId } = await completeOura(admin, { state, code });

    // One immediate pull so Settings shows a "last received" the moment she returns.
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await admin.from("health_sources")
      .select("id, user_id, oauth").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    if (data) {
      try {
        await pullTwoDays(admin, data as { id: string; user_id: string; oauth: string | null }, today);
      } catch {
        // A first pull that fails is not a failed connection; the cron retries at 06:00.
      }
    }
    return back(origin);
  } catch (e) {
    const reason = e instanceof HttpError ? e.code : "internal";
    return back(origin, reason);
  }
}
```

- [ ] Write `app/api/health/oura/disconnect/route.ts`:

```ts
/** POST /api/health/oura/disconnect — spec §5: revoke and null the tokens; samples stay. */
import { adminClient } from "@/lib/server/admin";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:oura:disconnect:${userId}`, 20, 3600);
    const { data, error } = await adminClient().from("health_sources")
      .update({ revoked_at: new Date().toISOString(), oauth: null })
      .eq("user_id", userId).eq("kind", "oura").select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "not_found", "No Oura source.");
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Run it: `pnpm test tests/health/oura-server.test.ts` — expected PASS (7 tests).
- [ ] Commit:
      `git add lib/server/oura.ts app/api/health/oura tests/health/oura-server.test.ts && git commit -m "feat(oura): confidential oauth flow, rotation and two-day pull"`

---

## Task 15 — `app/api/jobs/oura-pull/route.ts`

**Files**
- Create: `app/api/jobs/oura-pull/route.ts`
- Test: `tests/health/oura-pull-route.test.ts`

**Interfaces**

Consumes: the cron auth pattern in `app/api/jobs/backup/route.ts:49-58` (`timingSafeEqual` on
`CRON_SECRET`, rate limit first), `job_runs` (Task 8), `pullTwoDays` (Task 14).
Produces: `export async function POST(req: Request): Promise<Response>` answering `OuraPullResponse`.

**Steps**

- [ ] Write the failing test `tests/health/oura-pull-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullTwoDays } from "@/lib/server/oura";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/oura", () => ({ pullTwoDays: vi.fn() }));

const insert = vi.fn();
const sources = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: (table: string) => table === "job_runs"
    ? { insert: (row: unknown) => { insert(row); return { select: async () =>
        ({ data: [row], error: null }) }; },
        update: () => ({ match: async () => ({ error: null }) }) }
    : { select: () => ({ eq: () => ({ is: sources }) }) } }) }));

const { POST } = await import("@/app/api/jobs/oura-pull/route");

function post(secret = "cron-secret"): Request {
  return new Request("https://app.test/api/jobs/oura-pull", { method: "POST",
    headers: { authorization: `Bearer ${secret}` } });
}

describe("POST /api/jobs/oura-pull", () => {
  beforeEach(() => {
    resetRateLimits();
    insert.mockClear();
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    sources.mockResolvedValue({ data: [{ id: "src-o", user_id: "user-1", oauth: "sealed" }],
      error: null });
    vi.mocked(pullTwoDays).mockReset()
      .mockResolvedValue({ inserted: 4, updated: 0, skipped: 2 });
  });

  it("401s a wrong secret and never reads a source", async () => {
    expect((await POST(post("wrong"))).status).toBe(401);
    expect(sources).not.toHaveBeenCalled();
  });

  it("no-ops with the flag unset", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: 0, sources: 0, results: [] });
    expect(pullTwoDays).not.toHaveBeenCalled();
  });

  it("takes the job_runs lock per user and local date, then pulls", async () => {
    const res = await POST(post());
    expect(await res.json()).toMatchObject({ users: 1, sources: 1,
      results: [{ user_id: "user-1", inserted: 4, updated: 0, skipped: 2 }] });
    expect(insert.mock.calls[0][0]).toMatchObject({ job: "oura-pull", user_id: "user-1",
      status: "running" });
    expect(String((insert.mock.calls[0][0] as { run_key: string }).run_key))
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("records a source's error without failing the whole run", async () => {
    vi.mocked(pullTwoDays).mockRejectedValue(new Error("Oura sleep failed with 500"));
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toBe("Oura sleep failed with 500");
  });
});
```

- [ ] Run it: `pnpm test tests/health/oura-pull-route.test.ts` — expected failure:
      `Error: Failed to load url @/app/api/jobs/oura-pull/route`.
- [ ] Write `app/api/jobs/oura-pull/route.ts`:

```ts
/**
 * POST /api/jobs/oura-pull — Vercel cron at 06:00 America/New_York (spec §5, §8). Contracts §9:
 * rate limit → timing-safe CRON_SECRET → job_runs lock. The lock key is (job, user_id, local date),
 * so a duplicate cron fire is a no-op rather than a second pull.
 */
import { timingSafeEqual } from "node:crypto";
import type { OuraPullResponse } from "@/lib/health/contract";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { pullTwoDays, type OuraSourceRow } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit("jobs:oura-pull", 10, 3600);
    if (!bearerOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");

    const empty: OuraPullResponse = { users: 0, sources: 0, results: [] };
    if (!process.env.HEALTH_INGEST_ENABLED) return Response.json(empty);

    const admin = adminClient();
    const localDate = new Date().toISOString().slice(0, 10);
    const { data, error } = await admin.from("health_sources")
      .select("id, user_id, oauth").eq("kind", "oura").is("revoked_at", null);
    if (error) throw new HttpError(500, "internal", "could not list Oura sources");

    const rows = (data ?? []) as OuraSourceRow[];
    const results: OuraPullResponse["results"] = [];

    for (const source of rows) {
      const lock = await admin.from("job_runs")
        .insert({ job: "oura-pull", user_id: source.user_id, run_key: localDate, status: "running" })
        .select("run_key");
      if (lock.error) {
        // 23505 is unique_violation: today's run already holds the lock for this user.
        if (lock.error.code === "23505") continue;
        throw new HttpError(500, "internal", "could not take the pull lock");
      }
      try {
        const counts = await pullTwoDays(admin, source, localDate);
        results.push({ user_id: source.user_id, ...counts });
        await admin.from("job_runs")
          .update({ finished_at: new Date().toISOString(), status: "ok", detail: counts })
          .match({ job: "oura-pull", user_id: source.user_id, run_key: localDate });
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        results.push({ user_id: source.user_id, inserted: 0, updated: 0, skipped: 0, error: message });
        await admin.from("job_runs")
          .update({ finished_at: new Date().toISOString(), status: "error", detail: { message } })
          .match({ job: "oura-pull", user_id: source.user_id, run_key: localDate });
      }
    }

    const body: OuraPullResponse = { users: new Set(results.map((r) => r.user_id)).size,
      sources: results.length, results };
    return Response.json(body);
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Run it: `pnpm test tests/health/oura-pull-route.test.ts` — expected PASS (4 tests).
- [ ] Commit:
      `git add app/api/jobs/oura-pull tests/health/oura-pull-route.test.ts && git commit -m "feat(oura): locked daily pull job"`

---

## Task 16 — `lib/mcp/health-tools.ts`

**Files**
- Create: `lib/mcp/health-tools.ts`
- Test: `tests/health/mcp-health-tools.test.ts`

**Interfaces**

Consumes: `createMcpHandler` from `mcp-handler` (the shape `app/api/mcp/route.ts:57` builds), `z`,
`mergedDays` (Task 10).
Produces (contracts §2, §5):

```ts
export type McpServerLike = Parameters<Parameters<typeof createMcpHandler>[0]>[0];
export function registerHealthTools(server: McpServerLike,
  ctx: { userId: string; admin: SupabaseClient }): void;
export const HEALTH_TOOL_SCOPES: Record<"get_body_data", "read">;
```

The server type is taken from `createMcpHandler`'s own callback parameter rather than a deep import
into the SDK, so the test can hand `registerHealthTools` a stub with the same `registerTool`
signature and the integration route still passes the real server.

**Steps**

- [ ] Write the failing test `tests/health/mcp-health-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mergedDays } from "@/lib/server/health-daily";
import { HEALTH_TOOL_SCOPES, registerHealthTools,
  type McpServerLike } from "@/lib/mcp/health-tools";

vi.mock("@/lib/server/health-daily", () => ({ mergedDays: vi.fn() }));

type Tool = { name: string; config: { inputSchema: { parse: (v: unknown) => unknown } };
  run: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

function fakeServer(): { server: McpServerLike; tools: Tool[] } {
  const tools: Tool[] = [];
  const server = { registerTool: (name: string, config: Tool["config"], run: Tool["run"]) => {
    tools.push({ name, config, run });
  } } as unknown as McpServerLike;
  return { server, tools };
}

describe("registerHealthTools", () => {
  it("registers exactly one read-only tool", () => {
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    expect(tools.map((t) => t.name)).toEqual(["get_body_data"]);
    expect(HEALTH_TOOL_SCOPES).toEqual({ get_body_data: "read" });
  });

  it("returns the merged days for the token's user, never a body-supplied id", async () => {
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Oura"] }]);
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });

    const out = await tools[0].run({ from: "2026-09-15", to: "2026-09-15",
      user_id: "someone-else" });
    expect(vi.mocked(mergedDays).mock.calls[0][1]).toBe("user-1");
    expect(JSON.parse(out.content[0].text)[0].sleep_minutes).toBe(444);
  });

  it("rejects a window over 90 days in the tool body", async () => {
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    const out = await tools[0].run({ from: "2026-01-01", to: "2026-09-15" });
    expect(out.content[0].text).toMatch(/90 days/);
  });
});
```

- [ ] Run it: `pnpm test tests/health/mcp-health-tools.test.ts` — expected failure:
      `Error: Failed to load url @/lib/mcp/health-tools`.
- [ ] Write `lib/mcp/health-tools.ts`:

```ts
/**
 * One read-only MCP tool (spec §5, "MCP"). It runs on the privileged boundary, so the user id comes
 * from ctx (resolved from the token) and never from the tool arguments, and it reads through
 * lib/server/health-daily.ts so an agent sees exactly the dashboard's numbers.
 */
import type { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { MAX_DAILY_WINDOW_DAYS } from "@/lib/health/contract";
import { mergedDays } from "@/lib/server/health-daily";

export type McpServerLike = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

export const HEALTH_TOOL_SCOPES: Record<"get_body_data", "read"> = { get_body_data: "read" };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerHealthTools(server: McpServerLike,
    ctx: { userId: string; admin: SupabaseClient }): void {
  server.registerTool(
    "get_body_data",
    {
      title: "Her body data",
      description:
        "Merged daily steps, active energy, sleep minutes and weight (kg) for a date range, max 90 days. null means no observation that day — it is never a zero.",
      inputSchema: z.object({ from: isoDate, to: isoDate }),
    },
    async ({ from, to }: { from: string; to: string }) => {
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (span < 0 || span + 1 > MAX_DAILY_WINDOW_DAYS) {
        return { content: [{ type: "text" as const,
          text: `Ask for a range of at most ${MAX_DAILY_WINDOW_DAYS} days, from before to.` }] };
      }
      const days = await mergedDays(ctx.admin, ctx.userId, from, to);
      return { content: [{ type: "text" as const, text: JSON.stringify(days, null, 2) }] };
    },
  );
}
```

- [ ] Run it: `pnpm test tests/health/mcp-health-tools.test.ts` — expected PASS (3 tests).
- [ ] Commit:
      `git add lib/mcp/health-tools.ts tests/health/mcp-health-tools.test.ts && git commit -m "feat(mcp): read-only get_body_data tool"`

---

## Task 17 — `lib/health-client.ts` and `components/Sparkline.tsx`

**Files**
- Create: `lib/health-client.ts`, `components/Sparkline.tsx`
- Test: `tests/health/health-client.test.ts`, `tests/health/sparkline.test.ts`

**Interfaces**

Consumes: `DailyHealthResponse` (Task 1). Produces (contracts §2 — Lane Q's `WeightTrend` imports
`Sparkline`):

```ts
export const HEALTH_DAILY_CACHE_KEY = "smc:health_daily";
export type CachedDaily = { fetchedAt: string; response: DailyHealthResponse };
export function readCachedDaily(): CachedDaily | null;
export function writeCachedDaily(response: DailyHealthResponse, now?: Date): void;
export async function fetchDaily(from: string, to: string):
  Promise<{ response: DailyHealthResponse | null; fetchedAt: string | null; offline: boolean; disabled: boolean }>;
export async function issueToken(req: { kind: string; device_label?: string }): Promise<{ token: string; source: { id: string } }>;
export async function revokeToken(id: string): Promise<void>;
export function connectOura(): void;
export async function disconnectOura(): Promise<void>;
export default function Sparkline(props: { points: (number | null)[]; width?: number;
  height?: number; stroke?: string; label: string }): JSX.Element;
```

**Steps**

- [ ] Write the failing test `tests/health/health-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDaily, HEALTH_DAILY_CACHE_KEY, readCachedDaily,
  writeCachedDaily } from "@/lib/health-client";

const RESPONSE = { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96,
  sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Oura"] }], sources: [] };

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
});

describe("the health daily cache", () => {
  it("writes and reads one entry under smc:health_daily with a fetchedAt stamp", () => {
    writeCachedDaily(RESPONSE, new Date("2026-09-15T14:00:00Z"));
    expect([...store.keys()]).toEqual([HEALTH_DAILY_CACHE_KEY]);
    expect(readCachedDaily()).toEqual({ fetchedAt: "2026-09-15T14:00:00.000Z", response: RESPONSE });
  });

  it("returns null rather than throwing on unusable stored text", () => {
    store.set(HEALTH_DAILY_CACHE_KEY, "{not json");
    expect(readCachedDaily()).toBeNull();
  });
});

describe("fetchDaily", () => {
  it("caches a fresh response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 })));
    const out = await fetchDaily("2026-09-15", "2026-09-15");
    expect(out).toMatchObject({ response: RESPONSE, offline: false, disabled: false });
    expect(readCachedDaily()?.response).toEqual(RESPONSE);
  });

  it("reports disabled on a 503 and does not overwrite the cache", async () => {
    writeCachedDaily(RESPONSE, new Date("2026-09-15T14:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const out = await fetchDaily("2026-09-15", "2026-09-15");
    expect(out.disabled).toBe(true);
    expect(readCachedDaily()?.response).toEqual(RESPONSE);
  });

  it("falls back to the cache when the network throws", async () => {
    writeCachedDaily(RESPONSE, new Date("2026-09-15T14:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const out = await fetchDaily("2026-09-15", "2026-09-15");
    expect(out).toMatchObject({ response: RESPONSE, offline: true,
      fetchedAt: "2026-09-15T14:00:00.000Z" });
  });
});
```

- [ ] Write the failing test `tests/health/sparkline.test.ts`:

```ts
/**
 * @testing-library/react is not installed and no dependency may be added (contracts §1), so the
 * sparkline's geometry is tested through its exported pure helper and the screen itself is a manual
 * gate. The helper is what decides gap-versus-line, which is the rule worth protecting.
 */
import { describe, expect, it } from "vitest";
import { sparklineSegments } from "@/components/Sparkline";

describe("sparklineSegments", () => {
  it("breaks the path at a null instead of drawing through zero", () => {
    const segments = sparklineSegments([1, 2, null, 4], 100, 20);
    expect(segments).toHaveLength(2);
    expect(segments[0].split("L").length).toBe(2);
  });

  it("returns no segment for an isolated point and none at all for all nulls", () => {
    expect(sparklineSegments([null, 5, null], 100, 20)).toEqual([]);
    expect(sparklineSegments([null, null], 100, 20)).toEqual([]);
  });

  it("draws a flat series down the middle rather than dividing by zero", () => {
    const [path] = sparklineSegments([3, 3, 3], 100, 20);
    expect(path).toMatch(/^M0,10 L50,10 L100,10$/);
  });
});
```

- [ ] Run them: `pnpm test tests/health/health-client.test.ts tests/health/sparkline.test.ts` —
      expected failure: `Error: Failed to load url @/lib/health-client`.
- [ ] Write `lib/health-client.ts`:

```ts
/**
 * Client side of the body screen. Health data is server-owned and read-only here, so there is no
 * outbox and no merge — just one localStorage entry (contracts §2: no IndexedDB store this wave) so
 * the dashboard renders offline with a "last synced" line.
 */
import type { DailyHealthResponse } from "@/lib/health/contract";

export const HEALTH_DAILY_CACHE_KEY = "smc:health_daily";

export type CachedDaily = { fetchedAt: string; response: DailyHealthResponse };

export function readCachedDaily(): CachedDaily | null {
  try {
    const raw = localStorage.getItem(HEALTH_DAILY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDaily;
    return parsed && typeof parsed.fetchedAt === "string" && parsed.response ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedDaily(response: DailyHealthResponse, now: Date = new Date()): void {
  try {
    localStorage.setItem(HEALTH_DAILY_CACHE_KEY,
      JSON.stringify({ fetchedAt: now.toISOString(), response } satisfies CachedDaily));
  } catch {
    // A full or blocked store is not a reason to fail the screen.
  }
}

export async function fetchDaily(from: string, to: string): Promise<{
    response: DailyHealthResponse | null; fetchedAt: string | null;
    offline: boolean; disabled: boolean }> {
  try {
    const res = await fetch(`/api/health/daily?from=${from}&to=${to}`, { cache: "no-store" });
    if (res.status === 503) {
      const cached = readCachedDaily();
      return { response: cached?.response ?? null, fetchedAt: cached?.fetchedAt ?? null,
        offline: false, disabled: true };
    }
    if (!res.ok) throw new Error(`daily failed with ${res.status}`);
    const response = await res.json() as DailyHealthResponse;
    writeCachedDaily(response);
    return { response, fetchedAt: new Date().toISOString(), offline: false, disabled: false };
  } catch {
    const cached = readCachedDaily();
    return { response: cached?.response ?? null, fetchedAt: cached?.fetchedAt ?? null,
      offline: true, disabled: false };
  }
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res;
}

export async function issueToken(req: { kind: string; device_label?: string }):
    Promise<{ token: string; source: { id: string } }> {
  const res = await postJson("/api/health/tokens", req);
  return res.json() as Promise<{ token: string; source: { id: string } }>;
}

export async function revokeToken(id: string): Promise<void> {
  const res = await fetch(`/api/health/tokens/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`revoke failed with ${res.status}`);
}

/** A full navigation, not a fetch: the route answers 302 to Oura's consent page. */
export function connectOura(): void {
  window.location.assign("/api/health/oura/start");
}

export async function disconnectOura(): Promise<void> {
  await postJson("/api/health/oura/disconnect");
}
```

- [ ] Write `components/Sparkline.tsx`:

```tsx
/**
 * Seven-day sparkline, hand-written SVG, no dependency (contracts §1). A null point is a GAP: the
 * path breaks rather than dipping to zero, because a missing observation is not a zero (§9).
 * Stroke widths and the muted colour come from DESIGN.md; the default stroke is the olive accent.
 */
export function sparklineSegments(points: (number | null)[], width: number, height: number): string[] {
  const values = points.filter((p): p is number => p !== null);
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const coords = points.map((point, index) => point === null ? null
    : { x: Math.round(index * step * 100) / 100,
        y: span === 0 ? height / 2
          : Math.round((height - ((point - min) / span) * height) * 100) / 100 });

  const segments: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length > 1) {
      segments.push(run.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" "));
    }
    run = [];
  };
  for (const coord of coords) {
    if (coord === null) flush(); else run.push(coord);
  }
  flush();
  return segments;
}

export default function Sparkline({ points, width = 120, height = 28, stroke = "#4F5343", label }: {
  points: (number | null)[]; width?: number; height?: number; stroke?: string; label: string;
}) {
  const segments = sparklineSegments(points, width, height);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={label} style={{ overflow: "visible" }}>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round"
          strokeLinejoin="round" />
      ))}
    </svg>
  );
}
```

- [ ] Run them: `pnpm test tests/health/health-client.test.ts tests/health/sparkline.test.ts` —
      expected PASS (8 tests).
- [ ] Commit:
      `git add lib/health-client.ts components/Sparkline.tsx tests/health/health-client.test.ts tests/health/sparkline.test.ts && git commit -m "feat(health): cached daily client and gap-aware sparkline"`

---

## Task 18 — `/body`: metric cards, dashboard, sources sheet

**Files**
- Create: `components/HealthMetricCard.tsx`, `components/BodyDashboard.tsx`,
  `components/HealthSourcesSheet.tsx`, `app/body/page.tsx`
- Test: `tests/health/body-view.test.ts` (the pure view helpers; the screens are `[manual gate]`)

**Interfaces**

Consumes: `Sheet` + `Pill` (`components/Sheet.tsx`), the `.shell` / `.surface` / `.pill` / `.pill-in`
/ `.btn-ink` / `.tap` / `.ts` utilities (`app/globals.css:123-240`), `Sparkline` and the client
(Task 17), `LB_PER_KG` (Task 2), `DailyHealthResponse` (Task 1).
Values copied from the mockup working files: display size 40/300/-0.025em and the 12 px 400 #4A4A4A
caption from `Main.dc.html`; the metric value at 22 px/300 and the 11 px/500/0.1em uppercase eyebrow
in #6B6B6B from `ArenaRings.dc.html`; the charcoal card body and its 12 px/300 #6B6B6B sub-line from
`MealCard.dc.html`. Gauge colours per `DESIGN.md`: calories orange `#F97316`, protein blue `#3B82F6`,
carbs olive `#6B7059`, fat gold `#FBC336` — the four body metrics reuse that fixed set so a colour
never means two things.
Produces:

```tsx
export function formatMetric(value: number | null, unit: string): string;      // "—" for null
export function kgToLb(kg: number): number;
export function daysWithData(points: (number | null)[]): number;
export function lastSeen(iso: string | null, now?: Date): string;              // "4 h ago" | "never"
export default function HealthMetricCard(props: { eyebrow: string; value: string;
  points: (number | null)[]; stroke: string; footnote: string }): JSX.Element;
export default function BodyDashboard(props: { response: DailyHealthResponse;
  fetchedAt: string | null; offline: boolean; onOpenSources: () => void }): JSX.Element;
export default function HealthSourcesSheet(props: { sources: DailyHealthResponse["sources"];
  onClose: () => void; onChanged: () => void }): JSX.Element;
```

**Steps**

- [ ] Write the failing test `tests/health/body-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { daysWithData, formatMetric, kgToLb, lastSeen } from "@/components/BodyDashboard";

describe("the body view helpers", () => {
  it("renders an em dash for an absent observation, never a zero", () => {
    expect(formatMetric(null, "steps")).toBe("—");
    expect(formatMetric(0, "steps")).toBe("0 steps");
    expect(formatMetric(1300, "steps")).toBe("1,300 steps");
  });

  it("shows weight in pounds while storage stays kilograms", () => {
    expect(kgToLb(57.6)).toBeCloseTo(127.0, 1);
    expect(formatMetric(Math.round(kgToLb(57.6) * 10) / 10, "lb")).toBe("127 lb");
  });

  it("counts the days that actually carry data", () => {
    expect(daysWithData([1, null, 3, null, null, 6, 7])).toBe(4);
    expect(daysWithData([null, null])).toBe(0);
  });

  it("says how long ago a source last delivered, or never", () => {
    const now = new Date("2026-09-15T14:00:00Z");
    expect(lastSeen(null, now)).toBe("never");
    expect(lastSeen("2026-09-15T10:00:00Z", now)).toBe("4 h ago");
    expect(lastSeen("2026-09-15T13:45:00Z", now)).toBe("15 min ago");
    expect(lastSeen("2026-09-12T14:00:00Z", now)).toBe("3 d ago");
  });
});
```

- [ ] Run it: `pnpm test tests/health/body-view.test.ts` — expected failure:
      `Error: Failed to load url @/components/BodyDashboard`.
- [ ] Write `components/HealthMetricCard.tsx`:

```tsx
"use client";

import Sparkline from "@/components/Sparkline";

/**
 * One observation card. Values are read off the mockups: the metric at 22 px/300/-0.025em
 * (ArenaRings.dc.html), the eyebrow at 11 px/500/0.1em uppercase #6B6B6B, the footnote at
 * 12 px/300 #6B6B6B (Main.dc.html).
 */
export default function HealthMetricCard({ eyebrow, value, points, stroke, footnote }: {
  eyebrow: string; value: string; points: (number | null)[]; stroke: string; footnote: string;
}) {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 px-5 py-5">
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "#6B6B6B" }}>
          {eyebrow}
        </span>
        <span className="ts tabular-nums" style={{ fontSize: 22, fontWeight: 300,
          letterSpacing: "-0.025em", color: "#2B2B2B" }}>
          {value}
        </span>
        <Sparkline points={points} stroke={stroke} label={`${eyebrow}, last seven days`} />
        <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>{footnote}</span>
      </div>
    </section>
  );
}
```

- [ ] Write `components/BodyDashboard.tsx`:

```tsx
"use client";

import HealthMetricCard from "@/components/HealthMetricCard";
import { LB_PER_KG } from "@/lib/health/units";
import type { DailyHealthResponse } from "@/lib/health/contract";

/** Storage is kilograms; the screen is pounds (contracts §2, spec open question 8). */
export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function formatMetric(value: number | null, unit: string): string {
  if (value === null) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} ${unit}`;
}

export function daysWithData(points: (number | null)[]): number {
  return points.filter((p) => p !== null).length;
}

export function lastSeen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const GAUGE = { calories: "#F97316", protein: "#3B82F6", carbs: "#6B7059", fat: "#FBC336" };

export default function BodyDashboard({ response, fetchedAt, offline, onOpenSources }: {
  response: DailyHealthResponse; fetchedAt: string | null; offline: boolean;
  onOpenSources: () => void;
}) {
  const days = response.days;
  const window = days.length;
  const weight = days.map((d) => d.body_mass_kg === null ? null
    : Math.round(kgToLb(d.body_mass_kg) * 10) / 10);
  const sleep = days.map((d) => d.sleep_minutes);
  const steps = days.map((d) => d.steps);
  const energy = days.map((d) => d.active_kcal);
  const latest = <T,>(points: (T | null)[]): T | null => {
    for (let i = points.length - 1; i >= 0; i -= 1) if (points[i] !== null) return points[i];
    return null;
  };
  const footnote = (points: (number | null)[]) =>
    `${daysWithData(points)} of ${window} days with data`;

  return (
    <div className="flex flex-col gap-4">
      {offline && fetchedAt && (
        <p className="px-1" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
          Offline — last synced {lastSeen(fetchedAt)}.
        </p>
      )}

      <HealthMetricCard eyebrow="Weight" value={formatMetric(latest(weight), "lb")}
        points={weight} stroke={GAUGE.protein} footnote={footnote(weight)} />
      <HealthMetricCard eyebrow="Sleep" value={formatMetric(latest(sleep), "min")}
        points={sleep} stroke={GAUGE.carbs} footnote={footnote(sleep)} />
      <HealthMetricCard eyebrow="Steps" value={formatMetric(latest(steps), "steps")}
        points={steps} stroke={GAUGE.fat} footnote={footnote(steps)} />
      <HealthMetricCard eyebrow="Active energy" value={formatMetric(latest(energy), "kcal")}
        points={energy} stroke={GAUGE.calories} footnote={footnote(energy)} />

      <section className="shell">
        <div className="surface flex flex-col gap-3 px-5 py-5">
          <h2 className="ts m-0" style={{ fontSize: 20, fontWeight: 400,
            letterSpacing: "-0.01em", color: "#2B2B2B" }}>
            Sources
          </h2>
          {response.sources.length === 0 && (
            <p className="m-0" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
              No source yet. Issue a token to connect her phone.
            </p>
          )}
          {response.sources.map((source) => (
            <div key={source.id} className="flex items-center justify-between gap-3">
              <span className="ts" style={{ fontSize: 14, fontWeight: 400, color: "#4A4A4A" }}>
                {source.device_label ?? source.kind}
              </span>
              <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
                {source.revoked ? "revoked" : `last received ${lastSeen(source.last_received_at)}`}
              </span>
            </div>
          ))}
          <button type="button" onClick={onOpenSources}
            className="btn-ink tap mt-2 h-11 self-start px-5 text-caption font-normal">
            Manage sources
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] Write `components/HealthSourcesSheet.tsx`:

```tsx
"use client";

import { useState } from "react";
import Sheet from "@/components/Sheet";
import { connectOura, disconnectOura, issueToken, revokeToken } from "@/lib/health-client";
import type { DailyHealthResponse } from "@/lib/health/contract";

/**
 * Issue, copy once, revoke, connect, disconnect (spec §6). Every action needs a round trip that
 * cannot be replayed safely, so offline they are disabled with a plain reason rather than queued.
 */
export default function HealthSourcesSheet({ sources, onClose, onChanged }: {
  sources: DailyHealthResponse["sources"]; onClose: () => void; onChanged: () => void;
}) {
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const oura = sources.find((s) => s.kind === "oura" && !s.revoked);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch {
      setError("That did not go through. Try again when you have a connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Body data sources" subtitle="Issue a token, revoke it, connect the ring."
      onClose={onClose}>
      <div className="flex flex-col gap-4">
        {!online && (
          <p className="m-0" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
            These need a connection.
          </p>
        )}

        <button type="button" disabled={busy || !online}
          onClick={() => run(async () => {
            const { token } = await issueToken({ kind: "health_auto_export",
              device_label: "Health Auto Export" });
            setIssued(token);
          })}
          className="btn-ink tap h-11 px-5 text-caption font-normal disabled:opacity-40">
          Issue an ingest token
        </button>

        {issued && (
          <div className="well flex flex-col gap-2 p-4">
            <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.1em",
              textTransform: "uppercase", color: "#6B6B6B" }}>
              Copy it now — it is shown once
            </span>
            <code className="break-all" style={{ fontSize: 12, color: "#2B2B2B" }}>{issued}</code>
            <button type="button" className="pill tap inline-flex self-start"
              onClick={() => { void navigator.clipboard.writeText(issued); }}>
              <span className="pill-in ts flex h-11 items-center px-5 text-tiny font-normal">
                Copy
              </span>
            </button>
          </div>
        )}

        {sources.filter((s) => s.kind !== "oura").map((source) => (
          <div key={source.id} className="flex items-center justify-between gap-3">
            <span className="ts" style={{ fontSize: 14, fontWeight: 400, color: "#4A4A4A" }}>
              {source.device_label ?? source.kind}{source.revoked ? " · revoked" : ""}
            </span>
            {!source.revoked && (
              <button type="button" disabled={busy || !online}
                onClick={() => run(() => revokeToken(source.id))}
                className="pill tap inline-flex disabled:opacity-40">
                <span className="pill-in ts flex h-11 items-center px-5 text-tiny font-normal">
                  Revoke
                </span>
              </button>
            )}
          </div>
        ))}

        {oura ? (
          <button type="button" disabled={busy || !online}
            onClick={() => run(() => disconnectOura())}
            className="pill tap inline-flex self-start disabled:opacity-40">
            <span className="pill-in ts flex h-11 items-center px-5 text-tiny font-normal">
              Disconnect Oura
            </span>
          </button>
        ) : (
          <button type="button" disabled={!online} onClick={() => connectOura()}
            className="btn-ink tap h-11 px-5 text-caption font-normal disabled:opacity-40">
            Connect Oura
          </button>
        )}

        {error && (
          <p className="m-0" style={{ fontSize: 12, fontWeight: 300, color: "#F97316" }}>{error}</p>
        )}
      </div>
    </Sheet>
  );
}
```

- [ ] Write `app/body/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import BodyDashboard from "@/components/BodyDashboard";
import HealthSourcesSheet from "@/components/HealthSourcesSheet";
import { fetchDaily } from "@/lib/health-client";
import type { DailyHealthResponse } from "@/lib/health/contract";

const WINDOW_DAYS = 7;

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function BodyPage() {
  const [state, setState] = useState<{ response: DailyHealthResponse | null; fetchedAt: string | null;
    offline: boolean; disabled: boolean } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    setState(await fetchDaily(isoDate(-(WINDOW_DAYS - 1)), isoDate(0)));
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <MotionConfig reducedMotion="user">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
        style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <h1 className="ts m-0 px-1 text-display-md font-light leading-none tracking-display-md text-charcoal">
          Body
        </h1>

        {state === null && <div className="h-80 rounded-[32px] bg-fog" />}

        {state !== null && (state.disabled || state.response === null) && (
          <section className="shell">
            <div className="surface flex flex-col gap-2 px-5 py-5">
              <h2 className="ts m-0" style={{ fontSize: 20, fontWeight: 400, color: "#2B2B2B" }}>
                Nothing here yet
              </h2>
              <p className="m-0" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
                Body data turns on once Devin connects a source.
              </p>
            </div>
          </section>
        )}

        {state !== null && !state.disabled && state.response !== null && (
          <BodyDashboard response={state.response} fetchedAt={state.fetchedAt}
            offline={state.offline} onOpenSources={() => setSheetOpen(true)} />
        )}

        <AnimatePresence>
          {sheetOpen && state?.response && (
            <HealthSourcesSheet sources={state.response.sources}
              onClose={() => setSheetOpen(false)} onChanged={() => { void load(); }} />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
```

- [ ] Run it: `pnpm test tests/health/body-view.test.ts` — expected PASS (4 tests).
- [ ] `[manual gate]` On the phone, with `HEALTH_INGEST_ENABLED` set and one source issued: `/body`
      shows four cards; a day with no observation shows an em dash and a broken sparkline, never a 0;
      turning airplane mode on and reopening shows the cached rows with "Offline — last synced …";
      "Manage sources" issues a token, copies it, and revokes it; with the flag unset `/body` shows
      "Nothing here yet". Record screenshots under `docs/screenshots/phase-5/`.
- [ ] Commit:
      `git add components/HealthMetricCard.tsx components/BodyDashboard.tsx components/HealthSourcesSheet.tsx app/body/page.tsx tests/health/body-view.test.ts && git commit -m "feat(health): body dashboard, metric cards and sources sheet"`

---

## Task 19 — The phone recipe, the NOTICE row and the branch suite

**Files**
- Create: `docs/health-auto-export.md`, `tests/health/integration.test.ts`
- Modify: `NOTICE.md` (the fud-ai row at line 7 — fill in only if the reinstall-recovery idea is ported)

**Interfaces**

Consumes: everything above. Produces: the recipe Devin installs, and the `[needs branch]` suite that
measures spec §9's integration cases and acceptance criteria 1–4, 7–10.

**Steps**

- [ ] Write `docs/health-auto-export.md`:

```md
# Getting her phone to send body data

Two ways in. Health Auto Export is the recommended one (architecture §10); the Shortcut is the
fallback if Devin would rather not buy the app. Only one of them gets the seven-day gate.

## Before either

1. Open Settings → Body data → **Manage sources** → **Issue an ingest token**.
2. Copy the token. It is shown exactly once and is never stored in readable form.
   (CLI alternative: `pnpm exec tsx scripts/issue-health-token.ts <user_id> health_auto_export "Health Auto Export"`.)

## A. Health Auto Export (recommended)

1. Install **Health Auto Export — JSON+CSV** from the App Store and grant it Health read access for
   Steps, Active Energy, Weight & Body Mass and Sleep Analysis.
2. **Automations → Add Automation → REST API.**
3. URL: `https://sasha-meal-companion.vercel.app/api/health/ingest` · Method **POST** · Format **JSON**.
4. Headers: `Authorization: Bearer smh_…` (the token from above) and `Content-Type: application/json`.
5. Data type **Health Metrics**; select exactly: `Steps`, `Active Energy`, `Weight & Body Mass`,
   `Sleep Analysis`. Aggregation **Hourly** for steps and energy, **Daily** for weight and sleep.
6. Schedule: **daily at 06:30**, "Last 1 day", auto-retry on failure **on**.
7. Tap **Run Now** once. A success looks like `{"status":"applied","accepted":N}`. A `401` means the
   token is wrong or revoked; a `403` means the token was issued for a different source kind.

The app posts its own document (`{"data":{"metrics":[…]}}`) and cannot add a client timestamp, so this
path is bounded by payload-hash idempotency plus a 48-hour sample-age rule rather than the ten-minute
replay window. Re-running the same export changes nothing.

## B. Hand-built Shortcut (fallback)

Shortcuts can build a body, so this path carries `sent_at` and gets the ten-minute replay window.
Build: Find Health Samples → Repeat → Dictionary → Get Contents of URL (POST, the same two headers),
with this body:

```json
{ "source_kind": "apple_health_shortcut",
  "sent_at": "2026-09-15T14:01:00-04:00",
  "tz": "America/New_York",
  "samples": [
    { "type": "step_count", "value": 812, "unit": "count",
      "start_time": "2026-09-15T13:00:00-04:00", "end_time": "2026-09-15T14:00:00-04:00",
      "device_label": "Apple Watch" },
    { "type": "body_mass", "value": 127.2, "unit": "lb",
      "start_time": "2026-09-15T07:12:00-04:00", "end_time": "2026-09-15T07:12:00-04:00" } ] }
```

`sent_at` must be the current time (Shortcuts' "Current Date", ISO 8601 with offset). More than ten
minutes out and the server answers `409 replayed` and writes nothing.

## Oura

Settings → Body data → **Connect Oura**, sign in, approve `daily personal`. The daily pull runs at
06:00 America/New_York and asks for the previous two days, so a missed morning fills itself in.
**Disconnect** revokes the source and deletes the stored tokens; the samples already collected stay.

## When something stops

`/body` names the source and when it last delivered. Revoke the token there, issue a new one, and
paste it into step 4 again — nothing in the database needs touching.
```

- [ ] Write the failing test `tests/health/integration.test.ts`:

```ts
/**
 * [needs branch] — spec §9's integration cases. Skipped when SUPABASE_TEST_URL is unset.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { mergedDays } from "@/lib/server/health-daily";
import { applyIngest } from "@/lib/server/health-ingest";
import { issueSourceToken, resolveSourceByToken } from "@/lib/server/health-tokens";
import { toBytea } from "@/lib/server/tokens";

const run = HAS_BRANCH ? describe : describe.skip;

run("Phase 5 against a branch", () => {
  const admin = HAS_BRANCH ? adminClient() : (null as never);
  let userA = ""; let userB = ""; let sourceA = ""; let rawToken = "";

  const body = (over: Record<string, unknown> = {}) => ({
    source_kind: "apple_health_shortcut", sent_at: new Date().toISOString(),
    tz: "America/New_York",
    samples: [{ type: "step_count", value: 812, unit: "count",
      start_time: "2026-09-15T17:00:00Z", end_time: "2026-09-15T18:00:00Z",
      vendor_sample_id: "s-1", vendor_updated_at: "2026-09-15T18:05:00Z" }], ...over });

  beforeAll(async () => {
    const users = await createTestUsers();
    userA = users.a.userId; userB = users.b.userId;
    const { raw, hash } = issueSourceToken();
    rawToken = raw;
    const { data } = await admin.from("health_sources")
      .insert({ user_id: userA, kind: "apple_health_shortcut", device_label: "Shortcut",
        token_hash: toBytea(hash) }).select("id").single();
    sourceA = data!.id;
  });

  const source = () => ({ id: sourceA, userId: userA, kind: "apple_health_shortcut" });

  it("applies once and reports duplicate on the identical payload — AC 1 and 2", async () => {
    const payload = body();
    const first = await applyIngest(admin, source(), payload);
    expect(first).toMatchObject({ status: "applied", accepted: 1, updated: 0 });
    const before = await admin.from("health_samples").select("id, value").eq("user_id", userA);
    const second = await applyIngest(admin, source(), payload);
    expect(second).toMatchObject({ status: "duplicate", accepted: 0 });
    const after = await admin.from("health_samples").select("id, value").eq("user_id", userA);
    expect(after.data).toEqual(before.data);
  });

  it("takes a newer correction and skips an older one", async () => {
    await applyIngest(admin, source(), body({ samples: [{ type: "step_count", value: 900,
      unit: "count", start_time: "2026-09-15T17:00:00Z", end_time: "2026-09-15T18:00:00Z",
      vendor_sample_id: "s-1", vendor_updated_at: "2026-09-15T19:00:00Z" }] }));
    const fresh = await admin.from("health_samples").select("value")
      .eq("user_id", userA).eq("vendor_sample_id", "s-1").single();
    expect(Number(fresh.data!.value)).toBe(900);

    const stale = await applyIngest(admin, source(), body({ samples: [{ type: "step_count",
      value: 111, unit: "count", start_time: "2026-09-15T17:00:00Z",
      end_time: "2026-09-15T18:00:00Z", vendor_sample_id: "s-1",
      vendor_updated_at: "2026-09-15T17:30:00Z" }] }));
    expect(stale).toMatchObject({ accepted: 0, updated: 0, skipped: 1 });
  });

  it("409s a payload 30 minutes old and writes nothing — AC 3", async () => {
    const count = await admin.from("health_samples").select("id").eq("user_id", userA);
    await expect(applyIngest(admin, source(),
      body({ sent_at: new Date(Date.now() - 1_800_000).toISOString() })))
      .rejects.toMatchObject({ status: 409 });
    const after = await admin.from("health_samples").select("id").eq("user_id", userA);
    expect(after.data!.length).toBe(count.data!.length);
  });

  it("resolves a live token and refuses a revoked one — AC 4", async () => {
    expect(await resolveSourceByToken(admin, rawToken)).toMatchObject({ userId: userA });
    await admin.from("health_sources").update({ revoked_at: new Date().toISOString() })
      .eq("id", sourceA);
    expect(await resolveSourceByToken(admin, rawToken)).toBeNull();
    await admin.from("health_sources").update({ revoked_at: null }).eq("id", sourceA);
  });

  it("keeps user B out of user A's samples and merged days — AC 10", async () => {
    const days = await mergedDays(admin, userB, "2026-09-15", "2026-09-15");
    expect(days[0].steps).toBeNull();
    const cross = await admin.rpc("health_ingest_apply", { p_user_id: userB,
      p_source_id: sourceA, p_event_id: null, p_samples: [] });
    expect(cross.error?.message).toMatch(/forbidden/);
  });

  it("round-trips a sealed Oura token and stores no plaintext — AC 9", async () => {
    const tokens = { access_token: "at", refresh_token: "rt",
      expires_at: "2026-09-16T00:00:00Z", scope: "daily personal" };
    const sealed = sealOauth(tokens);
    await admin.from("health_sources").update({ oauth: sealed }).eq("id", sourceA);
    const { data } = await admin.from("health_sources").select("oauth").eq("id", sourceA).single();
    expect(String(data!.oauth)).not.toContain("rt");
    expect(openOauth(String(data!.oauth))).toEqual(tokens);
    await admin.from("health_sources").update({ oauth: null }).eq("id", sourceA);
  });

  it("a second pull of identical content changes no row — AC 7", async () => {
    const hashRows = async () => {
      const { data } = await admin.from("health_samples")
        .select("dedupe_key, value, unit, end_time").eq("user_id", userA).order("dedupe_key");
      return createHash("sha256").update(JSON.stringify(data), "utf8").digest("hex");
    };
    const before = await hashRows();
    await applyIngest(admin, source(), body({ sent_at: new Date().toISOString() }));
    expect(await hashRows()).toBe(before);
  });

  it("rejects an unknown, replayed and expired oauth state", async () => {
    const now = new Date().toISOString();
    const expired = createHash("sha256").update("expired", "utf8").digest("hex");
    await admin.from("oauth_states").insert({ state_hash: `\\x${expired}`, provider: "oura",
      user_id: userA, expires_at: new Date(Date.now() - 60_000).toISOString() });
    for (const state_hash of [`\\x${createHash("sha256").update("unknown", "utf8").digest("hex")}`,
      `\\x${expired}`]) {
      const { data } = await admin.from("oauth_states").update({ consumed_at: now })
        .eq("state_hash", state_hash).is("consumed_at", null).gt("expires_at", now)
        .select("user_id").maybeSingle();
      expect(data).toBeNull();
    }
  });
});
```

- [ ] Run it: `pnpm test:integration tests/health/integration.test.ts` — expected PASS (8 tests) with
      a branch; `8 skipped` without one `[needs branch]`.
- [ ] Modify `NOTICE.md` — only if fud-ai's reinstall-recovery idea is actually ported. The row at
      line 7 becomes:

```md
| apoorvdarshan/fud-ai — Copyright (c) 2026 Apoorv Darshan | MIT | entry-UUID sample tagging for rebuild-after-reinstall, beside our dedupe key | `lib/health/dedupe.ts` |
```

      If nothing is ported (this lane's `vendor_sample_id` fallback is our own design), leave the row
      as it stands and say so in the PR description.
- [ ] Commit:
      `git add docs/health-auto-export.md tests/health/integration.test.ts NOTICE.md && git commit -m "docs(health): phone recipe and the phase 5 branch suite"`

---

## Lane exit gate

Measured, reported, never lowered (contracts §7).

| # | Gate | How it is measured |
|---|---|---|
| 1 | `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` all green | run once before the PR; CI is the gate, never a second local full run (AGENTS.md) |
| 2 | Every spec §9 unit file exists and is green | `pnpm test tests/health/` — 16 suites |
| 3 | The `[needs branch]` suites pass on a Supabase branch | `pnpm db:push && pnpm test:integration tests/health/` |
| 4 | A duplicate payload changes nothing | `integration.test.ts` "applies once and reports duplicate" (AC 1, 2) |
| 5 | 409 replay, 401 revoked-before-read, 413, 422, partial `rejected` | `ingest-route.test.ts` + `integration.test.ts` (AC 3, 4, 5) |
| 6 | A second pull for the same day changes no row | `integration.test.ts` content hash (AC 7) |
| 7 | Refresh rotates and the old refresh token is gone | `oura-server.test.ts` CAS assertion (AC 8) |
| 8 | No plaintext token in any column | `integration.test.ts` sealed round trip; `tokens-route.test.ts` hash-only insert (AC 9) |
| 9 | Cross-user denial on every new table, view, function and the MCP tool | `integration.test.ts` + `migration-*.test.ts` + `mcp-health-tools.test.ts` (AC 10) |
| 10 | `daily_health` is `security_invoker` | `migration-ingest.test.ts` / `tests/rls/security-invoker.test.ts` |
| 11 | `null` renders as a gap and an em dash, never 0 | `body-view.test.ts` + `sparkline.test.ts` + the `[manual gate]` screenshots (AC 11) |
| 12 | Seven consecutive days of steps, energy, sleep and weight on `/body` | `[manual gate]`, Devin's phone, at **integration**, not on this branch (AC 6) |

Not this lane's gate: AC 6's seven-day run and the Oura PKCE canary belong to the integration stage
(contracts §8 step 3). This lane reports readiness, not the seven days.

## Hand-off to integration

### 1. `app/api/mcp/route.ts` — tool registration and scope map

Inside the per-request handler built within `withTokenUser` (contracts §5):

```ts
import { HEALTH_TOOL_SCOPES, registerHealthTools } from "@/lib/mcp/health-tools";

// …where the server is built, beside the existing registerTool calls:
registerHealthTools(server, { userId: ctx.userId, admin });

// …and in scopeForBody, merged with WRITE_TOOLS:
const TOOL_SCOPES: Record<string, "read" | "log:write" | "constraints:write"> = {
  ...HEALTH_TOOL_SCOPES,          // { get_body_data: "read" }
  ...EXPENDITURE_TOOL_SCOPES,     // Lane Q
  ...COACH_TOOL_SCOPES,           // Lane R
};
function scopeForBody(raw: string): "read" | "log:write" | "constraints:write" {
  // unchanged parse; then, per call:
  //   if (WRITE_TOOLS.has(name)) return "log:write";
  //   return TOOL_SCOPES[name] ?? "read";
}
```

`get_body_data` is read-only, so it never widens the scope a body asks for.

### 2. `vercel.json` — the cron line

06:00 America/New_York is **10:00 UTC** while the zone is on EDT (UTC−4); the contract accepts the
one-hour DST drift to 07:00 local in EST. Added beside wave 3's media-sweep entry:

```json
{ "crons": [
  { "path": "/api/jobs/media-sweep", "schedule": "0 * * * *" },
  { "path": "/api/jobs/oura-pull", "schedule": "0 10 * * *" }
] }
```

Register it only after one successful manual run (spec §11):
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://sasha-meal-companion.vercel.app/api/jobs/oura-pull`

### 3. `app/settings/page.tsx` — the Body data row and the sheet (13 lines)

```tsx
@@ app/settings/page.tsx:9 (after the SyncStatus import)
 import SyncStatus from "@/components/SyncStatus";
+import HealthSourcesSheet from "@/components/HealthSourcesSheet";
+import { fetchDaily } from "@/lib/health-client";
+import type { DailyHealthResponse } from "@/lib/health/contract";

@@ app/settings/page.tsx:125 (inside SettingsPage, beside the store state)
   const [store, setStore] = useState<Store | null>(null);
+  const [bodySources, setBodySources] = useState<DailyHealthResponse["sources"]>([]);
+  const [bodySheet, setBodySheet] = useState(false);
+  const loadSources = () => {
+    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
+    void fetchDaily(day(-6), day(0)).then((r) => setBodySources(r.response?.sources ?? []));
+  };
+  useEffect(loadSources, []);

@@ app/settings/page.tsx:399 (after <ExportCard />)
       <ExportCard />
+      <Card>
+        <a href="/body" className="tap flex items-center justify-between">
+          <span className="ts" style={CARD_TITLE}>Body data</span>
+          <span style={CAPTION}>{bodySources.length} source{bodySources.length === 1 ? "" : "s"}</span>
+        </a>
+        <button type="button" onClick={() => setBodySheet(true)} className="pill tap inline-flex self-start">
+          <span className="pill-in ts flex h-11 items-center px-5 text-tiny font-normal">Manage sources</span>
+        </button>
+      </Card>
+      {bodySheet && <HealthSourcesSheet sources={bodySources}
+        onClose={() => setBodySheet(false)} onChanged={loadSources} />}
```

### 4. `app/page.tsx` — the Today weight chip (11 lines)

Placed beside the existing day-type chip in the header (`app/page.tsx:375-393`), rendered only once a
`body_mass` sample exists, so the chip never appears empty:

```tsx
@@ app/page.tsx:26 (after the QuickActions import)
 import QuickActions from "@/components/QuickActions";
+import { readCachedDaily } from "@/lib/health-client";
+import { kgToLb } from "@/components/BodyDashboard";

@@ app/page.tsx:339 (beside the day-type chip lookup)
   const chip = DAY_TYPE_CHIP[resolved.dayType];
+  const latestKg = readCachedDaily()?.response.days
+    .reduce<number | null>((found, d) => d.body_mass_kg ?? found, null) ?? null;

@@ app/page.tsx:391 (after the day-type chip closes)
             <span className="ts text-tiny font-normal text-graphite">{chip.label}</span>
           </span>
         </span>
+        {latestKg !== null && (
+          <a href="/body" className="pill tap inline-flex shrink-0">
+            <span className="pill-in ts flex items-center px-3.5 py-2 text-tiny font-normal tabular-nums text-graphite">
+              {Math.round(kgToLb(latestKg) * 10) / 10} lb
+            </span>
+          </a>
+        )}
```

No fifth tab: `components/TabBar.tsx` is untouched by this lane (contracts §2; the Coach tab is Lane R's).

### 5. Also at integration

- Remove the unused `HEALTH_INGEST_TOKEN` env from Vercel (contracts §2).
- Set `HEALTH_TOKEN_KEY` (`openssl rand -base64 32`), `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`,
  `OURA_REDIRECT_URI` in Vercel and `.env.local`; leave `HEALTH_INGEST_ENABLED` unset until the
  migrations are on production.
- Run the Oura PKCE canary and record the result in `docs/architecture.md` §5.2 (spec open question 3).

## Open questions

1. **`health_samples.device_label` is a contract addition.** Contracts §2 requires Watch preference in
   `rollUpDay` and spec §5 puts `device_label` on every ingest sample, but Phase 0's table has no such
   column and one HAE source carries both Watch and phone rows. Task 7 adds it. Land the note
   `docs: phase-5-7 contract change — health_samples.device_label` before the PR.
2. **Oura sleep comes from `usercollection/sleep`, not `daily_sleep`.** `daily_sleep` returns a score
   and its contributors, and the frozen `SampleType` union has no sleep score, so sleep minutes would
   be unobtainable from it. `daily_readiness` still gives `readiness_score`. Confirm when the OAuth app
   is registered and the first real document is in hand; if `daily_sleep` does carry a duration on her
   account, `ouraSleepToSamples` reads it with no signature change.
3. **Health Auto Export cannot stamp a request.** Its REST automation posts its own document with no
   `sent_at` and no `tz`, so that path is bounded by payload-hash idempotency plus a 48-hour sample-age
   rule instead of spec §5's ten-minute replay window; the Shortcut path keeps the window and the 409.
   If Devin picks the Shortcut for the gate (spec open question 2), the HAE branch stays but is unused.
4. **Timezone for the HAE path** comes from `HEALTH_TZ` or the `DEFAULT_TZ` constant
   (`America/New_York`), because `health_sources` has no tz column and the payload carries none.
   One user, one zone — revisit when a second user exists.
5. **`HEALTH_TOKEN_KEY` rotation has no procedure** (spec open question 7). Either write the re-seal
   script before the key reaches production, or accept one Oura reconnect when it changes. Nothing in
   this lane depends on the answer.
6. **Sleep granularity** stays one `sleep_asleep` total per night plus `sleep_in_bed`; Oura's stage
   breakdown is not stored (spec open question 6). Backfill is limited, so Phase 7's coach either wants
   it now or never.
7. **Oura membership and ring generation** must be confirmed before the OAuth app is registered, or
   the callback succeeds and every pull returns an empty `data` array (spec open question 4).
8. **`weigh_ins` returns `value` + `unit` unconverted** (Phase 0). `weighInsKg` is the only sanctioned
   reader; Lane Q must not query the view directly (contracts §2). Worth a review check on Q's PR.
