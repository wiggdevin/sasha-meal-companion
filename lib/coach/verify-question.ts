/**
 * The fixed Jev question for the coach reply check (purpose `coach-verify`), built by the payload
 * builder (lib/ai/payloads.ts verifyPayload); no caller writes question text (Phase 13 §9 R3).
 */
import { noul } from "@/lib/ai/jev-types";

export const VERIFY_QUESTIONS = {
  claims_unlisted_action: noul(
    "Does the reply say that something was logged, moved, added, removed, changed, saved or "
      + "scheduled that is NOT covered by `actions`? `tools_ran` is read-only and never "
      + "covers a write claim.",
    {
      true: "The reply presents at least one completed write or schedule change that no listed "
        + "action covers; read-only tools cannot cover it.",
      false: "Every claimed write or schedule change is covered by a listed action, or the reply "
        + "makes no such claim.",
    },
  ),
};
