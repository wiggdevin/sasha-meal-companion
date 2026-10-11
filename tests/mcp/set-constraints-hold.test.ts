// W007 (audit 2026-10-10 A103): MCP `set_constraints` runs the same pace-hold target recompute
// as PUT /api/constraints, so a condition saved by an agent holds the pace at once.
import { beforeEach, describe, expect, it, vi } from "vitest";

const putProfile = vi.fn();
const recomputeAfterHoldChange = vi.fn(async () => undefined);
vi.mock("@/lib/server/constraints", () => ({ getProfile: vi.fn(), putProfile }));
vi.mock("@/lib/server/target-recompute", () => ({ recomputeAfterHoldChange }));

const { registerCoachTools } = await import("@/lib/mcp/coach-tools");

function setConstraints() {
  const tools = new Map<string, (args: never) => Promise<unknown>>();
  const admin = { tag: "admin" };
  registerCoachTools({ registerTool: (name, _config, handler) => { tools.set(name, handler); } },
    { userId: "u1", admin: admin as never });
  return { call: tools.get("set_constraints")!, admin };
}

beforeEach(() => { putProfile.mockReset(); recomputeAfterHoldChange.mockClear(); });

describe("MCP set_constraints", () => {
  it("recomputes the target after a saved conditions change", async () => {
    putProfile.mockResolvedValue({ status: "ok", profile: {}, rev: 2 });
    const { call, admin } = setConstraints();
    await call({ baseRev: 1, conditions: ["Pregnant"] } as never);
    expect(recomputeAfterHoldChange).toHaveBeenCalledWith(admin, "u1", "mcp set_constraints");
  });

  it("does not recompute after a conflict or when conditions are untouched", async () => {
    putProfile.mockResolvedValue({ status: "conflict", current_rev: 3 });
    const { call } = setConstraints();
    await call({ baseRev: 1, conditions: ["Pregnant"] } as never);
    putProfile.mockResolvedValue({ status: "ok", profile: {}, rev: 2 });
    await call({ baseRev: 1, avoidAllergens: ["peanut"] } as never);
    expect(recomputeAfterHoldChange).not.toHaveBeenCalled();
  });
});
