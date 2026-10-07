/**
 * Phase 13 §2: every Gemini call that carries user content needs the project attestation
 * (lib/ai/attestation.ts). Production sets both variables, so the suite runs attested by default,
 * as production does. A test that proves a refusal turns one off with vi.stubEnv; unstubAllEnvs
 * restores these values.
 */
process.env.HEALTH_CONTEXT_PROVIDER ??= "gemini";
process.env.GEMINI_BILLING_ATTESTED ??= "1";
