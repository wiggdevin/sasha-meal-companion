import { z } from "zod";
import type { SanityStatus } from "@/lib/log/sanity-types";

/** Per-item annotations use SanityStatus; turn-level eval status uses a separate vocabulary. */
export const ITEM_SANITY_WARNING_STATUS = "warn" satisfies SanityStatus;

export const jevExpectationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("logged_facet_mark"),
    facet: z.literal("contains_soy"),
    preference: z.literal("no_soy"),
  }),
  z.object({
    kind: z.literal("recipe_exclusion"),
    facet: z.literal("contains_soy"),
    preference: z.literal("no_soy"),
  }),
  z.object({
    kind: z.literal("unverified_recipe"),
    preference: z.literal("low_fodmap"),
  }),
  z.object({
    kind: z.literal("tiny_log_commit"),
    grams: z.literal(1),
  }),
  z.object({
    kind: z.literal("ranked_suggestions"),
    purpose: z.literal("suggest-options"),
    calls: z.literal(1),
  }),
  z.object({
    kind: z.literal("role_advice_unconfirmed"),
  }),
]);

export type JevExpectation = z.infer<typeof jevExpectationSchema>;
