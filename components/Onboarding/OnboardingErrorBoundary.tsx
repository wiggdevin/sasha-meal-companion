"use client";

/**
 * Onboarding v2, lane 5 (requirement 6: "if the chat path errors, the user lands on the legacy
 * form with their answers kept"). A render error anywhere inside `ConversationalOnboarding` — a
 * crashed slot, a bad API response the shell did not guard, anything — must never leave the
 * account stuck on a blank or frozen screen with no way to finish setup.
 *
 * Recovery reads this lane's own resume draft (`v2/draft-store.ts`) best-effort: whatever facts
 * the chat path had already confirmed before it crashed become `OnboardingFlow`'s own
 * `initialSettings`, so the legacy stepped form opens pre-filled instead of blank. `initial` is
 * pinned to step 0 (Body) rather than guessing which step the crash happened on — every field the
 * draft carries is still pre-filled either way, which is what "answers kept" actually requires.
 */
import { Component, type ReactNode } from "react";
import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import { loadOnboardingDraft } from "@/components/Onboarding/v2/draft-store";
import { loadOnboardingSettings } from "@/lib/profile/onboarding-client";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

type State = { crashed: boolean; ready: boolean; initialSettings: Settings };

export default class OnboardingErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { crashed: false, ready: false, initialSettings: defaultSettings() };

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidCatch(): void {
    // GPT-6 Sol round-1 WARN: building `initialSettings` from bare defaults plus the draft
    // discarded every field the account already had saved (anything the chat path's facts never
    // touched — activity detail, dietary flags, a prior weigh-in, ...). Load the account's real
    // settings first and layer the draft on top of THOSE, so only a totally unreadable account
    // (itself a failure worth falling back on) ever sees bare defaults.
    // GPT-6 Sol round-2 WARN: the settings-load failure branch fell all the way to bare defaults
    // with no attempt at the draft, even when the draft itself was perfectly readable — losing
    // answers this lane had every means to keep. Try the draft independently either way.
    loadOnboardingSettings().catch(() => null).then(async (base) => {
      const draft = await loadOnboardingDraft().catch(() => null);
      this.setState({
        ready: true, initialSettings: { ...(base ?? defaultSettings()), ...draft?.settings },
      });
    });
  }

  render(): ReactNode {
    if (this.state.crashed) {
      // A brief, invisible beat while the draft read resolves — rendering the still-blank default
      // settings for one tick would show a flash of unanswered fields before they fill in.
      if (!this.state.ready) return null;
      return <OnboardingFlow initial={0} initialSettings={this.state.initialSettings} />;
    }
    return this.props.children;
  }
}
