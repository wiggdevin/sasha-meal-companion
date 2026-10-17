import { jevHealthGateOn } from "@/lib/ai/jev-health";
import { jevConfigured } from "@/lib/ai/provider-env";
import { claimsAction, type CoachAction } from "@/lib/coach/actions";
import { actionLine } from "@/lib/coach/history";

export const VERIFY_FLAG_THRESHOLD = 0.8;

export type ReplyToolResult = string | { name: string; ok: boolean };

export type VerifyReplyInput = {
  reply: string;
  actions: CoachAction[];
  toolResults: ReplyToolResult[];
};

/** The pre-Jev guard: prose claiming a write is unsafe only when no action accompanies it. */
export function heuristic(reply: string, actions: CoachAction[]): boolean {
  return actions.length === 0 && claimsAction(reply);
}

function toolNames(results: ReplyToolResult[]): string[] {
  return [...new Set(results.flatMap((result) =>
    typeof result === "string" ? [result] : result.ok ? [result.name] : []))];
}

export async function verifyReply(
  input: VerifyReplyInput,
  context: { userId?: string },
): Promise<{ flagged: boolean; p: number | null }> {
  // OD12: a reply is always health-bearing, so with the health gate on it never reaches Jev;
  // skipping here keeps the adapter's refusal out of every turn's log.
  if (!jevConfigured() || jevHealthGateOn()) {
    return { flagged: heuristic(input.reply, input.actions), p: null };
  }
  const modules = await Promise.all([import("@/lib/ai/typesafe"), import("@/lib/ai/payloads")])
    .catch(() => null);
  if (!modules) return { flagged: heuristic(input.reply, input.actions), p: null };
  const [typesafe, payloads] = modules;
  const actions = input.actions.map((action) => ({
    kind: action.kind,
    summary: actionLine(action),
  }));
  const answers = await typesafe.systemOne(payloads.verifyPayload({
    reply: input.reply,
    actions,
    toolNames: toolNames(input.toolResults),
  }), { userId: context.userId });
  if (!answers) return { flagged: heuristic(input.reply, input.actions), p: null };
  const p = answers.claims_unlisted_action.noul;
  return { flagged: p >= VERIFY_FLAG_THRESHOLD, p };
}
