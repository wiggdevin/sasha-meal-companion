// scripts/recompute-target.ts: argument parsing and the production write guard, which must refuse
// before any client is created.
import { afterEach, describe, expect, it, vi } from "vitest";

const adminClient = vi.fn(() => { throw new Error("adminClient must not be reached"); });
vi.mock("@/lib/server/admin", () => ({ adminClient: () => adminClient() }));

const { main, parseArgs } = await import("../../scripts/recompute-target");

const USER = "40707946-c07f-4b3d-b960-68bb754e7660";
const PROD = "https://fivatgdpuenszxxnijpc.supabase.co";
const original = process.env.SUPABASE_URL;

afterEach(() => {
  process.env.SUPABASE_URL = original;
  adminClient.mockClear();
});

describe("recompute-target arguments", () => {
  it("requires a user id and a YYYY-MM-DD date", () => {
    expect(() => parseArgs([])).toThrow("--user-id");
    expect(() => parseArgs(["--user-id", "nope"])).toThrow("--user-id");
    expect(() => parseArgs(["--user-id", USER, "--date", "3 Oct"])).toThrow("YYYY-MM-DD");
    expect(() => parseArgs(["--user-id", USER, "--date", "2026-99-99"])).toThrow("YYYY-MM-DD");
    expect(() => parseArgs(["--user-id", USER, "--date", "2026-02-30"])).toThrow("YYYY-MM-DD");
    expect(() => parseArgs(["--user-id", USER, "--date"])).toThrow("needs a value");
    expect(() => parseArgs(["--user-id", USER, "--date", "--fix"])).toThrow("needs a value");
    expect(() => parseArgs(["--user-id", USER, "--all"])).toThrow("unknown argument");
    expect(parseArgs(["--user-id", USER, "--fix"])).toEqual(
      { userId: USER, date: undefined, fix: true, production: false });
  });
});

describe("recompute-target write guard", () => {
  it("refuses --fix on production without --production, before connecting", async () => {
    process.env.SUPABASE_URL = PROD;
    await expect(main(["--user-id", USER, "--fix"])).rejects.toThrow("without --production");
    expect(adminClient).not.toHaveBeenCalled();
  });

  it("lets --fix --production through on production (the deliberate owner step)", async () => {
    process.env.SUPABASE_URL = PROD;
    await expect(main(["--user-id", USER, "--fix", "--production"]))
      .rejects.toThrow("adminClient must not be reached");
    expect(adminClient).toHaveBeenCalledTimes(1);
  });

  it("judges SUPABASE_TEST_URL when SUPABASE_URL is unset, as adminClient does", async () => {
    const test = process.env.SUPABASE_TEST_URL;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_TEST_URL = PROD;
    try {
      await expect(main(["--user-id", USER, "--fix"])).rejects.toThrow("without --production");
      expect(adminClient).not.toHaveBeenCalled();
    } finally {
      if (test === undefined) delete process.env.SUPABASE_TEST_URL;
      else process.env.SUPABASE_TEST_URL = test;
    }
  });

  it("refuses --fix when the project cannot be identified", async () => {
    process.env.SUPABASE_URL = "https://example.invalid";
    await expect(main(["--user-id", USER, "--fix"])).rejects.toThrow("cannot identify");
    expect(adminClient).not.toHaveBeenCalled();
  });

  it("refuses --production against a non-production project", async () => {
    process.env.SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    await expect(main(["--user-id", USER, "--fix", "--production"])).rejects.toThrow("not production");
    expect(adminClient).not.toHaveBeenCalled();
  });
});
