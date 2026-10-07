/**
 * The NAMED keys of the provider's action object, in the order Gemini fills them.
 *
 * This is one shared list on purpose: every named key costs the provider schema a property, and
 * the live model stops accepting the turn schema past 30 (tests/coach/provider-schema.test.ts).
 * A new kind reuses these keys or carries its own fields positionally (`numericArgs` /
 * `stringArgs`), declared in its own spec; adding a key here spends that budget.
 *
 * `provider` is the form the model is SENT: required, empty allowed. `lenient` is the form a
 * reply is PARSED with (made optional when the schema is assembled); it defaults to `provider`.
 * Both use min(0) because Gemini rejects exclusiveMinimum; the strict per-kind schema is what
 * refuses zero grams.
 */

import { z } from "zod";
import { LOG_SLOT_IDS } from "@/lib/coach/actions/fields";

type NamedWireField = { provider: z.ZodType; lenient?: z.ZodType };

const name = () => z.string().max(120);
const amount = () => z.number().min(0).max(2000);

export const NAMED_WIRE_FIELDS = {
  date: { provider: z.string() },
  from: { provider: z.string() },
  through: { provider: z.string() },
  weekdays: { provider: z.array(z.number().int().min(0).max(6)).max(7) },
  title: { provider: z.string().max(120) },
  slot: { provider: z.enum(LOG_SLOT_IDS) },
  items: {
    provider: z.array(z.object({ name: name(), grams: amount() })).max(8),
    lenient: z.array(z.object({ name: name().optional(), grams: amount().optional() })).max(8),
  },
  item: {
    provider: z.object({ name: name(), grams: amount() }),
    lenient: z.object({ name: name().optional(), grams: amount().optional() }),
  },
  name: { provider: name() },
  grams: { provider: amount() },
  entryId: { provider: z.string().max(64) },
} as const satisfies Record<string, NamedWireField>;

export type NamedWireKey = keyof typeof NAMED_WIRE_FIELDS;
