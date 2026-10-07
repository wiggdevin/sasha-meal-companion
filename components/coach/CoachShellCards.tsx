import CoachComposedCard from "@/components/CoachComposedCard";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import { CoachError } from "@/lib/coach-client";
import ActionFeedbackToast, { type ActionFeedbackNotice } from "@/components/ui/ActionFeedback";
import Notice from "@/components/ui/Notice";

export function CoachComposedCards({ meals, tz, onAction, newId, now }: {
  meals: readonly ComposedMeal[];
  tz: string;
  onAction: (action: CoachAction, cardIndex: number) => void;
  newId?: () => string;
  now?: () => Date;
}) {
  return <>{meals.map((meal, index) => <CoachComposedCard
    key={`${meal.anchorProtein ?? meal.wish}-${index}`} meal={meal} tz={tz}
    onAction={(action) => onAction(action, index)} newId={newId} now={now} />)}</>;
}

export function CoachErrorNotice({ message, detail, retryable, onRetry }: {
  message: string; detail?: string; retryable: boolean; onRetry: () => void;
}) {
  return <Notice tone="error" title={message} className="mx-3"
    action={retryable ? { label: "Try again", onClick: onRetry } : undefined}>
    {detail}
  </Notice>;
}

export function CoachSendFeedbackToast({ notice, onDismiss, unresolved, retryable, onRetry }: {
  notice: ActionFeedbackNotice | null; onDismiss: () => void;
  unresolved: boolean; retryable: boolean; onRetry: () => void;
}) {
  return <ActionFeedbackToast notice={notice} onDismiss={onDismiss}
    detail={unresolved
      ? "This reply may have saved. Try again to recover it before sending another message. You can start a new conversation from Conversations."
      : undefined}
    action={retryable ? { label: "Try again", action: onRetry } : undefined} />;
}

export function threadRestoreFailure(error: unknown): "missing" | "denied" | "transient" {
  if (error instanceof CoachError) {
    if (error.status === 401 || error.status === 403) return "denied";
    if (error.status === 404 || error.status === 410) return "missing";
  }
  return "transient";
}
