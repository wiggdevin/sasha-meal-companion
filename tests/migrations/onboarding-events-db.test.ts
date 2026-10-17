/**
 * Followups #18 fix: `onboarding_event_shape_valid` (migration 20261226090200), referenced by
 * tests/profile/onboarding-events-route.test.ts as the place the store's own shape-matching runs
 * on a real stack.
 *
 * GPT-6 Sol BLOCK: the function could return SQL NULL for a kind missing its required field (e.g.
 * `step_left` with no step) -- every branch is an AND-chain over nullable inputs, and
 * `x in (...)`/`x is null` against a NULL input makes the whole chain NULL, not false. Postgres's
 * CHECK constraint treats NULL as satisfied, so the table's own defence-in-depth silently passed
 * exactly the row it exists to refuse. Fixed by wrapping the whole `case` in
 * `coalesce(..., false)`. A second, unrelated defect in the same function (a `when 'a', 'b' then`
 * multi-value branch, which is not valid simple-CASE syntax) blocked this migration from applying
 * at all; both are fixed in the same edit.
 *
 * Since W070 (20270105140000, 20270105140300) `authenticated` cannot insert at all, so the table's
 * own CHECK is probed as the service role, and the service-role batch writer
 * `record_onboarding_events_for` is checked here too.
 *
 * Text checks run in every shard. The database check needs a verified local stack
 * (SUPABASE_TEST_URL / SUPABASE_TEST_DB_URL / SUPABASE_TEST_SERVICE_ROLE_KEY all loopback,
 * `tests/tenancy/local-only` asserts it) and is skipped without one.
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";
import { assertLocalTargets } from "../tenancy/target-guard";

const UP = readFileSync("supabase/migrations/20261226090200_onboarding_events.sql", "utf8");
const FN = UP.slice(
  UP.indexOf("create function public.onboarding_event_shape_valid"),
  UP.indexOf("comment on function public.onboarding_event_shape_valid"),
);

describe("20261226090200 onboarding_event_shape_valid (text)", () => {
  it("never leaves a bare `case` to hand SQL NULL to the CHECK: the whole result is coalesced false", () => {
    expect(FN).toMatch(/coalesce\(\s*case p_kind/);
  });

  it("has no invalid multi-value WHEN branch (`when 'a', 'b' then`), which Postgres' simple CASE rejects", () => {
    expect(FN).not.toMatch(/when\s+'[a-zA-Z_]+'\s*,\s*'[a-zA-Z_]+'\s+then/);
  });

  it("gives step_left and step_abandoned their own WHEN branch", () => {
    expect(FN).toMatch(/when 'step_left' then/);
    expect(FN).toMatch(/when 'step_abandoned' then/);
  });
});

describe.skipIf(!HAS_BRANCH || !HAS_DB)("onboarding_events shape (database)", () => {
  let a: TestUser;
  const clear = () => runSql(`delete from public.onboarding_events where user_id = '${a.id}'`);

  beforeAll(async () => {
    assertLocalTargets();
    a = await ensureUser("a");
    clear();
  });
  afterAll(() => clear());

  it("refuses a direct insert of step_left with no step -- the table's own CHECK, not only the RPC's filter", async () => {
    const client = adminClient();
    const { error } = await client.from("onboarding_events").insert({
      client_event_id: crypto.randomUUID(), at: new Date().toISOString(), flow_version: "onboarding_v2",
      kind: "step_left", step: null, duration_ms: 1000, user_id: a.id,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514"); // check_violation
    expect(runSql(`select count(*) from public.onboarding_events where user_id = '${a.id}'`)).toBe("0");
  });

  it("refuses step_entered carrying a duration (a field only *_left/*_abandoned may hold)", async () => {
    const client = adminClient();
    const { error } = await client.from("onboarding_events").insert({
      client_event_id: crypto.randomUUID(), at: new Date().toISOString(), flow_version: "onboarding_v2",
      kind: "step_entered", step: "facts", duration_ms: 500, user_id: a.id,
    });
    expect(error?.code).toBe("23514");
  });

  it("still accepts a well-shaped step_left row", async () => {
    const client = adminClient();
    const id = crypto.randomUUID();
    const { error } = await client.from("onboarding_events").insert({
      client_event_id: id, at: new Date().toISOString(), flow_version: "onboarding_v2",
      kind: "step_left", step: "facts", duration_ms: 1000, user_id: a.id,
    });
    expect(error).toBeNull();
    expect(runSql(`select count(*) from public.onboarding_events where client_event_id = '${id}'`)).toBe("1");
  });

  it("still accepts a well-shaped step_abandoned row", async () => {
    const client = adminClient();
    const id = crypto.randomUUID();
    const { error } = await client.from("onboarding_events").insert({
      client_event_id: id, at: new Date().toISOString(), flow_version: "onboarding_v2",
      kind: "step_abandoned", step: "intro", duration_ms: 0, user_id: a.id,
    });
    expect(error).toBeNull();
    expect(runSql(`select count(*) from public.onboarding_events where client_event_id = '${id}'`)).toBe("1");
  });

  it("refuses a direct authenticated insert with 42501 (W070)", async () => {
    const client = await userClient(a);
    const id = crypto.randomUUID();
    const { error } = await client.from("onboarding_events").insert({
      client_event_id: id, at: new Date().toISOString(), flow_version: "onboarding_v2",
      kind: "step_entered", step: "facts", user_id: a.id,
    });
    expect(error?.code).toBe("42501");
    expect(runSql(`select count(*) from public.onboarding_events where client_event_id = '${id}'`)).toBe("0");
  });

  it("record_onboarding_events_for stores under the given user, skips a bad shape and dedupes a retry", async () => {
    const good = { client_event_id: crypto.randomUUID(), at: new Date().toISOString(),
      flow_version: "onboarding_v2", kind: "step_entered", step: "facts" };
    const bad = { ...good, client_event_id: crypto.randomUUID(), kind: "step_left" };
    const first = await adminClient().rpc("record_onboarding_events_for",
      { p_user_id: a.id, p_events: [good, bad] });
    expect(first.error).toBeNull();
    expect(first.data).toEqual([{ inserted: 1, duplicates: 0, rejected: 1 }]);
    const again = await adminClient().rpc("record_onboarding_events_for",
      { p_user_id: a.id, p_events: [good, good] });
    expect(again.data).toEqual([{ inserted: 0, duplicates: 2, rejected: 0 }]);
    expect(runSql(`select user_id || '|' || count(*) from public.onboarding_events
      where client_event_id = '${good.client_event_id}' group by user_id`)).toBe(`${a.id}|1`);
  });
});
