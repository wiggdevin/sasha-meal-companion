import { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { COACH_TOOL_SCOPES, registerCoachTools } from "@/lib/mcp/coach-tools";
import {
  EXPENDITURE_TOOL_SCOPES, registerExpenditureTools,
} from "@/lib/mcp/expenditure-tools";
import { HEALTH_TOOL_SCOPES, registerHealthTools } from "@/lib/mcp/health-tools";
import {
  parseMessages, readCappedText, rejectDeclaredOversize, scopesForMessages,
} from "@/lib/mcp/body";
import { jsonError } from "@/lib/server/http";
import { withTokenUser, type TokenScope, type TokenUser } from "@/lib/server/privileged";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { hashToken } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INSTRUCTIONS = "Use the registered user-scoped tools only.";

const buildMcpHandler = (ctx: TokenUser, admin: SupabaseClient) => createMcpHandler(
  (server) => {
    registerHealthTools(server, { userId: ctx.userId, admin });
    registerExpenditureTools(server, { userId: ctx.userId, admin });
    registerCoachTools(server as never, { userId: ctx.userId, admin });
  },
  {
    serverInfo: { name: "meal-companion", version: "1.0.0" },
    instructions: SERVER_INSTRUCTIONS,
  },
);

const PRE_IDENTITY_LIMIT = 30;

function preIdentityKey(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  // Scale S2: a caller with no token is keyed by its IP, not one bucket every such caller shares.
  const none = `mcp:pre:none:ip:${req.headers.get("x-real-ip") ?? "unknown"}`;
  if (!header.startsWith("Bearer ")) return none;
  const token = header.slice(7).trim();
  if (token.length === 0) return none;
  return `mcp:pre:${hashToken(token).toString("hex")}`;
}

function preIdentityIpKey(req: Request): string {
  return `mcp:pre:ip:${req.headers.get("x-real-ip") ?? "unknown"}`;
}

const TOOL_SCOPES: Record<string, TokenScope> = {
  ...HEALTH_TOOL_SCOPES,
  ...EXPENDITURE_TOOL_SCOPES,
  ...COACH_TOOL_SCOPES,
};

async function guarded(req: Request): Promise<Response> {
  try {
    // The IP key first (audit A150): a refused IP stops in memory before a fresh token-hash key can
    // reach the database.
    await enforceRateLimit(preIdentityIpKey(req), PRE_IDENTITY_LIMIT, 60);
    await enforceRateLimit(preIdentityKey(req), PRE_IDENTITY_LIMIT, 60);
    // A declared oversize is refused from the header alone; no body byte is read before auth (A131).
    rejectDeclaredOversize(req);
    const bodyConsumed = req.method !== "GET" && req.method !== "DELETE";
    let raw = "";

    const requiredScopes = async (ctx: TokenUser) => {
      await enforceRateLimit(`mcp:${ctx.tokenId}`, 60, 60);
      if (!bodyConsumed) return ["read" as const];
      raw = await readCappedText(req);
      return scopesForMessages(parseMessages(raw), TOOL_SCOPES);
    };

    return await withTokenUser(req, requiredScopes, async (ctx, admin) => {
      const replayed = bodyConsumed
        ? new Request(req.url, { method: req.method, headers: req.headers, body: raw })
        : req;
      return buildMcpHandler(ctx, admin)(replayed);
    });
  } catch (error) {
    const response = jsonError(error);
    if (response.status === 401) response.headers.set("WWW-Authenticate", "Bearer");
    return response;
  }
}

export { guarded as GET, guarded as POST, guarded as DELETE };
