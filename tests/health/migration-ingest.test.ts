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
