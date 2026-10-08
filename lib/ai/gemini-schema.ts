/**
 * Gemini-specific schema prep for the structured transport (lib/ai/adapter.ts): which schema one
 * call sends the provider, and stripping the ```json … ``` fence a chat model sometimes wraps its
 * answer in. lib/ai/json-schema.ts does the actual zod-to-JSON-Schema conversion.
 */
import type { ZodType } from "zod";
import { toGeminiSchema } from "@/lib/ai/json-schema";

/**
 * The schema Gemini is sent for one call: the caller's stricter provider schema when it gave one
 * (lib/coach/wire.ts requires every key), else the reply schema itself. Computed twice per call —
 * once for the cost estimate, which must be ready before any attempt starts, and once when the
 * transport opens — so this stays a pure, cheap re-derivation rather than cached state.
 */
export function geminiRequestSchema(schema: ZodType, providerSchema?: ZodType): unknown {
  return toGeminiSchema(providerSchema ?? schema);
}

/** Strip the ```json … ``` wrapper a chat model adds around an object. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}
