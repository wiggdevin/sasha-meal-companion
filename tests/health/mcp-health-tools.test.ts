import { describe, expect, it, vi } from "vitest";
import { mergedDays } from "@/lib/server/health-daily";
import { HEALTH_TOOL_SCOPES, registerHealthTools,
  type McpServerLike } from "@/lib/mcp/health-tools";

vi.mock("@/lib/server/health-daily", () => ({ mergedDays: vi.fn() }));

type Tool = { name: string; config: { inputSchema: { parse: (v: unknown) => unknown } };
  run: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

function fakeServer(): { server: McpServerLike; tools: Tool[] } {
  const tools: Tool[] = [];
  const server = { registerTool: (name: string, config: Tool["config"], run: Tool["run"]) => {
    tools.push({ name, config, run });
  } } as unknown as McpServerLike;
  return { server, tools };
}

describe("registerHealthTools", () => {
  it("registers exactly one read-only tool", () => {
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    expect(tools.map((t) => t.name)).toEqual(["get_body_data"]);
    expect(HEALTH_TOOL_SCOPES).toEqual({ get_body_data: "read" });
  });

  it("returns the merged days for the token's user, never a body-supplied id", async () => {
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47,
      hrv_sdnn: 45, readiness_score: 78, sources: ["Oura"], provenance: {} }]);
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });

    const out = await tools[0].run({ from: "2026-09-15", to: "2026-09-15",
      user_id: "someone-else" });
    expect(vi.mocked(mergedDays).mock.calls[0][1]).toBe("user-1");
    expect(JSON.parse(out.content[0].text)[0].sleep_minutes).toBe(444);
    expect(JSON.parse(out.content[0].text)[0].readiness_score).toBe(78);
  });

  it("rejects a window over 90 days in the tool body", async () => {
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    const out = await tools[0].run({ from: "2026-01-01", to: "2026-09-15" });
    expect(out.content[0].text).toMatch(/90 days/);
  });

  // Eighth round, finding 4: the tool serializes the shared roll-up as it stands, so a fractional
  // reading is not rounded on its way to an agent either.
  it("serializes a fractional RHR and HRV unrounded", async () => {
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47.4,
      hrv_sdnn: 45.375, readiness_score: 78, sources: ["Oura"], provenance: {} }]);
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    const out = await tools[0].run({ from: "2026-09-15", to: "2026-09-15" });
    expect(JSON.parse(out.content[0].text)[0]).toMatchObject({ resting_heart_rate: 47.4,
      hrv_sdnn: 45.375 });
  });

  // W037 (audit A104): the shape alone let 2026-02-31 roll into March and 2026-13-01 throw.
  it.each([["2026-02-30", "2026-03-05"], ["2026-13-01", "2026-13-05"], ["2026-04-31", "2026-05-02"],
    ["2026-03-01", "2026-02-29"]])("rejects the impossible date in %s..%s", async (from, to) => {
    vi.mocked(mergedDays).mockClear();
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    expect(() => tools[0].config.inputSchema.parse({ from, to })).toThrow();
    const out = await tools[0].run({ from, to });
    expect(out.content[0].text).toMatch(/real calendar dates/);
    expect(mergedDays).not.toHaveBeenCalled();
  });

  it("accepts a leap day", () => {
    const { server, tools } = fakeServer();
    registerHealthTools(server, { userId: "user-1", admin: {} as never });
    expect(() => tools[0].config.inputSchema.parse({ from: "2028-02-29", to: "2028-03-01" }))
      .not.toThrow();
  });
});
