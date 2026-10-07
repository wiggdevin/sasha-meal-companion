/**
 * Freezes an object and everything inside it (typed-array contents cannot be frozen; skipped).
 * An accessor property (a getter) is left unread: invoking it here would pay for whatever it
 * lazily computes -- a byte-array copy, say -- on every mint, whether or not anything ever reads
 * it. `Object.freeze` still locks the property itself down; only its value goes unwalked.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)
    && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      if (Object.getOwnPropertyDescriptor(value, key)?.get) continue;
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
