// @vitest-environment jsdom
/**
 * Sol review S4 (2026-10-04): a card with nothing planned has no footer, so closing the Plan or Log
 * flow inside it used to drop focus to the page. It goes back to the control that opened the flow.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import SlotCard from "./SlotCard";
import type { ResolvedSlot } from "@/lib/types";

afterEach(cleanup);

const empty: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Meal 2", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};

function Card({ variant, flow }: { variant: "focus" | "standard"; flow: boolean }) {
  return <MotionConfig reducedMotion="always">
    <SlotCard slot={empty} variant={variant} canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}}
      attachment={flow ? <button type="button">Inside the flow</button> : undefined} />
  </MotionConfig>;
}

describe("an empty meal card's flow hands focus back", () => {
  it("returns focus to Plan when the flow it opened closes", () => {
    const { rerender } = render(<Card variant="standard" flow={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    rerender(<Card variant="standard" flow />);
    screen.getByRole("button", { name: "Inside the flow" }).focus();
    rerender(<Card variant="standard" flow={false} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Plan" }));
  });

  it("returns focus to Log what you ate when that opened the flow", () => {
    const { rerender } = render(<Card variant="focus" flow={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Log what you ate" }));
    rerender(<Card variant="focus" flow />);
    screen.getByRole("button", { name: "Inside the flow" }).focus();
    rerender(<Card variant="focus" flow={false} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Log what you ate" }));
  });

  it("leaves focus alone when it had already moved elsewhere on the page", () => {
    const { rerender } = render(<><input aria-label="Elsewhere" /><Card variant="focus" flow={false} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Plan with the coach" }));
    rerender(<><input aria-label="Elsewhere" /><Card variant="focus" flow /></>);
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<><input aria-label="Elsewhere" /><Card variant="focus" flow={false} /></>);
    expect(document.activeElement).toBe(elsewhere);
  });
});
