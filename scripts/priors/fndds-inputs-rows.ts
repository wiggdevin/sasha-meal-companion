/**
 * Turns the W4 input plan (fndds-inputs.ts) into `catalog_food_inputs` rows against one catalog,
 * diffs them with the rows already stored, and groups the writes. Pure: the reads and writes are
 * scripts/import-fndds-inputs.ts.
 *
 * Release identity (Sol W4 r1 BLOCK 1): each dish's active `fdc_fndds` revision must belong to the
 * catalog version of the pinned FNDDS release (input-sources.ts `FNDDS_RELEASE`, checked by
 * fndds-release.ts). A revision of any other version refuses the run, whatever its description.
 *
 * Atomicity (Sol W4 r1 WARN 2): a dish is never written row by row. `replaceBatches` hands the
 * writer every planned row of each changed dish, whole dishes per batch, and the writer replaces
 * them through `catalog_replace_food_inputs` (one transaction per batch), so a failure leaves each
 * dish fully old or fully new.
 */
import type { InputPlan } from "@/scripts/priors/fndds-inputs";

export type CatalogFood = { id: number; source: string; source_id: string };
export type ActiveRevision = { id: number; catalog_food_id: number; catalog_version_id: number };
export type InputRow = {
  food_revision_id: number; seq: number; input_catalog_food_id: number; grams: number;
  source: "fndds"; estimated: true;
};
export type StoredRow = Omit<InputRow, "source" | "estimated"> & { source: string; estimated: boolean };

export type RowsResult = { rows: InputRow[]; problems: string[]; dishes: number; revisionIds: Set<number> };

const key = (source: string, fdcId: string) => `${source}|${fdcId}`;

export function buildRows(plan: InputPlan, foods: readonly CatalogFood[], active: readonly ActiveRevision[],
  releaseVersionId: number): RowsResult {
  const foodId = new Map(foods.map((food) => [key(food.source, food.source_id), Number(food.id)]));
  const revisionOf = new Map(active.map((revision) => [Number(revision.catalog_food_id), revision]));
  const out: RowsResult = { rows: [], problems: [], dishes: 0, revisionIds: new Set() };
  for (const [dishFdcId, inputs] of plan.dishes) {
    const dishFood = foodId.get(key("fdc_fndds", dishFdcId));
    const revision = dishFood === undefined ? undefined : revisionOf.get(dishFood);
    if (!revision) {
      out.problems.push(`dish ${dishFdcId}: no active fdc_fndds revision in the catalog`);
      continue;
    }
    if (Number(revision.catalog_version_id) !== releaseVersionId) {
      out.problems.push(`dish ${dishFdcId}: active revision ${revision.id} belongs to catalog version `
        + `${revision.catalog_version_id}, not ${releaseVersionId} (the pinned FNDDS release)`);
      continue;
    }
    const rows: InputRow[] = [];
    for (const input of inputs) {
      const target = foodId.get(key(input.source, input.fdcId));
      if (target === undefined) {
        out.problems.push(`dish ${dishFdcId} seq ${input.seq}: ${input.source} ${input.fdcId} (code ${input.code}) is not in the catalog`);
        continue;
      }
      rows.push({ food_revision_id: Number(revision.id), seq: input.seq, input_catalog_food_id: target,
        grams: input.grams, source: "fndds", estimated: true });
    }
    if (rows.length !== inputs.length) continue;
    out.rows.push(...rows);
    out.dishes += 1;
    out.revisionIds.add(Number(revision.id));
  }
  return out;
}

export type RowDiff = { upserts: InputRow[]; deletes: { food_revision_id: number; seq: number }[]; unchanged: number };

/**
 * What a commit writes: planned rows that are new or differ, and stored rows of the planned
 * revisions that the plan no longer names. Rows of other revisions (an older FNDDS version kept
 * for rollback) are left alone; they go with their revision.
 */
export function diffRows(planned: readonly InputRow[], stored: readonly StoredRow[],
  revisionIds: ReadonlySet<number>): RowDiff {
  const at = (row: { food_revision_id: number; seq: number }) => `${row.food_revision_id}|${row.seq}`;
  const storedAt = new Map(stored.map((row) => [at(row), row]));
  const plannedAt = new Set(planned.map(at));
  const diff: RowDiff = { upserts: [], deletes: [], unchanged: 0 };
  for (const row of planned) {
    const current = storedAt.get(at(row));
    const same = current && Number(current.input_catalog_food_id) === row.input_catalog_food_id
      && Number(current.grams) === row.grams && current.source === row.source && current.estimated === row.estimated;
    if (same) diff.unchanged += 1;
    else diff.upserts.push(row);
  }
  for (const row of stored) {
    if (revisionIds.has(Number(row.food_revision_id)) && !plannedAt.has(at(row))) {
      diff.deletes.push({ food_revision_id: Number(row.food_revision_id), seq: Number(row.seq) });
    }
  }
  return diff;
}

/** Whole dishes per write, at most `max` rows each: one upsert is one transaction, so no dish is half-written. */
export function batchByDish(rows: readonly InputRow[], max = 500): InputRow[][] {
  const byDish = new Map<number, InputRow[]>();
  for (const row of rows) byDish.set(row.food_revision_id, [...(byDish.get(row.food_revision_id) ?? []), row]);
  const batches: InputRow[][] = [];
  let current: InputRow[] = [];
  for (const dish of byDish.values()) {
    if (current.length && current.length + dish.length > max) { batches.push(current); current = []; }
    current.push(...dish);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Every planned row of each dish the diff touches, whole dishes per batch (for the atomic replace). */
export function replaceBatches(planned: readonly InputRow[], diff: RowDiff, max = 500): InputRow[][] {
  const changed = new Set([...diff.upserts, ...diff.deletes].map((row) => row.food_revision_id));
  return batchByDish(planned.filter((row) => changed.has(row.food_revision_id)), max);
}
