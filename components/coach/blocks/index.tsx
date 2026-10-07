import type { ReactElement } from "react";
import ChartBlock from "@/components/coach/blocks/chart";
import DietaryProfileProposalBlock from "@/components/coach/blocks/dietary_profile";
import FoodIdeasBlock from "@/components/coach/blocks/food_ideas";
import FoodSearchBlock from "@/components/coach/blocks/food_search";
import RecipeResultsBlock from "@/components/coach/blocks/recipe_results";
import LogDraftBlock from "@/components/coach/blocks/log_draft";
import NextActionChipBlock from "@/components/coach/blocks/next_action_chip";
import QuickRepliesBlock from "@/components/coach/blocks/quick_replies";
import UiTreeBlock from "@/components/coach/blocks/ui";
import { invalidV1Identity } from "@/components/coach/blocks/identity";
import type { CoachBlockContext } from "@/components/coach/blocks/context";
import { uiBlockSchema, type UiBlock } from "@/lib/coach/ui-blocks";
export { BLOCK_KINDS } from "@/components/coach/blocks/identity";

export function renderBlock(block: UiBlock | unknown, ctx: CoachBlockContext): ReactElement | null {
  const parsed = uiBlockSchema.safeParse(block);
  if (!parsed.success) {
    const identity = invalidV1Identity(block);
    if (identity) console.warn(`Invalid coach block ${JSON.stringify(identity)}`);
    return null;
  }
  const valid = parsed.data;
  if (valid.kind === "log_draft") return <LogDraftBlock key={valid.id} block={valid} ctx={ctx} />;
  if (valid.kind === "chart") return <ChartBlock key={valid.id} block={valid} />;
  if (valid.kind === "quick_replies") return <QuickRepliesBlock key={valid.id} block={valid} ctx={ctx} />;
  if (valid.kind === "food_search") return <FoodSearchBlock key={valid.id} block={valid} ctx={ctx} />;
  if (valid.kind === "recipe_results") return <RecipeResultsBlock key={valid.id}
    blockId={valid.id} recipes={valid.recipes} limitations={valid.limitations} exactMatch={valid.exactMatch} />;
  if (valid.kind === "ui") return <UiTreeBlock key={valid.id} block={valid} ctx={ctx} />;
  if (valid.kind === "dietary_profile_proposal") return <DietaryProfileProposalBlock key={valid.id} block={valid} />;
  if (valid.kind === "next_action_chip") return <NextActionChipBlock key={valid.id} block={valid} ctx={ctx} />;
  return <FoodIdeasBlock key={valid.id} block={valid} ctx={ctx} />;
}
export type { LogDraftBlockV1, UiBlock } from "@/lib/coach/ui-blocks";
export type {
  CoachBlockContext, FoodBlockRef, LogDraftBlockContext, LogDraftCommit,
} from "@/components/coach/blocks/context";
