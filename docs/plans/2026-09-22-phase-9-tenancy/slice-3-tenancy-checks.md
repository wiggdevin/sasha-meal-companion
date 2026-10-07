# Slice 3 — Tenancy checks in CI (spec section 3, items 1–5)

> **IMPLEMENTED — see PR #247 (branch `test/p9-tenancy-checks`).** The PR code and its reviews in
> `docs/audit/code/` are the source of truth; the text below is the original plan and is
> superseded (audit plan r12).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI proves, with behavioral tests that fail when a guard is weakened, that no account can read or change another account's rows, RPC results, views or Storage objects on the current schema.

**Architecture:** Two manifests (`tests/tenancy/table-ops.json`, `tests/tenancy/rpc-ops.json`) declare what `authenticated` may do. Generators read `pg_catalog` and must equal the manifests, so a new table or function fails CI until declared. A matrix test runs every declared and undeclared operation as user A with a real JWT against A's and B's rows. A mutation test weakens each policy inside a rolled-back transaction and requires the probe to see the leak. A third manifest lists admin-client entry points, each with its cross-user test.

**Tech Stack:** Vitest (node), `@supabase/supabase-js` user clients, `psql` via `runSql` (`tests/helpers/supabase.ts:44-54`), Postgres catalogs.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` section 3, Slices item 3.

**Branch:** `feat/p9-tenancy-checks`. One PR, unmerged. No migration.

## Global Constraints

See `README.md`. These tests need a database: they skip unless `HAS_BRANCH` (and `HAS_DB` for the
catalog and mutation parts), and they run in CI's `integration` job against the local stack
(`python3 scripts/ci-local-supabase.py start`, then `pnpm test:integration`; CI only). Locally, run each new
file alone against a local stack; never the whole `tests/` directory.

## Spec item not in this slice

- **Item 7 (`tests/tenancy/no-authored-plan.test.ts`) moves to slice 6.** Reason: it fails on the
  current code by design — her meal ids and ritual slot keys live in `lib/meals.ts`,
  `lib/plan.ts` and `lib/rotation.ts` until slice 6 removes them from runtime, and the fixture it
  reads (`scripts/fixtures/sasha-plan.json`) arrives in slice 4. The spec's slice list puts item 7
  in slice 3 with the gate "pass in CI"; the two cannot both hold.
- **Item 6 (fresh-account test)** is slice 6's gate (the spec's slice list says so).

## Current code (verified at `1d5790d`)

- Existing cross-user tests: `tests/rls/{cross-user,new-user-isolation,apply-sync-op,security-invoker}.test.ts`, `tests/sync/cross-user-http.test.ts`, `tests/log/cross-user.test.ts`, `tests/export/cross-user.test.ts`, `tests/search/cross-user.test.ts`.
- `tests/rls/cross-user.test.ts:7-16` hardcodes a `USER_TABLES` list (31 tables) — the generator replaces the need to keep it by hand.
- Non-uniform grants: `health_samples`, `ingest_events` select-only (`supabase/migrations/20260925000000_phase5_health_ingest.sql:16-21`); `coach_intent_events` no `authenticated` grant (`20261022090100_coach_intent_telemetry.sql:26-29`).
- `media` bucket policy `media_own_folder` (`20260920090100_phase4_media_bucket.sql:12-15`).
- Helpers: `ensureUser("a"|"b")`, `userClient`, `resetUser` (RPC `test_reset_user`), `adminClient`, `runSql`, `HAS_BRANCH`, `HAS_DB` (`tests/helpers/supabase.ts`).
- Admin client: `lib/server/admin.ts` (`adminClient()`, `adminClientForCli()`); MCP route `app/api/mcp/route.ts:20-24`; catalog writer `lib/server/catalog-writer.ts:21-27`.

## File structure

Create:
- `tests/tenancy/catalog.ts` — SQL generators from the catalog only: `ownedTables()` (direct `user_id` tables plus foreign-key descendants), `userTables()`, `rlsState()`, `authenticatedFunctions()` (full signatures).
- `tests/tenancy/table-ops.json` — `{ "<table>": { "ops": ["select", …], "owner": "user_id" | { "parent": "<table>", "fk": "<column>" }, "seed": "<seed id>" } }`.
- `tests/tenancy/rpc-ops.json` — keyed by full signature, `{ "<name>(<arg types>)": { "crossUserTest": "<test file>::<test name>" } }` (for example `"apply_sync_op(uuid, jsonb)"`), so a new overload fails until declared.
- `tests/tenancy/admin-entry-points.json` — `{ "<file>": { "test": "<test file>" } }`.
- `tests/tenancy/seed.ts` — one seeding function per `seed` id, through `apply_sync_op` or the admin client, returning the row's primary key.
- `tests/tenancy/rls-lint.test.ts`, `tests/tenancy/table-matrix.test.ts`, `tests/tenancy/rpc-matrix.test.ts`, `tests/tenancy/storage.test.ts`, `tests/tenancy/policy-mutation.test.ts`, `tests/tenancy/admin-entry-points.test.ts`.

---

### Task 1: RLS lint and the table generator

**Files:** `tests/tenancy/catalog.ts`, `tests/tenancy/rls-lint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tenancy/rls-lint.test.ts
import { describe, expect, it } from "vitest";
import { HAS_DB } from "../helpers/supabase";
import { ownedTables, rlsState, userTables } from "./catalog";
import manifest from "./table-ops.json";

describe.skipIf(!HAS_DB)("RLS lint (spec 3.1)", () => {
  it("every public table with user_id, and every declared child, has RLS on and no anon policy", () => {
    const tables = userTables();
    const bad = rlsState(tables).filter((t) => !t.rlsEnabled || t.anonPolicies > 0);
    expect(bad).toEqual([]);
  });
  it("the generated table list equals the manifest keys", () => {
    expect(userTables()).toEqual(Object.keys(manifest).sort());
  });
  it("each child's declared owner equals the owner the catalog finds", () => {
    const wrong = ownedTables().filter((t) => t.parent !== null).filter((t) => {
      const owner = (manifest as Record<string, { owner: unknown }>)[t.table]?.owner as { parent?: string; fk?: string } | undefined;
      return owner?.parent !== t.parent || owner?.fk !== t.fk;
    }).map((t) => t.table);
    expect(wrong).toEqual([]);
  });
});
```

```ts
// tests/tenancy/catalog.ts
import { runSql } from "../helpers/supabase";

/**
 * Account-owned tables, found from the catalog only (never from the manifest it checks; audit
 * plan r1 finding 9): every public table with a `user_id` column, plus every public table that
 * reaches one of those through a chain of foreign keys (for example `log_items` → `log_entries`).
 * Returns `table|parent|fk` rows; `parent` and `fk` are empty for a direct owner.
 */
export function ownedTables(): { table: string; parent: string | null; fk: string | null }[] {
  return runSql(`
    with recursive direct as (
      select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
    ), owned(oid, relname, parent, fk) as (
      select oid, relname, null::text, null::text from direct
      union
      select ch.oid, ch.relname, o.relname, att.attname
      from owned o
      join pg_constraint k on k.confrelid = o.oid and k.contype = 'f' and array_length(k.conkey, 1) = 1
      join pg_class ch on ch.oid = k.conrelid
      join pg_namespace n on n.oid = ch.relnamespace and n.nspname = 'public'
      join pg_attribute att on att.attrelid = ch.oid and att.attnum = k.conkey[1]
      where ch.oid not in (select oid from direct)
    )
    select distinct on (relname) relname || '|' || coalesce(parent, '') || '|' || coalesce(fk, '')
    from owned order by relname, parent nulls first`).split("\n").filter(Boolean).map((line) => {
      const [table, parent, fk] = line.split("|");
      return { table, parent: parent || null, fk: fk || null };
    });
}

export function userTables(): string[] {
  return ownedTables().map((t) => t.table).sort();
}

export function rlsState(tables: string[]): { table: string; rlsEnabled: boolean; anonPolicies: number }[] {
  const list = tables.map((t) => `'${t}'`).join(",");
  return runSql(`
    select c.relname, c.relrowsecurity,
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
         and 'anon' = any(p.roles))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in (${list}) order by 1`)
    .split("\n").filter(Boolean).map((line) => {
      const [table, rls, anon] = line.split("|");
      return { table, rlsEnabled: rls === "t", anonPolicies: Number(anon) };
    });
}

/** Full signatures (`name(arg types)`), so an overload is its own manifest entry. */
export function authenticatedFunctions(): string[] {
  return runSql(`
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1`).split("\n").filter(Boolean);
}
```

- [ ] **Step 2: Run and see it fail** — start the local stack (README "Local DB tests": `pnpm exec supabase start` and the `SUPABASE_TEST_*` exports), then `pnpm exec vitest run tests/tenancy/rls-lint.test.ts` — Expected: FAIL (manifest missing).
- [ ] **Step 3: Write `tests/tenancy/table-ops.json`.** Fill it from the generator output and the migrations: for each table, read its grants and policies (`\dp <table>` via `runSql`), and declare what `authenticated` is **meant** to have. Start from the spec's examples: `health_samples: [select]`, `ingest_events: [select]`, `coach_intent_events: []`, `plan_days: [select, insert, update]`. Children (for example `log_items` → parent `log_entries` by `entry_id`; `recipe_items`, `favorites_meal_items`, `duplicate_group_members`, `coach_messages`) use the `{ "parent", "fk" }` owner form. Every entry gets a `seed` id.
- [ ] **Step 4: Run and see it pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git add tests/tenancy && git commit -m "test: RLS lint and declared table operations manifest"`

---

### Task 2: The behavioral matrix (spec 3.2)

**Files:** `tests/tenancy/seed.ts`, `tests/tenancy/table-matrix.test.ts`

**Interfaces:** `seed(id: string, owner: string): Promise<{ table: string; pk: Record<string, unknown> }>`; `probe(client, table, op, pk): Promise<{ ok: boolean; affected: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tenancy/table-matrix.test.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, ensureUser, resetUser, userClient, type TestUser } from "../helpers/supabase";
import manifest from "./table-ops.json";
import { probe, seed, OPS, type Op } from "./seed";

type Entry = { ops: Op[]; seed: string };
const entries = Object.entries(manifest as Record<string, Entry>);

describe.skipIf(!HAS_BRANCH)("declared operations matrix (spec 3.2)", () => {
  let a: TestUser; let b: TestUser; let asA: SupabaseClient;
  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
    asA = await userClient(a);
  });

  for (const [table, entry] of entries) {
    for (const op of OPS) {
      const declared = entry.ops.includes(op);
      it(`${table}: ${op} on A's own row ${declared ? "succeeds" : "fails"}`, async () => {
        const own = await seed(entry.seed, a.id);
        const r = await probe(asA, table, op, own.pk);
        expect(r.ok && r.affected > 0).toBe(declared);
      });
      it(`${table}: ${op} on B's row affects nothing`, async () => {
        const theirs = await seed(entry.seed, b.id);
        const r = await probe(asA, table, op, theirs.pk);
        expect(r.affected).toBe(0);
      });
    }
  }
});
```

`probe` maps `select` → `.select().match(pk)` (affected = rows returned), `insert` → insert a
copy of the seed row with a fresh key and `user_id` set to the target owner (affected = rows
returned by `.select()`), `update` → `.update({ <a harmless column> }).match(pk).select()`,
`delete` → `.delete().match(pk).select()`. An error counts as `ok: false, affected: 0`. After each
B case, the test also reads B's row with the admin client and asserts it is unchanged
(`expect(after).toEqual(before)`).

- [ ] **Step 2: Run and see it fail** — `pnpm exec vitest run tests/tenancy/table-matrix.test.ts` — Expected: FAIL (`seed` missing), then real failures where the manifest is wrong.
- [ ] **Step 3: Implement `seed.ts`.** Seed through `apply_sync_op` where the entity is synced (see `tests/rls/cross-user.test.ts:40-60` for the pattern), else through the admin client. Fix the **manifest**, not the policy, when a declared operation disagrees with the grant, unless the grant is a real leak — then stop and report it to Devin (a production security finding is a human step; do not change policies in this slice).
- [ ] **Step 4: Run and see it pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "test: behavioral cross-user matrix per declared operation"`

---

### Task 3: RPCs, views and Storage (spec 3.3)

**Files:** `tests/tenancy/rpc-ops.json`, `tests/tenancy/rpc-matrix.test.ts`, `tests/tenancy/storage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tenancy/rpc-matrix.test.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB } from "../helpers/supabase";
import { authenticatedFunctions } from "./catalog";
import rpcs from "./rpc-ops.json";

describe.skipIf(!HAS_DB)("RPC manifest (spec 3.3)", () => {
  it("every function authenticated may execute is declared", () => {
    expect(authenticatedFunctions().sort()).toEqual(Object.keys(rpcs).sort());
  });
  it("every declared function names a cross-user test that exists", () => {
    const missing = Object.entries(rpcs as Record<string, { crossUserTest: string }>)
      .filter(([, v]) => {
        const [file, name] = v.crossUserTest.split("::");
        return !existsSync(file) || !readFileSync(file, "utf8").includes(name);
      }).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
```

```ts
// tests/tenancy/storage.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, adminClient, ensureUser, userClient } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("media bucket (spec 3.3)", () => {
  let path = "";
  beforeAll(async () => {
    const b = await ensureUser("b");
    path = `${b.id}/canary-${crypto.randomUUID()}.jpg`;
    const { error } = await adminClient().storage.from("media").upload(path, new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), { contentType: "image/jpeg" });
    expect(error).toBeNull();
  });
  it("A cannot download, list, overwrite or delete B's object", async () => {
    const asA = await userClient(await ensureUser("a"));
    const bucket = asA.storage.from("media");
    expect((await bucket.download(path)).data).toBeNull();
    expect((await bucket.list(path.split("/")[0])).data ?? []).toEqual([]);
    expect((await bucket.upload(path, new Blob(["x"]), { upsert: true })).error).not.toBeNull();
    await bucket.remove([path]);
    expect((await adminClient().storage.from("media").download(path)).data).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/tenancy/rpc-matrix.test.ts tests/tenancy/storage.test.ts`.
- [ ] **Step 3: Write `rpc-ops.json`.** For each function, point at an existing cross-user test (for example `"apply_sync_op(uuid, jsonb)"` → `tests/rls/apply-sync-op.test.ts::<its cross-user test name>`; copy each key exactly as `authenticatedFunctions()` prints it) or add a new `it` to `tests/tenancy/rpc-matrix.test.ts` that calls the function as A with B's ids and asserts no B data returns and B's rows do not change. Views stay covered by `tests/rls/security-invoker.test.ts` (no change).
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit** — `git commit -am "test: RPC manifest and media bucket cross-user cases"`

---

### Task 4: The policy mutation test (spec 3.4)

**Files:** `tests/tenancy/policy-mutation.test.ts`

**Two kinds of policy (audit plan r11 finding 1).** Owner policies (`permissive`, the `_rw` /
parent-chain policies) are mutation-tested cross-user, as below. The minimum-client policies that
slice 6 adds (`<table>_min_client`, `as restrictive`) cannot leak another account's row when
weakened alone, because the owner policy still applies (`20260911000500_rls.sql:17-19`). They get
their own probe: as an **invited account without `x-smc-client`** (claims `sub` = A,
`request.headers` = `{}`, a `min_client_build` row present), the probe reads **A's own** seeded row.
Baseline: 0 rows. With the restrictive policy weakened (`using (true) with check (true)`): ≥ 1 row.
The test picks the probe by `pg_policies.permissive` (`PERMISSIVE` → cross-user probe,
`RESTRICTIVE` → own-row old-client probe). Slice 6 adds its policies to this test in the same PR.

For every **permissive** policy on every manifest table, one `psql` call runs:

```sql
begin;
alter policy "<policy>" on public.<table> using (true) with check (true);  -- omit a clause the policy lacks
grant select, insert, update, delete on public.<table> to authenticated;    -- grant undeclared ops
set local role authenticated;
set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
select count(*) from public.<table> where <owner predicate for B>;         -- the probe
rollback;
```

The test requires `count > 0` for every mutated policy (the probe sees the leak). A baseline run of
the same probe without the `alter`/`grant` lines must return `0`. For child tables the owner
predicate joins the parent (`exists (select 1 from <parent> p where p.id = <table>.<fk> and
p.user_id = '<B>')`). B must have at least one seeded row per table first (reuse `seed.ts`).

- [ ] **Step 1: Write the test** as a loop over `pg_policies` for manifest tables:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql } from "../helpers/supabase";
import manifest from "./table-ops.json";
import { ownerPredicate, seed } from "./seed";

const policies = HAS_DB ? runSql(`select tablename || '|' || policyname || '|' || (qual is not null) || '|' || (with_check is not null)
  from pg_policies where schemaname = 'public' and tablename = any(array[${Object.keys(manifest).map((t) => `'${t}'`).join(",")}])`)
  .split("\n").filter(Boolean).map((l) => { const [table, name, hasUsing, hasCheck] = l.split("|"); return { table, name, hasUsing: hasUsing === "true", hasCheck: hasCheck === "true" }; }) : [];

describe.skipIf(!HAS_BRANCH || !HAS_DB)("policy mutation (spec 3.4)", () => {
  let A = ""; let B = "";
  beforeAll(async () => {
    [A, B] = (await Promise.all([ensureUser("a"), ensureUser("b")])).map((u) => u.id);
    for (const [, e] of Object.entries(manifest as Record<string, { seed: string }>)) await seed(e.seed, B);
  });
  for (const p of policies) {
    it(`${p.table}.${p.name}: weakened, the probe sees B's rows`, () => {
      const clauses = [p.hasUsing ? "using (true)" : "", p.hasCheck ? "with check (true)" : ""].join(" ");
      const probe = (mutate: boolean) => Number(runSql(`begin;
        ${mutate ? `alter policy "${p.name}" on public.${p.table} ${clauses};
        grant select, insert, update, delete on public.${p.table} to authenticated;` : ""}
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}';
        select count(*) from public.${p.table} where ${ownerPredicate(p.table, B)};
        rollback;`).split("\n").filter((l) => /^\d+$/.test(l)).pop());
      expect(probe(false)).toBe(0);
      expect(probe(true)).toBeGreaterThan(0);
    });
  }
});
```

A policy that only covers `insert` (no `using`) cannot leak on a select probe; for those the probe
is an `insert … returning 1` of a B-owned row inside the same transaction, expected to succeed only
when mutated. Implement that branch in `ownerPredicate`'s sibling `probeSql(table, policy, B)`.

- [ ] **Step 2: Run and see it fail** (before `ownerPredicate` exists), then pass.
- [ ] **Step 3: Commit** — `git commit -am "test: mutate each policy and require the probe to see the leak"`

---

### Task 5: Admin-client entry points (spec 3.5)

**Files:** `tests/tenancy/admin-entry-points.json`, `tests/tenancy/admin-entry-points.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import entries from "./admin-entry-points.json";

function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
}
const USES_ADMIN = /from\s+["']@\/lib\/server\/admin["']|admin:\s*SupabaseClient/;

describe("admin-client entry points (spec 3.5)", () => {
  it("the generated list equals the manifest", () => {
    const found = ["app", "lib"].flatMap(files).filter((f) => USES_ADMIN.test(readFileSync(f, "utf8"))).sort();
    expect(found).toEqual(Object.keys(entries).sort());
  });
  it("each entry names a cross-user test that seeds B with a canary", () => {
    const weak = Object.entries(entries as Record<string, { test: string }>).filter(([, v]) => {
      const src = readFileSync(v.test, "utf8");
      return !/canary/i.test(src);
    }).map(([k]) => k);
    expect(weak).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `pnpm exec vitest run tests/tenancy/admin-entry-points.test.ts` (no DB needed).
- [ ] **Step 3: Build the manifest.** For each file, point at an existing cross-user test (`tests/export/cross-user.test.ts`, `tests/log/cross-user.test.ts`, `tests/search/cross-user.test.ts`, `tests/sync/cross-user-http.test.ts`, `tests/mcp/*`) or write one that seeds B with a canary string (`canary-<uuid>`), calls the route as A, and asserts the canary is absent from A's response and B's rows are unchanged. Cron jobs (`app/api/jobs/*`): assert each write carries the `user_id` of the row it read (a unit test with a fake admin client that records writes). Record in the PR body one manual mutation per route family (for example: change the `.eq("user_id", userId)` in one export query to omit it, run its test, see it fail, restore).
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Gates and PR** — `pnpm exec tsc --noEmit && pnpm lint`; run each new file alone against the local stack; push; `gh pr create --base main --title "test: tenancy checks — declared ops, mutation, admin entry points (Phase 9 slice 3)"`. Unmerged. Review file to `docs/audit/code/`.

## Preview test steps

This slice adds tests only; there is nothing to see in the app. Devin checks the PR's CI run:
job `integration` lists `tests/tenancy/*` as passed, and the PR body shows the manual mutation
per route family with its failing output.

## Rollback

Revert the merge commit. No runtime or data change.

## Human steps for Devin

1. If Task 2 or 4 reports a real leak (a grant or policy that lets A reach B), decide the fix; the
   run does not change production policies.
2. Merge the PR.
