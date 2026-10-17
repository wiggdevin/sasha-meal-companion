import { flattenMeals, type MealRow } from "@/lib/server/export-meals";
/**
 * GET /api/export?kind=…&format=…
 *
 * Phase 0 shape for weight: one page per `page`, buffered.
 * Phase 2 shape for meals, progress, recipes, favorites and water: `from`/`to`/`cursor`/`limit`,
 * streamed through a ReadableStream so a 12,000-row log never lands in one array at the route
 * boundary. architecture §4.6, §5 (60/day and 10/hour per user).
 */

import { csvDocument, toCsv } from "@/lib/export/csv";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { isCalendarDate } from "@/lib/server/validate";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { FAVORITE_COLUMNS, favoriteRowValues, MEAL_COLUMNS, mealRowValues, PROGRESS_COLUMNS,
  progressRowValues, RECIPE_COLUMNS, recipeRowValues, streamFavorites, streamMeals,
  streamProgress, streamRecipes, streamWater, WATER_COLUMNS, waterRowValues,
  type ExportOpts } from "@/lib/server/export";
// T11b: export.ts is over the house line limit, so the two body kinds are imported directly.
import { BODY_DATA_COLUMNS, BODY_PROFILE_COLUMNS, bodyDataRowValues, bodyProfileRowValues,
  streamBodyData, streamBodyProfile } from "@/lib/server/export-body";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const MAX_LIMIT = 5000;
const STREAMED = new Set(["meals", "progress", "recipes", "favorites", "water", "body-profile",
  "body-data"]);
type StreamKind = "meals" | "progress" | "recipes" | "favorites" | "water" | "body-profile"
  | "body-data";

// The buffered `page=` map keeps only the two kinds that are still Phase 0 shaped. `recipes`,
// `favorites` and `water` move to the streamed path above (contracts §3: "same paging").
type Kind = "meals" | "weight";

const SOURCES: Record<
  Kind,
  { from: string; select: string; order: string; columns: string[]; tombstoned?: boolean }
> = {
  meals: {
    from: "log_entries",
    select: "id, local_date, tz, eaten_at, slot, method, note, deleted_at, " +
      "log_items(seq, qty, unit, grams, food_ref_id, snapshot)",
    order: "eaten_at", tombstoned: true,
    columns: ["id", "local_date", "tz", "eaten_at", "slot", "method", "note", "seq", "qty",
      "unit", "grams", "food_ref_id", "energy_kcal", "protein_g", "carbohydrate_g", "fat_g"],
  },
  weight: {
    // weigh_ins (architecture.md §2.1) has no tz column.
    from: "weigh_ins", select: "id, local_date, start_time, value, unit", order: "start_time",
    columns: ["id", "local_date", "start_time", "value", "unit"],
  },
};

type Row = Record<string, unknown>;

function dateParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!isCalendarDate(raw)) throw new HttpError(422, "bad_request", `malformed ${name}`);
  return raw;
}

function limitParam(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return MAX_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new HttpError(422, "bad_request", `limit must be an integer 1..${MAX_LIMIT}`);
  }
  return value;
}

// finding 45: a streamed CSV export otherwise looks byte-identical whether it carries the user's whole
// history or silently stopped partway through it. `csvDocument` already appends a trailing `#`
// comment line for the ODbL notice, so a truncated page reuses that same mechanism.
// W012 (A086): the cursor used to live only in the JSON body, so a CSV page could say it was cut
// short but never be continued. The notice now names the cursor, and two headers carry it for the
// phone: `x-export-next-cursor` (absent on the last page) and `x-export-notice-lines`, the count of
// trailing `#` lines, so a client joining pages strips exactly those and never a data line.
const NEXT_CURSOR_HEADER = "x-export-next-cursor";
const NOTICE_LINES_HEADER = "x-export-notice-lines";

function truncationNotice(cursor: string): string {
  return `Export truncated: more rows exist. Re-request with cursor=${cursor} to get the rest.`;
}

function csvResponse(kind: string, opts: ExportOpts, header: string[],
  rows: readonly (string | number | null)[][], notices: string[],
  nextCursor: string | null): Response {
  const allNotices = nextCursor ? [...notices, truncationNotice(nextCursor)] : notices;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(csvDocument(header, rows, allNotices)));
      controller.close();
    },
  });
  const from = opts.from ?? "all";
  const to = opts.to ?? "all";
  const headers = new Headers({
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="meal-companion-${kind}-${from}-${to}.csv"`,
    [NOTICE_LINES_HEADER]: String(allNotices.length) });
  if (nextCursor) headers.set(NEXT_CURSOR_HEADER, nextCursor);
  return new Response(body, { headers });
}

async function streamed(kind: StreamKind, client: SupabaseClient, userId: string,
  url: URL): Promise<Response> {
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "csv" && format !== "json") {
    throw new HttpError(400, "bad_request", "unknown format");
  }
  const opts: ExportOpts = { from: dateParam(url, "from"), to: dateParam(url, "to"),
    limit: limitParam(url), cursor: url.searchParams.get("cursor") ?? undefined };

  if (kind === "meals") {
    const page = await streamMeals(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, MEAL_COLUMNS, page.rows.map(mealRowValues), page.notices,
      page.next_cursor);
  }
  if (kind === "recipes") {
    const page = await streamRecipes(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, RECIPE_COLUMNS, page.rows.map(recipeRowValues), page.notices,
      page.next_cursor);
  }
  if (kind === "favorites") {
    const page = await streamFavorites(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, FAVORITE_COLUMNS, page.rows.map(favoriteRowValues),
      page.notices, page.next_cursor);
  }
  if (kind === "water") {
    const page = await streamWater(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, WATER_COLUMNS, page.rows.map(waterRowValues), page.notices,
      page.next_cursor);
  }
  if (kind === "body-profile") {
    const page = await streamBodyProfile(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, BODY_PROFILE_COLUMNS, page.rows.map(bodyProfileRowValues),
      page.notices, page.next_cursor);
  }
  if (kind === "body-data") {
    const page = await streamBodyData(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, BODY_DATA_COLUMNS, page.rows.map(bodyDataRowValues),
      page.notices, page.next_cursor);
  }
  const page = await streamProgress(client, userId, opts);
  if (format === "json") return Response.json(page);
  return csvResponse(kind, opts, PROGRESS_COLUMNS, page.rows.map(progressRowValues), page.notices,
    page.next_cursor);
}

// W012 review (Sol WARN): the phone downloads a long log as one first request plus up to seven
// cursor continuations (`MAX_EXPORT_PAGES` in lib/export-client.ts). Counted against the 10/hour
// export budget, one download spent 8 of the 10, so a second download or a retry got 429 partway
// and saved nothing. A continuation of a streamed kind counts against its own buckets instead,
// sized for ten full downloads an hour; the first request of each download keeps the old limits.
const CONTINUATIONS_PER_HOUR = 70;

function isContinuation(url: URL): boolean {
  return STREAMED.has(url.searchParams.get("kind") ?? "") && Boolean(url.searchParams.get("cursor"));
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const continued = isContinuation(url);
    const ip = requestIp(req);
    if (continued) await enforceRateLimit(`export:ip:cursor:${ip}`, CONTINUATIONS_PER_HOUR, 3600);
    else await enforceRateLimit(`export:ip:${ip}`, 60, 3600);
    const { userId, client } = await requireUser(req);
    if (continued) {
      await enforceRateLimit(`export:user:cursor:${userId}`, CONTINUATIONS_PER_HOUR, 3600);
    } else {
      await enforceRateLimit(`export:user:day:${userId}`, 60, 86400);
      await enforceRateLimit(`export:user:hour:${userId}`, 10, 3600);
    }

    const kind = url.searchParams.get("kind") ?? "";
    if (STREAMED.has(kind)) {
      return await streamed(kind as StreamKind, client, userId, url);
    }

    const format = url.searchParams.get("format") ?? "json";
    const page = Number(url.searchParams.get("page") ?? "0");
    if (!(kind in SOURCES)) throw new HttpError(400, "bad_request", "unknown kind");
    if (format !== "csv" && format !== "json") {
      throw new HttpError(400, "bad_request", "unknown format");
    }
    if (!Number.isInteger(page) || page < 0) {
      throw new HttpError(400, "bad_request", "page must be a non-negative integer");
    }

    const source = SOURCES[kind as Kind];
    const from = page * PAGE_SIZE;
    // finding 65: `source.order` alone (e.g. weigh_ins.start_time) is not unique, so two rows
    // sharing a timestamp have no guaranteed stable order across two separate `.range()` calls.
    // `id` is a unique tie-breaker on every source here.
    let query = client
      .from(source.from)
      .select(source.select)
      .order(source.order, { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE);
    // log_entries and recipes are tombstoned, never deleted (architecture.md
    // §3.7). An export that carried the tombstones would hand the user's back rows the user
    // deleted, so they are filtered out here.
    if (source.tombstoned) query = query.is("deleted_at", null);
    const { data, error } = await query;
    if (error) throw new HttpError(500, "internal", error.message);

    const raw = (data ?? []) as unknown as MealRow[];
    const hasMore = raw.length > PAGE_SIZE;
    const pageRows = hasMore ? raw.slice(0, PAGE_SIZE) : raw;
    const rows = kind === "meals" ? flattenMeals(pageRows) : (pageRows as Row[]);

    if (format === "json") {
      return Response.json({ rows, next_page: hasMore ? page + 1 : null });
    }
    return new Response(toCsv(rows, source.columns), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${kind}-page-${page}.csv"`,
      },
    });
  } catch (e) {
    return jsonError(e);
  }
}
