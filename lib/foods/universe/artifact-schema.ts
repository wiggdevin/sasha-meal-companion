/**
 * The strict schemas of the W1b server-only artifacts (Phase 18 D10, hard rules H1 and H4): the
 * population prior table, the substitute graph and the manifest. Every object is an allowlist: an
 * unknown key at any depth fails, so nothing respondent-level can ride along under a new name.
 * scripts/priors/check-artifact.ts and the runtime loader (./artifacts.ts) both parse with these.
 *
 * Pure. No I/O.
 */
import { z } from "zod";
import {
  GRAPH_FILE, MIN_EFFECTIVE_N, NHANES_RULING_PATH, PRIOR_COHORTS, PRIOR_FILE, type PriorRow,
} from "@/lib/foods/universe/prior";
import {
  MAX_NEIGHBOURS, SUBSTITUTE_TERMS, type SubstituteGraph, type SubstituteTerm,
} from "@/lib/foods/universe/substitutes";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);
const cohort = z.string().refine((value) => PRIOR_COHORTS.includes(value), "not a cohort");
const term = z.enum(SUBSTITUTE_TERMS as [SubstituteTerm, ...SubstituteTerm[]]);

export const PriorRowSchema = z.strictObject({
  cohort, food_key: z.string().min(1), rate: z.number().gt(0).lt(1),
  n_eff: z.number().int().min(MIN_EFFECTIVE_N),
});
export const PriorTableSchema = z.array(PriorRowSchema);

export const SubstituteEdgeSchema = z.strictObject({
  from: z.string().min(1), to: z.string().min(1), sub: unit,
  tax: unit.optional(), nutr: unit.optional(), ctx: unit.optional(), like: unit.optional(), comp: unit.optional(),
});
export const SubstituteGraphSchema = z.strictObject({
  type: z.literal("substitute"),
  version: z.string().min(1),
  weights: z.strictObject({ tax: z.number(), nutr: z.number(), ctx: z.number(), like: z.number(), comp: z.number() }),
  absent: z.array(term),
  edges: z.array(SubstituteEdgeSchema),
});

const releases = z.strictObject({ "2017-2020": unit, "2021-2023": unit });
const cellStats = z.strictObject({ cells: count, min: count, median: count, max: count });

export const NhanesSummarySchema = z.strictObject({
  population: z.literal("U.S. adults 18 and over"),
  coefficients: z.strictObject({
    gramsThreshold: z.number(), minEffectiveN: z.literal(MIN_EFFECTIVE_N), rootPrior: z.string(),
    shrinkage: z.number(), shrinkageGrid: z.array(z.number()), shrinkageByFold: z.array(z.number()),
    pooling: z.string(), cohorts: z.enum(["national only", "national and sex by age"]),
    sexAgeEnabled: z.boolean(), sexAgeDisabledBecause: z.array(z.string()),
  }),
  mapping: z.strictObject({
    coverageAllGrams: unit, coverageFoodGrams: unit, byRelease: releases, mappedKeys: count, universeKeys: count,
    rankedKeys: count, matches: z.strictObject({ exact: unit, family: unit, loose: unit }),
  }),
  effectiveCounts: z.record(cohort, cellStats),
  calibration: z.strictObject({ model: z.enum(["national_pooled", "sexage_pooled"]), holdout: z.literal("cluster"),
    brier: unit, ece: unit, eceDecile: unit }),
  reports: z.strictObject({ holdout: z.string(), fairness: z.string(), crosswalk: z.string() }),
  fairnessAuditPass: z.boolean(),
});

/** Where a present substitute term comes from: manifest source ids and their licences (W4). */
const termSource = z.strictObject({ sources: z.array(z.string().min(1)).min(1), licences: z.array(z.string().min(1)).min(1) });

export const ManifestSchema = z.strictObject({
  schema: z.literal(3),
  metricsVersion: z.literal(2),
  artifactHash: hex64,
  coefficientVersion: z.string(),
  ruling: z.strictObject({ path: z.literal(NHANES_RULING_PATH), sha256: hex64 }).nullable(),
  prior: z.strictObject({ file: z.literal(PRIOR_FILE), sha256: hex64, rows: count }).nullable(),
  graph: z.strictObject({ file: z.literal(GRAPH_FILE), sha256: hex64, version: z.string(), edges: count,
    absent: z.array(term), terms: z.partialRecord(term, termSource),
    context: z.strictObject({ dishes: count, foods: count }) }),
  universe: z.strictObject({ version: z.string(), hash: hex64 }),
  sources: z.array(z.strictObject({
    id: z.string(), name: z.string(), kind: z.enum(["nhanes", "fndds", "fdc"]), url: z.string().url(),
    licence: z.string(), terms: z.string(), use: z.string(),
    files: z.array(z.strictObject({ path: z.string(), sha256: hex64 })).min(1),
  })).min(1),
  withheld: z.array(z.strictObject({ id: z.string(), name: z.string(), reason: z.string() })),
  licenceCheck: z.literal("pass"),
  nhanes: NhanesSummarySchema.nullable(),
});
export type PriorsManifest = z.infer<typeof ManifestSchema>;

/** Readable issues of a strict parse ("graph.respondents: unrecognized key"), or none. */
export function schemaIssues(name: string, schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) =>
    `${name}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`
      + ("keys" in issue && Array.isArray(issue.keys) ? ` (${issue.keys.join(", ")})` : ""));
}

/** The graph rules a schema cannot say: no self edge, no absent term carried, at most MAX_NEIGHBOURS. */
export function graphRuleIssues(graph: z.infer<typeof SubstituteGraphSchema>, keys?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) out.push(`graph: self edge ${edge.from}`);
    if (keys && (!keys.has(edge.from) || !keys.has(edge.to))) out.push(`graph: unknown food ${edge.from} -> ${edge.to}`);
    for (const absent of graph.absent) if (edge[absent] !== undefined) out.push(`graph: absent term ${absent} on ${edge.from}`);
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
  }
  for (const [key, value] of counts) if (value > MAX_NEIGHBOURS) out.push(`graph: ${key} has ${value} neighbours`);
  return out;
}

/** The strict table (H3, H4): null unless every row is a valid aggregate row, each cell once. */
export function parsePriorRows(value: unknown): PriorRow[] | null {
  const parsed = PriorTableSchema.safeParse(value);
  if (!parsed.success) return null;
  const cells = new Set(parsed.data.map((row) => `${row.cohort}|${row.food_key}`));
  return cells.size === parsed.data.length ? parsed.data : null;
}

/** The strict graph: null unless the schema and the graph rules both hold. */
export function parseSubstituteGraph(value: unknown, keys?: ReadonlySet<string>): SubstituteGraph | null {
  const parsed = SubstituteGraphSchema.safeParse(value);
  if (!parsed.success || graphRuleIssues(parsed.data, keys).length) return null;
  return parsed.data as SubstituteGraph;
}

export function parseManifest(value: unknown): PriorsManifest | null {
  const parsed = ManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
