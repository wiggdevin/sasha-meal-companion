/**
 * [needs branch] — spec §9's integration cases. Skipped when SUPABASE_TEST_URL is unset.
 */
import { createHash, randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { mergedDays } from "@/lib/server/health-daily";
import { applyIngest } from "@/lib/server/health-ingest";
import { issueSourceToken, resolveSourceByToken } from "@/lib/server/health-tokens";
import { toBytea } from "@/lib/server/tokens";

const run = HAS_BRANCH ? describe : describe.skip;

// The branch suite stubs its own sealing key so it never depends on ambient env, matching
// tests/health/oura-server.test.ts.
const KEY = randomBytes(32).toString("base64");

run("Phase 5 against a branch", () => {
  const admin = HAS_BRANCH ? adminClient() : (null as never);
  let userA = ""; let userB = ""; let sourceA = ""; let rawToken = "";
  let asUserA: SupabaseClient; let asUserB: SupabaseClient;

  beforeEach(() => {
    vi.stubEnv("HEALTH_TOKEN_KEY", KEY);
  });

  const body = (over: Record<string, unknown> = {}) => ({
    source_kind: "apple_health_shortcut", sent_at: new Date().toISOString(),
    tz: "America/New_York",
    samples: [{ type: "step_count", value: 812, unit: "count",
      start_time: "2026-09-15T17:00:00Z", end_time: "2026-09-15T18:00:00Z",
      vendor_sample_id: "s-1", vendor_updated_at: "2026-09-15T18:05:00Z" }], ...over });

  beforeAll(async () => {
    const users = await createTestUsers();
    userA = users.a.userId; userB = users.b.userId;
    asUserA = users.a.client; asUserB = users.b.client;
    // Clear last run's health rows so the vendor_sample_id lookups below see exactly one row.
    await resetUser(userA);
    await resetUser(userB);
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

  /**
   * The card's provenance rides the `health_sources(kind)` embed, and `mergedDays` runs it with the
   * *request's* client — the browser path is a user JWT, not the service role. So RLS has to scope
   * that embed: her own source's kind comes back, another user's source row never does.
   * Skipped locally (`HAS_BRANCH` unset); it needs `scripts/db-branch.sh env`.
   */
  it("reads health_sources(kind) only for the signed-in user — RLS", async () => {
    const mine = await asUserA.from("health_sources").select("id, kind");
    expect(mine.error).toBeNull();
    expect((mine.data ?? []).filter((row) => row.id === sourceA).map((row) => row.kind))
      .toEqual(["apple_health_shortcut"]);

    const theirs = await asUserB.from("health_sources").select("id, kind");
    expect(theirs.error).toBeNull();
    expect((theirs.data ?? []).map((row) => row.id)).not.toContain(sourceA);

    // The join itself, under RLS: a fresh step sample names the kind of the source behind it.
    const seeded = await admin.from("health_samples").insert({ user_id: userA, source_id: sourceA,
      type: "step_count", value: 421, unit: "count",
      start_time: "2026-09-17T17:00:00Z", end_time: "2026-09-17T18:00:00Z", tz: "America/New_York",
      vendor_sample_id: "rls-kind-1" });
    expect(seeded.error).toBeNull();
    const days = await mergedDays(asUserA, userA, "2026-09-17", "2026-09-17");
    expect(days[0].provenance.step_count?.kind).toBe("apple_health_shortcut");
    expect(Date.parse(days[0].provenance.step_count!.end))
      .toBe(Date.parse("2026-09-17T18:00:00Z"));
  });

  it("round-trips a sealed Oura token and stores no plaintext — AC 9", async () => {
    const tokens = { access_token: "access-token-plaintext-aaaa",
      refresh_token: "refresh-token-plaintext-bbbb",
      expires_at: "2026-09-16T00:00:00Z", scope: "daily personal" };
    const sealed = sealOauth(tokens);
    await admin.from("health_sources").update({ oauth: sealed }).eq("id", sourceA);
    const { data } = await admin.from("health_sources").select("oauth").eq("id", sourceA).single();
    expect(String(data!.oauth)).not.toContain("refresh-token-plaintext-bbbb");
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
