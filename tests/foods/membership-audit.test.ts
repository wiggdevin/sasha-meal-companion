import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), adminClient: vi.fn() }));

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => mocks.adminClient(),
}));

const { assertWriteTarget, main, projectRef } = await import("@/scripts/food-membership-audit");

const PRODUCTION_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
const BRANCH_URL = "https://abcdefghijklmnopqrst.supabase.co";

const ROWS = [
  {
    user_id: "11111111-1111-4111-8111-111111111111",
    name_norm: "Watermélon, raw",
    row_count: 3,
    ref_ids: ["ref-1", "ref-2", "ref-3"],
    kind: "conflict",
    eats_updated_at: "2026-09-18T00:00:00.000Z",
    avoid_updated_at: "2026-09-19T00:00:00.000Z",
  },
  {
    user_id: "22222222-2222-4222-8222-222222222222",
    name_norm: "Rice, cooked",
    row_count: 2,
    ref_ids: ["ref-4", "ref-5"],
    kind: "conflict",
    eats_updated_at: "2026-09-19T00:00:00.000Z",
    avoid_updated_at: "2026-09-18T00:00:00.000Z",
  },
  {
    user_id: "33333333-3333-4333-8333-333333333333",
    name_norm: "Carrots, raw",
    row_count: 3,
    ref_ids: ["ref-6", "ref-7", "ref-8"],
    kind: "partial",
    eats_updated_at: "2026-09-19T00:00:00.000Z",
    avoid_updated_at: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminClient.mockReturnValue({ rpc: mocks.rpc });
  vi.stubEnv("SUPABASE_URL", BRANCH_URL);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("food membership contradiction audit", () => {
  it("--fix resolves conflicts and completes a partial mark, then reports zero remaining", async () => {
    let auditReads = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "food_membership_contradictions") {
        auditReads += 1;
        return { data: auditReads === 1 ? ROWS : [], error: null };
      }
      return { data: { rev: 1_800_000_000_000 }, error: null };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--fix"]);

    const fixes = mocks.rpc.mock.calls.filter(([name]) => name === "set_food_membership");
    expect(fixes).toHaveLength(3);
    expect(fixes.map(([, args]) => args)).toEqual([
      expect.objectContaining({ p_name_norm: "watermelon", p_status: "avoid" }),
      expect.objectContaining({ p_name_norm: "rice", p_status: "eats" }),
      expect.objectContaining({ p_name_norm: "carrots", p_status: "eats" }),
    ]);
    expect(log.mock.calls.flat()).toContain("food membership contradictions: 0");
    log.mockRestore();
  });
});

describe("food membership --fix production guard", () => {
  it("derives the project ref from the hostname only", () => {
    expect(projectRef(PRODUCTION_URL)).toBe("fivatgdpuenszxxnijpc");
    expect(projectRef("https://example.com/?ref=fivatgdpuenszxxnijpc")).toBeNull();
    expect(projectRef("not a url")).toBeNull();
    expect(projectRef(undefined)).toBeNull();
    expect(projectRef("http://127.0.0.1:54321")).toBe("local");
  });

  it("refuses --fix on production without --production, before any client is created", async () => {
    vi.stubEnv("SUPABASE_URL", PRODUCTION_URL);
    await expect(main(["--fix"])).rejects.toThrow(/refuses production project .* without --production/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("allows --fix --production on production as the deliberate repair", () => {
    expect(() => assertWriteTarget(["--fix", "--production"], PRODUCTION_URL)).not.toThrow();
  });

  it("refuses --production anywhere but production, and without --fix", () => {
    expect(() => assertWriteTarget(["--fix", "--production"], BRANCH_URL)).toThrow(/is not production/);
    expect(() => assertWriteTarget(["--production"], PRODUCTION_URL)).toThrow(/only applies together with --fix/);
  });

  it("refuses --fix when the project cannot be identified", () => {
    expect(() => assertWriteTarget(["--fix"], undefined)).toThrow(/cannot identify/);
    expect(() => assertWriteTarget(["--fix"], "https://example.com")).toThrow(/cannot identify/);
  });

  it("keeps the read-only report and branch --fix unguarded, and --branch-check off production", () => {
    expect(() => assertWriteTarget([], PRODUCTION_URL)).not.toThrow();
    expect(() => assertWriteTarget(["--fix"], BRANCH_URL)).not.toThrow();
    expect(() => assertWriteTarget(["--fix"], "http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertWriteTarget(["--branch-check"], PRODUCTION_URL)).toThrow(/--branch-check refuses production/);
  });
});
