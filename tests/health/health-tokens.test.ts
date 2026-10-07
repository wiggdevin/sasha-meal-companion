import { describe, expect, it, vi } from "vitest";
import { hashToken, toBytea } from "@/lib/server/tokens";
import { issueSourceToken, resolveSourceByToken } from "@/lib/server/health-tokens";

/** One-row stub shaped like the PostgREST builder chain the module uses. */
function stubAdmin(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const is = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { admin: { from } as never, eq };
}

describe("issueSourceToken", () => {
  it("mints a smh_ token whose hash is the stored sha256", () => {
    const { raw, hash } = issueSourceToken();
    expect(raw.startsWith("smh_")).toBe(true);
    expect(raw.length).toBeGreaterThan(40);
    expect(hash.equals(hashToken(raw))).toBe(true);
    expect(issueSourceToken().raw).not.toBe(raw);
  });
});

describe("resolveSourceByToken", () => {
  it("looks the row up by hash, never by the raw token", async () => {
    const raw = "smh_abc";
    const hash = hashToken(raw);
    const { admin, eq } = stubAdmin({ id: "src-1", user_id: "user-1",
      kind: "health_auto_export", token_hash: `\\x${hash.toString("hex")}` });
    expect(await resolveSourceByToken(admin, raw))
      .toEqual({ id: "src-1", userId: "user-1", kind: "health_auto_export" });
    expect(eq).toHaveBeenCalledWith("token_hash", toBytea(hash));
  });

  it("returns null for an unknown or revoked token", async () => {
    const { admin } = stubAdmin(null);
    expect(await resolveSourceByToken(admin, "smh_nope")).toBeNull();
  });

  it("returns null when the stored hash does not actually match", async () => {
    const { admin } = stubAdmin({ id: "src-1", user_id: "user-1", kind: "oura",
      token_hash: `\\x${hashToken("smh_other").toString("hex")}` });
    expect(await resolveSourceByToken(admin, "smh_abc")).toBeNull();
  });
});
