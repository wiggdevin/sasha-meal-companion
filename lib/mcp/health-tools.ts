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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (span < 0 || span + 1 > MAX_DAILY_WINDOW_DAYS) {
        return { content: [{ type: "text" as const,
          text: `Ask for a range of at most ${MAX_DAILY_WINDOW_DAYS} days, from before to.` }] };
      }
      const days = await mergedDays(ctx.admin, ctx.userId, from, to);
      return { content: [{ type: "text" as const, text: JSON.stringify(days, null, 2) }] };
    },
  );
}
