import "server-only";

/** UI-NEEDS SPROUT-CARE item 6: "did this op grow the current day's log". */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { CareLogGrowthResult } from "@/lib/care/contract";

type RpcAnswer = { opId?: string; kind?: string | null; localDate?: string | null; grew?: boolean };

export async function readCareLogGrowth(
  client: SupabaseClient, userId: string, opId: string, zone: string,
): Promise<CareLogGrowthResult> {
  const { data, error } = await client.rpc("care_log_grew", { p_user_id: userId, p_op_id: opId, p_zone: zone });
  if (error) {
    if (error.code === "22023") throw new HttpError(400, "bad_request", "That could not be checked.");
    throw new HttpError(502, "care_log_grew_failed", "That could not be checked. Try again.", { cause: error });
  }
  const answer = data as RpcAnswer | null;
  if (!answer || typeof answer.grew !== "boolean") {
    throw new HttpError(502, "care_log_grew_failed", "That could not be checked. Try again.", { cause: answer });
  }
  return { opId, kind: answer.kind ?? null, localDate: answer.localDate ?? null, grew: answer.grew };
}
