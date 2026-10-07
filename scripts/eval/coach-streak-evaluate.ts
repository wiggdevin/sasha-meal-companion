import { heuristic, type VerifyReplyInput } from "@/lib/coach/verify";
import type { CoachTurnResponse } from "@/lib/coach/types";
import {
  evaluateTurn,
  type Assertion,
  type CoachCase,
} from "./coach-streak-state";

export type VerificationRecord = {
  flagged: boolean;
  p: number | null;
  verifier: "jev" | "heuristic";
};

export type ReplyVerifier = (
  input: VerifyReplyInput,
) => Promise<{ flagged: boolean; p: number } | null>;

type RunnerEvaluation = {
  diagnosis: "verifier_error" | null;
  error?: string;
  verification: VerificationRecord | null;
  evaluated: {
    path: "fast" | "llm";
    assertions: Assertion[];
    passed: boolean;
  };
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function evaluateRunnerTurn(
  item: CoachCase,
  response: CoachTurnResponse,
  elapsedMs: number,
  verify: ReplyVerifier,
  persistedBlocks: readonly unknown[] = [],
  activityContextPresent = false,
): Promise<RunnerEvaluation> {
  const reply = response.messages.at(-1)?.content ?? "";
  let verified: Awaited<ReturnType<ReplyVerifier>>;
  try {
    verified = await verify({ reply, actions: response.actions, toolResults: response.toolsUsed });
  } catch (error) {
    const detail = errorDetail(error);
    return {
      diagnosis: "verifier_error",
      error: detail,
      verification: null,
      evaluated: {
        path: response.model.modelId ? "llm" : "fast",
        assertions: [{ name: "reply verifier", passed: false, detail }],
        passed: false,
      },
    };
  }

  const verification: VerificationRecord = verified
    ? { ...verified, verifier: "jev" }
    : { flagged: heuristic(reply, response.actions), p: null, verifier: "heuristic" };
  return {
    diagnosis: null,
    verification,
    evaluated: evaluateTurn(
      item, response, elapsedMs, verification, persistedBlocks, activityContextPresent,
    ),
  };
}
