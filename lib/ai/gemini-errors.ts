import { ProviderHttpError } from "@/lib/ai/call";

/**
 * The provider words a Gemini error may keep: fixed codes only, never its free text, which can echo
 * the user's own content into `ai_calls.error` and the logs (W068). The codes are what
 * lib/ai/failures.ts reads: a project denial, a quota, an overload, and a 503 that is really a
 * schema complaint (2026-09-16).
 */
const GEMINI_ERROR_CODES: readonly [string, RegExp][] = [
  ["PERMISSION_DENIED", /permission[_ ]denied|denied access/i],
  ["RESOURCE_EXHAUSTED", /resource[_ ]exhausted|quota/i],
  ["UNAVAILABLE", /\bunavailable\b|overloaded|high demand/i],
  ["DEADLINE_EXCEEDED", /deadline[_ ]exceeded/i],
  ["INVALID_ARGUMENT", /invalid[_ ]argument/i],
  ["schema", /schema/i],
];

export function geminiHttpError(e: unknown): ProviderHttpError | null {
  const { status, message: detail } = e as { status?: unknown; message?: unknown };
  if (typeof status !== "number") return null;
  const text = typeof detail === "string" ? detail : "";
  const codes = GEMINI_ERROR_CODES.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  return new ProviderHttpError(status, `gemini ${status}${codes.length ? `: ${codes.join(" ")}` : ""}`);
}
