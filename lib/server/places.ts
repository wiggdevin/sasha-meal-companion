import "server-only";
/**
 * The Shopping build flow's store search (UI makeover W8 §7.4): a typed area to a point
 * (OpenStreetMap Nominatim) and a point to nearby named grocery stores (Overpass). Both hosts are
 * fixed here; nothing about a request picks a host. Nothing is stored.
 *
 * - Every call names the app and its production address in `User-Agent` (Nominatim's usage
 *   policy). Without `VERCEL_PROJECT_PRODUCTION_URL` there is no honest User-Agent, so nothing is
 *   sent at all: 503 `places_unavailable`, never an anonymous call.
 * - A geocode always names its country (ISO 3166 alpha-2): free text goes as `q` +
 *   `countrycodes`, a postal code as the structured `postalcode` + `country`. No country, no call —
 *   the map never centres on a guess.
 * - The point comes back rounded to 2 decimals (about 1 km), and the store search rounds the point
 *   it is given the same way before it leaves.
 * - One global `places:nominatim` limit of 1 request a second (Nominatim's policy is per
 *   application, not per user), waited out once, then 503.
 * - Budgets: 6 s for the geocoder; 9 s for the store search including its one wider retry, under
 *   the phone's 12 s `places` deadline.
 * - Logs carry the upstream status only, never the query, the area or a coordinate.
 */
import { z } from "zod";
import { APP_NAME } from "@/lib/brand";
import { HttpError } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import type { GeocodeResult, PlaceStore } from "@/lib/shopping/contracts";

export const NOMINATIM_ORIGIN = "https://nominatim.openstreetmap.org";
export const OVERPASS_ORIGIN = "https://overpass-api.de";

export const NOMINATIM_BUDGET_MS = 6_000;
export const OVERPASS_BUDGET_MS = 9_000;
/** A wider retry starts only with at least this much of the store budget left. */
const MIN_RETRY_MS = 1_500;

export const STORE_RADIUS_M = 4_000;
export const STORE_RETRY_RADIUS_M = 8_000;
/** Fewer stores than this within 4 km asks once more at 8 km. */
export const STORE_RETRY_BELOW = 3;
export const STORE_MAX = 25;

/** The OSM `shop` values counted as a grocery store. */
export const GROCERY_SHOPS = ["supermarket", "grocery", "greengrocer", "health_food", "butcher", "deli"] as const;

export const PLACES_UNAVAILABLE_MESSAGE = "Store search isn't available right now. You can skip this step.";

export class PlacesUnavailable extends HttpError {
  constructor() { super(503, "places_unavailable", PLACES_UNAVAILABLE_MESSAGE); }
}

/** The one variable the User-Agent reads (process.env, or a test's own). */
export type PlacesEnv = { VERCEL_PROJECT_PRODUCTION_URL?: string; [name: string]: string | undefined };

export type PlacesDeps = {
  fetch?: typeof fetch;
  env?: PlacesEnv;
  /** Tests: shorter budgets. */
  nominatimMs?: number;
  overpassMs?: number;
  /** Tests: the wait before the one retry of a refused global limit. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The User-Agent every upstream call carries: the app's name and its production address, or null
 * when the deployment has no production address (then no call is made).
 */
export function placesUserAgent(env: PlacesEnv = process.env): string | null {
  const raw = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(host)) return null;
  return `${APP_NAME}/1.0 (+https://${host.toLowerCase()})`;
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** An ISO 3166 alpha-2 code, upper case, or null. */
export function countryCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

/**
 * Whether the typed area is a postal code (asked as Nominatim's structured `postalcode`): a U.S.
 * ZIP or ZIP+4, a Canadian, British or Dutch code, or any short all-digit code.
 */
export function isPostalCode(text: string, country: string): boolean {
  const value = text.trim();
  if (country === "US") return /^\d{5}(-\d{4})?$/.test(value);
  if (/^\d{3,7}([ -]\d{2,4})?$/.test(value)) return true;
  if (country === "CA") return /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(value);
  if (country === "GB") return /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i.test(value);
  if (country === "NL") return /^\d{4} ?[A-Z]{2}$/i.test(value);
  return false;
}

/** The Nominatim search URL for one area in one country (exported for tests). */
export function geocodeUrl(q: string, country: string): string {
  const params = new URLSearchParams({ format: "jsonv2", limit: "1", addressdetails: "0" });
  if (isPostalCode(q, country)) {
    params.set("postalcode", q.trim());
    params.set("country", country);
  } else {
    params.set("q", q.trim());
    params.set("countrycodes", country.toLowerCase());
  }
  return `${NOMINATIM_ORIGIN}/search?${params.toString()}`;
}

const NominatimHits = z.array(z.object({
  lat: z.union([z.string(), z.number()]),
  lon: z.union([z.string(), z.number()]),
  display_name: z.string().optional(),
}).passthrough());

/** "Mission District, San Francisco, California, 94110, United States" → its first two parts. */
function shortLabel(displayName: string | undefined, fallback: string): string {
  const parts = (displayName ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const label = parts.slice(0, 2).join(", ");
  return (label || fallback).slice(0, 120);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The global Nominatim limit: one request a second for the whole app, waited out once. */
async function nominatimSlot(sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await enforceRateLimit("places:nominatim", 1, 1);
      return;
    } catch (error) {
      if (error instanceof HttpError && error.status === 429 && attempt === 0) {
        await sleep(1_000);
        continue;
      }
      if (error instanceof HttpError && error.status === 429) {
        console.warn("[places] nominatim status 429 (app limit)");
        throw new PlacesUnavailable();
      }
      throw error;
    }
  }
}

/** One upstream GET or POST under a deadline; any failure is logged by status only. */
async function upstream(service: "nominatim" | "overpass", fetcher: typeof fetch, url: string,
  init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: "error", cache: "no-store" });
  } catch {
    console.warn(`[places] ${service} ${signal.aborted ? "timeout" : "network error"}`);
    throw new PlacesUnavailable();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    console.warn(`[places] ${service} status ${response.status}`);
    throw new PlacesUnavailable();
  }
  try {
    return await response.json();
  } catch {
    console.warn(`[places] ${service} ${signal.aborted ? "timeout" : "malformed answer"}`);
    throw new PlacesUnavailable();
  }
}

/** A deadline whose timer never outlives the call. */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** A typed area in a stated country to a rounded point; 404 `place_not_found` when there is none. */
export async function geocodePlace(q: string, country: string, deps: PlacesDeps = {}): Promise<GeocodeResult> {
  const code = countryCode(country);
  if (!code) throw new HttpError(400, "country_required", "Pick a country first.");
  const text = q.trim();
  if (!text || text.length > 120) throw new HttpError(400, "bad_request", "Enter an area, city or ZIP code.");
  const agent = placesUserAgent(deps.env ?? process.env);
  if (!agent) {
    console.warn("[places] no production URL for the User-Agent; not calling");
    throw new PlacesUnavailable();
  }
  await nominatimSlot(deps.sleep ?? wait);
  const budget = deadline(deps.nominatimMs ?? NOMINATIM_BUDGET_MS);
  let body: unknown;
  try {
    body = await upstream("nominatim", deps.fetch ?? fetch, geocodeUrl(text, code), {
      method: "GET", headers: { "user-agent": agent, accept: "application/json", "accept-language": "en" },
    }, budget.signal);
  } finally {
    budget.done();
  }
  const hits = NominatimHits.safeParse(body);
  if (!hits.success) {
    console.warn("[places] nominatim malformed answer");
    throw new PlacesUnavailable();
  }
  const hit = hits.data[0];
  const lat = hit ? Number(hit.lat) : NaN;
  const lon = hit ? Number(hit.lon) : NaN;
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(404, "place_not_found", "We couldn't find that place. Try a ZIP code or a nearby city.");
  }
  return { lat: round2(lat), lon: round2(lon), label: shortLabel(hit.display_name, text) };
}

/** The Overpass QL for named grocery stores within `radius` metres of a point (exported for tests). */
export function storesQuery(lat: number, lon: number, radius: number): string {
  const shops = GROCERY_SHOPS.join("|");
  return `[out:json][timeout:8];nwr["shop"~"^(${shops})$"]["name"](around:${radius},${lat},${lon});out center 80;`;
}

const OverpassBody = z.object({
  elements: z.array(z.object({
    type: z.string(),
    id: z.number(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    center: z.object({ lat: z.number(), lon: z.number() }).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  }).passthrough()),
}).passthrough();

/** Great-circle distance in metres. */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Named stores from an Overpass answer, nearest first; one row per store (a node and its building collapse). */
export function storesFrom(body: unknown, lat: number, lon: number, radius: number): PlaceStore[] {
  const parsed = OverpassBody.safeParse(body);
  if (!parsed.success) {
    console.warn("[places] overpass malformed answer");
    throw new PlacesUnavailable();
  }
  const rows: PlaceStore[] = [];
  for (const element of parsed.data.elements) {
    const name = element.tags?.name?.trim();
    const at = element.center ?? (element.lat !== undefined && element.lon !== undefined
      ? { lat: element.lat, lon: element.lon } : null);
    if (!name || !at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
    const distance = Math.round(distanceM(lat, lon, at.lat, at.lon));
    if (distance > radius) continue;
    rows.push({ id: `${element.type}/${element.id}`, name: name.slice(0, 120),
      lat: Math.round(at.lat * 1e5) / 1e5, lon: Math.round(at.lon * 1e5) / 1e5, distanceM: distance });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const kept: PlaceStore[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) continue;
    const twin = kept.some((other) => other.name.toLowerCase() === row.name.toLowerCase()
      && distanceM(other.lat, other.lon, row.lat, row.lon) < 75);
    if (twin) continue;
    ids.add(row.id);
    kept.push(row);
    if (kept.length >= STORE_MAX) break;
  }
  return kept;
}

/**
 * Named grocery stores within 4 km of a point (rounded to 2 decimals first), and once more within
 * 8 km when there are fewer than 3. A failed wider retry keeps the first answer.
 */
export async function nearbyStores(latIn: number, lonIn: number, deps: PlacesDeps = {}): Promise<PlaceStore[]> {
  if (!Number.isFinite(latIn) || !Number.isFinite(lonIn) || Math.abs(latIn) > 90 || Math.abs(lonIn) > 180) {
    throw new HttpError(400, "bad_request", "Check the map point.");
  }
  const agent = placesUserAgent(deps.env ?? process.env);
  if (!agent) {
    console.warn("[places] no production URL for the User-Agent; not calling");
    throw new PlacesUnavailable();
  }
  const lat = round2(latIn);
  const lon = round2(lonIn);
  const fetcher = deps.fetch ?? fetch;
  const budgetMs = deps.overpassMs ?? OVERPASS_BUDGET_MS;
  const startedAt = Date.now();
  const budget = deadline(budgetMs);
  const ask = async (radius: number) => storesFrom(await upstream("overpass", fetcher,
    `${OVERPASS_ORIGIN}/api/interpreter`, {
      method: "POST",
      headers: { "user-agent": agent, accept: "application/json",
        "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: storesQuery(lat, lon, radius) }).toString(),
    }, budget.signal), lat, lon, radius);
  try {
    const near = await ask(STORE_RADIUS_M);
    const left = budgetMs - (Date.now() - startedAt);
    if (near.length >= STORE_RETRY_BELOW || left < Math.min(MIN_RETRY_MS, budgetMs / 2)) return near;
    try {
      const wide = await ask(STORE_RETRY_RADIUS_M);
      return wide.length >= near.length ? wide : near;
    } catch (error) {
      if (error instanceof PlacesUnavailable) return near;
      throw error;
    }
  } finally {
    budget.done();
  }
}
