// lib/ai/gemini-config.ts
/**
 * The `config` block for a Gemini generateContent call, in one testable place.
 *
 * It exists because of the knob that was missing from it. gemini-3.6-flash THINKS by default, and
 * nothing turned that off: every coach turn paid for hidden reasoning on three to seven calls, and
 * some of that reasoning reached the user inside the reply — "Wait, no control tokens allowed
 * anywhere at any places in JSON string!" went to the user's verbatim on 2026-09-14.
 *
 * Measured against the live API, one trivial prompt, same schema and temperature:
 *   default 2375 ms / 206 thought tokens      MINIMAL 1134 ms / 0 thought tokens
 *   default 3191 ms / 453 thought tokens      MINIMAL 1434 ms / 0 thought tokens
 *
 * Every call this app makes is a short structured reply — a coach turn, a text-to-items
 * extraction, a weekly summary. The coach uses MINIMAL; the capture pin gemini-3.8-flash
 * rejects MINIMAL, so it uses LOW (verified against the provider on 2026-09-15).
 * A caller that needs more can explicitly request it.
 *
 * `thinkingBudget` is deliberately not used: the SDK states it "will no longer be supported and
 * will result in a user error" from Gemini 3.5 onwards. `thinkingLevel` replaced it.
 */
import { ThinkingLevel } from "@google/genai";
import { REJECTS_MINIMAL_THINKING } from "@/lib/ai/lanes";

export type GeminiConfigArgs = {
  model: string;
  jsonSchema: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
};

export function geminiConfig(args: GeminiConfigArgs): Record<string, unknown> {
  return {
    temperature: args.temperature ?? 0,
    responseMimeType: "application/json",
    responseSchema: args.jsonSchema as Record<string, unknown>,
    thinkingConfig: { thinkingLevel: args.thinkingLevel
      ?? (REJECTS_MINIMAL_THINKING.has(args.model) ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL) },
    ...(args.signal === undefined ? {} : { abortSignal: args.signal }),
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
  };
}
