import "server-only";
/**
 * The target authority's write RPCs, on the service-role client, always for a user id the caller
 * already verified (the session user, or a job's or script's own listed account), never a value
 * from a request body. Migration 20261228090000 revokes EXECUTE on these four functions from
 * `authenticated`: a signed-in phone that called them over PostgREST skipped every server-side
 * check in lib/server/targets.ts and lib/server/proposals.ts (the adult floor, the pace holds,
 * the pace caps, the floors). The functions keep their own `_sync_assert_caller` guard; the
 * service role carries no auth.uid() and passes it.
 * Tenancy canary: tests/tenancy/admin-targets.test.ts.
 */
import { adminClient } from "@/lib/server/admin";

type RpcResult = { data: unknown; error: unknown };

async function call(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await adminClient().rpc(fn, args);
  return { data, error };
}

/** `write_target_revision(p_user_id, p_row)`. */
export function rpcWriteTargetRevision(
  userId: string, row: Record<string, unknown>,
): Promise<RpcResult> {
  return call("write_target_revision", { p_user_id: userId, p_row: row });
}

/** `write_target_revision_if_active(p_user_id, p_row, p_expected_id, p_expected_settings_rev)`. */
export function rpcWriteTargetRevisionIfActive(
  userId: string, row: Record<string, unknown>,
  expectedActiveId: string | null, expectedSettingsRev: number | null,
): Promise<RpcResult> {
  return call("write_target_revision_if_active", {
    p_user_id: userId, p_row: row, p_expected_id: expectedActiveId,
    p_expected_settings_rev: expectedSettingsRev,
  });
}

/** `write_target_revision_pair(p_user_id, p_predecessor, p_row)`: one transaction. */
export function rpcWriteTargetRevisionPair(
  userId: string, predecessor: Record<string, unknown>, row: Record<string, unknown>,
): Promise<RpcResult> {
  return call("write_target_revision_pair",
    { p_user_id: userId, p_predecessor: predecessor, p_row: row });
}

/** `approve_target_proposal(p_user_id, p_proposal_id)`. */
export function rpcApproveTargetProposal(userId: string, proposalId: string): Promise<RpcResult> {
  return call("approve_target_proposal", { p_user_id: userId, p_proposal_id: proposalId });
}
