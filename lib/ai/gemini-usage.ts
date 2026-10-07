/**
 * Token counts from a Gemini response. Thinking tokens (usageMetadata.thoughtsTokenCount) are billed
 * as output, additive to candidatesTokenCount (node_modules/@google/genai/dist/genai.d.ts), and every
 * candidate model here runs with thinking at LOW or MINIMAL, never off. Reading candidatesTokenCount
 * alone understated cost while usageKnown still said "true". Absent (no thinking billed), it adds
 * nothing. Pure data. No I/O.
 */
import type { ProviderResult } from "@/lib/ai/call-ledger";

type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };

export function geminiUsage(meta: Usage | undefined): Omit<ProviderResult, "text"> {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    usageKnown: typeof meta?.promptTokenCount === "number"
      && typeof meta?.candidatesTokenCount === "number",
  };
}
