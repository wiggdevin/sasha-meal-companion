/**
 * Whether a provider is configured, without reading the key anywhere but here. Callers that skip
 * a provider entirely when it is absent (the Jev intent pre-pass, the reply check) ask this module
 * instead of reading the key themselves, so the key stays inside the provider boundary
 * (tests/ai/call-registry.test.ts).
 */
export function jevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

/** Owner request 2026-10-02: lets the coach skip the OpenRouter fallback (and its primary route,
 *  COACH_PROVIDER=openrouter) entirely when no key is set, without reading OPENROUTER_API_KEY
 *  anywhere but here (tests/ai/call-registry.test.ts). */
export function openRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
