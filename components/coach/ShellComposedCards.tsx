import CoachComposedCard from "@/components/CoachComposedCard";
import type { CoachShellMessage } from "@/components/coach/attachments/shell-state";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";

/** One meal's identity across the turn's `composed` list and its food_ideas block (a parsed copy). */
function mealKey(meal: ComposedMeal): string {
  return JSON.stringify([meal.wish, meal.anchorProtein ?? null,
    meal.items.map((item) => [item.foodRefId, item.grams])]);
}

/**
 * The turn's composed meals that still need the footer, each with its index in `composed` (the
 * `compose_action` cardIndex). A meal the reply already shows as a food_ideas card is skipped, so a
 * card renders once; a meal with no such block keeps its footer card. Without a block renderer
 * (`blocksShown` false) every meal stays.
 */
export function footerMeals(composed: readonly ComposedMeal[], reply: CoachShellMessage | undefined,
  blocksShown: boolean): { meal: ComposedMeal; index: number }[] {
  const shown = new Set(blocksShown ? (reply?.blocks ?? []).flatMap((block) =>
    block.kind === "food_ideas" ? block.ideas.map((idea) => mealKey(idea as ComposedMeal)) : []) : []);
  return composed.map((meal, index) => ({ meal, index })).filter(({ meal }) => !shown.has(mealKey(meal)));
}

/** The composed cards under the transcript: the latest reply's meals not already shown as a block. */
export default function ShellComposedCards({ composed, messages, blocksShown, tz, onAction }: {
  composed: readonly ComposedMeal[];
  messages: readonly CoachShellMessage[];
  blocksShown: boolean;
  tz: string;
  onAction: (action: CoachAction, cardIndex: number, messageId: string | null) => void;
}) {
  const reply = messages.findLast((message) => message.role === "assistant");
  // The reply's own composed meals are the slate every card in it shares (Phase 18 W6); no reply
  // id yet (still loading) means no signal, same as any other caller that passes no slateId.
  return <>{footerMeals(composed, reply, blocksShown).map(({ meal, index }) => <CoachComposedCard
    key={`${meal.anchorProtein ?? meal.wish}-${index}`} meal={meal} tz={tz} provenance={reply?.provenance}
    slate={composed} slateId={reply?.id ?? undefined}
    onAction={(action) => onAction(action, index, reply?.id ?? null)} />)}</>;
}
