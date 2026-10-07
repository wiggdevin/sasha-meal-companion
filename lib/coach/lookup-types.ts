/**
 * The `lookup` tool's result shape (Phase 13 §3.3, slice 6).
 *
 * Kept apart from lib/server/lookup-lane.ts, which imports lib/ai/gemini-grounded.ts to make the
 * actual grounded call: lib/coach/executors.ts needs this type for `ExecutorPorts.lookup`, and
 * executors is reachable from client-safe entry points (lib/capture/propose.ts,
 * lib/coach/ui-blocks.ts — tests/coach/sanity-integration.test.ts) that must never pull the
 * provider adapter in, even through a type-only import the bundler cannot always elide.
 *
 * Pure. No I/O, no lib/ai import.
 */
import type { SubjectRejectionReason } from "@/lib/coach/lookup-subject";
import type { StoredAllergenEvidence } from "@/lib/policy/allergens";

export type LookupSource = { uri: string; title: string | null };

export type LookupRefusalReason = SubjectRejectionReason | "unresolved" | "unavailable";

export type LookupToolResult =
  | { ok: false; subject: string; refusal: LookupRefusalReason }
  | {
      ok: true;
      subject: string;
      /** The catalog's own name for the resolved product or brand field — never the model's raw
       *  candidate — is what was actually sent to search. */
      resolvedName: string;
      foodRefId: string | null;
      brand: string | null;
      answer: string;
      sources: readonly LookupSource[];
      webSearchQueries: number;
      /** §9 R8: always `no_evidence`. A lookup fact is never allergen evidence a hard rule reads. */
      evidence: StoredAllergenEvidence;
    };
