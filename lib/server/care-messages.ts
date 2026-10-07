import "server-only";

/** UI-NEEDS SPROUT-CARE item 4: the message inbox, read through RLS; marked via care_message_mark. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { CareMessage, CareMessageType } from "@/lib/care/contract";

type Row = { id: string; type: string; payload: unknown; created_at: string;
  read_at: string | null; dismissed_at: string | null };

export async function readCareMessages(
  client: SupabaseClient, userId: string, unreadOnly: boolean,
): Promise<CareMessage[]> {
  let query = client.from("care_messages")
    .select("id, type, payload, created_at, read_at, dismissed_at")
    .eq("user_id", userId).is("dismissed_at", null);
  if (unreadOnly) query = query.is("read_at", null);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) throw new HttpError(502, "care_messages_read_failed", "Messages could not be read.", { cause: error });
  return (data as Row[] ?? []).map((r) => ({
    id: r.id, type: r.type as CareMessageType, payload: r.payload, createdAt: r.created_at,
    readAt: r.read_at, dismissedAt: r.dismissed_at,
  }));
}

export async function markCareMessage(
  client: SupabaseClient, userId: string, id: string, action: "read" | "dismiss",
): Promise<boolean> {
  const { data, error } = await client.rpc("care_message_mark",
    { p_user_id: userId, p_id: id, p_action: action });
  if (error) throw new HttpError(502, "care_message_mark_failed", "That could not be saved.", { cause: error });
  return data === true;
}
