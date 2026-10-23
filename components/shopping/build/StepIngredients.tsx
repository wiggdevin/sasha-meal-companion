"use client";

import type { Dispatch } from "react";
import RuleMark from "@/components/ui/RuleMark";
import Tag from "@/components/ui/Tag";
import { sourceLabel } from "@/lib/shopping/build-candidates";
import { deckCounter, deckDone, yesIngredients, type BuildAction, type BuildState } from "@/lib/shopping/build-flow";
import YesNoDeck from "./YesNoDeck";
import Button from "@/components/ui/Button";

/**
 * Step 2, Ingredients (UI makeover §7.3): the account's own foods, one card each. The order line
 * says who ordered them: "AI ranked" only when Jev actually ranked the deck, else "In your usual
 * order". Foods a rule blocks are never shown; the count of them is.
 */
export default function StepIngredients({ state, dispatch }: { state: BuildState; dispatch: Dispatch<BuildAction> }) {
  const deck = state.ingredients;
  if (deck.status === "loading") return <p role="status" className="m-0 text-caption text-muted">Finding your foods…</p>;
  const card = deck.cards[deck.index];
  const ranked = deck.provenance.ai;
  const leftOut = deck.leftOutByRules > 0
    ? <p className="m-0 text-caption text-muted">{deck.leftOutByRules} left out by your food rules</p> : null;
  const yes = yesIngredients(state).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-body font-semibold text-charcoal">Foods for your list</h3>
        {ranked
          ? <Tag tone="neutral" data-ai-label="jev"><span aria-hidden="true">AI ranked</span><span className="sr-only">Ranked by AI</span></Tag>
          : <span className="text-caption text-muted">In your usual order</span>}
      </div>
      {leftOut}
      {deck.cards.length === 0 ? (
        <p className="m-0 text-body text-muted">No foods to offer yet. Favorite a few foods, or go on to meals.</p>
      ) : (
        <YesNoDeck label="Foods for your list" name={card?.name ?? ""} counter={deckCounter(deck)}
          finished={deckDone(deck)} title={card?.name}
          meta={card ? sourceLabel(card) : undefined}
          detail={card?.ruleMark ? <RuleMark mark={card.ruleMark} /> : undefined}
          onYes={() => dispatch({ type: "answer", answer: "yes" })}
          onNo={() => dispatch({ type: "answer", answer: "no" })}
          onYesToRest={() => dispatch({ type: "yes-to-rest" })}
          done={<p className="m-0 text-body text-charcoal">{yes} of {deck.cards.length} foods on your list.</p>} />
      )}
      {(deckDone(deck)) && (
        <Button variant="primary" className="self-start" onClick={() => dispatch({ type: "next" })}>Next: meals</Button>
      )}
    </div>
  );
}
