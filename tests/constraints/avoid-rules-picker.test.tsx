// @vitest-environment jsdom
/**
 * D1 §6.2: adding a rule is the only way a rule appears. This drives the picker for real, because
 * the point of the change is that nothing is preselected — a markup snapshot of a card that is
 * closed by default cannot show that.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ calls: [] as { patch: unknown; rev: number }[] }));

vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: vi.fn(async () => null),
  saveConstraints: vi.fn(async (patch: unknown, rev: number) => {
    saved.calls.push({ patch, rev });
    return {
      status: "ok" as const,
      profile: {
        avoid_allergens: (patch as { avoidAllergens?: string[] }).avoidAllergens ?? [],
        avoid_food_ref_ids: [],
        banned_categories: (patch as { bannedCategories?: string[] }).bannedCategories ?? [],
        conditions: [],
        notes: null,
      },
      rev: rev + 1,
    };
  }),
}));

import AvoidRules from "@/components/AvoidRules";
import { ALLERGEN_KEYS, ALLERGEN_LABELS, CATEGORY_LABELS } from "@/lib/reference";

const EMPTY = {
  avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
  conditions: [], notes: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  saved.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function press(label: string): void {
  const button = [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === label
      || node.getAttribute("aria-label") === label);
  expect(button, label).toBeTruthy();
  button?.click();
}

describe("adding the first rule", () => {
  it("opens a picker with nothing preselected", async () => {
    await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
    expect(container.textContent).toContain("No food rules yet");

    await act(async () => { press("Add a rule"); });

    for (const key of ALLERGEN_KEYS) {
      expect(container.textContent, ALLERGEN_LABELS[key].label).toContain(ALLERGEN_LABELS[key].label);
    }
    // A retired key keeps its label for stored rows but is never offered (2026-09-22).
    expect(container.textContent).not.toContain(ALLERGEN_LABELS.apple.label);
    for (const rule of Object.values(CATEGORY_LABELS)) {
      expect(container.textContent, rule.label).toContain(rule.label);
    }
    expect([...container.querySelectorAll("[aria-pressed='true']")]).toHaveLength(0);
  });

  it("sends only the key that was pressed", async () => {
    await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
    await act(async () => { press("Add a rule"); });
    await act(async () => { press(ALLERGEN_LABELS.shellfish.label); });

    expect(saved.calls).toEqual([{ patch: { baseRev: 0, avoidAllergens: ["shellfish"] }, rev: 0 }]);
    // The pressed chip confirms in place (2026-10-04 UI pass: no success toast for a control that stays).
    const chip = [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.trim() === ALLERGEN_LABELS.shellfish.label);
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("lists the rule afterwards with a control that takes it back off", async () => {
    await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
    await act(async () => { press("Add a rule"); });
    await act(async () => { press(CATEGORY_LABELS.onion_garlic.label); });
    await act(async () => { press("Done"); });

    expect(container.textContent).not.toContain("No food rules yet");
    expect(container.textContent).toContain(CATEGORY_LABELS.onion_garlic.help);

    await act(async () => { press(`Remove ${CATEGORY_LABELS.onion_garlic.label}`); });
    expect(saved.calls.at(-1)).toEqual({ patch: { baseRev: 1, bannedCategories: [] }, rev: 1 });
    expect(container.textContent).toContain("No food rules yet");
  });
});
