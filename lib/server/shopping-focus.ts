import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { localDate } from "@/lib/recipes-hub/put-in-meal";
import { defaultFocusEnd, maxFocusEnd } from "@/lib/shopping/focus";

/** The account's current `shopping_focus_until`, or null when never set. */
export async function getShoppingFocusUntil(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client.from("user_settings").select("shopping_focus_until")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const value = (data as { shopping_focus_until?: unknown } | null)?.shopping_focus_until;
  return typeof value === "string" ? value : null;
}

/** Writes `shopping_focus_until`; returns the value it REPLACED (for Undo). */
export async function setShoppingFocusUntil(
  client: SupabaseClient, userId: string, until: string | null,
): Promise<string | null> {
  const previous = await getShoppingFocusUntil(client, userId);
  const { error } = await client.from("user_settings")
    .update({ shopping_focus_until: until }).eq("user_id", userId);
  if (error) throw error;
  return previous;
}

/**
 * D7's default end: the open shopping period's own end (through its last moment), or
 * FOCUS_DEFAULT_DAYS out with none open; `days` (explicit, 1-31) overrides both, still capped at
 * FOCUS_MAX_DAYS out. The server decides this, never the model (set-shopping-focus.ts's own doc).
 */
export async function resolveFocusEnd(
  client: SupabaseClient, userId: string, now: Date, days?: number,
): Promise<string> {
  const max = maxFocusEnd(now);
  if (days !== undefined) {
    const requested = new Date(now.getTime() + days * 86_400_000).toISOString();
    return requested > max ? max : requested;
  }
  const today = localDate(now);
  const { data, error } = await client.from("shopping_periods").select("end_date")
    .eq("user_id", userId).lte("start_date", today).gte("end_date", today)
    .order("end_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const openEnd = (data as { end_date?: unknown } | null)?.end_date;
  const resolved = defaultFocusEnd(now, typeof openEnd === "string" ? openEnd : null);
  return resolved > max ? max : resolved;
}
