# Slice 5 — Shared rate limit, invite codes, the hook and the account claim

> **Later, not built (needs a product decision).** See the banner in `README.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every public sign-up path is refused at the database unless a live reservation exists for that email and that sign-up's nonce; a successful sign-up is finalized by `claim_account(nonce)`, which spends one use and writes the default template in one transaction. Scripts and tests create users only through the gated helper. The UI stays hidden behind `NEXT_PUBLIC_INVITE_SIGNUP=1`.

**Architecture:** Two migrations: a Postgres-backed rate limiter and the invite tables with `claim_invite`, `hook_before_user_created` and `claim_account`. One route, `POST /api/auth/invite/claim`, is the only place that accepts a plain code. `AuthGate` gains an `unclaimed` state for an account without an `account_claims` row.

**Tech Stack:** Postgres plpgsql, Supabase Auth before-user-created hook (`pg-functions://`), Next.js route, Zod, Vitest, `tsx` scripts.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` 1.1–1.7, Slices item 5.

**Branch:** `feat/p9-invites-claim` (base: `main` after slice 4 merges, or stacked on `feat/p9-templates-m1`). One PR, unmerged.

## Global Constraints

See `README.md`. For this slice:

- Migrations `supabase/migrations/20261105090000_shared_rate_limit.sql` and
  `supabase/migrations/20261105090100_invites.sql`, each with a down file; add both to
  `tests/migrations/down-coverage.test.ts`. Local stack and `p9-tenancy` only.
- **No hosted hook activation on production**, no production sign-up toggle, no production env
  change. `supabase/config.toml` gets the hook for local runs, CI and branches.
- No email-only mode: the hook requires the nonce (spec 1.1, 1.5).
- Limits: `invite:ip:<sha256(ip)>` 10/hour, `invite:email:<sha256(email)>` 5/hour, `invite:all`
  100/hour. No raw IP or email stored.
- Every failure of the claim route gets the same generic answer.
- Reservation 30 minutes; `hooked` 24 hours; `used_count` moves only in `claim_account`.
- **Tenancy manifests in PR #247's format (audit plan r4 finding 9), same PR:**
  - `tests/tenancy/table-ops.json`: `"invite_claims": { "ops": [], "owner": "user_id", "seed": "invite_claims" }`
    (it has a nullable `user_id`, so the catalog lists it; `authenticated` has no grant).
    `invite_codes` and `rate_limit_counters` have no `user_id` and no foreign key to an owned table,
    so the catalog does not list them; `tests/tenancy/rls-lint.test.ts` still needs RLS on — add
    both to its "no-owner tables with RLS on and no policy" assertion (one `it`).
    `account_claims` is slice 4's entry.
  - `tests/tenancy/fixtures.ts`: an `invite_claims` builder (creates an `invite_codes` parent with
    the admin client; `user_id: owner`, state `consumed`).
  - `tests/tenancy/rpc-ops.json`: `"claim_account(text)": { "class": "account", "case": "claim_account" }`,
    and the `claim_account` case in `tests/tenancy/rpc-matrix.test.ts`: B, signed in, calls
    `claim_account` with A's nonce → refused; A's claim, `used_count` and templates unchanged.
    `claim_invite`, `rate_limit_hit` and `hook_before_user_created` are not executable by
    `authenticated`, so they have no entry (the generated list would fail if they were).
- Sign-in keeps PR #246's neutral screen for known and unknown addresses; no invite UI may add
  an error that reveals whether an address has an account (audit plan r4 finding 10).

## Current code (verified at `1d5790d`)

- `supabase/config.toml` `[auth]` at lines 25–35 (`enable_signup = true`), `[auth.email]` 37–41; no `[auth.hook.*]` section.
- `lib/server/ratelimit.ts`: `enforceRateLimit(key, limit, windowSeconds): Promise<void>`, `resetRateLimits()`; in-memory `Map` (`:1-17`).
- Admin-API user creation (to move to the gated helper, spec 1.6): `scripts/readiness/new-user-walk.mjs:95`, `scripts/t6-coach-proof.ts:43`, `scripts/t7-transcribe-proof.ts:51`, `scripts/coach-live-check.ts:158`, `scripts/food-membership-audit.ts:106`, `scripts/eval/coach-streak-harness.ts:147`, `tests/helpers/supabase.ts:87` (`ensureUser`), `tests/rls/new-user-isolation.test.ts:45`, `tests/integration/profile-sync.test.ts:32`, `tests/mcp/token.test.ts:32-33`, `tests/coach/suggest-new-account.test.ts:124`, `tests/sync/two-client.test.ts:51`; `app/api/dev/sign-in/route.ts:29` (`generateLink`, dev only).
- `scripts/lib/` exists (holds `database_backup.py`); `scripts/lib/gated-user.ts` is new.
- `tests/rls/admin-bypass.test.ts` does not exist (new).
- `components/AuthGate.tsx` states `unknown | out | onboarding | in` (`:33`).
- Sign-in page `app/sign-in/page.tsx` (slice 2 sets `shouldCreateUser: false` on Sign in).

## File structure

Create: the two migrations + downs; `app/api/auth/invite/claim/route.ts`; `lib/server/invite.ts`
(normalize code and email, hash, nonce); `lib/server/ratelimit.ts` (add `enforceSharedRateLimit`);
`lib/invite/client.ts` (`requestInvite`, `claimAccount`, nonce in `sessionStorage` key
`smc:invite-nonce` — device-level, add to slice 1's `DEVICE_KEYS`); `components/InviteSignUp.tsx`;
`scripts/invite.ts`; `scripts/invite-probe.ts`; `scripts/lib/gated-user.ts`;
`tests/invite/*.test.ts`; `tests/rls/admin-bypass.test.ts`; `tests/tenancy/no-admin-create.test.ts`.

Modify: `supabase/config.toml`; `tests/helpers/supabase.ts` (`createInvitedUser`,
`createTrustedAdminUser`; `ensureUser` uses `createInvitedUser`); every admin caller listed above;
`components/AuthGate.tsx` (`unclaimed`); `app/sign-in/page.tsx` ("New here?" behind the flag).

## Interfaces (produced)

```sql
rate_limit_hit(p_key text, p_limit int, p_window_seconds int) returns boolean      -- service_role
claim_invite(p_code_hash text, p_email text, p_nonce_hash text) returns boolean    -- service_role
hook_before_user_created(event jsonb) returns jsonb                                -- supabase_auth_admin
claim_account(p_nonce text) returns jsonb   -- authenticated; { status: 'claimed' | 'already' }
```
```ts
export async function enforceSharedRateLimit(admin: SupabaseClient, key: string, limit: number, windowSeconds: number): Promise<void>; // throws HttpError(429)
export function normalizeInviteCode(raw: string): string;   // upper, strip spaces and dashes
export function normalizeEmail(raw: string): string;        // trim, lower
export function newNonce(): { nonce: string; nonceHash: string }; // 32 random bytes base64url; sha256 hex
export async function createInvitedUser(opts?: { email?: string; password?: string }): Promise<TestUser>;
export async function createTrustedAdminUser(email: string, password: string): Promise<TestUser>; // admin-bypass test only
```

---

### Task 1: Shared rate limit

**Files:** `20261105090000_shared_rate_limit.sql` (+ down), `lib/server/ratelimit.ts`, `tests/invite/shared-rate-limit.test.ts` (DB), `lib/server/ratelimit.test.ts` or `tests/invite/rate-limit-unit.test.ts` (fake client)

- [ ] **Step 1: Failing tests** — DB: 10 calls of `rate_limit_hit('t:k', 10, 3600)` return `true`, the 11th `false`; a different key is independent; the table holds no row whose key contains `@` or a dotted IP. Unit: `enforceSharedRateLimit` with a fake admin whose `rpc` answers `false` throws `HttpError` 429 `rate_limited`; answers `true` → resolves.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/invite/shared-rate-limit.test.ts tests/invite/rate-limit-unit.test.ts`.
- [ ] **Step 3: Implement** — table `rate_limit_counters (key text, window_start timestamptz, count int not null, primary key (key, window_start))`, RLS on, no policies; `rate_limit_hit` as one `insert … on conflict (key, window_start) do update set count = rate_limit_counters.count + 1 returning count`, compare with `p_limit`, then `delete from rate_limit_counters where ctid in (select ctid from rate_limit_counters where window_start < now() - interval '1 day' limit 100)`. `security definer`, execute for `service_role` only.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat: shared Postgres rate limiter"`

### Task 2: Invite tables, `claim_invite`, the hook, `claim_account`

**Files:** `20261105090100_invites.sql` (+ down), `tests/invite/claim.test.ts` (DB), `supabase/config.toml`

The migration also adds `alter table account_claims add constraint account_claims_invite_fk foreign key (invite_id) references invite_codes (id);` (spec 1.2), and declares `invite_claims.user_id uuid references auth.users (id) on delete set null` (audit plan r13 finding 4): deleting a user (the probe's cleanup, or Devin deleting an account) keeps the claim row, its `hook_user_id`/`hooked_at` evidence and the code's `used_count`, and clears `user_id`, so the production check "every user-table `user_id` exists in `auth.users`" holds. `hook_user_id` has no foreign key on purpose (evidence of a user who may be deleted). Test: create an invited user, delete it with the admin client, and assert its claim row still exists with `user_id` null and `hook_user_id` set; `scripts/invite-probe.ts` asserts the same after its cleanup.

**Hook proof bound to the created user (audit plan r4 findings 1 and 11).** `invite_claims` gets
two more columns: `hook_user_id uuid` and `hooked_at timestamptz`. The hook sets `state = 'hooked'`,
`hook_user_id = (event->'user'->>'id')::uuid`, `hooked_at = now()`. These two columns are never
cleared, also not when the claim becomes `consumed`, so they stay as evidence. If
`event->'user'->>'id'` is null or not a UUID, the hook refuses (`invite_required`): there is no
email-only binding.

`claim_account(p_nonce text default null)` accepts **only** a claim with `state = 'hooked'`,
`hook_user_id = auth.uid()`, not expired (and, when `p_nonce` is given, the matching
`nonce_hash`). It never accepts a `reserved` claim. So:
- an admin-created user (no hook ran for it) can never claim, even with a valid new code and a
  fresh `reserved` nonce from the claim route;
- the cross-browser case (spec 1.4 step 6) needs no code and no nonce: the account calls
  `claim_account()` and the hook's binding to its user id is the proof. If that `hooked` claim
  expired (24 hours), the account stays unclaimed; Devin resolves it (Open for Devin).

- [ ] **Step 1: Failing tests (spec 1.4 test list)**

```ts
// tests/invite/claim.test.ts
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, anonClient, runSql } from "../helpers/supabase";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nonce = () => randomBytes(32).toString("base64url");
function newCode(uses = 1): { id: string; hash: string } {
  const code = `T${randomBytes(6).toString("hex").toUpperCase()}`;
  const id = runSql(`insert into invite_codes (code_hash, max_uses, expires_at)
    values ('${sha(code)}', ${uses}, now() + interval '1 day') returning id`);
  return { id, hash: sha(code) };
}
async function reserve(codeHash: string, email: string, n: string): Promise<boolean> {
  const { data, error } = await adminClient().rpc("claim_invite",
    { p_code_hash: codeHash, p_email: email, p_nonce_hash: sha(n) });
  if (error) throw error;
  return data as boolean;
}
async function signUp(email: string, n?: string) {
  const client = anonClient();
  const res = await client.auth.signUp({ email, password: "p9-invite-test-pw-1",
    options: n ? { data: { invite_nonce: n } } : undefined });
  return { client, res };
}
const email = () => `p9-${randomBytes(4).toString("hex")}@meal-companion.test`;

describe.skipIf(!HAS_BRANCH || !HAS_DB)("claim_invite and claim_account (spec 1.4)", () => {
  it("two concurrent claim_account calls on a one-use code consume one use", async () => {
    const code = newCode(1);
    const e = email(); const n = nonce();
    expect(await reserve(code.hash, e, n)).toBe(true);
    const { client, res } = await signUp(e, n);
    expect(res.error).toBeNull();
    const [r1, r2] = await Promise.all([
      client.rpc("claim_account", { p_nonce: n }), client.rpc("claim_account", { p_nonce: n })]);
    const statuses = [r1, r2].map((r) => (r.data as { status?: string } | null)?.status ?? "refused").sort();
    expect(statuses).toEqual(["already", "claimed"]);
    expect(runSql(`select used_count from invite_codes where id = '${code.id}'`)).toBe("1");
    expect(runSql(`select count(*) from day_templates t join auth.users u on u.id = t.user_id
      where u.email = '${e}'`)).toBe("1");
  });
});
```

The other cases, each its own `it` in the same file with the same helpers:

| Case | Setup | Assertion |
|---|---|---|
| repeated claim, same email, `max_uses = 1` | `reserve(code, e, n1)` then `reserve(code, e, n2)` | both `true`; first claim row `cancelled`, second `reserved` |
| a second request between the hook and the email link (audit plan r5 finding 2) | `reserve(code, e, n1)`; `signUp(e, n1)` (claim now `hooked`); `reserve(code, e, n2)`; then `claim_account(n1)` as the new user | the second `reserve` is `false` and inserts nothing; the `hooked` claim is unchanged; `claim_account` answers `claimed`; `used_count = 1` |
| nonce of another email | `reserve(code, e1, n)`; `signUp(e2, n)` | `res.error` message contains `invite_required`; no `auth.users` row for `e2` |
| expired reservation | `reserve`; `update invite_claims set expires_at = now() - interval '1 minute'`; `signUp(e, n)` | refused as above |
| no matching nonce | `signUp` as an admin-created user (in `admin-bypass.test.ts`), `claim_account(nonce())` | `error` not null; no `account_claims` row |
| `claim_account` writes claim + template | as the first test, one call | `account_claims.seed_policy = 'default'`, `invite_id` = code id, 1 template, 4 slots; the claim row is `consumed` and **still** has `hook_user_id` = the user's id and a `hooked_at` |
| admin-created user with a valid new code (audit plan r4 finding 1) | `createTrustedAdminUser`; `reserve(newCode, itsEmail, n)` (as the claim route does); sign in; `claim_account(n)` and `claim_account()` | both refused; no `account_claims` row, no template, `used_count = 0` |
| cross-browser finish | `reserve`, `signUp(e, n)` on client 1; on client 2 sign in as the same user; `claim_account()` with no nonce | `claimed`; `used_count = 1` |
| hook without a user id | call `hook_before_user_created` directly as `supabase_auth_admin` with an event whose `user.id` is missing | `{ "error": { "http_code": 403, "message": "invite_required" } }`; claim stays `reserved` |
| abandoned sign-up | `reserve`, `signUp`, no `claim_account` | `used_count = 0`, claim `hooked`, `expires_at` about now + 24 h |
| password sign-up without a nonce | `signUp(email())` | refused (`invite_required`) |
| full code | `max_uses = 1`, one full claim done; `reserve(code, e3, n3)` | `false` |
| replacement invite on another code after expiry (audit plan r8 finding 2) | `reserve(codeX, e, n1)`; `update invite_claims set expires_at = now() - interval '1 minute'` for it; `reserve(codeY, e, n2)`; `signUp(e, n2)`; `claim_account(n2)` | second `reserve` is `true`; the codeX claim is `cancelled`; claim `claimed`; codeY `used_count = 1`, codeX `used_count = 0` |
| replacement on another code before expiry | `reserve(codeX, e, n1)`; `reserve(codeY, e, n2)` | both `true`; codeX claim `cancelled`, codeY claim `reserved` |
| a failed replacement leaves the old claim usable (audit plan r9 finding 1) | `reserve(codeX, e, n1)`; then `reserve(codeY, e, n2)` three times, with codeY revoked, expired, and full | each `false`; the codeX claim stays `reserved` with its nonce; `signUp(e, n1)` and `claim_account(n1)` succeed |

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the three functions exactly as spec 1.4 steps 2, 4, 5 (lock the code row `for update`; take a per-email lock (`pg_advisory_xact_lock(hashtext(email_normalized))`); **validate the new code first** — not revoked, not expired, and `used_count + (unexpired reserved/hooked claims of other emails on it) < max_uses` — and on any failure return the generic answer and change nothing (audit plan r9 finding 1: a mistyped or dead code must not cancel a working reservation); only then, in the same transaction, cancel **every `reserved` claim of the same email on any code** (expired or not) and insert the new one, so an abandoned reservation on code X never blocks a replacement on code Y (audit plan r8 finding 2); and **never cancel a `hooked` claim**: when the email already has a `hooked` claim (on any code), `claim_invite` returns the generic failure and reserves nothing (an account with that email already exists; it finishes by `claim_account()` or by Devin's human step 0) (audit plan r5 finding 2; the user finishes by opening the email link that is already on its way); the hook's error shape `{ "error": { "http_code": 403, "message": "invite_required" } }`; `claim_account` idempotent on an existing claim, and for `default` without templates it calls `create_default_template`; the `hooked`-only rule and the hook binding above). Grants: `claim_invite` service_role; `hook_before_user_created` `grant execute … to supabase_auth_admin; revoke … from public, anon, authenticated;` plus `grant usage on schema public to supabase_auth_admin` and select/update on `invite_claims` to `supabase_auth_admin` if the function is not `security definer` (it is, per spec). Add to `supabase/config.toml`:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_before_user_created"
```

- [ ] **Step 4: Run and see them pass** — restart the local stack so the hook config loads (`pnpm exec supabase stop --no-backup && pnpm exec supabase start`, then the README "Local DB tests" exports), then the test files only.
- [ ] **Step 5: Commit** — `git commit -am "feat: invite codes, nonce-bound sign-up hook, claim_account"`

### Task 3: The claim route (the only plain-code entry)

**Files:** `app/api/auth/invite/claim/route.ts`, `lib/server/invite.ts`, `tests/invite/claim-route.test.ts` (mocked admin)

- [ ] **Step 1: Failing tests** — 200 `{ nonce }` when `claim_invite` returns true; the same generic `400 { error: "invite_unavailable" }` for a bad code, an expired code, a revoked code and a full code (four cases, identical bodies); 429 when any of the three limits trips; the limiter keys are `invite:ip:<64 hex>`, `invite:email:<64 hex>`, `invite:all`; the nonce is 43 base64url characters and the RPC receives only its sha256; the plain code never appears in a `console.*` call (spy).
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/invite/claim-route.test.ts`.
- [ ] **Step 3: Implement.** Body schema `z.object({ email: z.email(), code: z.string().min(4).max(32) })`, 4 KB limit.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit.**

### Task 4: One gate for scripts and tests (spec 1.6)

**Files:** `scripts/lib/gated-user.ts`, `tests/helpers/supabase.ts`, every admin caller in "Current code", `tests/rls/admin-bypass.test.ts`, `tests/tenancy/no-admin-create.test.ts`

- [ ] **Step 1: Failing guard test**

```ts
// tests/tenancy/no-admin-create.test.ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
const ALLOWED = new Set(["scripts/lib/gated-user.ts", "tests/helpers/supabase.ts", "app/api/dev/sign-in/route.ts"]);
const BAD = /auth\.admin\.createUser\(|generateLink\(/;
describe("admin user creation only through the gated helpers (spec 1.6)", () => {
  it("has no other caller", () => {
    const files = ["app", "lib", "scripts", "tests"].flatMap((d) =>
      (readdirSync(d, { recursive: true }) as string[]).map((f) => `${d}/${f}`))
      .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && f !== "tests/tenancy/no-admin-create.test.ts");
    expect(files.filter((f) => !ALLOWED.has(f) && BAD.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail** (lists the 12 callers).
- [ ] **Step 3: Implement** `createInvitedUser` (service role creates a one-use code, `claim_invite`, anon `signUp` with the nonce, sign in, `claim_account`; every client it builds sends `global.headers["x-smc-client"] = String(CLIENT_BUILD)` from `lib/client-build.ts` once slice 6 adds it — an option `{ clientBuild?: string | null }` lets a test build an old client, `null` = no header; audit plan r7 finding 4) and `createTrustedAdminUser` (admin `createUser`, used only by `tests/rls/admin-bypass.test.ts`). Move each caller. `scripts/readiness/new-user-walk.mjs` refuses a URL whose host is the production project ref (read it from `.env.example`'s documented variable, or refuse any host not `127.0.0.1`/`localhost`/a branch ref passed with `--target`).
- [ ] **Step 4: Run** — `pnpm exec vitest run tests/tenancy/no-admin-create.test.ts` (PASS) and each moved DB test file against the local stack.
- [ ] **Step 5: Commit.**

### Task 5: `unclaimed` gate state and the hidden UI

**Files:** `components/AuthGate.tsx`, `components/InviteSignUp.tsx`, `lib/invite/client.ts`, `app/sign-in/page.tsx`, `tests/invite/auth-gate-unclaimed.test.tsx`, `tests/invite/sign-up-ui.test.tsx` (jsdom)

- [ ] **Step 1: Failing tests** — with `NEXT_PUBLIC_INVITE_SIGNUP` unset, `/sign-in` renders no "New here?"; with `=1` it renders email + code fields; submit calls the claim route, stores the nonce in `sessionStorage` `smc:invite-nonce`, then `signInWithOtp` with `shouldCreateUser: true` and `options.data.invite_nonce`; after sign-in with a stored nonce, `AuthGate` calls `claim_account(nonce)` and clears the nonce; a signed-in account with no `account_claims` row and no nonce calls `claim_account()` once; if that is refused, it shows "This account is not set up yet. Please contact the person who invited you, so they can finish it." with a Retry button that calls `claim_account()` again (the `unclaimed` view: no code field, no claim-route call; audit plan r13 finding 5 — a new invite cannot work while this email has a `hooked` claim, and the fix is Devin's human step 0); the plain Sign in form still shows PR #246's neutral "If this email has an account, we sent a sign-in link." for an unknown address, with and without the flag (audit plan r4 finding 10).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** `unclaimed` is decided after the onboarding read: read `account_claims` for `auth.uid()` (RLS select). A `manual` account is never `unclaimed`.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit.**

### Task 6: Operations scripts and the probe on `p9-tenancy`

**Files:** `scripts/invite.ts` (`create [--uses N] [--days N] [--label L]`, `list`, `revoke <id>`; 10 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, grouped `XXXX-XXXX-XX`; prints the plain code once), `scripts/invite-probe.ts --target <url>` (probes 1–5 of spec 1.5; deletes the users it made; refuses a production URL unless `--i-am-devin-on-production`), `tests/invite/invite-script.test.ts` (code format and alphabet; `revoke` sets `revoked_at`).

- [ ] **Step 1–4:** TDD for the code generator and argument parsing (no DB). The probe itself is run, not unit-tested.
- [ ] **Step 5: Gate** — apply both migrations to `p9-tenancy` (`SUPABASE_PROJECT_REF=<branch ref> python3 scripts/apply-migrations.py`, dry run lists exactly `20261105090000`, `20261105090100`, then `--commit`, then `scripts/p9/check-sync-guard.sql`). Enable the hook on the branch: branches read `supabase/config.toml` on creation; if the branch predates this config, Devin enables the hook for the branch in the dashboard (human step) — never on production. Run `pnpm exec tsx scripts/invite-probe.ts --target <p9-tenancy url>`. Expected: probes 1 and 2 refused, 3 created and `used_count` +1, 4 refused, 5 reads the probe-3 user's claim **after** finalization: `state = 'consumed'`, `hook_user_id` = that user's `auth.users.id`, `hooked_at` not null (the durable hook evidence; audit plan r4 finding 11). Probe 5 also records the claim's state between sign-up and `claim_account` (`hooked`, captured by probe 3 before it finalizes). Save the output in the PR body. **If probe 5 fails**, the gate fails: record the open BLOCK (spec 1.5, Open for Devin 8) and keep the UI flag off.
- [ ] **Step 6: Fast gates, push, PR (unmerged), review to `docs/audit/code/`.**

## Preview test steps

Needs the `p9-tenancy` branch as the preview's database and `NEXT_PUBLIC_INVITE_SIGNUP=1` set on the
**Preview** environment for this branch only (Devin sets it; never Production).

1. Devin creates a code against `p9-tenancy`: `pnpm exec tsx scripts/invite.ts create --uses 1 --days 1 --label preview-test`.
2. On the preview, `/sign-in` → "New here?" → a new address + the code → the email arrives → open
   it on the **same** browser. Expected: the app opens onboarding (a fresh account). In the branch,
   `invite_codes.used_count` = 1, `account_claims.seed_policy` = `default`, one `everyday` template.
3. Try the same code with another address. Expected: the generic "That invite does not work" message.
4. With a second new address and a second code, sign up in browser 1, but open the email link in
   a **different** browser (no nonce there): expected the app finishes setup by itself (no code
   asked); `used_count` of that code = 1.
5. `/sign-in` with a new address and no code (plain Sign in). Expected: PR #246's neutral screen
   "If this email has an account, we sent a sign-in link."; no email arrives; no user is created.
6. Devin adds a user in the `p9-tenancy` dashboard (Authentication → Add user; no invite, so no
   hook ran) and signs in as it: expected "This account is not set up yet. Please contact the person
   who invited you, so they can finish it." with Retry;
   nothing on screen can finish it, and no template is created.
7. Sasha's copy on the branch (after the restore) signs in as before; no invite screen.

## Rollback

**First response to any problem is not a down file** (audit plan r8 finding 3): turn the invite flag
off, disable the before-user-created hook in the dashboard and turn hosted sign-up off. That stops
all new sign-ups and changes no data.

Code: revert the merge commit (the claim route and UI go; existing accounts are not touched).

Database, only in the free window: `down/20261105090100_invites.down.sql` starts with a guard that
refuses, and changes nothing, while any `invite_claims` row is `hooked` or `consumed`, or any
`account_claims` row has `seed_policy = 'default'` or a non-null `invite_id` (the claim and usage
evidence of a real account). So it can run only before the first real sign-up. After that, M5 is
roll-forward only: fix it in a new migration. Before running any down file on production, Devin
takes a backup with `scripts/backup.sh` and checks it restores into `p9-tenancy`
(`scripts/restore-to-branch.sh`), with the ledger check (slice 7) passing on the restore. Then
`down/20261105090000_shared_rate_limit.down.sql` (it holds only counters). The hook must be
disabled before either down file runs (a hook pointing at a dropped function blocks all sign-ups).

Drill (slice 5 gate, on `p9-tenancy`, after the probe left a `consumed` claim): run the invites
down file → it raises "M5 rollback refused" and changes nothing (row counts and
`ledger-check.sql` unchanged). Add it to `tests/migrations/down-coverage.test.ts` as a DB case in a
rolled-back transaction: with one `consumed` claim, the down file raises; with none, it succeeds.

## Human steps for Devin

0. An account whose `hooked` claim expired before `claim_account` ran stays unclaimed. To finish
   it (only while its code still has a free use), Devin runs, on the target, as the service role:
   `update invite_claims set expires_at = now() + interval '1 hour' where hook_user_id = '<id>'`
   and asks the user to reopen the app (it calls `claim_account()`).

1. Set `NEXT_PUBLIC_INVITE_SIGNUP=1` on the Preview environment of this branch only, to test.
2. If the `p9-tenancy` branch did not pick up the hook from `config.toml`, enable it for the branch
   in the dashboard.
3. Production (later, rollout step 6): activate the hook, turn sign-up on, run
   `scripts/invite-probe.ts --target <production> --i-am-devin-on-production` probes 1–5 at once,
   and turn sign-up off again on any failure. Then (step 7) the production flag.
