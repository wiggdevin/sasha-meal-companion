/**
 * Phase 14 slice 1 — 20261117090000_voice_ears.sql, the live-dictation minute ledger.
 *
 * The text half pins what a careless edit would break (service-role only, RLS forced, the per-user
 * lock before the checks). The branch half runs the real functions: one open token per user, the
 * daily cap charging every non-refused token its whole reservation (a close frees the slot but
 * never lowers the charge), the refund on refuse, and that a signed-in user cannot call them.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, ensureUser, HAS_BRANCH, userClient, type TestUser }
  from "../helpers/supabase";

const NAME = "20261117090000_voice_ears";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql (text)`, () => {
  it("forces RLS on the ledger and gives it to the service role only", () => {
    expect(UP).toContain("alter table voice_ears enable row level security");
    expect(UP).toContain("alter table voice_ears force row level security");
    expect(UP).toContain("revoke all on table voice_ears from anon, authenticated");
    expect(UP).toContain("grant all on table voice_ears to service_role");
  });

  it("revokes every function from authenticated and grants it to service_role", () => {
    for (const sig of ["voice_ears_open(uuid, integer, integer)",
      "voice_ears_close(uuid, uuid)", "voice_ears_refuse(uuid, uuid)"]) {
      expect(UP).toContain(`revoke execute on function ${sig} from public, anon, authenticated`);
      expect(UP).toContain(`grant execute on function ${sig} to service_role`);
    }
  });

  it("has no way for a reported duration to lower a charge", () => {
    expect(UP).not.toMatch(/used_seconds\s+integer\s*,\s*p_floor/);
    expect(UP).not.toContain("charged_seconds");
    expect(UP).toContain("sum(v.reserved_seconds)");
  });

  it("takes the per-user lock before it checks anything", () => {
    const lock = UP.indexOf("pg_advisory_xact_lock");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(UP.indexOf("'busy'"));
    expect(lock).toBeLessThan(UP.indexOf("'exhausted'"));
  });

  it("down drops the three functions and the table", () => {
    expect(DOWN).toContain("drop function if exists voice_ears_open(uuid, integer, integer)");
    expect(DOWN).toContain("drop function if exists voice_ears_close(uuid, uuid)");
    expect(DOWN).toContain("drop function if exists voice_ears_refuse(uuid, uuid)");
    expect(DOWN).toContain("drop table if exists voice_ears");
  });
});

describe.skipIf(!HAS_BRANCH)(`${NAME} (branch)`, () => {
  let admin: SupabaseClient;
  let user: TestUser;

  const clear = async () => {
    const { error } = await admin.from("voice_ears").delete().eq("user_id", user.id);
    if (error) throw error;
  };
  const openRow = async (reserved = 90, cap = 1800) => {
    const { data, error } = await admin.rpc("voice_ears_open", {
      p_user_id: user.id, p_reserved_seconds: reserved, p_daily_cap_seconds: cap,
    });
    if (error) throw error;
    return (data as { outcome: string; ears_id: string | null }[])[0];
  };

  beforeAll(async () => {
    admin = adminClient();
    user = await ensureUser("a");
    await clear();
  });
  afterAll(async () => { await clear(); });

  const close = async (id: string | null) => (await admin.rpc("voice_ears_close", {
    p_user_id: user.id, p_ears_id: id })).data as boolean;

  it("allows one open token at a time, and again once it is closed", async () => {
    await clear();
    const first = await openRow();
    expect(first.outcome).toBe("ok");
    expect((await openRow()).outcome).toBe("busy");
    expect(await close(first.ears_id)).toBe(true);
    expect(await close(first.ears_id)).toBe(false);
    expect((await openRow()).outcome).toBe("ok");
  });

  it("serialises concurrent opens: exactly one of five wins", async () => {
    await clear();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => openRow()));
    expect(outcomes.filter((o) => o.outcome === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "busy")).toHaveLength(4);
  });

  it("charges every token its whole reservation, closed or not; a refused one is free", async () => {
    await clear();
    const refused = await openRow(40, 100);
    await admin.rpc("voice_ears_refuse", { p_user_id: user.id, p_ears_id: refused.ears_id });
    const first = await openRow(40, 100);
    expect(first.outcome).toBe("ok");
    expect(await close(first.ears_id)).toBe(true);
    const second = await openRow(40, 100);
    expect(second.outcome).toBe("ok");
    await close(second.ears_id);
    // 80 charged; another 40 would reach 120 > 100, closed early or not.
    expect((await openRow(40, 100)).outcome).toBe("exhausted");
    expect((await openRow(20, 100)).outcome).toBe("ok");
  });

  it("does not let one user close another's token", async () => {
    await clear();
    const row = await openRow();
    const other = await ensureUser("b");
    const { data } = await admin.rpc("voice_ears_close", { p_user_id: other.id, p_ears_id: row.ears_id });
    expect(data).toBe(false);
    expect((await openRow()).outcome).toBe("busy");
  });

  it("refuses a signed-in user calling the functions directly", async () => {
    const client = await userClient(user);
    const { error } = await client.rpc("voice_ears_open", {
      p_user_id: user.id, p_reserved_seconds: 90, p_daily_cap_seconds: 1800 });
    expect(error).not.toBeNull();
    const read = await client.from("voice_ears").select("id");
    expect(read.error ?? (read.data ?? []).length === 0).toBeTruthy();
  });
});
