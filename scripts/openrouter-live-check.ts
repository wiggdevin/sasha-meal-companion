/**
 * Owner request 2026-10-02: one real structured call through lib/ai/openrouter.ts, against the
 * live provider — no stubbed fetch. Requires OPENROUTER_API_KEY and OPENROUTER_ATTESTED=1
 * (docs/ai-data-handling.md "OpenRouter"); refuses before any network call without both.
 *
 *   node --env-file=.env.local --import tsx scripts/openrouter-live-check.ts [model-slug]
 *   pnpm exec tsx scripts/openrouter-live-check.ts [model-slug]
 *
 * With no model slug given, queries GET /v1/models for one that supports structured outputs. This
 * writes no `ai_calls` row and needs no Supabase credentials: the admin double below only records
 * what callModel WOULD have written, so the only precondition is the OpenRouter key.
 */
import { loadEnvFile } from "node:process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { OPENROUTER_PINS } from "@/lib/ai/lanes";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { coachOpenRouterPayload } from "@/lib/ai/openrouter-payloads";

loadEnvFile(".env.local");

const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const PREFERRED_MODEL = OPENROUTER_PINS.coach;
const SCHEMA = z.object({ answer: z.string().min(1) });

type ApiModel = { id: string; supported_parameters?: string[] };

function supportsStructuredOutputs(model: ApiModel): boolean {
  const supported = model.supported_parameters ?? [];
  return supported.includes("structured_outputs") || supported.includes("response_format");
}

/** GET /v1/models, filtered to structured-output-capable slugs; prefers PREFERRED_MODEL when it
 *  is present, otherwise the first match the catalog returns. */
async function pickModel(key: string): Promise<string> {
  const res = await fetch(MODELS_ENDPOINT, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET /v1/models: HTTP ${res.status}`);
  const body = await res.json() as { data: ApiModel[] };
  const candidates = body.data.filter(supportsStructuredOutputs);
  const picked = candidates.find((model) => model.id === PREFERRED_MODEL) ?? candidates[0];
  if (!picked) throw new Error("no structured-output-capable model found in the OpenRouter catalog");
  return picked.id;
}

/** Records what callModel would have written to `ai_calls`, without a real database. */
function fakeAdmin(): { admin: SupabaseClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
    gte: async () => ({ data: [], error: null }),
    insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
  });
  return { admin: { from: () => chain } as unknown as SupabaseClient, rows };
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
  if (process.env.OPENROUTER_ATTESTED !== "1") {
    throw new Error(
      "OPENROUTER_ATTESTED=1 is required before a call carries any content "
      + "(docs/ai-data-handling.md \"OpenRouter\").",
    );
  }
  const modelId = process.argv[2] ?? await pickModel(key);
  const { admin, rows } = fakeAdmin();
  const payload = coachOpenRouterPayload(["Reply by setting answer to the single word: pong"]);

  console.log(`model: ${modelId}`);
  const started = Date.now();
  const result = await generateOpenRouter({
    payload, userId: "openrouter-live-check", admin, modelId, schema: SCHEMA,
  });
  console.log(`elapsed: ${Date.now() - started} ms`);
  console.log(`reply: ${JSON.stringify(result)}`);
  console.log(`would-be ai_calls row: ${JSON.stringify(rows[0] ?? null)}`);
  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
