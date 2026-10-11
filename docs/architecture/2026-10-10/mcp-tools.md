# MCP tool surface

Audit date: 2026-10-10. Diagram: `mcp-tools-dd.html`. All paths are repo-relative.

The MCP server is one route, `app/api/mcp/route.ts`. It serves six tools. Every tool
runs on the service-role client. None runs under RLS. Tenant isolation is code
discipline: each query adds `.eq("user_id", userId)` with the id taken from the
token row.

## Token life cycle

**Issue.** One path: `scripts/mint-token.ts` (an operator runs it with the service key).
- `mintToken()` makes `smc_` plus 32 random bytes, base64url (`lib/server/tokens.ts:21-24`).
- The script stores only the SHA-256 hash, sent as a `\x…` bytea literal
  (`lib/server/tokens.ts:11-13`, `:31-33`; `scripts/mint-token.ts:31-34`).
- The raw token prints once (`scripts/mint-token.ts:46`).
- Scopes allowed: `read`, `log:write`, `constraints:write`
  (`scripts/mint-token.ts:14`, DB check `supabase/migrations/20261003000000_phase7_token_scopes.sql:4-6`).
- The script never sets `expires_at`.
- No app route or UI issues, lists or revokes tokens.

**Table.** `api_tokens` (`supabase/migrations/20260911000400_privileged.sql:3-7`):
`token_hash bytea unique`, `scopes text[]`, `expires_at`, `revoked_at`, `last_used_at`.
Since `20261015000000_lock_api_tokens_writes.sql:16-19`, `authenticated` can only
SELECT its own rows. Insert, update and delete are revoked.

**Check.** `withTokenUser` (`lib/server/privileged.ts:24-50`):
1. Read `Authorization: Bearer …`. A missing or empty value gives 401 (`:29-30`).
2. Call `lookup_api_token(p_token_hash)` on the admin client (`:33-35`).
3. The RPC (`supabase/migrations/20260911000600_rpc.sql:69-82`) is `security definer`,
   granted to `service_role` only. It returns a row only when the hash matches, the
   token is not revoked and `expires_at` is null or in the future. It sets
   `last_used_at` in the same statement.
4. No row, or an empty `user_id`, gives 401 (`:40-42`). A failed RPC also gives 401 (`:36`).
5. The route's required scope must be in the row's `scopes`, else 403 (`:45-47`).
6. The callback gets `{ userId: row.user_id, tokenId, scopes }` and the admin client (`:49`).

**Revoke.** The RPC `revoke_api_token(p_user_id, p_token_id)` exists
(`supabase/migrations/20260911000600_rpc.sql:56-66`). Nothing in `app/`, `lib/` or
`components/` calls it. Only a test does (`tests/rls/cross-user.test.ts:193`).

## Request path (`app/api/mcp/route.ts`, `guarded`, lines 101-134)

1. Rate limit `mcp:pre:<sha256(token) hex>`, 30 per 60 s (`:35-43`, `:103`). With no
   bearer header the key is `mcp:pre:none:ip:<x-real-ip>`.
2. Rate limit `mcp:pre:ip:<x-real-ip>`, 30 per 60 s (`:45-47`, `:104`).
3. Read the body, cap 64 KB, else 413 (`:89-99`).
4. `withTokenUser(req, scopeForBody(raw), …)` (`:107`). The scope for the first check
   is the first non-`read` scope named by any `tools/call` in the body (`:84-87`).
5. Rate limit `mcp:<tokenId>`, 60 per 60 s (`:108`).
6. Re-check every non-`read` scope named in the body, else 403 (`:118-122`). Batches
   are covered (`:66`).
7. Build a fresh MCP handler per request, bound to `ctx.userId` and the admin client
   (`:20-30`, `:127`).

All three limiter calls use the default `fail_closed` policy. Limiter errors give 503.
The limiter is `lib/server/ratelimit.ts` (Postgres `rate_limit_hit`).

## Tool list

Scope map: `HEALTH_TOOL_SCOPES`, `EXPENDITURE_TOOL_SCOPES`, `COACH_TOOL_SCOPES`, merged at
`app/api/mcp/route.ts:51-55`. All six run on `ctx.admin` (the service-role client, from
`lib/server/admin.ts:14-28`). The user id never comes from tool arguments.

| Tool | Scope | Reads | Writes | User scoping (quoted) |
|---|---|---|---|---|
| `get_body_data` (`lib/mcp/health-tools.ts:20-40`) | read | `health_samples`, with embed `health_sources(kind)` | none | `lib/server/health-daily.ts:74` `.eq("user_id", userId)` |
| `get_expenditure_status` (`lib/mcp/expenditure-tools.ts:28-46`) | read | `expenditure_estimates`; `user_settings` (time zone, profile seed); `target_profiles` (frozen seed) | none | `lib/server/expenditure.ts:207` `.eq("user_id", userId)`; `lib/server/account-day.ts:86` `.eq("user_id", userId)`; `lib/server/profile-tdee.ts:52` `.eq("user_id", userId)`; `lib/server/targets.ts:53` `.eq("user_id", userId)` |
| `get_targets` (`lib/mcp/expenditure-tools.ts:48-62`) | read | `target_profiles`; `user_settings.time_zone` | none | `lib/server/targets.ts:53` `.eq("user_id", userId)`; `lib/server/account-day.ts:86` |
| `get_constraints` (`lib/mcp/coach-tools.ts:38-46`) | read | `constraint_profiles` | none | `lib/server/constraints.ts:59` `.eq("user_id", userId)` |
| `set_constraints` (`lib/mcp/coach-tools.ts:48-56`) | constraints:write | `constraint_profiles` | `constraint_profiles` (upsert at first write, else compare-and-swap update); DB triggers on that table fire | update: `lib/server/constraints.ts:172` `.eq("user_id", userId).eq("rev", rev)`; insert: `:149` `user_id: userId` in the row, `:163` `upsert(next)` |
| `list_coach_messages` (`lib/mcp/coach-tools.ts:58-81`) | read | `coach_messages` | none | `lib/mcp/coach-tools.ts:73` `.eq("user_id", ctx.userId)`; the optional `threadId` filter (`:74`) is added to it, never in place of it |

No tool calls an RPC. No tool starts a coach turn (`lib/mcp/coach-tools.ts:3-4`).
The `log:write` scope is allowed by the DB check and the route type
(`lib/server/privileged.ts:26`), but no tool uses it.

Input limits: `get_body_data` takes a 90-day window (`lib/mcp/health-tools.ts:33`).
`list_coach_messages` takes at most 100 rows (`lib/mcp/coach-tools.ts:66`).
`set_constraints` is validated by `constraintsPutSchema` (`lib/coach/types.ts:233-246`).

## Scoping check

Method: read every query a tool reaches and look for a missing user filter or a reliance
on RLS. The service role bypasses RLS, so a missing `.eq("user_id")` would be a
cross-tenant read or write.

**Result: no tool lacks a user filter. No tool relies on RLS.** Each table read or written
above carries an explicit filter on the token's user id. A runtime test covers
read and write isolation for A and B tokens
(`tests/tenancy/admin-routes.test.ts:146`).

Findings and risks on this path:

1. **Systemic, medium. No database backstop.** The whole handler gets the service-role
   client (`app/api/mcp/route.ts:127`, `lib/server/privileged.ts:49`). One missed
   `.eq("user_id", …)` in any helper the tools call would leak across tenants. The
   shared helpers carry the filter today. Today's guard is the tenancy test, not the database.
2. **`health_sources(kind)` embed has no user filter of its own.**
   `lib/server/health-daily.ts:38` embeds the source through the `source_id` foreign key.
   The sample rows are filtered by user (`:74`). The embed returns only `kind`. It
   would leak only if a sample pointed at another user's source. No schema rule
   (composite key) prevents that. Low.
3. **`set_constraints` skips the target recompute.**
   `app/api/constraints/route.ts:33-35` calls `recomputeAfterHoldChange` after a
   `conditions` write. `lib/mcp/coach-tools.ts:55` does not. A condition that adds a pace
   hold (pregnancy, eating disorder, kidney disease) set over MCP leaves the active
   target unchanged until another recompute runs. See `lib/server/target-recompute.ts:383-392`.
   Medium: a safety rule does not apply on this path.
4. **First `set_constraints` write is not a compare-and-swap.** With `rev === 0`
   the code upserts without a revision check (`lib/server/constraints.ts:162-167`). Two
   first writers (phone onboarding and an agent) can overwrite each other. The same
   path serves `PUT /api/constraints`. Low.
5. **A `read` token exposes coach chat.** `list_coach_messages` returns `content` of
   every thread kind for the user, including private plan and weekly-review threads
   (`lib/mcp/coach-tools.ts:71-77`). By design, but it is health-adjacent text under the
   lowest scope. `constraints:write` lets an agent remove every allergen rule, subject
   to the review gate (`lib/server/constraints.ts:134-142`).

## Token and rate-limit observations

- **Tokens never expire and cannot be revoked from the app.**
  `scripts/mint-token.ts:32-34` sets no `expires_at`, and nothing calls
  `revoke_api_token`. A leaked token works until someone runs SQL. Medium.
- **The per-token limit of 60/min is unreachable.** The pre-identity limits are 30/min
  per token hash and 30/min per IP (`app/api/mcp/route.ts:33`, `:103-104`). The effective
  ceiling is 30 requests a minute per token. Many tokens behind one IP share 30/min.
  Low (availability, not security).
- **Pre-auth limiter writes before it refuses.** The token-keyed hit runs first
  (`:103`), then the IP hit (`:104`). A caller that sends a new fake token on each
  request creates a new `rate_limits` row each time, even after its IP is over the limit.
  The rows expire, but each request costs two database writes. Put the IP check first.
  Low.
- **The limiter key holds the full token hash.** `mcp:pre:<hex of sha256(token)>`
  (`app/api/mcp/route.ts:42`) is the same value as `api_tokens.token_hash`. The
  `rate_limits` table is service-role only, so exposure is small. A hash cannot
  authenticate without the raw token. Low.
- **Token hashes are readable and backed up.** `authenticated` can SELECT its own
  `api_tokens` rows, hash included (`supabase/migrations/20261015000000_lock_api_tokens_writes.sql:17-18`).
  The backup job also dumps the table to Storage (`app/api/jobs/backup/route.ts:45`).
  A hash of 256 random bits is not reversible. Low.
- **Bearer prefix is case-sensitive.** `bearer` (`lib/server/privileged.ts:17-22`) and
  `preIdentityKey` (`app/api/mcp/route.ts:39`) only accept `Bearer `. A client that sends
  `bearer` gets a 401 and shares the no-token IP bucket. Cosmetic.
- **Every call writes `last_used_at`.** `lookup_api_token` updates the row on each request
  (`supabase/migrations/20260911000600_rpc.sql:76`). A hot token causes row-lock
  contention only. Low.

## What I could not verify

- Scope parsing assumes the MCP SDK reads the same JSON body the route pre-parses
  (the route replays the exact raw text, `app/api/mcp/route.ts:124-126`). Tests for the
  tool-name parser were not read.
- RLS state of `health_samples` through the embed was not tested against a live database.
