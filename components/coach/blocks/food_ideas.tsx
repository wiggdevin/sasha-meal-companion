"use client";

import type { CoachBlockContext } from "@/components/coach/blocks/context";
import FoodIdeaCard from "@/components/coach/blocks/FoodIdeaCard";
import type { FoodIdeasBlockV1 } from "@/lib/coach/ui-blocks";

/** The saved meal ideas, one tap-once card each (FoodIdeaCard). */
export default function FoodIdeasBlock({ block, ctx }: {
  block: FoodIdeasBlockV1;
  ctx: CoachBlockContext;
}) {
  return <div className="flex flex-col gap-3">
    <p className="ground-muted m-0 text-sm">These saved meal ideas may lack a complete method or ingredient list.</p>
    <button type="button" className="tap self-start text-sm underline" onClick={() => ctx.sendText("Find a complete recipe")}>Find a recipe</button>
    {block.ideas.map((idea, index) => <FoodIdeaCard
      key={`${idea.anchorProtein ?? idea.wish}-${index}`}
      idea={idea}
      ideas={block.ideas}
      blockId={block.id}
      ctx={ctx}
    />)}
  </div>;
}
