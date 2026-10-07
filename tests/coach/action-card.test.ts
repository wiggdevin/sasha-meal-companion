import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  default as CoachActionCard, actionFlaggedCopy, actionMacroStrip, actionTitle, actionUndoLabel,
} from "@/components/CoachActionCard";
import type { CoachAction } from "@/lib/coach/actions";

const food = {
  name: "chicken", grams: 150,
  foodRefId: "33333333-3333-4333-8333-333333333333",
  catalogFoodRevisionId: 77,
  kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
  verdict: "allowed" as const,
};

describe("CoachActionCard copy", () => {
  it("uses the action-specific confirmation titles", () => {
    const cases: [CoachAction, string][] = [
      [{ actionId: "1", kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [food], flagged: [] }, "Logged meal 1"],
      [{ actionId: "2", kind: "add_slot_item", date: "2026-09-16", slot: "meal-2",
        item: food, flagged: [] }, "Added to meal 2"],
      [{ actionId: "3", kind: "set_slot_item", date: "2026-09-16", slot: "meal-1",
        ...food, name: "chicken", grams: 150, flagged: [] }, "Changed chicken to 150 g"],
      [{ actionId: "4", kind: "move_slot", date: "2026-09-16", slot: "meal-3",
        time: "19:30", flagged: [] }, "Moved meal 3 to 19:30"],
      [{ actionId: "5", kind: "shift_schedule", date: "2026-09-16", minutes: 30,
        scope: "remaining", flagged: [] }, "Moved remaining meals 30 min later"],
      [{ actionId: "6", kind: "log_water", ml: 480, flagged: [] }, "Logged 2 cups (16 oz) of water"],
      [{ actionId: "7", kind: "log_weight", kg: 58.1, flagged: [] }, "Weight 58.1 kg"],
      [{ actionId: "8", kind: "update_profile", birthYear: 1992, flagged: [] },
        "Profile updated"],
      [{ actionId: "9", kind: "set_targets", dayType: "training", kcal: 2300,
        flagged: [] }, "Training day 2,300 kcal"],
      [{ actionId: "10", kind: "add_to_eats", ...food, name: "salmon", flagged: [] },
        "Salmon → Eats"],
      [{ actionId: "11", kind: "remove_from_eats", ...food, name: "salmon", flagged: [] },
        "Salmon → Avoid"],
    ];
    for (const [action, title] of cases) expect(actionTitle(action)).toBe(title);
  });

  it("sums grounded per-100 g values into a compact strip", () => {
    const action: CoachAction = {
      actionId: "1", kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [food, { ...food, name: "rice", grams: 100, kcalPer100g: 130,
        proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3 }], flagged: [],
    };
    expect(actionMacroStrip(action)).toBe("378 kcal · 49g PRO · 28g CAR · 6g FAT");
  });

  it("marks blocked names and keeps Undo copy plain", () => {
    expect(actionFlaggedCopy(["milk", "apple"])).toBe("Marked off-plan: milk, apple");
    expect(actionFlaggedCopy([])).toBeNull();
    expect(actionUndoLabel()).toBe("Undo");
  });

  it("shows the applied state as Done beside Undo", () => {
    const markup = renderToStaticMarkup(createElement(CoachActionCard, {
      action: { actionId: "4", kind: "move_slot", date: "2026-09-16", slot: "meal-3",
        time: "19:30", flagged: [] },
      status: "applied", canUndo: true, onRetry: () => {}, onUndo: () => {},
    }));

    expect(markup).toContain(">Done<");
    expect(markup).toContain(">Undo<");
    expect(markup).not.toContain(">Applied<");
  });

  it("does not claim a pending action already happened", () => {
    const markup = renderToStaticMarkup(createElement(CoachActionCard, {
      action: { actionId: "4", kind: "shift_schedule", date: "2026-09-16", minutes: 30,
        scope: "remaining", flagged: [] },
      status: "pending", canUndo: false, onRetry: () => {}, onUndo: () => {},
    }));

    expect(markup).toContain("Moving remaining meals 30 min later");
    expect(markup).not.toContain("Moved remaining meals");
  });

  it.each([
    ["applied", true, "Undo", "Retry"],
    ["failed", false, "Retry", "Undo again"],
    ["failed", true, "Undo again", "Retry"],
  ] as const)("shows the right %s action when canUndo=%s", (status, canUndo, shown, hidden) => {
    const markup = renderToStaticMarkup(createElement(CoachActionCard, {
      action: { actionId: "4", kind: "move_slot", date: "2026-09-16", slot: "meal-3",
        time: "19:30", flagged: [] },
      status, canUndo, reason: status === "failed" ? "That did not save." : undefined,
      onRetry: () => {}, onUndo: () => {},
    }));
    expect(markup).toContain(`>${shown}<`);
    expect(markup).not.toContain(`>${hidden}<`);
  });

  it("offers no Undo on an applied action nothing can undo (expired or phone-only, C4)", () => {
    const markup = renderToStaticMarkup(createElement(CoachActionCard, {
      action: { actionId: "4", kind: "move_slot", date: "2026-09-16", slot: "meal-3",
        time: "19:30", flagged: [] },
      status: "applied", canUndo: false, onRetry: () => {}, onUndo: () => {},
    }));
    expect(markup).toContain(">Done<");
    expect(markup).not.toContain(">Undo<");
  });
});

/**
 * Design §8.5: `actionTitle` and `actionPendingTitle` are exhaustive switches over the action union,
 * so a client given a kind a newer server has added falls off the end and renders a blank title.
 * The default arm names the one thing every coach action has in common.
 */
describe("an action kind this build does not know", () => {
  // The envelope every action carries, with a `kind` no version of this client has a case for.
  const unknown = {
    kind: "rearrange_pantry", slot: "meal-1", actionId: "a-9", flagged: [],
  } as unknown as CoachAction;

  it("still has a title rather than an empty line", () => {
    expect(actionTitle(unknown)).toBe("Updated your plan");
  });

  it("renders that title on the card, applied and pending alike", () => {
    for (const status of ["applied", "pending"] as const) {
      const markup = renderToStaticMarkup(
        createElement(CoachActionCard, { action: unknown, status, canUndo: false,
          onRetry: () => {}, onUndo: () => {} }),
      );
      expect(markup).toContain("Updated your plan");
    }
  });

  it("leaves every known kind's title alone", () => {
    expect(actionTitle({ kind: "log_water", ml: 250 } as CoachAction))
      .toBe("Logged 1 cup (8 oz) of water");
    expect(actionTitle({ kind: "update_profile" } as CoachAction)).toBe("Profile updated");
  });
});
