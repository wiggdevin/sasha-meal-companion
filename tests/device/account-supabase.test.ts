import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { unbindAccount(); });

/** Server-only modules and the one session read the gate owns before any account is bound. */
const EXEMPT = new Set([
  "lib/foods/facet-warm.ts", "lib/coach/suggest-policy.ts", "lib/coach/blocks/index.ts",
  // AuthGate's onboarding read runs to decide the gate, before the device binds; RLS scopes it.
  "lib/profile/onboarding-state.ts",
]);
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api|app\/sign-in)\//;

describe("every direct client Supabase call goes through withAccount", () => {
  it("has no .rpc( / .from( in a client module without withAccount", () => {
    const offenders: string[] = [];
    const files = ["lib", "components", "app"].flatMap((d) =>
      (readdirSync(d, { recursive: true }) as string[]).map((f) => `${d}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f));
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes('import "server-only"')) continue;
      if (/\.(rpc|from)\(["'`]/.test(src) && !src.includes("withAccount(")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("withAccount (audit plan r3 finding 3)", () => {
  it("hands the starting account's id into the call", async () => {
    const run = vi.fn(async (userId: string) => userId);
    await expect(withAccount(bindAccount(A), run)).resolves.toBe(A);
    expect(run).toHaveBeenCalledWith(A);
  });

  it("issues nothing with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    const run = vi.fn(async () => "x");
    await expect(withAccount(a, run)).rejects.toBeInstanceOf(AccountChanged);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops an answer that resolves after the account changed", async () => {
    let answer!: (v: string) => void;
    const a = bindAccount(A);
    const pending = withAccount(a, () => new Promise<string>((r) => { answer = r; }));
    bindAccount(B);
    answer("A's rows");
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
  });
});
