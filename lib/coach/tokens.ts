/**
 * The one token estimate the coach budgets with — T6 §1 and §2 both cap a block of prompt text,
 * and neither can call the provider's counter before building the text it would count.
 *
 * Four characters per token is the working figure for English prose and compact JSON on Gemini;
 * it is deliberately a slight over-count on JSON, so a block that estimates under the cap is
 * under it in fact. The spec asks for "the adapter's estimate"; lib/ai/adapter.ts has none — it
 * reads `usageMetadata` AFTER the call — so this is the nearest implementable thing.
 *
 * Pure. No I/O, no Supabase import.
 */

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
