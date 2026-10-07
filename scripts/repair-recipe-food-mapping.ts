/** Append-only repair of original pilot recipe identities. Default is a read-only dry run. */
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClientForSeedTarget } from "@/lib/server/admin";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { pilotSrLegacySource } from "@/lib/recipe-catalog/pilot-sr-legacy";
import { resolvePilotCatalogRevisions, type PilotCatalogIdentity }
  from "@/lib/server/recipe-pilot-identity";
import { resolveSeedTarget } from "./seed-recipe-catalog";

type Root = { id: string; slug: string; current_revision_id: string | null;
  source_revision: string; publication_state: string };
type Revision = { id: string; recipe_id: string; rev: number; name: string; cuisine: string | null;
  dish_tags: string[]; active_minutes: number | null; total_minutes: number | null;
  effort: string; servings: number; yield_grams: number | null; yield_status: string;
  min_serving_fraction: number; max_serving_fraction: number; nutrition_per_serving: unknown };
type Item = { recipe_revision_id: string; seq: number; name: string;
  food_ref_id: string | null; food_revision_id: number | null; food_db_id: string | null;
  quantity: number; unit: string; grams: number | null; state: string; required: boolean;
  purchase_grams: number | null; purchase_conversion_status: string;
  nutrition: unknown; allergen_evidence: unknown };
type Step = { recipe_revision_id: string; seq: number; instruction: string };
export type Snapshot = { roots: Root[]; revisions: Revision[]; items: Item[]; steps: Step[];
  seals: Set<string>; identities: Map<string, PilotCatalogIdentity>; refs: Map<number, string> };
export type Repair = { root: Root; current: Revision; items: Item[]; steps: Step[];
  missing: number; pending?: { revision: Revision; hasItems: boolean; hasSteps: boolean } };

async function readRows<T>(client: SupabaseClient, table: string, select: string,
  column: string, values: readonly (string | number)[]): Promise<T[]> {
  if (!values.length) return [];
  const result = await client.from(table).select(select).in(column, [...values]);
  if (result.error) throw new Error(`${table} read failed: ${result.error.message}`);
  return (result.data ?? []) as T[];
}

async function snapshot(client: SupabaseClient): Promise<Snapshot> {
  const slugs = pilotRecipes().map((recipe) => recipe.recipeId);
  const roots = (await readRows<Root>(client, "recipe_catalog",
    "id,slug,current_revision_id,source_revision,publication_state", "slug", slugs))
    .filter((root) => root.source_revision === "original-pilot-v1");
  const rootIds = roots.map((root) => root.id);
  const revisions = await readRows<Revision>(client, "recipe_catalog_revisions", "*",
    "recipe_id", rootIds);
  const revisionIds = revisions.map((row) => row.id);
  const [items, steps, sealRows] = await Promise.all([
    readRows<Item>(client, "recipe_catalog_items", "*", "recipe_revision_id", revisionIds),
    readRows<Step>(client, "recipe_catalog_steps", "*", "recipe_revision_id", revisionIds),
    readRows<{ recipe_revision_id: string }>(client, "recipe_catalog_seals",
      "recipe_revision_id", "recipe_revision_id", revisionIds),
  ]);
  const ids = [...new Set(items.map((item) => item.food_db_id)
    .filter((id): id is string => id !== null))];
  const identities = await resolvePilotCatalogRevisions(client, ids);
  const refs = new Map<number, string>();
  for (const row of await readRows<{ id: string; catalog_food_id: number; kind: string }>(
    client, "food_refs", "id,catalog_food_id,kind", "catalog_food_id",
    [...new Set([...identities.values()].map((identity) => identity.catalogFoodId))])) {
    if (row.kind !== "catalog") throw new Error("Pilot food reference is not catalog-owned");
    if (refs.has(row.catalog_food_id)) throw new Error("Duplicate pilot catalog food reference");
    refs.set(row.catalog_food_id, row.id);
  }
  return { roots, revisions, items, steps,
    seals: new Set(sealRows.map((row) => row.recipe_revision_id)), identities, refs };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function sameRevisionContent(a: Revision, b: Revision): boolean {
  const content = (row: Revision) => canonical({ name: row.name, cuisine: row.cuisine,
    dish_tags: row.dish_tags, active_minutes: row.active_minutes,
    total_minutes: row.total_minutes, effort: row.effort, servings: Number(row.servings),
    yield_grams: row.yield_grams === null ? null : Number(row.yield_grams),
    yield_status: row.yield_status, min_serving_fraction: Number(row.min_serving_fraction),
    max_serving_fraction: Number(row.max_serving_fraction),
    nutrition_per_serving: row.nutrition_per_serving });
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

function mappedItem(item: Item, nextId: string, state: Snapshot): Item {
  const identity = state.identities.get(item.food_db_id!);
  const ref = identity && state.refs.get(identity.catalogFoodId);
  if (!identity || !ref) throw new Error(`Pilot identity unavailable for ${item.food_db_id}`);
  return { ...item, recipe_revision_id: nextId,
    food_ref_id: ref, food_revision_id: identity.revisionId };
}

function sameItemContent(a: Item, b: Item): boolean {
  const content = (row: Item) => canonical({ seq: row.seq, name: row.name,
    food_ref_id: row.food_ref_id, food_revision_id: row.food_revision_id,
    food_db_id: row.food_db_id, quantity: Number(row.quantity), unit: row.unit,
    grams: row.grams === null ? null : Number(row.grams), state: row.state,
    required: row.required, purchase_grams: row.purchase_grams === null
      ? null : Number(row.purchase_grams),
    purchase_conversion_status: row.purchase_conversion_status,
    nutrition: row.nutrition, allergen_evidence: row.allergen_evidence });
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

/** Never copy a stale or inconsistent identity into a new sealed revision. */
export function planRepair(state: Snapshot): { repairs: Repair[]; missingCatalog: string[];
  missingRefs: number[]; alreadyMapped: number } {
  const repairs: Repair[] = [];
  const missingCatalog = new Set<string>();
  const missingRefs = new Set<number>();
  let alreadyMapped = 0;
  for (const root of state.roots) {
    if (root.publication_state !== "published" || !root.current_revision_id) continue;
    const history = state.revisions.filter((row) => row.recipe_id === root.id);
    const current = history.find((row) => row.id === root.current_revision_id);
    if (!current) throw new Error(`Pilot ${root.slug} has no current revision`);
    const future = history.filter((row) => row.rev > current.rev);
    if (future.length > 1 || (future.length === 1 && future[0].rev !== current.rev + 1)) {
      throw new Error(`Pilot ${root.slug} has multiple or changed future revisions; stop for review`);
    }
    const pending = future[0];
    if (pending && (state.seals.has(pending.id)
      || !sameRevisionContent(current, pending))) {
      throw new Error(`Pilot ${root.slug} has a sealed or inconsistent pending revision`);
    }
    const items = state.items.filter((row) => row.recipe_revision_id === current.id);
    const steps = state.steps.filter((row) => row.recipe_revision_id === current.id);
    if (!items.length || !steps.length) throw new Error(`Pilot ${root.slug} has incomplete content`);
    let missing = 0;
    for (const item of items) {
      const dbId = item.food_db_id;
      if (!dbId || !pilotSrLegacySource(dbId)) {
        throw new Error(`Pilot ${root.slug} has unreviewed food identity at line ${item.seq}`);
      }
      const identity = state.identities.get(dbId);
      if (!identity) { missingCatalog.add(dbId); continue; }
      const ref = state.refs.get(identity.catalogFoodId);
      if (!ref) {
        if (item.food_ref_id !== null) {
          throw new Error(`Pilot ${root.slug} has a food reference outside its catalog identity at line ${item.seq}`);
        }
        missingRefs.add(identity.catalogFoodId);
      }
      if (item.food_revision_id !== null && item.food_revision_id !== identity.revisionId) {
        throw new Error(`Pilot ${root.slug} has conflicting catalog revision at line ${item.seq}`);
      }
      if (item.food_ref_id !== null && ref && item.food_ref_id !== ref) {
        throw new Error(`Pilot ${root.slug} has conflicting food reference at line ${item.seq}`);
      }
      if (item.food_revision_id === null || item.food_ref_id === null) missing++;
      else alreadyMapped++;
    }
    if (missing === 0 && pending) {
      throw new Error(`Pilot ${root.slug} has an unexpected pending revision`);
    }
    if (missing > 0) {
      const pendingItems = pending ? state.items.filter((row) => row.recipe_revision_id === pending.id) : [];
      const pendingSteps = pending ? state.steps.filter((row) => row.recipe_revision_id === pending.id) : [];
      if (pendingItems.length && !missingCatalog.size && !missingRefs.size
        && (pendingItems.length !== items.length || pendingItems.some((row) => {
          const original = items.find((item) => item.seq === row.seq);
          return !original || !sameItemContent(row, mappedItem(original, pending!.id, state));
        }))) {
        throw new Error(`Pilot ${root.slug} has inconsistent pending items`);
      }
      if (pendingSteps.length && (pendingSteps.length !== steps.length
        || pendingSteps.some((row) => !steps.some((step) => step.seq === row.seq
          && step.instruction === row.instruction)))) {
        throw new Error(`Pilot ${root.slug} has inconsistent pending steps`);
      }
      repairs.push({ root, current, items, steps, missing,
        ...(pending ? { pending: { revision: pending,
          hasItems: pendingItems.length > 0, hasSteps: pendingSteps.length > 0 } } : {}) });
    }
  }
  return { repairs, missingCatalog: [...missingCatalog], missingRefs: [...missingRefs],
    alreadyMapped };
}

export async function appendRevision(client: SupabaseClient, repair: Repair,
  state: Snapshot): Promise<void> {
  const current = repair.current;
  let nextId = repair.pending?.revision.id;
  if (!nextId) {
    const created = await client.from("recipe_catalog_revisions").insert({
      recipe_id: repair.root.id, rev: current.rev + 1, name: current.name, cuisine: current.cuisine,
      dish_tags: current.dish_tags, active_minutes: current.active_minutes,
      total_minutes: current.total_minutes, effort: current.effort, servings: current.servings,
      yield_grams: current.yield_grams, yield_status: current.yield_status,
      min_serving_fraction: current.min_serving_fraction,
      max_serving_fraction: current.max_serving_fraction,
      nutrition_per_serving: current.nutrition_per_serving,
    }).select("id").single();
    if (created.error || !created.data) throw new Error(`Could not append revision for ${repair.root.slug}`);
    nextId = created.data.id as string;
  }
  const items = repair.items.map((item) => {
    const mapped = mappedItem(item, nextId, state);
    return { recipe_revision_id: nextId, seq: item.seq, name: item.name,
      food_ref_id: mapped.food_ref_id, food_revision_id: mapped.food_revision_id,
      food_db_id: item.food_db_id,
      quantity: item.quantity, unit: item.unit, grams: item.grams, state: item.state,
      required: item.required, purchase_grams: item.purchase_grams,
      purchase_conversion_status: item.purchase_conversion_status,
      nutrition: item.nutrition, allergen_evidence: item.allergen_evidence };
  });
  if (!repair.pending?.hasItems) {
    const inserted = await client.from("recipe_catalog_items").insert(items);
    if (inserted.error) throw new Error(`Could not copy items for ${repair.root.slug}`);
  }
  const steps = repair.steps.map((step) => ({ recipe_revision_id: nextId,
    seq: step.seq, instruction: step.instruction }));
  if (!repair.pending?.hasSteps) {
    const copied = await client.from("recipe_catalog_steps").insert(steps);
    if (copied.error) throw new Error(`Could not copy steps for ${repair.root.slug}`);
  }
  const switched = await client.from("recipe_catalog").update({ current_revision_id: nextId })
    .eq("id", repair.root.id).eq("current_revision_id", current.id)
    .eq("publication_state", "published").select("id");
  if (switched.error || switched.data?.length !== 1) {
    throw new Error(`Could not switch ${repair.root.slug}; old revision stays current`);
  }
}

export async function repair(args: string[], env: Record<string, string | undefined>) {
  const allowed = new Set(["--production", "--write", "--dry-run"]);
  if (args.some((arg) => !allowed.has(arg) && !arg.startsWith("--confirm-project-ref="))
    || (args.includes("--write") && args.includes("--dry-run"))) {
    throw new Error("Use --dry-run (default) or --write with an explicit target");
  }
  const write = args.includes("--write");
  const target = resolveSeedTarget(args.length ? args : ["--dry-run"], env);
  const client = adminClientForSeedTarget(target, env);
  let state = await snapshot(client);
  let plan = planRepair(state);
  const summary = () => ({ target: target.mode, checked: state.items.length,
    repairableRecipes: plan.repairs.length,
    repairableItems: plan.repairs.reduce((sum, item) => sum + item.missing, 0),
    alreadyMapped: plan.alreadyMapped, missingCatalog: plan.missingCatalog,
    missingRefs: plan.missingRefs.length });
  if (!write) return { ...summary(), updatedRecipes: 0, createdRefs: 0, writes: 0 };
  if (plan.missingCatalog.length) throw new Error(`Missing reviewed catalog identities: ${plan.missingCatalog.join(", ")}`);
  const createdRefs = plan.missingRefs.length;
  if (plan.missingRefs.length) {
    const created = await client.from("food_refs").insert(plan.missingRefs.map((id) =>
      ({ kind: "catalog", catalog_food_id: id })));
    if (created.error) throw new Error("Could not create shared catalog food references; rerun dry-run");
    state = await snapshot(client);
    plan = planRepair(state);
  }
  if (plan.missingCatalog.length || plan.missingRefs.length) {
    throw new Error("Catalog identities changed during repair; stop for review");
  }
  const before = summary();
  let updatedRecipes = 0;
  let appendedRows = 0;
  for (const candidate of plan.repairs) {
    await appendRevision(client, candidate, state);
    updatedRecipes++;
    appendedRows += 1 + candidate.items.length + candidate.steps.length + 1;
  }
  return { ...before, updatedRecipes, createdRefs, writes: appendedRows + createdRefs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  repair(process.argv.slice(2), process.env).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => { process.stderr.write(`Repair stopped: ${String(error)}\n`);
    process.exitCode = 1; });
}
