/**
 * T9 §1 moved the two calorie steppers into components/settings/CaloriesCard.tsx. The markup
 * snapshot proves the move changed nothing you can see; this proves it changed nothing you can
 * tap — the card still wires the ± buttons to the page's setters, at the 50 kcal step.
 *
 * React Testing Library is not installed (see tests/today/day-type-toggle.test.tsx), so the tree
 * is walked rather than mounted: a function component is called, its result recursed into, and
 * the button found by the accessible name Stepper gives it. No DOM, no act(), no snapshot.
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import CaloriesCard from "@/components/settings/CaloriesCard";

type Node = ReactElement<Record<string, unknown>> | Node[] | string | number | null | undefined;

/** The first button whose aria-label matches, with function components called on the way down. */
function findButton(node: Node, ariaLabel: string): { onClick: () => void } | null {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, ariaLabel);
      if (hit) return hit;
    }
    return null;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    const render = element.type as (props: Record<string, unknown>) => Node;
    return findButton(render(element.props), ariaLabel);
  }
  if (element.type === "button" && element.props["aria-label"] === ariaLabel) {
    return { onClick: element.props.onClick as () => void };
  }
  return findButton(element.props.children as Node, ariaLabel);
}

function card(over: Partial<Parameters<typeof CaloriesCard>[0]> = {}) {
  const onTrainingChange = vi.fn();
  const onRestChange = vi.fn();
  const tree = CaloriesCard({
    trainingKcal: 2400, restKcal: 2000,
    trainingCaption: null, restCaption: null, trainingAlert: null, restAlert: null,
    onTrainingChange, onRestChange, ...over,
  });
  return { tree: tree as Node, onTrainingChange, onRestChange };
}

describe("CaloriesCard", () => {
  it("steps the training steppers up by 50", () => {
    const { tree, onTrainingChange, onRestChange } = card();
    findButton(tree, "Increase Training day calories")?.onClick();
    expect(onTrainingChange).toHaveBeenCalledWith(2450);
    expect(onRestChange).not.toHaveBeenCalled();
  });

  it("steps the training steppers down by 50", () => {
    const { tree, onTrainingChange } = card();
    findButton(tree, "Decrease Training day calories")?.onClick();
    expect(onTrainingChange).toHaveBeenCalledWith(2350);
  });

  it("wires the rest stepper to its own setter", () => {
    const { tree, onTrainingChange, onRestChange } = card();
    findButton(tree, "Increase Rest day calories")?.onClick();
    expect(onRestChange).toHaveBeenCalledWith(2050);
    expect(onTrainingChange).not.toHaveBeenCalled();
  });
});
