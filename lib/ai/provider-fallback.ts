import { CallRefused, classifyFailure, ProviderHttpError, SchemaRejection } from "@/lib/ai/call";
import { isPermissionDeniedFailure } from "@/lib/ai/failures";
import { HttpError } from "@/lib/server/auth";

/** Try another governed call only for a transport outage, timeout, rate limit or server error. */
export function providerFallbackWorthTrying(error: unknown): boolean {
  if (error instanceof HttpError || error instanceof CallRefused || error instanceof SchemaRejection) return false;
  // 2026-10-06: a 403 PERMISSION_DENIED is the project being blocked outright, worth trying a
  // DIFFERENT PROVIDER (this predicate's whole job) even though lib/ai/failures.ts
  // worthAnotherModel deliberately says no to retrying the SAME provider's other model.
  if (isPermissionDeniedFailure(error)) return true;
  if (error instanceof ProviderHttpError) return error.status === 429 || (error.status >= 500 && error.status < 600);
  if (classifyFailure(error) === "timeout") return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  // The circuit breaker's own refusal (lib/ai/circuit.ts assertCircuitClosed) is a plain Error,
  // not a ProviderHttpError — a circuit open for permission_denied or ordinary failures is worth
  // a different provider either way.
  return error instanceof Error && error.message.startsWith("circuit open");
}
