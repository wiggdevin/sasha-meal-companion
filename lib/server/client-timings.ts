import "server-only";

/**
 * The store behind `POST /api/timings` (T0 §1, W070). Since migration 20270105140300
 * `authenticated` has no INSERT on `client_timings`, so the route's rate limit is the only way in:
 * the rows are written with the admin client, each stamped with the session-verified `userId`
 * (never a value off the body). Returns the error code, or null, so the route can still answer 202.
 */
import { adminClient } from "@/lib/server/admin";

export type ClientTimingRow = {
  run_id: string; path: string; step: string; ms: number; at: string; device: string | null;
};

export async function recordClientTimings(
  userId: string, rows: readonly ClientTimingRow[],
): Promise<string | null> {
  const { error } = await adminClient().from("client_timings")
    .insert(rows.map((row) => ({ ...row, user_id: userId })));
  return error ? (error.code ?? "unknown") : null;
}
