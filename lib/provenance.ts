/**
 * The one AI-provenance shape (`Provenance`, lib/types.ts): its wire schema and the three ways to
 * build it. Every API that carries model-produced content uses these, so the label the phone
 * shows is decided once, on the server, from the path that actually ran.
 */

import { z } from "zod";
import type { Provenance } from "@/lib/types";

export type { Provenance };

export const provenanceSchema: z.ZodType<Provenance> = z.discriminatedUnion("ai", [
  z.object({
    ai: z.literal(true), source: z.enum(["model", "jev"]),
    purpose: z.string().min(1).max(64).optional(),
  }).strict(),
  z.object({ ai: z.literal(false), source: z.literal("app") }).strict(),
]);

/** A generative model call produced it; `purpose` is its `ai_calls` purpose. */
export function byModel(purpose?: string): Provenance {
  return purpose ? { ai: true, source: "model", purpose } : { ai: true, source: "model" };
}

/** A Jev (TypeSafe System One) judgment decided it. */
export function byJev(purpose?: string): Provenance {
  return purpose ? { ai: true, source: "jev", purpose } : { ai: true, source: "jev" };
}

/** The app wrote it from data and rules alone; no model or Jev call shaped it. */
export const BY_APP: Provenance = Object.freeze({ ai: false, source: "app" }) as Provenance;

/** A stored or received value, or null when it is not a valid provenance. */
export function parseProvenance(value: unknown): Provenance | null {
  const parsed = provenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
