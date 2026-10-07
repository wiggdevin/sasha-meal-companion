/**
 * Oura OAuth2 confidential authorization-code flow and the daily pull (architecture §5.2).
 * client_secret never leaves the server, `state` is stored as a hash and consumed once, and a refresh
 * rotates in one compare-and-swap update so the old refresh token cannot survive it.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OauthTokens } from "@/lib/health/contract";
import { ouraActivityToSamples, ouraReadinessToSamples, ouraSleepToSamples } from "@/lib/oura/map";
import { ouraGet } from "@/lib/oura/client";
import { HttpError } from "@/lib/server/auth";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { hashToken, toBytea } from "@/lib/server/tokens";

export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_SCOPE = "daily personal";
export const OURA_STATE_TTL_MS = 600_000;
export const OURA_REFRESH_SKEW_MS = 300_000;

export type OuraSourceRow = { id: string; user_id: string; oauth: string | null };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpError(503, "unavailable", `${name} not set`);
  return value;
}

export function ouraAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({ client_id: env("OURA_CLIENT_ID"),
    redirect_uri: env("OURA_REDIRECT_URI"), response_type: "code", scope: OURA_SCOPE, state });
  return `${OURA_AUTHORIZE_URL}?${params.toString()}`;
}

export async function startOura(admin: SupabaseClient, userId: string, now: Date = new Date(),
    returnTo = "/settings"):
    Promise<{ url: string }> {
  const state = `${randomBytes(32).toString("base64url")}.${Buffer.from(returnTo).toString("base64url")}`;
  const { error } = await admin.from("oauth_states").insert({
    state_hash: toBytea(hashToken(state)), provider: "oura", user_id: userId,
    expires_at: new Date(now.getTime() + OURA_STATE_TTL_MS).toISOString() });
  if (error) throw new HttpError(500, "internal", "could not store the oauth state");
  return { url: ouraAuthorizeUrl(state) };
}

async function exchange(body: Record<string, string>, fetchFn: typeof fetch): Promise<OauthTokens> {
  const res = await fetchFn(OURA_TOKEN_URL, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: env("OURA_CLIENT_ID"),
      client_secret: env("OURA_CLIENT_SECRET") }).toString() });
  if (!res.ok) throw new HttpError(502, "exchange_failed", "Oura rejected the token request.");
  const json = await res.json() as { access_token?: string; refresh_token?: string;
    expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token) {
    throw new HttpError(502, "exchange_failed", "Oura returned no token pair.");
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
    scope: json.scope ?? OURA_SCOPE };
}

export async function completeOura(admin: SupabaseClient, args: { state: string; code: string },
    deps: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<{ sourceId: string; userId: string }> {
  const now = deps.now ?? new Date();
  // Verify, unconsumed, unexpired and consumed — one statement, so a replay finds nothing.
  const { data, error } = await admin.from("oauth_states")
    .update({ consumed_at: now.toISOString() })
    .eq("state_hash", toBytea(hashToken(args.state)))
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("user_id").maybeSingle();
  if (error) throw new HttpError(500, "internal", "could not consume the oauth state");
  if (!data) throw new HttpError(400, "bad_state", "Unknown, used or expired state.");
  const userId = (data as { user_id: string }).user_id;

  const tokens = await exchange({ grant_type: "authorization_code", code: args.code,
    redirect_uri: env("OURA_REDIRECT_URI") }, deps.fetchFn ?? fetch);

  // No unique index backs (user_id, kind), and none can: production holds two health_auto_export
  // sources for one account, and PostgREST cannot name a partial index as its conflict target. So a
  // reconnect reuses the account's source — the active one first, else the newest revoked one, so
  // its samples keep their source — and the first connect inserts one.
  const found = await admin.from("health_sources").select("id")
    .eq("user_id", userId).eq("kind", "oura")
    .order("revoked_at", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (found.error) throw new HttpError(500, "internal", "could not read the Oura source");
  const fields = { device_label: "Oura", oauth: sealOauth(tokens), revoked_at: null };
  const existingId = (found.data as { id: string } | null)?.id;
  const stored = existingId
    ? await admin.from("health_sources").update(fields)
      .eq("id", existingId).eq("user_id", userId).select("id").single()
    : await admin.from("health_sources").insert({ user_id: userId, kind: "oura", ...fields })
      .select("id").single();
  if (stored.error) throw new HttpError(500, "internal", "could not store the Oura source");
  return { sourceId: (stored.data as { id: string }).id, userId };
}

export async function accessTokenFor(admin: SupabaseClient, source: OuraSourceRow,
    deps: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<string> {
  if (!source.oauth) throw new HttpError(400, "not_connected", "This source has no Oura tokens.");
  const now = deps.now ?? new Date();
  const current = openOauth(source.oauth);
  if (Date.parse(current.expires_at) - now.getTime() > OURA_REFRESH_SKEW_MS) {
    return current.access_token;
  }

  const rotated = await exchange({ grant_type: "refresh_token",
    refresh_token: current.refresh_token }, deps.fetchFn ?? fetch);
  // One statement writes the new pair and clears the old, matched on the exact sealed value we read.
  const { data, error } = await admin.from("health_sources")
    .update({ oauth: sealOauth(rotated) })
    .eq("id", source.id).eq("oauth", source.oauth);
  if (error) throw new HttpError(500, "internal", "could not rotate the Oura tokens");
  void data;
  return rotated.access_token;
}

function previousTwoDays(today: string): { start: string; end: string } {
  const end = today;
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000)
    .toISOString().slice(0, 10);
  return { start, end };
}

export async function pullTwoDays(admin: SupabaseClient, source: OuraSourceRow, today: string,
    deps: { fetchFn?: typeof fetch } = {}): Promise<{ inserted: number; updated: number; skipped: number }> {
  const { start, end } = previousTwoDays(today);
  const token = await accessTokenFor(admin, source, { fetchFn: deps.fetchFn });
  const params = { start_date: start, end_date: end };
  const opts = { accessToken: token, fetchFn: deps.fetchFn,
    refresh: async () => accessTokenFor(admin, source, { fetchFn: deps.fetchFn }) };

  const [activity, readiness, sleep] = await Promise.all([
    ouraGet("daily_activity", params, opts),
    ouraGet("daily_readiness", params, opts),
    ouraGet("sleep", params, opts),
  ]);

  const samples = [
    ...activity.data.flatMap(ouraActivityToSamples),
    ...readiness.data.flatMap(ouraReadinessToSamples),
    ...sleep.data.flatMap(ouraSleepToSamples),
  ];

  // The same content hashes the same, so a second pull of the same day is a duplicate event and the
  // correction upsert changes no row (acceptance criterion 7).
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify(samples), "utf8").digest();
  const event = await admin.rpc("health_ingest_event", { p_user_id: source.user_id,
    p_source_id: source.id, p_payload_hash: `\\x${hash.toString("hex")}`, p_status: "applied" });
  if (event.error) throw new HttpError(500, "internal", "could not record the pull event");
  const eventRow = (Array.isArray(event.data) ? event.data[0] : event.data) as
    { id: string; is_new: boolean };
  const eventId = eventRow.id;

  const applied = await admin.rpc("health_ingest_apply", { p_user_id: source.user_id,
    p_source_id: source.id, p_event_id: eventId, p_samples: samples });
  if (applied.error) throw new HttpError(500, "internal", "could not apply the pulled samples");
  const counts = (Array.isArray(applied.data) ? applied.data[0] : applied.data) as
    { accepted: number; updated: number; skipped: number } | null;
  return { inserted: counts?.accepted ?? 0, updated: counts?.updated ?? 0,
    skipped: counts?.skipped ?? 0 };
}
