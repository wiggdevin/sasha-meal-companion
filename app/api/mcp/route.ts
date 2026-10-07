import { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { COACH_TOOL_SCOPES, registerCoachTools } from "@/lib/mcp/coach-tools";
import {
  EXPENDITURE_TOOL_SCOPES, registerExpenditureTools,
} from "@/lib/mcp/expenditure-tools";
import { HEALTH_TOOL_SCOPES, registerHealthTools } from "@/lib/mcp/health-tools";
import { HttpError } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { withTokenUser, type TokenUser } from "@/lib/server/privileged";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { hashToken, hasScope } from "@/lib/server/tokens";

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

const MAX_BODY_BYTES = 64 * 1024;
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

type Scope = "read" | "constraints:write";

const TOOL_SCOPES: Record<string, Scope> = {
  ...HEALTH_TOOL_SCOPES,
  ...EXPENDITURE_TOOL_SCOPES,
  ...COACH_TOOL_SCOPES,
};

function toolNamesInBody(raw: string): string[] {
  if (raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    const candidate = call as { method?: unknown; params?: { name?: unknown } };
    if (candidate.method === "tools/call" && typeof candidate.params?.name === "string") {
      names.push(candidate.params.name);
    }
  }
  return names;
}

function scopesForBody(raw: string): Set<Scope> {
  const required = new Set<Scope>();
  for (const name of toolNamesInBody(raw)) {
    const scope = TOOL_SCOPES[name];
    if (scope && scope !== "read") required.add(scope);
  }
  return required;
}

function scopeForBody(raw: string): Scope {
  const [first] = scopesForBody(raw);
  return first ?? "read";
}

async function readCappedBody(req: Request): Promise<{
  bodyConsumed: boolean;
  raw: string;
}> {
  const bodyConsumed = req.method !== "GET" && req.method !== "DELETE";
  const raw = bodyConsumed ? await req.text() : "";
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new HttpError(413, "too_large", `Body over ${MAX_BODY_BYTES} bytes.`);
  }
  return { bodyConsumed, raw };
}

async function guarded(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(preIdentityKey(req), PRE_IDENTITY_LIMIT, 60);
    await enforceRateLimit(preIdentityIpKey(req), PRE_IDENTITY_LIMIT, 60);
    const { bodyConsumed, raw } = await readCappedBody(req);

    return await withTokenUser(req, scopeForBody(raw), async (ctx, admin) => {
      await enforceRateLimit(`mcp:${ctx.tokenId}`, 60, 60);

      if (bodyConsumed) {
        await readJson(
          new Request(req.url, { method: req.method, headers: req.headers, body: raw }),
          z.unknown(),
          MAX_BODY_BYTES,
        );
      }

      for (const scope of scopesForBody(raw)) {
        if (!hasScope(ctx.scopes, scope)) {
          throw new HttpError(403, "forbidden", `Token lacks the "${scope}" scope.`);
        }
      }

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
