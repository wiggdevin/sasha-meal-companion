import { deleteOp, type AccountHandle, type OutboxOp } from "./idb";
import type { OpResult } from "./types";

export type FoodMembershipRejectedResult = {
  op_id: string;
  status: "rejected";
  user_id: string;
  name_norm: string;
  current_status: "eats" | "avoid" | null;
  current_rev: number;
};

export type SyncResult = OpResult | FoodMembershipRejectedResult;

/** Settle the synthetic normalized-name entity without writing it into the row mirror. */
export async function applyFoodMembershipResult(
  h: AccountHandle, result: SyncResult,
  op: OutboxOp,
  onUnexpectedRejection: () => Promise<void>,
): Promise<boolean> {
  if (result.status === "rejected") {
    const rejectedRev = op.payload.rev;
    if (op.entity !== "food_membership" || typeof rejectedRev !== "number") {
      await onUnexpectedRejection();
      return true;
    }
    const { reconcileFoodMembership } = await import("../foods/prefs-client");
    reconcileFoodMembership(
      h, result.user_id, result.name_norm, result.current_status, result.current_rev, rejectedRev,
    );
    await deleteOp(h, op.op_id);
    return true;
  }
  if (op.entity !== "food_membership" || result.status !== "applied") return false;
  await deleteOp(h, op.op_id);
  return true;
}
