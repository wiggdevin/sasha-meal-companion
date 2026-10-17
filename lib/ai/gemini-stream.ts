/**
 * OD06 / W091: a Gemini structured call, streamed. The same request as `generateContent`; each
 * chunk carries the next piece of the reply text, which `onText` sees whole so far, and the usage
 * rides on the last chunk. Provider I/O only, like the rest of the lane (lib/ai/adapter.ts).
 */
import type { GoogleGenAI } from "@google/genai";
import type { ProviderResult } from "@/lib/ai/call-ledger";
import { geminiUsage } from "@/lib/ai/gemini-usage";

type Request = Parameters<GoogleGenAI["models"]["generateContentStream"]>[0];

export async function streamGemini(
  ai: GoogleGenAI, request: Request, onText: (raw: string) => void,
): Promise<ProviderResult> {
  let text = "";
  let usage: Parameters<typeof geminiUsage>[0];
  for await (const chunk of await ai.models.generateContentStream(request)) {
    const piece = chunk.text ?? "";
    if (piece !== "") {
      text += piece;
      try { onText(text); } catch { /* a watcher's failure never fails the call */ }
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }
  return { text, ...geminiUsage(usage) };
}
