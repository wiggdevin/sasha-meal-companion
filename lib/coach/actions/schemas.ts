/**
 * Every action schema, derived from the registered specs instead of kept by hand:
 *
 * - the STRICT union, from each spec's `input` (the application boundary);
 * - the LENIENT flat object a reply is parsed with, and the PROVIDER object the model is sent,
 *   from the shared named keys plus each spec's positional fields;
 * - the positional codec (`numericArgs` / `stringArgs`) and its provider description;
 * - the REPLAY union, from each spec's `replay`, for grounded rows read back from the database.
 *
 * Pure. Takes the specs as an argument so it never imports the registry.
 */

import { z } from "zod";
import { NAMED_WIRE_FIELDS, type NamedWireKey } from "@/lib/coach/actions/wire-fields";
import type { ActionSpec, SpecTypes } from "@/lib/coach/actions/spec";

/** The part of a spec the schemas are derived from. */
export type SchemaSpec = Pick<ActionSpec<SpecTypes>,
  "kind" | "input" | "normalizeInput" | "wire" | "replay" | "normalizeReplay">;
type AnySpec = SchemaSpec;
type Discriminable = Parameters<typeof z.discriminatedUnion>[1];

/** Same name, same lenient form: two kinds may share a positional field only if they agree. */
function positionalFields(specs: readonly AnySpec[]): Record<string, z.ZodType> {
  const fields: Record<string, z.ZodType> = {};
  for (const spec of specs) {
    for (const [name, schema] of Object.entries(spec.wire.fields ?? {})) {
      const known = fields[name];
      if (known && JSON.stringify(z.toJSONSchema(known)) !== JSON.stringify(z.toJSONSchema(schema))) {
        throw new Error(`coach action field "${name}" has two different wire forms`);
      }
      fields[name] ??= schema;
    }
  }
  return fields;
}

function usedNamedKeys(specs: readonly AnySpec[]): NamedWireKey[] {
  const used = new Set(specs.flatMap((spec) => spec.wire.named));
  return (Object.keys(NAMED_WIRE_FIELDS) as NamedWireKey[]).filter((key) => used.has(key));
}

function positionalLength(spec: AnySpec, side: "numbers" | "strings"): number {
  const fixed = spec.wire[side]?.length ?? 0;
  const rest = side === "numbers" ? spec.wire.numbersRest?.max : spec.wire.stringsRest?.max;
  return fixed + (rest ?? 0);
}

/** "log_water [ml]; …" — each kind's positions in registry order, equal entries merged. */
function positionalDoc(specs: readonly AnySpec[], side: "numbers" | "strings"): string {
  const entries: string[] = [];
  for (const spec of specs) {
    const fields = [...(spec.wire[side] ?? [])];
    if (side === "numbers" && spec.wire.numbersRest) fields.push(`...${spec.wire.numbersRest.field}`);
    if (side === "strings" && spec.wire.stringsRest) fields.push(`...${spec.wire.stringsRest.field}`);
    if (fields.length === 0) continue;
    const note = side === "numbers" ? spec.wire.numbersDoc : spec.wire.stringsDoc;
    const entry = `${spec.wire.docLabel ?? spec.kind} [${fields.join(", ")}]${note ?? ""}`;
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.join("; ");
}

export function buildActionSchemas(specs: readonly AnySpec[]) {
  const kinds = specs.map((spec) => spec.kind) as [string, ...string[]];
  const byKind = new Map(specs.map((spec) => [spec.kind, spec]));
  const named = usedNamedKeys(specs);
  const positional = positionalFields(specs);
  const numericMax = Math.max(...specs.map((spec) => positionalLength(spec, "numbers")));
  const stringMax = Math.max(...specs.map((spec) => positionalLength(spec, "strings")));
  const numericArgs = () => z.array(z.number()).max(numericMax);
  const stringArgs = () => z.array(z.string().max(2000)).max(stringMax);

  const flat = z.object({
    kind: z.enum(kinds),
    ...Object.fromEntries(named.map((key) => {
      const field: { provider: z.ZodType; lenient?: z.ZodType } = NAMED_WIRE_FIELDS[key];
      return [key, (field.lenient ?? field.provider).optional()];
    })),
    ...Object.fromEntries(Object.entries(positional).map(([key, schema]) => [key, schema.optional()])),
    numericArgs: numericArgs().optional(),
    stringArgs: stringArgs().optional(),
  });

  const provider = z.object({
    kind: z.enum(kinds),
    ...Object.fromEntries(named.map((key) => [key, NAMED_WIRE_FIELDS[key].provider])),
    numericArgs: numericArgs().describe(
      `Positional numbers: ${positionalDoc(specs, "numbers")}. Use [] otherwise.`),
    stringArgs: stringArgs().describe(
      `Positional strings: ${positionalDoc(specs, "strings")}. Use [] otherwise.`),
  });

  const specOf = (value: unknown) => typeof value === "object" && value !== null
    ? byKind.get((value as { kind?: unknown }).kind as string) : undefined;

  const strict = z.preprocess((value) => {
    const spec = specOf(value);
    return spec?.normalizeInput ? spec.normalizeInput(value as Record<string, unknown>) : value;
  }, z.discriminatedUnion("kind", specs.map((spec) => spec.input) as unknown as Discriminable));

  const replay = z.preprocess((value) => {
    const spec = specOf(value);
    return spec?.normalizeReplay ? spec.normalizeReplay(value as Record<string, unknown>) : value;
  }, z.discriminatedUnion("kind", specs.map((spec) => spec.replay) as unknown as Discriminable));

  /**
   * Empty is how a required-on-the-wire field says "not for this kind": an empty string, a zero
   * quantity, an empty list, or a named item with no name. Dropping them before the strict parse is
   * what lets one flat object carry every supported action shape.
   */
  function stripEmpty(wire: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const keepNull = specOf(wire)?.wire.keepNull ?? [];
    for (const [key, value] of Object.entries(wire)) {
      if (value === undefined) continue;
      if (value === null) {
        if (keepNull.includes(key)) out[key] = null;
        continue;
      }
      if (typeof value === "string" && value.trim() === "") continue;
      if (typeof value === "number" && value === 0) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        if (value.every((item) => typeof item !== "object" || item === null)) {
          out[key] = [...value];
          continue;
        }
        const items = value.filter((item) =>
          typeof (item as { name?: unknown }).name === "string"
          && ((item as { name: string }).name.trim() !== ""));
        if (items.length === 0) continue;
        out[key] = items.map((item) => stripEmpty(item as Record<string, unknown>));
        continue;
      }
      if (typeof value === "object") {
        const inner = stripEmpty(value as Record<string, unknown>);
        if (Object.keys(inner).length === 0) continue;
        out[key] = inner;
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /**
   * A numeric rest list (update_profile's training weekdays) without its zero placeholders. 0 is
   * both the provider's placeholder and Sunday (audit 2026-10-10 A160): a goal-only update padded
   * with zeros wrote Sunday as the only training day. Two or more zeros are padding (a weekday is
   * never listed twice); a single 0 is Sunday. Repeats are dropped.
   */
  function restValues(values: number[]): number[] {
    const zeros = values.filter((value) => value === 0).length;
    const padding = zeros > 1;
    const kept = values.filter((value) => typeof value === "number" && !(padding && value === 0));
    return [...new Set(kept)];
  }

  /** Expand the provider-only positional fields back into the named application action. */
  function expandCompactArgs(cleaned: Record<string, unknown>): Record<string, unknown> {
    const { numericArgs: numericValue, stringArgs: stringValue, ...expanded } = cleaned;
    const numbers = Array.isArray(numericValue) ? numericValue as number[] : [];
    const strings = Array.isArray(stringValue) ? stringValue as string[] : [];
    const wire = specOf(expanded)?.wire;
    (wire?.numbers ?? []).forEach((name, index) => {
      const value = numbers[index];
      if (expanded[name] === undefined && typeof value === "number" && value !== 0) {
        expanded[name] = value;
      }
    });
    (wire?.strings ?? []).forEach((name, index) => {
      const value = strings[index];
      if (expanded[name] === undefined && typeof value === "string" && value.trim() !== "") {
        expanded[name] = value;
      }
    });
    const rest = wire?.numbersRest;
    const fixed = wire?.numbers?.length ?? 0;
    if (rest && expanded[rest.field] === undefined && numbers.length > fixed) {
      const values = restValues(numbers.slice(fixed));
      if (values.length > 0) expanded[rest.field] = values;
    }
    const stringsRest = wire?.stringsRest;
    const fixedStrings = wire?.strings?.length ?? 0;
    if (stringsRest && expanded[stringsRest.field] === undefined && strings.length > fixedStrings) {
      expanded[stringsRest.field] = strings.slice(fixedStrings);
    }
    return expanded;
  }

  function actionCandidate(wire: z.infer<typeof flat>, today?: string): unknown {
    const cleaned = expandCompactArgs(stripEmpty(wire));
    const candidate = cleaned.date === undefined && cleaned.from === undefined && today !== undefined
      ? { ...cleaned, date: today } : cleaned;
    const rule = specOf(cleaned)?.wire.candidate;
    const accepted = rule ? rule(candidate, cleaned) : candidate;
    if (accepted === null) return null;
    const parsed = strict.safeParse(accepted);
    return parsed.success ? parsed.data : null;
  }

  /** Flat for the provider, strict when the adapter parses it. */
  function wireFor(today?: string) {
    return flat
      .superRefine((wire, ctx) => {
        if (actionCandidate(wire, today) === null) {
          ctx.addIssue({ code: "custom", message: "the action is not a supported action shape" });
        }
      })
      .transform((wire, ctx) => {
        const candidate = actionCandidate(wire, today);
        if (candidate === null) {
          ctx.addIssue({ code: "custom", message: "the action is not a supported action shape" });
          return z.NEVER;
        }
        return candidate;
      });
  }

  return { kinds, flat, provider, strict, replay, wireFor };
}
