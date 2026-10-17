import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { openOauthAnyKey, resealOauth } from "@/lib/server/health-tokens";
import { guardFlags, keyFromEnv, parseArgs, reseal } from "@/scripts/reseal-health-tokens";

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const tokens = { access_token: "a-1", refresh_token: "r-1", expires_at: "2026-10-18T00:00:00Z" } as never;

afterEach(() => vi.unstubAllEnvs());

describe("resealOauth", () => {
  it("moves a value to the new key and the old key no longer opens it", () => {
    const sealed = sealOauth(tokens, oldKey);
    const out = resealOauth(sealed, oldKey, newKey);
    expect(out.changed).toBe(true);
    expect(openOauth(out.sealed, newKey)).toEqual(tokens);
    expect(() => openOauth(out.sealed, oldKey)).toThrow();
  });

  it("leaves a value already under the new key alone", () => {
    const sealed = sealOauth(tokens, newKey);
    expect(resealOauth(sealed, oldKey, newKey)).toEqual({ sealed, changed: false });
  });

  it("throws for a value under neither key", () => {
    expect(() => resealOauth(sealOauth(tokens, randomBytes(32)), oldKey, newKey)).toThrow();
  });
});

describe("openOauthAnyKey", () => {
  it("opens old tokens during the swap, and only while the previous key is set", () => {
    const sealed = sealOauth(tokens, oldKey);
    vi.stubEnv("HEALTH_TOKEN_KEY", newKey.toString("base64"));
    expect(() => openOauthAnyKey(sealed)).toThrow();
    vi.stubEnv("HEALTH_TOKEN_KEY_PREVIOUS", oldKey.toString("base64"));
    expect(openOauthAnyKey(sealed)).toEqual(tokens);
    expect(openOauthAnyKey(sealOauth(tokens, newKey))).toEqual(tokens);
  });
});

type Row = { id: string; oauth: string };
function fakeAdmin(rows: Row[], race?: string) {
  const writes: string[] = [];
  const admin = {
    from: () => ({
      select: () => {
        const q = {
          not: () => q, order: () => q,
          gt: (_c: string, v: string) => { q.after = v; return q; },
          limit: () => Promise.resolve({ data: rows.filter((r) => r.id > q.after).slice(0, 200), error: null }),
          after: "",
        };
        return q;
      },
      update: (v: { oauth: string }) => ({
        eq: (_c: string, id: string) => ({
          eq: (_d: string, expected: string) => ({
            select: () => {
              const row = rows.find((r) => r.id === id);
              if (!row || row.oauth !== expected || id === race) return Promise.resolve({ data: [], error: null });
              row.oauth = v.oauth; writes.push(id);
              return Promise.resolve({ data: [{ id }], error: null });
            },
          }),
        }),
      }),
    }),
  };
  return { admin: admin as never, writes };
}

describe("reseal", () => {
  const make = () => [
    { id: "1", oauth: sealOauth(tokens, oldKey) },
    { id: "2", oauth: sealOauth(tokens, newKey) },
    { id: "3", oauth: sealOauth(tokens, oldKey) },
  ];

  it("dry run counts and writes nothing", async () => {
    const rows = make(); const before = rows.map((r) => r.oauth);
    const { admin, writes } = fakeAdmin(rows);
    expect(await reseal(admin, oldKey, newKey, false))
      .toEqual({ total: 3, resealed: 2, alreadyNew: 1, raced: 0, failed: 0 });
    expect(writes).toEqual([]);
    expect(rows.map((r) => r.oauth)).toEqual(before);
  });

  it("commit re-seals, every token still opens, and a second run changes nothing", async () => {
    const rows = make();
    const { admin } = fakeAdmin(rows);
    await reseal(admin, oldKey, newKey, true);
    for (const r of rows) expect(openOauth(r.oauth, newKey)).toEqual(tokens);
    expect(await reseal(admin, oldKey, newKey, true))
      .toEqual({ total: 3, resealed: 0, alreadyNew: 3, raced: 0, failed: 0 });
  });

  it("counts a row the app rotated meanwhile as raced and leaves it", async () => {
    const rows = make();
    const { admin } = fakeAdmin(rows, "3");
    const tally = await reseal(admin, oldKey, newKey, true);
    expect(tally.raced).toBe(1);
    expect(openOauth(rows[2].oauth, oldKey)).toEqual(tokens);
  });

  it("counts an unreadable value as failed", async () => {
    const { admin } = fakeAdmin([{ id: "1", oauth: "bm9wZQ==" }]);
    expect((await reseal(admin, oldKey, newKey, true)).failed).toBe(1);
  });
});

describe("script arguments", () => {
  it("is a dry run unless --commit, and maps to the shared write guard", () => {
    expect(parseArgs([])).toEqual({ commit: false, production: false });
    expect(guardFlags(parseArgs(["--commit", "--production"]))).toEqual(["--fix", "--production"]);
    expect(() => parseArgs(["--fix"])).toThrow();
  });

  it("keys must be 32 bytes", () => {
    expect(() => keyFromEnv("K", {} as NodeJS.ProcessEnv)).toThrow("not set");
    expect(() => keyFromEnv("K", { K: "AAAA" } as NodeJS.ProcessEnv)).toThrow("32 bytes");
    expect(keyFromEnv("K", { K: newKey.toString("base64") } as NodeJS.ProcessEnv).equals(newKey)).toBe(true);
  });
});
