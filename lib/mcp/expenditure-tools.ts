/**
 * The estimator's MCP surface: read-only, no write path to targets in this phase (spec "User
 * stories — Agent via MCP"). `get_expenditure_status` ships here, not in Phase 7 (contracts §3,
 * reconciled); the coach's registry calls `latestEstimate` directly instead of going through MCP.
 *
 * The handler is built per request inside `withTokenUser`, so `ctx.userId` is the token row's
 * single tenant and every read is bound to it (§2.2).
 */
import type { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { latestEstimate } from "@/lib/server/expenditure";
import { activeTargets } from "@/lib/server/targets";

export type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];
export type ToolContext = { userId: string; admin: SupabaseClient };

export const EXPENDITURE_TOOL_SCOPES: Record<"get_expenditure_status" | "get_targets", "read"> = {
  get_expenditure_status: "read",
  get_targets: "read",
};

const json = (value: unknown) => ({ content: [{ type: "text" as const,
  text: JSON.stringify(value, null, 2) }] });

export function registerExpenditureTools(server: McpServer, ctx: ToolContext): void {
  const activityContextEnabled = process.env.COACH_ACTIVITY_CONTEXT_ENABLED === "true";
  server.registerTool(
    "get_expenditure_status",
    {
      title: "Expenditure status",
      description: activityContextEnabled
        ? "Your advisory expenditure status: learned and profile TDEE, learning progress, confidence, reason, and activity context when available. Read-only; it can neither propose nor set a target."
        : "The advisory expenditure estimate: status, TDEE in kcal, confidence and the reason string. Read-only; it can neither propose nor set a target.",
      inputSchema: z.object({}),
    },
    async () => {
      const status = await latestEstimate(ctx.admin, ctx.userId);
      if (activityContextEnabled) return json(status);
      // exp-3.0.0: `profileTdeeKcal` is the starting estimate every surface shows, so it stays even
      // with the activity fields off; only the activity context and the learning counter are gated.
      const { activityContext, learningDaysRemaining, ...legacy } = status;
      void activityContext; void learningDaysRemaining;
      return json(legacy);
    },
  );

  server.registerTool(
    "get_targets",
    {
      title: "Active targets",
      description: "The calorie and macro targets in force per day type, from the account's latest effective target revision. Read-only. With no revision it answers `needs_profile` and no numbers — design §5.2; there is no authored fallback.",
      inputSchema: z.object({}),
    },
    /* Design §5.1/§5.2: the authored ramp is deleted, not gated. A read never derives, and a
       row-less account gets the same discriminated answer `GET /api/targets` gives, so the coach
       cannot mistake an absent profile for a target of zero. */
    async () => {
      const target = await activeTargets(ctx.admin, ctx.userId);
      return json(target ? { status: "ready", target } : { status: "needs_profile", target: null });
    },
  );
}
