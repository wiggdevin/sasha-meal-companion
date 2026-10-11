/**
 * One read-only MCP tool (spec §5, "MCP"). It runs on the privileged boundary, so the user id comes
 * from ctx (resolved from the token) and never from the tool arguments, and it reads through
 * lib/server/health-daily.ts so an agent sees exactly the dashboard's numbers.
 */
import type { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { MAX_DAILY_WINDOW_DAYS } from "@/lib/health/contract";
import { mergedDays } from "@/lib/server/health-daily";

export type McpServerLike = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

export const HEALTH_TOOL_SCOPES: Record<"get_body_data", "read"> = { get_body_data: "read" };

/** A real calendar date: the shape alone lets 2026-02-31 roll over and 2026-13-01 throw (A104). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const isoDate = z.string().refine(isCalendarDate, "Expected a real calendar date, YYYY-MM-DD.");

export function registerHealthTools(server: McpServerLike,
    ctx: { userId: string; admin: SupabaseClient }): void {
  server.registerTool(
    "get_body_data",
    {
      title: "Their body data",
      description:
        "Merged daily steps, active energy, sleep minutes, weight (kg), resting heart rate (bpm), " +
        "HRV (ms, sdnn) and Oura readiness (score) for a date range, max 90 days. RHR is the day's " +
        "minimum, HRV the day's mean and readiness the day's latest sample. null means no " +
        "observation that day — it is never a zero.",
      inputSchema: z.object({ from: isoDate, to: isoDate }),
    },
    async ({ from, to }: { from: string; to: string }) => {
      if (!isCalendarDate(from) || !isCalendarDate(to)) {
        return { content: [{ type: "text" as const,
          text: "Ask with real calendar dates, YYYY-MM-DD." }] };
      }
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(span) || span < 0 || span + 1 > MAX_DAILY_WINDOW_DAYS) {
        return { content: [{ type: "text" as const,
          text: `Ask for a range of at most ${MAX_DAILY_WINDOW_DAYS} days, from before to.` }] };
      }
      const days = await mergedDays(ctx.admin, ctx.userId, from, to);
      return { content: [{ type: "text" as const, text: JSON.stringify(days, null, 2) }] };
    },
  );
}
