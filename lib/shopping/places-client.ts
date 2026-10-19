"use client";

/**
 * Nearby store search for "Have AI build my list" (UI makeover §7.4). Both calls are POSTs with
 * JSON bodies, so the typed area never sits in a URL, and both run on the `places` deadline.
 * `503 places_unavailable` (OpenStreetMap busy or down) is its own result: the step then says
 * "Store search isn't available right now. You can skip this step." Nothing is stored here.
 */
import { AccountChanged, accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import type { GeocodeResult, PlaceStore } from "@/lib/shopping/contracts";

export const PLACES_UNAVAILABLE_COPY = "Store search isn't available right now. You can skip this step.";

export type PlacesFailure = { status: "unavailable" } | { status: "not_found" } | { status: "failed" };
export type GeocodeAnswer = { status: "ok"; place: GeocodeResult } | PlacesFailure;
export type StoresAnswer = { status: "ok"; stores: PlaceStore[] } | PlacesFailure;

type Opts = { account?: AccountHandle; fetchImpl?: typeof fetch };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Two decimals (about 1 km): the most this phone ever sends about where it is. */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

async function post(path: string, payload: unknown, opts: Opts): Promise<
  { ok: true; body: unknown } | PlacesFailure> {
  try {
    const account = opts.account ?? accountHandle();
    const res = await accountFetch(account, path, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, { budget: "places", fetchImpl: opts.fetchImpl });
    if (res.status === 503) return { status: "unavailable" };
    if (res.status === 404) {
      const body = await accountJson<{ error?: unknown }>(account, res).catch(() => null);
      // A pilot 404 is the same fact to this step as a search that is not offered.
      return body?.error === "recipe_pilot_unavailable" ? { status: "unavailable" } : { status: "not_found" };
    }
    if (!res.ok) return { status: "failed" };
    return { ok: true, body: await accountJson<unknown>(account, res) };
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    return { status: "failed" };
  }
}

export async function geocodePlace(q: string, country: string, opts: Opts = {}): Promise<GeocodeAnswer> {
  const answer = await post("/api/shopping/places/geocode", { q: q.trim(), country }, opts);
  if (!("ok" in answer)) return answer;
  const body = answer.body as Partial<GeocodeResult> | null;
  if (!body || !finite(body.lat) || !finite(body.lon) || typeof body.label !== "string") return { status: "failed" };
  return { status: "ok", place: { lat: body.lat, lon: body.lon, label: body.label } };
}

function validStore(value: unknown): value is PlaceStore {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string" && row.name.trim().length > 0
    && finite(row.lat) && finite(row.lon) && finite(row.distanceM);
}

export async function nearbyStores(lat: number, lon: number, opts: Opts = {}): Promise<StoresAnswer> {
  const answer = await post("/api/shopping/places/stores", { lat: roundCoord(lat), lon: roundCoord(lon) }, opts);
  if (!("ok" in answer)) return answer;
  const stores = (answer.body as { stores?: unknown } | null)?.stores;
  if (!Array.isArray(stores)) return { status: "failed" };
  return { status: "ok", stores: stores.filter(validStore) };
}
