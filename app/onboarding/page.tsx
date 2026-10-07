import ConversationalOnboarding from "@/components/Onboarding/ConversationalOnboarding";
import OnboardingErrorBoundary from "@/components/Onboarding/OnboardingErrorBoundary";
import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";

export const dynamic = "force-dynamic";

/**
 * Onboarding v2 (lanes L2-L5, 2026-10-07): the full-screen conversational shell is dark behind
 * `NEXT_PUBLIC_CHAT_ONBOARDING`, default off. The existing 6-step form stays the fallback and stays
 * reachable at this same route whenever the flag reads anything other than "1" — not just while the
 * flag is unset, so a bad or unrecognised value never strands a new account mid-sign-up on a half
 * built screen. The orchestrator flips the flag once Lane 5's safety QA passes (LANES.md).
 *
 * `OnboardingErrorBoundary` is the other half of that same promise while the flag IS on: a render
 * error anywhere inside the chat shell falls back to this same legacy form, pre-filled from
 * whatever the chat path had already drafted, rather than stranding the account on a crashed
 * screen (lane 5 requirement: "the user lands on the legacy form with their answers kept").
 */
export default function OnboardingPage() {
  if (process.env.NEXT_PUBLIC_CHAT_ONBOARDING === "1") {
    return <OnboardingErrorBoundary><ConversationalOnboarding /></OnboardingErrorBoundary>;
  }
  return <OnboardingFlow />;
}
