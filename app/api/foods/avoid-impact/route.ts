import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchesRule, type CustomRule } from "@/lib/policy/custom-rules";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { sameBaseName } from "@/lib/foods/base-name";
import { avoidFoodDbIds } from "@/lib/recipe-catalog/avoid-food-db";
import { mayHaveSubingredients } from "@/lib/policy/custom-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Query = z.object({ q: z.string().trim().min(2).max(80),
  kind: z.enum(["ingredient", "cuisine"]) }).strict();
const Batch = z.object({ foods: z.array(z.object({ id: z.string().min(1).max(128),
  name: z.string().trim().min(2).max(80),
  catalogFoodId: z.number().int().positive().optional().nullable() }).strict()).max(100) }).strict();
type RuleQuery = z.infer<typeof Query> & { catalogFoodId?: number };
type Instance = { date: string; slot: string; title: string; source: "recipe" | "edited";
  matched: string; recipeId?: string };
type Impact = { instances: Instance[]; count: number; complete: boolean;
  scope: string; checkedFrom: string };

function todayInZone(zone: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone ?? "UTC", year: "numeric",
      month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const read = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
    return `${read("year")}-${read("month")}-${read("day")}`;
  } catch { return new Date().toISOString().slice(0, 10); }
}

/** One owner-scoped read serves either an individual modal or all visible Avoid rows. */
async function scan(client: SupabaseClient, userId: string, queries: readonly RuleQuery[]): Promise<Impact[]> {
  const settings = await client.from("user_settings").select("time_zone")
    .eq("user_id", userId).maybeSingle();
  if (settings.error) throw new HttpError(503, "impact_unavailable", "Could not check future meals.");
  const today = todayInZone(settings.data?.time_zone ?? null);
  const [selections, days] = await Promise.all([
    client.from("recipe_plan_selections")
      .select("local_date,slot_id,recipe_id,recipe_name,recipe_revision_id,ingredient_snapshot")
      .eq("user_id", userId).is("superseded_at", null)
      .gte("local_date", today).order("local_date").limit(501),
    client.from("plan_days").select("local_date,item_overrides,swaps,eaten_slots")
      .eq("user_id", userId).gte("local_date", today).order("local_date").limit(501),
  ]);
  if (selections.error || days.error) throw new HttpError(503, "impact_unavailable",
    "Could not check future meals.");
  const rows = selections.data ?? [];
  const revisions = queries.some((query) => query.kind === "cuisine")
    ? [...new Set(rows.map((row) => row.recipe_revision_id))] : [];
  const cuisines = revisions.length ? await client.from("recipe_catalog_revisions")
    .select("id,cuisine").in("id", revisions) : { data: [], error: null };
  if (cuisines.error) throw new HttpError(503, "impact_unavailable", "Could not check recipe cuisines.");
  const cuisineById = new Map((cuisines.data ?? []).map((row) => [row.id, row.cuisine ?? ""]));
  const dayByDate = new Map((days.data ?? []).map((row) => [row.local_date, row]));
  const snapshotRefs = rows.flatMap((row) => Array.isArray(row.ingredient_snapshot)
    ? row.ingredient_snapshot.map((item) => typeof item?.foodRefId === "string" ? item.foodRefId : null)
      .filter((id): id is string => id !== null) : []);
  const overrideRefs = (days.data ?? []).flatMap((day) =>
    Object.values((day.item_overrides ?? {}) as Record<string, { components?: { foodRefId?: string }[] }>)
      .flatMap((override) => Array.isArray(override?.components)
        ? override.components.map((item) => item?.foodRefId).filter((id): id is string => typeof id === "string")
        : []));
  const allRefs = [...new Set([...snapshotRefs, ...overrideRefs])];
  const refs = new Map<string, { catalog_food_id: number | null; user_food_id: string | null }>();
  for (let i = 0; i < Math.min(allRefs.length, 500); i += 100) {
    const found = await client.from("food_refs").select("id,catalog_food_id,user_food_id")
      .in("id", allRefs.slice(i, i + 100));
    if (found.error) throw new HttpError(503, "impact_unavailable", "Could not check food identities.");
    for (const ref of found.data ?? []) refs.set(ref.id, ref);
  }
  const userIds = [...new Set([...refs.values()].map((ref) => ref.user_food_id)
    .filter((id): id is string => id !== null))];
  const userNames = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 100) {
    const found = await client.from("user_foods").select("id,name")
      .eq("user_id", userId).in("id", userIds.slice(i, i + 100));
    if (found.error) throw new HttpError(503, "impact_unavailable", "Could not check account food names.");
    for (const food of found.data ?? []) userNames.set(food.id, food.name);
  }
  return queries.map((query): Impact => {
    const rule: CustomRule = { id: "impact", kind: query.kind, text: query.q };
    const dbIds = query.kind === "ingredient" ? new Set(avoidFoodDbIds([query.q])) : new Set<string>();
    const instances: Instance[] = [];
    const seen = new Set<string>();
    let opaque = allRefs.length > 500;
    for (const row of rows) {
      const day = dayByDate.get(row.local_date);
      const eaten = day?.eaten_slots as Record<string, { eaten_at?: string; consumed?: unknown }> | null;
      if (eaten?.[row.slot_id]?.eaten_at || eaten?.[row.slot_id]?.consumed) continue;
      const overrides = (day?.item_overrides ?? {}) as Record<string, { followPlan?: boolean }>;
      // A changed slot supersedes its previous selection for this impact count.
      if (overrides[row.slot_id] && !overrides[row.slot_id].followPlan) continue;
      if ((day?.swaps as Record<string, unknown> | null)?.[row.slot_id]) {
        opaque = true; continue;
      }
      const cuisine = cuisineById.get(row.recipe_revision_id) ?? "";
      if (query.kind === "cuisine" && !cuisine) opaque = true;
      const ingredients = row.ingredient_snapshot;
      if (query.kind === "ingredient" && (!Array.isArray(ingredients) || ingredients.length === 0)) opaque = true;
      const matched = query.kind === "cuisine" ? (matchesRule(cuisine, rule) ? cuisine : "")
        : (Array.isArray(ingredients) ? ingredients : []).map((item) => {
          const name = typeof item?.name === "string" ? item.name : "";
          const refId = typeof item?.foodRefId === "string" ? item.foodRefId : null;
          const ref = refId ? refs.get(refId) : null;
          const ownerName = ref?.user_food_id ? userNames.get(ref.user_food_id) : null;
          if (!name && !refId && !item?.foodDbId) opaque = true;
          if (refId && !ref) opaque = true;
          if (ref?.user_food_id && !ownerName) opaque = true;
          const byName = name && (sameBaseName(name, query.q) || matchesRule(name, rule));
          const byOwnerName = ownerName && (sameBaseName(ownerName, query.q)
            || matchesRule(ownerName, rule));
          const byDbId = typeof item?.foodDbId === "string" && dbIds.has(item.foodDbId);
          const byCatalogId = query.catalogFoodId && ref?.catalog_food_id === query.catalogFoodId;
          if (!byName && !byOwnerName && !byDbId && !byCatalogId
            && mayHaveSubingredients(name || ownerName || "")) opaque = true;
          return byName || byOwnerName || byDbId || byCatalogId ? name || ownerName || query.q : "";
        }).find(Boolean);
      if (!matched) continue;
      const key = `${row.local_date}:${row.slot_id}`;
      seen.add(key);
      instances.push({ date: row.local_date, slot: row.slot_id, title: row.recipe_name,
        source: "recipe", matched, recipeId: row.recipe_id });
    }
    for (const day of days.data ?? []) {
      const eaten = (day.eaten_slots ?? {}) as Record<string, { eaten_at?: string; consumed?: unknown }>;
      const overrides = (day.item_overrides ?? {}) as Record<string, {
        title?: string; components?: { name?: string; foodRefId?: string; foodDbId?: string }[];
        followPlan?: boolean;
        removed?: boolean; cleared?: boolean }>;
      for (const [slot, override] of Object.entries(overrides)) {
        if (eaten[slot]?.eaten_at || eaten[slot]?.consumed || override.followPlan
          || override.removed || override.cleared
          || seen.has(`${day.local_date}:${slot}`)) continue;
        if (query.kind === "cuisine") { opaque = true; continue; }
        if (!Array.isArray(override.components) || override.components.length === 0) opaque = true;
        const matched = (override.components ?? []).map((item) => {
          const name = item?.name ?? "";
          const ref = item?.foodRefId ? refs.get(item.foodRefId) : null;
          const ownerName = ref?.user_food_id ? userNames.get(ref.user_food_id) : null;
          if (!name && !item?.foodRefId && !item?.foodDbId) opaque = true;
          if (item?.foodRefId && !ref) opaque = true;
          const byName = name && (sameBaseName(name, query.q) || matchesRule(name, rule));
          const byOwnerName = ownerName && (sameBaseName(ownerName, query.q)
            || matchesRule(ownerName, rule));
          const byDbId = typeof item?.foodDbId === "string" && dbIds.has(item.foodDbId);
          const byCatalogId = query.catalogFoodId && ref?.catalog_food_id === query.catalogFoodId;
          if (!byName && !byOwnerName && !byDbId && !byCatalogId
            && (item?.foodRefId || item?.foodDbId || mayHaveSubingredients(name))) opaque = true;
          return byName || byOwnerName || byDbId || byCatalogId ? name || ownerName || query.q : "";
        }).find(Boolean);
        if (!matched && (override.components ?? []).some((item) => mayHaveSubingredients(item.name ?? ""))) opaque = true;
        if (matched) instances.push({ date: day.local_date, slot,
          title: override.title ?? "Edited meal", source: "edited", matched });
      }
      for (const slot of Object.keys((day.swaps ?? {}) as object)) {
        if (!eaten[slot]?.eaten_at && !eaten[slot]?.consumed
          && !overrides[slot]?.removed && !overrides[slot]?.cleared) opaque = true;
      }
    }
    instances.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
    return { instances, count: instances.length,
      complete: rows.length <= 500 && (days.data ?? []).length <= 500 && !opaque,
      scope: "saved future meals", checkedFrom: today };
  });
}

async function authorized(req: Request) {
  await enforceRateLimit(`avoid-impact:pre:ip:${requestIp(req)}`, 120, 60);
  const { client, userId } = await requireUser(req);
  await enforceRateLimit(`avoid-impact:${userId}`, 30, 60);
  return { client, userId };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await authorized(req);
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const parsed = Query.extend({ catalogFoodId: z.coerce.number().int().positive().optional() })
      .safeParse(params);
    if (!parsed.success) throw new HttpError(400, "bad_request", "Enter an ingredient or cuisine.");
    const [result] = await scan(client, userId, [parsed.data]);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

/** Read-only batch for restrained per-Avoid badges; no snapshot or cross-account state is written. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await authorized(req);
    const body = await readJson(req, Batch, 20_000);
    const impacts = await scan(client, userId, body.foods.map((food) =>
      ({ kind: "ingredient", q: food.name, catalogFoodId: food.catalogFoodId ?? undefined })));
    return Response.json({ byId: Object.fromEntries(body.foods.map((food, index) =>
      [food.id, { count: impacts[index].count, complete: impacts[index].complete }])) },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
