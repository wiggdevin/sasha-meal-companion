import { describe, expect, it } from "vitest";
import { adminClient, ensureUser, HAS_BRANCH } from "@/tests/helpers/supabase";

describe.skipIf(!HAS_BRANCH)("ai_calls capture migration [needs branch]", () => {
  it("accepts each of the six status values and refuses a seventh", async () => {
    const admin = adminClient();
    const user = await ensureUser("a");
    const base = {
      user_id: user.id, purpose: "textToItems", provider: "google",
      model_id: "gemini-3.8-flash", sdk_version: "2.21.0", input_hash: "\\x00", cost_estimate: 0,
    };
    for (const status of ["ok", "schema_invalid", "provider_error", "timeout", "blocked", "error"]) {
      const { error } = await admin.from("ai_calls").insert({ ...base, status });
      expect(error, status).toBeNull();
    }
    const bad = await admin.from("ai_calls").insert({ ...base, status: "weird" });
    expect(bad.error?.code).toBe("23514");
    await admin.from("ai_calls").delete().eq("user_id", user.id);
  });

  it("ai_calls_today counts only today's ok rows in the caller's zone", async () => {
    const admin = adminClient();
    const user = await ensureUser("a");
    await admin.from("ai_calls").delete().eq("user_id", user.id);
    const base = {
      user_id: user.id, purpose: "textToItems", provider: "google",
      model_id: "gemini-3.8-flash", sdk_version: "2.21.0", input_hash: "\\x00", cost_estimate: 0,
    };
    const nowIso = new Date().toISOString();
    const ins = await admin.from("ai_calls").insert([
      { ...base, status: "ok", created_at: nowIso },
      { ...base, status: "ok", created_at: nowIso },
      { ...base, status: "blocked", created_at: nowIso },
      { ...base, status: "ok", created_at: "2020-01-01T00:00:00Z" },
    ]);
    expect(ins.error).toBeNull();
    const { data, error } = await admin.rpc("ai_calls_today", {
      p_user_id: user.id, p_tz: "America/New_York",
    });
    expect(error).toBeNull();
    expect(data).toBe(2);
    await admin.from("ai_calls").delete().eq("user_id", user.id);
  });
});
