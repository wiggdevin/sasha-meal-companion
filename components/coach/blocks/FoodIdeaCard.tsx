"use client";

import { useRef, useState } from "react";
import CoachComposedCard from "@/components/CoachComposedCard";
import type { CoachBlockContext } from "@/components/coach/blocks/context";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { FoodIdeasBlockV1 } from "@/lib/coach/ui-blocks";

/**
 * One idea, tapped at most once. Like a composed card (chat-state `compose_action`), the first tap
 * hands its action to the ledger and the card leaves the screen; the ledger's CoachActionCard under
 * this message then shows pending/applied/failed with Undo or Retry. The ref closes the window
 * before React re-renders, so a double tap cannot queue a second action with a fresh actionId.
 * `ideas` and `blockId` are the offered slate a "picked" signal reports (Phase 18 W6).
 */
export default function FoodIdeaCard({ idea, ideas, blockId, ctx }: {
  idea: FoodIdeasBlockV1["ideas"][number];
  ideas: FoodIdeasBlockV1["ideas"];
  blockId: string;
  ctx: CoachBlockContext;
}) {
  const tapped = useRef(false);
  const [spent, setSpent] = useState(false);
  if (spent) return null;
  const apply = (action: CoachAction) => {
    if (tapped.current) return;
    tapped.current = true;
    setSpent(true);
    ctx.applyAction(action);
  };
  return <CoachComposedCard meal={idea} tz={ctx.tz} onAction={apply} provenance={ctx.provenance}
    slate={ideas as unknown as ComposedMeal[]} slateId={blockId} />;
}
