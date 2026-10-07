/**
 * The shared "parsed, but nothing usable" rule for both structured lanes (lib/ai/adapter.ts and
 * lib/ai/openrouter.ts). Split out so the adapter stays inside its size budget
 * (tests/speed/file-size.test.ts). A caller's `refuse` names why a well-formed reply carries
 * nothing usable (an unreadable label, lib/ai/capture.ts); the reply then becomes an
 * UnusableReply (lib/ai/call.ts), which is recorded as schema_invalid and never retried.
 *
 * Pure. No I/O.
 */
import { UnusableReply } from "@/lib/ai/call";
import { isCapacityFailure, isPermissionDeniedFailure } from "@/lib/ai/failures";

export type Refuse<T> = (value: T) => string | null;
export type RefuseArg<T> = {
  /** A reason to refuse a reply that parsed but carries nothing usable (lib/ai/call.ts UnusableReply). */
  refuse?: Refuse<T>;
};

/** The parsed value, or an UnusableReply when the caller's `refuse` names a reason. */
export function acceptRefused<T>(value: T, refuse?: Refuse<T>): T {
  const reason = refuse?.(value);
  if (reason) throw new UnusableReply(reason);
  return value;
}

/** An UnusableReply is final: a second attempt reads the same input the same way. */
export function isFinalReply(e: unknown): boolean {
  return e instanceof UnusableReply;
}

/**
 * The Gemini lane's retry rule: never a final reply, never a capacity failure when the caller has
 * another model waiting (`abandonOnCapacity`, lib/ai/failures.ts), and — 2026-10-06 — never a 403
 * PERMISSION_DENIED, full stop. Retrying it answers the identical way every time (the whole
 * project is blocked, not this one request), so a second and third attempt only cost the caller
 * the time a fallback provider could have spent answering; unlike capacity, there is no
 * `abandonOnCapacity`-style opt-out here because there is no scenario where re-asking the SAME
 * model helps.
 */
export function geminiRetryable(abandonOnCapacity?: boolean): (e: unknown) => boolean {
  return (e) => !isFinalReply(e) && !isPermissionDeniedFailure(e)
    && !(abandonOnCapacity && isCapacityFailure(e));
}
