import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mintToken, toBytea } from "@/lib/server/tokens";
import { withTokenUser } from "@/lib/server/privileged";

const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const ready = Boolean(URL && KEY);

function req(raw: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${raw}` },
  });
}

describe.skipIf(!ready)("api_tokens on a Supabase branch", () => {
  let setup: SupabaseClient;
  let userA = "";
  let userB = "";
  const tokenA = mintToken();
  const tokenB = mintToken();
  const revoked = mintToken();
  const expired = mintToken();

  beforeAll(async () => {
    // adminClient() is lazy, so stubbing before the first call points it at the branch.
    vi.stubEnv("SUPABASE_URL", URL as string);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY as string);
    setup = createClient(URL as string, KEY as string, { auth: { persistSession: false } });

    const a = await setup.auth.admin.createUser({ email: "lane-b-a@example.test", email_confirm: true });
    const b = await setup.auth.admin.createUser({ email: "lane-b-b@example.test", email_confirm: true });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    userA = a.data.user!.id;
    userB = b.data.user!.id;

    const { error } = await setup.from("api_tokens").insert([
      { label: "A full", user_id: userA, token_hash: toBytea(tokenA.hash), scopes: ["read", "log:write"] },
      { label: "B read", user_id: userB, token_hash: toBytea(tokenB.hash), scopes: ["read"] },
      { label: "A revoked", user_id: userA, token_hash: toBytea(revoked.hash), scopes: ["read"], revoked_at: new Date().toISOString() },
      { label: "A expired", user_id: userA, token_hash: toBytea(expired.hash), scopes: ["read"], expires_at: "2020-01-01T00:00:00Z" },
    ]);
    expect(error).toBeNull();
  });

  afterAll(async () => {
    if (!ready) return;
    await setup.from("api_tokens").delete().in("user_id", [userA, userB]);
    await setup.auth.admin.deleteUser(userA);
    await setup.auth.admin.deleteUser(userB);
    vi.unstubAllEnvs();
  });

  it("resolves a token to its own user and never to the other one", async () => {
    const seenA = await withTokenUser(req(tokenA.raw), "read", async (ctx) => ctx.userId);
    const seenB = await withTokenUser(req(tokenB.raw), "read", async (ctx) => ctx.userId);
    expect(seenA).toBe(userA);
    expect(seenB).toBe(userB);
    expect(seenA).not.toBe(seenB);
  });

  it("401s a revoked, an expired and a never-issued token", async () => {
    for (const raw of [revoked.raw, expired.raw, mintToken().raw]) {
      await expect(withTokenUser(req(raw), "read", async () => "reached")).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it("403s user B's read-only token when log:write is required", async () => {
    await expect(withTokenUser(req(tokenB.raw), "log:write", async () => "reached")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("bumps last_used_at on a successful lookup", async () => {
    await withTokenUser(req(tokenA.raw), "read", async () => "ok");
    const { data, error } = await setup
      .from("api_tokens")
      .select("last_used_at")
      .eq("token_hash", toBytea(tokenA.hash))
      .single();
    expect(error).toBeNull();
    expect(typeof data?.last_used_at).toBe("string");
  });
});
