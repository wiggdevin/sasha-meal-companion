import "server-only";

/** The account's day and a non-null zone, for every care_* route (they all need a real IANA zone
 * to pass through to SQL, where `accountDay` alone can leave `zone: null` on the client-day path). */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_DAY_LAST_RESORT_ZONE, accountDay, readAccountZone } from "@/lib/server/account-day";

export async function resolveCareDay(
  client: SupabaseClient, userId: string, purpose: string, clientDay: unknown,
): Promise<{ date: string; zone: string }> {
  const day = await accountDay(client, userId, { purpose, clientDay });
  const zone = day.zone ?? await readAccountZone(client, userId) ?? ACCOUNT_DAY_LAST_RESORT_ZONE;
  return { date: day.date, zone };
}
