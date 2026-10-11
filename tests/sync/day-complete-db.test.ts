// TDEE step E6 (docs/specs/phase-16-adaptive-handoff.md): the "day fully logged" mark syncs with
// the omit/keep, null/clear rule, and the day marking began is stored once and never moves
// (ruling R3, audit 2026-10-10 P20).  [needs branch]
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, HAS_BRANCH, userClient, type TestUser } from "../helpers/supabase";

const run = HAS_BRANCH ? describe : describe.skip;

run("plan_days.day_complete_at on a real database", () => {
  let user: TestUser; let other: TestUser;
  let client: SupabaseClient; let otherClient: SupabaseClient; let admin: SupabaseClient;
  const revs = new Map<string, number>();

  beforeAll(async () => {
    admin = adminClient();
    async function temporaryUser(): Promise<TestUser> {
      const email = `day-mark-${crypto.randomUUID()}@meal-companion.test`;
      const password = `Local-${crypto.randomUUID()}-1`;
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error || !result.data.user) throw result.error ?? new Error("Test user failed");
      return { id: result.data.user.id, email, password };
    }
    user = await temporaryUser(); other = await temporaryUser();
    client = await userClient(user); otherClient = await userClient(other);
    const settings = await admin.from("user_settings").upsert({ user_id: user.id,
      first_opened_at: "2026-09-01T00:00:00Z" });
    expect(settings.error).toBeNull();
  });

  afterAll(async () => {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
    if (other?.id) await admin.auth.admin.deleteUser(other.id);
  });

  async function write(date: string, payload: Record<string, unknown>) {
    const base = revs.get(date) ?? null;
    const result = await client.rpc("apply_sync_op", { p_user_id: user.id, p_op: {
      op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
      kind: base === null ? "create" : "update", base_rev: base,
      payload: { local_date: date, ...payload }, client_ts: new Date().toISOString() } });
    expect(result.error).toBeNull();
    expect(result.data.status).toBe("applied");
    revs.set(date, result.data.rev);
  }
  const day = async (date: string) => (await client.from("plan_days")
    .select("day_complete_at, floor_day").eq("local_date", date).single()).data;
  const startedOn = async () => (await admin.from("user_settings")
    .select("day_marks_started_on").eq("user_id", user.id).single()).data?.day_marks_started_on;

  it("stores a mark, keeps it when the key is omitted, and clears it on null", async () => {
    expect(await startedOn()).toBeNull();
    await write("2099-10-10", { floor_day: false, day_complete_at: "2099-10-10T21:30:00Z" });
    expect(new Date((await day("2099-10-10"))?.day_complete_at).toISOString())
      .toBe("2099-10-10T21:30:00.000Z");
    await write("2099-10-10", { floor_day: true });
    expect((await day("2099-10-10"))?.day_complete_at).not.toBeNull();
    await write("2099-10-10", { day_complete_at: null });
    expect((await day("2099-10-10"))?.day_complete_at).toBeNull();
  });

  it("records the day marking began, never a marked date, and never moves it (R3, audit P20)", async () => {
    // The account has no stored zone, so its day is the UTC date (migration 20261231130000).
    const today = new Date().toISOString().slice(0, 10);
    const started = await startedOn();
    expect([today, new Date(Date.now() - 60_000).toISOString().slice(0, 10)]).toContain(started);
    await write("2099-10-20", { day_complete_at: "2099-10-20T21:00:00Z" });
    expect(await startedOn()).toBe(started);
    await write("2099-10-05", { day_complete_at: "2099-10-05T21:00:00Z" });
    expect(await startedOn()).toBe(started);
    await write("2099-10-05", { day_complete_at: null });
    expect(await startedOn()).toBe(started);
  });

  it("puts the mark in the sync feed and keeps it from another account", async () => {
    const feed = await client.rpc("sync_changes", { p_user_id: user.id, p_since: 0, p_limit: 500 });
    expect(feed.error).toBeNull();
    const rows = (feed.data as { entity_key: string; current: { day_complete_at?: string } }[])
      .filter((row) => row.entity_key === "2099-10-20");
    expect(rows.at(-1)?.current.day_complete_at).toBeTruthy();
    const foreign = await otherClient.from("plan_days").select("day_complete_at")
      .eq("user_id", user.id);
    expect(foreign.data ?? []).toEqual([]);
    const foreignSettings = await otherClient.from("user_settings").select("day_marks_started_on")
      .eq("user_id", user.id);
    expect(foreignSettings.data ?? []).toEqual([]);
  });
});
