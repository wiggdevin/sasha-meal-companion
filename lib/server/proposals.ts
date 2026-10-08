/**
 * Proposal reads and the decide path. Approval is one transaction inside
 * `approve_target_proposal` (§3.7 change_log rows included); rejection is a compare-and-swap
 * update, so a second tap cannot silently overwrite a decision made on the other device.
 *
 * Both run on the CALLER's RLS-scoped client: `_sync_assert_caller` inside the function checks the
 * same identity again, and another user's proposal id is simply invisible (spec: assert 404).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { accountDay } from "@/lib/server/account-day";
import { readTargetEligibility } from "@/lib/server/target-eligibility";
import { activeProfile } from "@/lib/server/targets";
import { AdultOnlyError, paceAllowed } from "@/lib/profile/rate-eligibility";
import type {
  DecideRequest, DecideResponse, ProposalSummary, ProposedTargets,
} from "@/lib/api-types";

export class ProposalConflictError extends HttpError {
  constructor(public readonly current: ProposalSummary) {
    super(409, "conflict", "This proposal was already decided.");
    this.name = "ProposalConflictError";
  }
}

export function toSummary(row: Record<string, unknown>): ProposalSummary {
  return {
    id: String(row.id),
    weekStart: String(row.week_start ?? "").slice(0, 10),
    createdAt: String(row.created_at),
    status: row.status as ProposalSummary["status"],
    basedOnEstimateId: (row.based_on_estimate_id as string | null) ?? null,
    proposed: row.proposed as ProposedTargets,
    activityContext: (row.activity_context as ProposalSummary["activityContext"]) ?? undefined,
  };
}

export async function listProposals(
  client: SupabaseClient, userId: string, status?: ProposalSummary["status"],
): Promise<ProposalSummary[]> {
  const query = client.from("target_proposals")
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed, activity_context")
    .eq("user_id", userId);
  const { data, error } = await (status
    ? query.eq("status", status).order("week_start", { ascending: false })
    : query.order("week_start", { ascending: false }));
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

async function readOne(
  client: SupabaseClient, userId: string, proposalId: string,
): Promise<ProposalSummary | null> {
  const { data, error } = await client.from("target_proposals")
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed, activity_context")
    .eq("user_id", userId).eq("id", proposalId).maybeSingle();
  if (error) throw error;
  return data ? toSummary(data) : null;
}

/**
 * Pace holds (onboarding v2 G1-G3): approving copies the active revision's pace into the new one
 * (`approve_target_proposal`), so an account under 18 approves nothing, and a held account
 * approves only once its revision in force is at a 0 pace (a hold re-derives it at once,
 * lib/server/target-recompute.ts `recomputeAfterHoldChange`). A proposal built before the hold
 * could carry a deficit; the next weekly proposal is built at a 0 pace.
 */
async function assertApprovalEligible(client: SupabaseClient, userId: string): Promise<void> {
  const day = await accountDay(client, userId, { purpose: "approve proposal" });
  const eligibility = await readTargetEligibility(client, userId, day.date);
  if (eligibility.minor) throw new AdultOnlyError();
  if (paceAllowed(eligibility)) return;
  const active = await activeProfile(client, userId, day.date);
  if (active && Number(active.goal_rate_bp_week ?? 0) !== 0) {
    throw new HttpError(409, "rate_not_eligible",
      "Your health answers changed. A new suggestion will follow at maintenance.");
  }
}

export async function decideProposal(
  client: SupabaseClient, userId: string, proposalId: string, req: DecideRequest,
): Promise<DecideResponse> {
  if (req.decision === "approve") {
    await assertApprovalEligible(client, userId);
    const { data, error } = await client.rpc("approve_target_proposal",
      { p_user_id: userId, p_proposal_id: proposalId });
    if (error) throw error;
    const result = data as { status: string; target_profile_id?: string; current?: Record<string, unknown> };
    if (result.status === "not_found") throw new HttpError(404, "not_found", "No such proposal.");
    if (result.status === "conflict") {
      throw new ProposalConflictError(toSummary(result.current as Record<string, unknown>));
    }
    return { status: "approved", targetProfileId: String(result.target_profile_id) };
  }

  const { data, error } = await client.from("target_proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: userId })
    .eq("user_id", userId).eq("id", proposalId).eq("status", req.expectedStatus)
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed, activity_context")
    .maybeSingle();
  if (error) throw error;
  if (data) return { status: "rejected", targetProfileId: null };

  // Nothing matched: either the row is invisible (another user, or gone) or it moved on.
  const current = await readOne(client, userId, proposalId);
  if (!current) throw new HttpError(404, "not_found", "No such proposal.");
  throw new ProposalConflictError(current);
}
