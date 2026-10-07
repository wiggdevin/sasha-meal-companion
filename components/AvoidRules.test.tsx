// @vitest-environment jsdom
/**
 * D1 §6.2. Avoids renders the ACCOUNT's own `constraint_profiles` row. Until this run it rendered
 * a fixed list from lib/reference.ts and let the server switch each row on or off, so a fresh
 * account opened Foods > Avoids and read three locked allergens and five "off the plan" rules
 * that belonged to somebody else. The cases below are the four states that matters splits into:
 * empty, populated, cold (profile not loaded) and offline.
 *
 * renderToStaticMarkup runs no effects, which is what `initial` is for: a whole profile with no
 * fetch. The picker's interactions live in tests/constraints/avoid-rules-picker.test.tsx.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const constraints = vi.hoisted(() => ({
  load: vi.fn(async () => null as { profile: unknown; rev: number } | null),
  save: vi.fn(async (..._args: unknown[]): Promise<unknown> =>
    ({ status: "error" as const, message: "Could not save." })),
}));

vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: constraints.load,
  saveConstraints: constraints.save,
}));

import AvoidRules, { isRuleListEmpty } from "./AvoidRules";
import type { Profile } from "@/lib/constraints-client";
import { ALLERGEN_LABELS, CATEGORY_LABELS } from "@/lib/reference";

const EMPTY: Profile = {
  avoid_allergens: [],
  avoid_food_ref_ids: [],
  banned_categories: [],
  conditions: [],
  notes: null,
};

const POPULATED: Profile = {
  ...EMPTY,
  avoid_allergens: ["gluten", "soy"],
  banned_categories: ["simple_sugars"],
  conditions: ["ulcerative colitis"],
};

const empty = renderToStaticMarkup(<AvoidRules initial={EMPTY} />);
const populated = renderToStaticMarkup(<AvoidRules initial={POPULATED} />);
const cold = renderToStaticMarkup(<AvoidRules />);

/** The opening tag of the control labelled `label`, or carrying `label` as its text. */
function control(markup: string, label: string): string {
  // A `Button` wraps its words in label spans, so the words are found up to their next tag.
  const at = markup.includes(`aria-label="${label}"`)
    ? markup.indexOf(`aria-label="${label}"`)
    : markup.indexOf(`>${label}<`);
  expect(at, label).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<button", at), markup.indexOf(">", at) + 1);
}

describe("AvoidRules for an account with no rules", () => {
  it("says so plainly and offers one way to add one", () => {
    expect(isRuleListEmpty(EMPTY)).toBe(true);
    expect(empty).toContain("No food rules yet");
    // The shared Button at its 44 px size (2026-10-04 button system).
    expect(control(empty, "Add a rule")).toContain("btn-md");
  });

  it("invents no rule of its own", () => {
    for (const key of Object.keys(ALLERGEN_LABELS)) {
      expect(empty, key).not.toContain(`Remove ${ALLERGEN_LABELS[key].label}`);
    }
    for (const [key, rule] of Object.entries(CATEGORY_LABELS)) {
      expect(empty, key).not.toContain(`Remove ${rule.label}`);
    }
    expect(empty).not.toContain("Allergens</h2>");
    expect(empty).not.toContain("Off the plan</h2>");
  });
});

describe("AvoidRules with a populated profile", () => {
  it("renders each rule the account added, with the generic help line under it", () => {
    expect(isRuleListEmpty(POPULATED)).toBe(false);
    for (const key of ["gluten", "soy"]) {
      expect(populated, key).toContain(ALLERGEN_LABELS[key].label);
      expect(populated, key).toContain(ALLERGEN_LABELS[key].help);
    }
    expect(populated).toContain(CATEGORY_LABELS.simple_sugars.label);
    expect(populated).toContain(CATEGORY_LABELS.simple_sugars.help);
    expect(populated).toContain("ulcerative colitis");
  });

  it("renders no rule the account did not add", () => {
    expect(populated).not.toContain(ALLERGEN_LABELS.dairy.help);
    expect(populated).not.toContain(CATEGORY_LABELS.onion_garlic.help);
  });

  it("locks nothing — every rule can be taken off, including a former floor allergen", () => {
    expect(control(populated, "Remove Gluten")).not.toContain('disabled=""');
    expect(control(populated, "Remove Simple sugars")).not.toContain('disabled=""');
    expect(control(populated, "Remove Gluten")).toContain("min-h-11");
  });

  it("says nothing about a connection when there is nothing wrong", () => {
    expect(populated).not.toContain("Needs a connection to change.");
    expect(populated).not.toContain("Could not load your rules.");
  });
});

describe("AvoidRules before the profile arrives", () => {
  it("does not claim the account has no rules and offers no control it cannot honour", () => {
    expect(isRuleListEmpty(null)).toBe(true);
    expect(cold).not.toContain("No food rules yet");
    expect(cold).toContain("Checking your rules…");
    expect(control(cold, "Add a rule")).toContain('disabled=""');
  });
});

/**
 * Grok pass 1 on T2, FIX 3. A failed ONLINE load left the card saying "Checking your rules…" with
 * "Add a rule" disabled and no way forward: the only sign of the failure was a caption under the
 * whole list. A failure is a state of its own — it says so in the card body and offers the one
 * control that can help.
 */
describe("AvoidRules after the profile fails to load", () => {
  const LOADED: Profile = { ...EMPTY, avoid_allergens: ["soy"] };

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    constraints.load.mockReset();
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
      .find((node) => node.textContent?.trim() === label);
    expect(button, label).toBeTruthy();
    button?.click();
  }

  it("says the load failed instead of still checking, and retries on demand", async () => {
    constraints.load.mockResolvedValueOnce(null);
    await act(async () => { root.render(<AvoidRules />); });

    expect(container.textContent).not.toContain("Checking your rules…");
    expect(container.textContent).toContain("Could not load your rules.");
    expect(container.textContent).not.toContain("No food rules yet");

    constraints.load.mockResolvedValueOnce({ profile: LOADED, rev: 3 });
    await act(async () => { press("Retry"); });

    expect(constraints.load).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Could not load your rules.");
    expect(container.textContent).toContain(ALLERGEN_LABELS.soy.label);
  });
});

/**
 * FluidVoice A05: Avoids keeps the user's own avoid list first, in every state of the rules
 * profile — before the add-rule control, the rule cards, custom rules and Conditions.
 */
describe("Avoids hierarchy", () => {
  const LIST = '<section data-avoid-list="">';
  const list = <section data-avoid-list="" />;

  it.each([
    ["before the profile arrives", undefined],
    ["with no rules", EMPTY],
    ["with rules", POPULATED],
  ] as const)("renders the avoid list first %s", (_state, initial) => {
    const markup = renderToStaticMarkup(<AvoidRules initial={initial}>{list}</AvoidRules>);
    const at = markup.indexOf(LIST);
    expect(at).toBeGreaterThan(-1);
    for (const later of ["Food rules", "Add a rule", "Allergens", "Custom rules", "Conditions"]) {
      const next = markup.indexOf(later);
      if (next > -1) expect(at, later).toBeLessThan(next);
    }
  });
});

/**
 * FluidVoice A11: Conditions owns its feedback. A custom-rule save must never light the Conditions
 * control, and a Conditions save lights only its own.
 */
describe("Conditions feedback", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const RULES: Profile = { ...EMPTY, conditions: ["ulcerative colitis"] };

  beforeEach(() => {
    constraints.save.mockReset();
    constraints.save.mockImplementation(async (...args: unknown[]) => {
      const patch = args[0] as { customRules?: unknown; conditions?: string[] };
      return { status: "ok", rev: 2, profile: { ...RULES,
        ...(patch.customRules ? { custom_rules: patch.customRules } : {}),
        ...(patch.conditions ? { conditions: patch.conditions } : {}) } };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const byLabel = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const buttonNamed = (text: string) => [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === text)!;
  function type(input: HTMLElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("does not light Conditions when a custom rule saves", async () => {
    await act(async () => { root.render(<AvoidRules initial={RULES} />); });
    await act(async () => { type(byLabel("Custom food rule"), "garlic"); });
    await act(async () => { buttonNamed("Add rule").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("garlic");
    expect(byLabel("Save conditions").getAttribute("data-feedback-state")).toBeNull();
    expect(byLabel("Save conditions").getAttribute("aria-busy")).toBeNull();
  });

  it("lights Conditions when Conditions saves", async () => {
    await act(async () => { root.render(<AvoidRules initial={RULES} />); });
    await act(async () => { type(byLabel("Conditions, separated by commas"), "ulcerative colitis, reflux"); });
    await act(async () => { byLabel("Save conditions").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(1);
    expect(constraints.save.mock.calls[0][0]).toMatchObject(
      { conditions: ["ulcerative colitis", "reflux"] });
    expect(byLabel("Save conditions").getAttribute("data-feedback-state")).toBe("success");
  });
});

/**
 * An exclusion matches only the whole saved text (lib/policy/custom-rules.ts matchesRule), so a
 * phrase saved as one blocks nothing. The same literal-name guard onboarding's composer applies.
 */
describe("Custom rule literal-name guard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    constraints.save.mockReset();
    constraints.save.mockImplementation(async (...args: unknown[]) => {
      const patch = args[0] as { customRules?: unknown };
      return { status: "ok", rev: 2, profile: { ...EMPTY, custom_rules: patch.customRules } };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  function type(value: string) {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Custom food rule"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const buttonNamed = (text: string) => [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === text)!;

  it.each(["allergic to garlic", "I can't eat garlic", "garlic makes me sick today"])(
    "refuses %j as an ingredient exclusion", async (text) => {
      await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
      await act(async () => { buttonNamed("ingredient").click(); });
      await act(async () => { type(text); });
      await act(async () => { buttonNamed("Add rule").click(); });
      expect(constraints.save).not.toHaveBeenCalled();
      expect(container.textContent).toContain("literal ingredient or cuisine name");
    });

  it("still saves a bare name as an exclusion, and a phrase as guidance", async () => {
    await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
    await act(async () => { buttonNamed("ingredient").click(); });
    await act(async () => { type("garlic"); });
    await act(async () => { buttonNamed("Add rule").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(1);
    await act(async () => { buttonNamed("Guidance only").click(); });
    await act(async () => { type("allergic to garlic"); });
    await act(async () => { buttonNamed("Add rule").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(2);
  });
});

describe("Custom rule literal-name guard, longer names and editing", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const OLIVE = { id: "11111111-1111-4111-8111-111111111111", kind: "ingredient" as const, text: "extra virgin olive oil" };

  beforeEach(() => {
    constraints.save.mockReset();
    constraints.save.mockImplementation(async (...args: unknown[]) => {
      const patch = args[0] as { customRules?: unknown };
      return { status: "ok", rev: 2, profile: { ...EMPTY, custom_rules: patch.customRules } };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const buttonNamed = (text: string) => [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === text)!;

  it("re-saves an existing multi-word ingredient rule from Edit", async () => {
    await act(async () => { root.render(<AvoidRules initial={{ ...EMPTY, custom_rules: [OLIVE] }} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Edit extra virgin olive oil"]')!.click(); });
    await act(async () => { buttonNamed("Save rule").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(1);
  });

  it("saves a list as guidance only", async () => {
    await act(async () => { root.render(<AvoidRules initial={EMPTY} />); });
    const input = container.querySelector<HTMLInputElement>('[aria-label="Custom food rule"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "garlic, onion");
    await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { buttonNamed("cuisine").click(); });
    await act(async () => { buttonNamed("Add rule").click(); });
    expect(constraints.save).not.toHaveBeenCalled();
    await act(async () => { buttonNamed("Guidance only").click(); });
    await act(async () => { buttonNamed("Add rule").click(); });
    expect(constraints.save).toHaveBeenCalledTimes(1);
  });
});
