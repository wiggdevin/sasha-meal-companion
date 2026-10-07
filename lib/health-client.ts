/**
 * Client side of the body screen. Health data is server-owned and read-only here, so there is no
 * outbox and no merge — just one localStorage entry (contracts §2: no IndexedDB store this wave) so
 * the dashboard renders offline with a "last synced" line.
 */
import type { DailyHealthResponse } from "@/lib/health/contract";
import {
  accountFetch, accountHandle, accountJson, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";

const APPLE_SOURCE_KINDS = new Set(["apple_health_shortcut", "health_auto_export"]);
export const APPLE_SYNC_STALE_HOURS = 36;

function relativeHealthTime(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours <= APPLE_SYNC_STALE_HOURS) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export type AppleHealthConnectionState = {
  status: string;
  detail: string | null;
  action: "Connect" | "Manage";
  hasActiveSource: boolean;
};

export function appleHealthConnectionState(
  sources: DailyHealthResponse["sources"],
  disabled: boolean,
  now = new Date(),
): AppleHealthConnectionState {
  const active = sources.filter((source) => !source.revoked && APPLE_SOURCE_KINDS.has(source.kind));
  const hasActiveSource = active.length > 0;
  const action = hasActiveSource ? "Manage" : "Connect";
  if (disabled) return { status: "Not available yet", detail: null, action, hasActiveSource };
  if (!hasActiveSource) return { status: "Not set up", detail: null, action, hasActiveSource };
  const lastReceived = active.map((source) => source.last_received_at)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  if (!lastReceived) {
    return { status: "Setup started · waiting for first sync", detail: null, action,
      hasActiveSource };
  }
  const ageHours = (now.getTime() - Date.parse(lastReceived)) / 3_600_000;
  const relative = relativeHealthTime(lastReceived, now);
  if (ageHours <= APPLE_SYNC_STALE_HOURS) {
    return { status: `Syncing · last received ${relative}`, detail: null, action,
      hasActiveSource };
  }
  return { status: `Needs attention · last received ${relative}`,
    detail: "Open your Shortcut or exporter and run it once.", action, hasActiveSource };
}

/** The account's own cache name (Phase 9 §0.4): `smc:u:<userId>:health_daily`. */
export const HEALTH_DAILY_CACHE_NAME = "health_daily";

export type CachedDaily = { fetchedAt: string; response: DailyHealthResponse };

/**
 * A row cached before T11 has no `provenance`, and an intermittent failure serves that row straight
 * back to the card. Normalise every row on the way out of the cache — and on the way out of a 200,
 * because a server build from before T11 can answer one — so no reader has to index a map that may
 * not exist (second audit, T11a finding 1). Chosen over a cache-key bump: it repairs the row that
 * is already on their phone, with no sweep and no second key to expire.
 */
function normalizeDays(response: DailyHealthResponse): DailyHealthResponse {
  return { ...response,
    days: response.days.map((day) => (day.provenance ? day : { ...day, provenance: {} })) };
}

export function readCachedDaily(h: AccountHandle | null): CachedDaily | null {
  if (h === null) return null;
  try {
    const raw = readAccountItem(h, HEALTH_DAILY_CACHE_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDaily;
    if (!parsed || typeof parsed.fetchedAt !== "string" || !parsed.response) return null;
    return { fetchedAt: parsed.fetchedAt, response: normalizeDays(parsed.response) };
  } catch {
    return null;
  }
}

export function writeCachedDaily(
  h: AccountHandle, response: DailyHealthResponse, now: Date = new Date(),
): void {
  // A full or blocked store is not a reason to fail the screen (writeAccountItem swallows it); a
  // stale handle is: nothing of A's lands after B binds.
  writeAccountItem(h, HEALTH_DAILY_CACHE_NAME,
    JSON.stringify({ fetchedAt: now.toISOString(), response } satisfies CachedDaily));
}

/**
 * The account's daily rows, live or from its own cache. A response that arrives after the account
 * changed rejects with `AccountChanged` and is cached for nobody (audit plan r1 finding 2).
 */
export async function fetchDaily(
  h: AccountHandle, from: string, to: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<{
    response: DailyHealthResponse | null; fetchedAt: string | null;
    offline: boolean; disabled: boolean }> {
  try {
    const res = await accountFetch(h, `/api/health/daily?from=${from}&to=${to}`,
      { cache: "no-store" }, { fetchImpl: opts.fetchImpl });
    if (res.status === 503) {
      const cached = readCachedDaily(h);
      return { response: cached?.response ?? null, fetchedAt: cached?.fetchedAt ?? null,
        offline: false, disabled: true };
    }
    if (!res.ok) throw new Error(`daily failed with ${res.status}`);
    const response = normalizeDays(await accountJson<DailyHealthResponse>(h, res));
    writeCachedDaily(h, response);
    return { response, fetchedAt: new Date().toISOString(), offline: false, disabled: false };
  } catch (e) {
    rethrowAccountChanged(e);
    const cached = readCachedDaily(h);
    return { response: cached?.response ?? null, fetchedAt: cached?.fetchedAt ?? null,
      offline: true, disabled: false };
  }
}

async function postJson(h: AccountHandle, url: string, body?: unknown): Promise<Response> {
  const res = await accountFetch(h, url, { method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res;
}

export async function issueToken(req: { kind: string; device_label?: string; time_zone?: string }):
    Promise<{ token: string; source: { id: string } }> {
  const h = accountHandle();
  const res = await postJson(h, "/api/health/tokens", req);
  return accountJson<{ token: string; source: { id: string } }>(h, res);
}

export async function revokeToken(id: string): Promise<void> {
  const res = await accountFetch(accountHandle(), `/api/health/tokens/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`revoke failed with ${res.status}`);
}

/**
 * Oura's consent page, for the account that tapped (audit plan r3 finding 4). The start route
 * answers `{ url }` to a POST after checking `x-smc-account`, so a stale tab gets `409` before any
 * OAuth state is bound; then the page leaves the app for that absolute Oura URL.
 */
export async function connectOura(
  h: AccountHandle, opts: { fetchImpl?: typeof fetch; assign?: (url: string) => void;
    returnTo?: string } = {},
): Promise<void> {
  const res = await accountFetch(h, "/api/health/oura/start", { method: "POST",
    ...(opts.returnTo ? { headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnTo: opts.returnTo }) } : {}) },
    { fetchImpl: opts.fetchImpl });
  if (!res.ok) throw new Error(`oura start failed with ${res.status}`);
  const { url } = await accountJson<{ url: string }>(h, res);
  assertCurrent(h);
  (opts.assign ?? ((to: string) => window.location.assign(to)))(url);
}

export async function disconnectOura(): Promise<void> {
  await postJson(accountHandle(), "/api/health/oura/disconnect");
}

export type DailyFetch = Awaited<ReturnType<typeof fetchDaily>>;

/**
 * What the Settings "Body data" card shows for one fetchDaily result (contracts §6: with
 * HEALTH_INGEST_ENABLED unset the server 503s and the card must not appear; a failed fetch is
 * an error state, never "Loading…" forever).
 *
 * `canEditProfile` gates the body-profile fields that ride inside the card (T11b ninth-round finding
 * 4): while the first fetch is in flight this cannot tell whether the card will exist at all, so the
 * fields mount only once a response has come back and the capability is not disabled. An offline
 * fetch that served the cached row counts — that row was written by a 200 — but a failed fetch with
 * nothing cached does not: the capability is still unknown.
 */
export function bodyDataCard(daily: DailyFetch | null): {
    hidden: boolean; caption: string; canManage: boolean; canEditProfile: boolean } {
  if (daily === null) {
    return { hidden: false, caption: "Loading…", canManage: false, canEditProfile: false };
  }
  if (daily.disabled) return { hidden: true, caption: "", canManage: false, canEditProfile: false };
  if (daily.response === null) {
    return { hidden: false,
      caption: "Couldn’t reach body data — try again when you have a connection.",
      canManage: false, canEditProfile: false };
  }
  const n = daily.response.sources.length;
  const caption = daily.offline ? `${n} source${n === 1 ? "" : "s"} · offline, last synced copy` : `${n} source${n === 1 ? "" : "s"}`;
  return { hidden: false, caption, canManage: !daily.offline, canEditProfile: true };
}
