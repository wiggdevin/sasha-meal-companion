import { afterEach, describe, expect, it, vi } from "vitest";
import { COACH_TOOL_SCOPES, registerCoachTools } from "@/lib/mcp/coach-tools";
import { defaultPorts } from "@/lib/server/coach-ports";
import { buildToolSpec } from "@/lib/coach/prompt";
import { lookupTool } from "@/lib/coach/registry";
import { HttpError } from "@/lib/server/auth";
import { hasScope } from "@/lib/server/tokens";

afterEach(() => vi.unstubAllEnvs());

/** An in-memory McpServer: the same registerTool surface app/api/mcp/route.ts calls. */
function recorder() {
  const tools = new Map<string, (args: never) => Promise<{ content: { text: string }[] }>>();
  const schemas = new Map<string, unknown>();
  return {
    tools, schemas,
    registerTool(name: string, config: { inputSchema: unknown }, handler: never) {
      tools.set(name, handler as never); schemas.set(name, config.inputSchema);
    },
  };
}

describe("registerCoachTools", () => {
  it("registers exactly the three MCP tools the spec names", () => {
    const server = recorder();
    registerCoachTools(server as never, { userId: "u1", admin: {} as never });
    expect([...server.tools.keys()].sort())
      .toEqual(["get_constraints", "list_coach_messages", "set_constraints"]);
  });

  it("scopes the two reads read and the write constraints:write", () => {
    expect(COACH_TOOL_SCOPES).toEqual({
      get_constraints: "read", list_coach_messages: "read",
      set_constraints: "constraints:write",
    });
  });

  it("binds every query to ctx.userId, never to an argument", async () => {
    const eq = vi.fn().mockReturnThis();
    const ordered = { order: () => ordered, limit: async () => ({ data: [], error: null }) };
    const admin = { from: () => ({ select: () => ({ eq, gte: () => ordered }) }) };
    const server = recorder();
    registerCoachTools(server as never, { userId: "u1", admin: admin as never });
    await server.tools.get("list_coach_messages")!({ limit: 10, userId: "u2" } as never);
    expect(eq).toHaveBeenCalledWith("user_id", "u1");
  });

  // W037 (audit A101, A111): the default read is the newest N, still presented newest last.
  type Row = { id: number; seq: number; created_at: string };
  /** Applies every .order() in turn, as PostgREST does; a tie with no key keeps insertion order. */
  function messagesDb(rows: Row[]) {
    const calls: { ascending?: boolean; limit?: number } = {};
    const orders: { column: keyof Row; ascending: boolean }[] = [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, gte: () => chain,
      order: (column: keyof Row, o: { ascending: boolean }) => {
        calls.ascending ??= o.ascending;
        orders.push({ column, ascending: o.ascending });
        return chain;
      },
      limit: async (n: number) => {
        calls.limit = n;
        const sorted = [...rows].sort((a, b) => {
          for (const { column, ascending } of orders) {
            const d = String(a[column]).localeCompare(String(b[column]), undefined, { numeric: true });
            if (d !== 0) return ascending ? d : -d;
          }
          return 0;
        });
        return { data: sorted.slice(0, n), error: null };
      },
    });
    return { calls, admin: { from: () => chain } };
  }
  const history: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, seq: i + 1,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString() }));

  it("keeps a user turn before its reply when both share created_at", async () => {
    const at = "2026-10-11T10:00:00.000Z";
    const { admin } = messagesDb([{ id: 1, seq: 1, created_at: at }, { id: 2, seq: 2, created_at: at }]);
    const server = recorder();
    registerCoachTools(server as never, { userId: "u1", admin: admin as never });
    const out = await server.tools.get("list_coach_messages")!({} as never);
    expect(JSON.parse(out.content[0].text).map((r: Row) => r.id)).toEqual([1, 2]);
  });

  it("returns the newest N messages, newest last, with no sinceIso", async () => {
    const { admin } = messagesDb(history);
    const server = recorder();
    registerCoachTools(server as never, { userId: "u1", admin: admin as never });
    const out = await server.tools.get("list_coach_messages")!({ limit: 3 } as never);
    expect(JSON.parse(out.content[0].text).map((r: { id: number }) => r.id)).toEqual([298, 299, 300]);
    const all = await server.tools.get("list_coach_messages")!({} as never);
    const ids = JSON.parse(all.content[0].text).map((r: { id: number }) => r.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(251);
    expect(ids.at(-1)).toBe(300);
  });

  it("keeps the oldest-first window from sinceIso", async () => {
    const { admin, calls } = messagesDb(history);
    const server = recorder();
    registerCoachTools(server as never, { userId: "u1", admin: admin as never });
    await server.tools.get("list_coach_messages")!(
      { sinceIso: "2026-01-02T00:00:00Z", limit: 2 } as never);
    expect(calls.ascending).toBe(true);
  });

  it("refuses a read-only token on set_constraints, through the real scope check", () => {
    const scopes = ["read"];
    expect(hasScope(scopes, COACH_TOOL_SCOPES.set_constraints)).toBe(false);
    expect(() => {
      if (!hasScope(scopes, COACH_TOOL_SCOPES.set_constraints)) {
        throw new HttpError(403, "forbidden", 'Token lacks the "constraints:write" scope.');
      }
    }).toThrow(HttpError);
    expect(hasScope(scopes, COACH_TOOL_SCOPES.get_constraints)).toBe(true);
  });
});

describe("coach expenditure tool port", () => {
  const activityContext = {
    version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
    currentStepsAvg: 3200, currentDays: 6, baselineStepsAvg: 8000, baselineDays: 24,
    deviationPct: -0.6, band: "lower", activeKcal7dAvg: 520, activeKcalDays: 6,
    residualKcal: -40, smoothing: "corroborated", targetAdjustmentKcal: 0,
  };
  const db = {
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        expenditure_estimates: {
          local_date: "2026-09-20", status: "estimating", tdee_kcal: 2180,
          weight_trend_kg: 58.1, intake_completeness: 0.93, qualified_days: 21,
          weigh_in_count: 13, confidence: 0.82, reason: null, engine_version: "exp-2.0.0",
          activity_context: activityContext, learning_days_remaining: 0,
        },
        user_settings: {
          sex: "female", birth_year: 1996, height_cm: 165, weight_kg: 58,
          body_fat_pct: null, activity_level: "moderate",
        },
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      });
      return chain;
    },
  } as never;

  it("exposes new status fields only when the coach activity flag is enabled", async () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "false");
    const hidden = await defaultPorts(db, db, () => "id", { tz: "UTC", date: "2026-09-20" })
      .latestEstimate("u1") as Record<string, unknown>;
    expect(hidden).not.toHaveProperty("activityContext");
    expect(hidden).not.toHaveProperty("learningDaysRemaining");
    // exp-3.0.0: the starting estimate is core, not an activity field; it stays with the flag off.
    expect(hidden.profileTdeeKcal).toEqual(expect.any(Number));

    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const visible = await defaultPorts(db, db, () => "id", { tz: "UTC", date: "2026-09-20" })
      .latestEstimate("u1") as Record<string, unknown>;
    expect(visible).toMatchObject({ activityContext, learningDaysRemaining: 0 });
    expect(visible.profileTdeeKcal).toEqual(expect.any(Number));
  });

  it("keeps get_expenditure_status read-only with no mutation effect", () => {
    expect(lookupTool("get_expenditure_status")).toMatchObject({
      effect: "read",
      maxCallsPerTurn: 1,
    });
  });

  it("describes only landing-2 expenditure fields while the activity flag is off", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "false");
    const tool = lookupTool("get_expenditure_status")!;
    const description = buildToolSpec([tool])[0].description;

    expect(description).toBe(
      "The advisory expenditure estimate: status (burn_in, held, estimating or blocked), the TDEE "
      + "number when there is one, the weight trend and the confidence. Advisory only — never a target.",
    );
  });

  it("describes activity context when the activity flag is on", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const tool = lookupTool("get_expenditure_status")!;
    const description = buildToolSpec([tool])[0].description;

    expect(description).toContain("activity context when available");
    expect(description).toContain("profile TDEE");
    expect(description).toContain("learning progress");
  });
});
