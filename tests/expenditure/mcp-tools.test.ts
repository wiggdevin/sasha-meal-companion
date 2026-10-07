// tests/expenditure/mcp-tools.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPENDITURE_TOOL_SCOPES, registerExpenditureTools } from "@/lib/mcp/expenditure-tools";

type Registered = {
  name: string;
  description: string;
  handler: (args: unknown) => Promise<{ content: { text: string }[] }>;
};

function fakeServer() {
  const tools: Registered[] = [];
  const server = { registerTool: (
    name: string, cfg: { description: string }, handler: Registered["handler"],
  ) => tools.push({ name, description: cfg.description, handler }) };
  return { server: server as never, tools };
}

const admin = {
  from: vi.fn(() => ({ select: () => ({ eq: () => ({
    order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    lte: () => ({ order: () => ({ order: () => ({ limit: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    maybeSingle: async () => ({ data: { first_opened_at: "2026-08-01T00:00:00.000Z",
      ramp_override: 3 }, error: null }) }) }) })),
} as never;

afterEach(() => vi.unstubAllEnvs());

function estimateAdmin() {
  const rows: Record<string, unknown> = {
    expenditure_estimates: {
      local_date: "2026-09-20", status: "estimating", tdee_kcal: 2180,
      weight_trend_kg: 58.1, intake_completeness: 0.93, qualified_days: 21,
      weigh_in_count: 13, confidence: 0.82, reason: null, engine_version: "exp-2.0.0",
      learning_days_remaining: 0,
      activity_context: {
        version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
        currentStepsAvg: 3200, currentDays: 6, baselineStepsAvg: 8000, baselineDays: 24,
        deviationPct: -0.6, band: "lower", activeKcal7dAvg: 520, activeKcalDays: 6,
        residualKcal: -40, smoothing: "corroborated", targetAdjustmentKcal: 0,
      },
    },
    user_settings: {
      sex: "female", birth_year: 1996, height_cm: 165, weight_kg: 58,
      body_fat_pct: null, activity_level: "moderate",
    },
  };
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      });
      return chain;
    },
  } as never;
}

describe("registerExpenditureTools", () => {
  it("registers exactly the two read-only tools with the expanded description when enabled", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    expect(tools.map((t) => t.name)).toEqual(["get_expenditure_status", "get_targets"]);
    expect(EXPENDITURE_TOOL_SCOPES).toEqual(
      { get_expenditure_status: "read", get_targets: "read" });
    expect(tools[0].description).toContain("activity context");
    expect(tools[0].description).toContain("profile TDEE");
    expect(tools[0].description).toContain("learning progress");
    expect(tools[0].description).toContain("Read-only");
  });

  /* The landing-2 description, in second person: design §6.5/C4 takes the third-person pronoun
     out of every active runtime string, and an MCP tool description is one. */
  it("keeps the landing-2 description, named for nobody, while the activity flag is off", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "false");
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });

    expect(tools[0].description).toBe(
      "The advisory expenditure estimate: status, TDEE in kcal, confidence and the reason string. "
      + "Read-only; it can neither propose nor set a target.",
    );
  });

  it("get_expenditure_status holds with no number when there is no estimate and no profile", async () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    const out = await tools[0].handler({});
    const value = JSON.parse(out.content[0].text);
    expect(value).toMatchObject({
      status: "held", tdeeKcal: null, profileTdeeKcal: null, learningDaysRemaining: 21,
      reason: "Finish your profile — the estimate starts from your own numbers",
    });
    expect(value).not.toHaveProperty("activityContext");
  });

  it("returns the API's activity context, profile TDEE and learning progress unchanged", async () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin: estimateAdmin() });
    const out = await tools[0].handler({});
    const value = JSON.parse(out.content[0].text);

    expect(value).toEqual({
      status: "estimating", localDate: "2026-09-20", tdeeKcal: 2180,
      weightTrendKg: 58.1, confidence: 0.82, intakeCompleteness: 0.93,
      qualifiedDays: 21, weighInCount: 13, reason: null, engineVersion: "exp-2.0.0",
      activityContext: {
        version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
        currentStepsAvg: 3200, currentDays: 6, baselineStepsAvg: 8000, baselineDays: 24,
        deviationPct: -0.6, band: "lower", activeKcal7dAvg: 520, activeKcalDays: 6,
        residualKcal: -40, smoothing: "corroborated", targetAdjustmentKcal: 0,
      },
      profileTdeeKcal: expect.any(Number), learningDaysRemaining: 0,
      // exp-3 columns this legacy exp-2.0.0 row never wrote: null, not missing.
      phase: null, tdeeLowKcal: null, tdeeHighKcal: null, dataWeight: null, seedSource: null,
      proposalEligible: null, reviewFlag: null, fluidCycleDays: null,
    });
  });

  it("keeps the new activity fields absent while the coach activity flag is off", async () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "false");
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin: estimateAdmin() });
    const out = await tools[0].handler({});
    const value = JSON.parse(out.content[0].text);

    expect(value).toMatchObject({ status: "estimating", tdeeKcal: 2180 });
    expect(value).not.toHaveProperty("activityContext");
    expect(value).not.toHaveProperty("learningDaysRemaining");
    // exp-3.0.0: the starting estimate is core, not an activity field; it stays with the flag off.
    expect(value).toHaveProperty("profileTdeeKcal");
  });

  /* Design §5.1/§5.2: the authored ramp is gone. An account with no effective revision gets the
     discriminated `needs_profile` answer and no numbers — never a target invented in code. */
  it("get_targets answers needs_profile when no revision is effective", async () => {
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    const out = await tools[1].handler({});
    expect(JSON.parse(out.content[0].text)).toEqual({ status: "needs_profile", target: null });
  });

  it("get_targets says so plainly in its description, with no fallback promised", () => {
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    expect(tools[1].description).toContain("needs_profile");
    expect(tools[1].description).not.toContain("ramp");
  });
});
