/**
 * The three coach tools an authorized agent gets over MCP — spec "API changes". Privileged boundary
 * (§2.2): the user comes from the token row through ctx, and every query is bound to it with an
 * explicit .eq('user_id', ctx.userId). No MCP tool may start a coach turn.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { constraintsPutSchema } from "@/lib/coach/types";
import { getProfile, putProfile } from "@/lib/server/constraints";
import { recomputeAfterHoldChange } from "@/lib/server/target-recompute";

export const COACH_TOOL_SCOPES = {
  get_constraints: "read",
  list_coach_messages: "read",
  set_constraints: "constraints:write",
} as const satisfies Record<"get_constraints" | "list_coach_messages", "read">
  & Record<"set_constraints", "constraints:write">;

/** Lower bound for a message read with no `sinceIso`: well before any turn, so it filters nothing. */
export const MESSAGES_FROM_FLOOR = "1970-01-01T00:00:00.000Z";

type Content = { content: { type: "text"; text: string }[] };

export type McpServerLike = {
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodType },
    handler: (args: never) => Promise<Content>,
  ): void;
};

const json = (v: unknown): Content =>
  ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

export function registerCoachTools(
  server: McpServerLike, ctx: { userId: string; admin: SupabaseClient }
): void {
  server.registerTool(
    "get_constraints",
    {
      title: "Read your constraint profile",
      description: "Avoided allergens, banned categories, avoided food ids, conditions and notes, with the current rev.",
      inputSchema: z.object({}),
    },
    async () => json(await getProfile(ctx.admin, ctx.userId)),
  );

  server.registerTool(
    "set_constraints",
    {
      title: "Change your constraint profile",
      description: "Compare-and-swap on baseRev for this account's rules.",
      inputSchema: constraintsPutSchema,
    },
    async (args: never) => {
      const body = args as Parameters<typeof putProfile>[2];
      const result = await putProfile(ctx.admin, ctx.userId, body);
      // The same pace-hold recompute as PUT /api/constraints (audit 2026-10-10 A103): a condition
      // saved here holds the pace now, and a removed one restores the stored preset.
      if (result.status === "ok" && body.conditions !== undefined) {
        await recomputeAfterHoldChange(ctx.admin, ctx.userId, "mcp set_constraints");
      }
      return json(result);
    },
  );

  server.registerTool(
    "list_coach_messages",
    {
      title: "Read coach turns",
      description: "Your latest coach messages (default 50), newest last, for a review. Optionally one thread; with sinceIso, the first messages from that time on.",
      inputSchema: z.object({
        threadId: z.uuid().optional(),
        sinceIso: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async (args: never) => {
      const a = args as { threadId?: string; sinceIso?: string; limit?: number };
      let query = ctx.admin.from("coach_messages")
        .select("id, thread_id, role, content, seq, deflected, created_at")
        .eq("user_id", ctx.userId);
      if (a.threadId) query = query.eq("thread_id", a.threadId);
      // With sinceIso: the oldest-first window from that moment. Without: the newest N, read
      // newest-first and reversed so the answer still reads newest last (audit A101, A111).
      const fromSince = a.sinceIso !== undefined;
      const { data, error } = await query
        .gte("created_at", a.sinceIso ?? MESSAGES_FROM_FLOOR)
        .order("created_at", { ascending: fromSince }).limit(a.limit ?? 50);
      if (error) return json({ error: "could not read coach messages" });
      const rows = data ?? [];
      return json(fromSince ? rows : [...rows].reverse());
    },
  );
}
