// @vitest-environment jsdom
/**
 * Phase 13 slice 4 (§4 onboarding capture): the pure, presentational picker. No account, no
 * network — the container (components/Onboarding/DietaryProfilePicker.tsx's default export owns
 * the fetch) passes catalog/instances/callbacks in.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DietaryProfilePickerView } from "@/components/Onboarding/DietaryProfilePicker";
import type { ProfileSummary } from "@/lib/policy/profiles/catalog-summary";
import type { ProfileInstance } from "@/lib/policy/profiles/types";

afterEach(cleanup);

const VEGAN: ProfileSummary = {
  id: "vegan", label: "Vegan", category: "ethical_lifestyle",
  synonyms: ["vegan", "plant-based (strict)"],
  do: ["Offer plant-based proteins."], dont: ["Treat honey as vegan."],
  hardBasis: "user_rule", requiresUserConfirmation: false, options: [],
  items: [{ facet: "contains_animal_product", strength: "never", hardBasis: "user_rule" }],
};

const G6PD: ProfileSummary = {
  id: "g6pd_deficiency", label: "G6PD deficiency", category: "medical_condition",
  synonyms: ["G6PD deficiency", "favism"],
  do: ["Ask before adding fava beans."], dont: ["Assume fava is safe."],
  hardBasis: "user_confirmed_safety", requiresUserConfirmation: true, options: [],
  items: [
    { facet: "fava_bean", strength: "never", hardBasis: "user_confirmed_safety" },
    { facet: "protein_dense", strength: "prefer", hardBasis: null },
  ],
};

/** Item-level confirmation (requires_user_confirmation: true, map §4.6): three hard religious
 *  rules and no do/dont copy, so a blanket tap would confirm rules the user never saw. */
const HALAL: ProfileSummary = {
  id: "halal", label: "Halal", category: "religious_cultural", synonyms: ["halal"],
  do: [], dont: [], hardBasis: "religious", requiresUserConfirmation: true,
  options: [
    { id: "zabiha_meat_only", label: "Meat must be halal-slaughtered", default: true },
    { id: "no_carmine", label: "Avoid carmine and insect ingredients", default: false },
  ],
  items: [
    { facet: "pork", strength: "never", hardBasis: "religious" },
    { facet: "alcohol", strength: "never", hardBasis: "religious" },
    { facet: "blood_product", strength: "never", hardBasis: "religious" },
  ],
};

const PESCATARIAN_PLUS: ProfileSummary = {
  id: "pescatarian", label: "Pescatarian", category: "ethical_lifestyle", synonyms: ["pescatarian"],
  do: [], dont: [], hardBasis: "user_rule", requiresUserConfirmation: true, options: [],
  items: [
    { facet: "meat", strength: "never", hardBasis: "user_rule" },
    { facet: "fish_seafood", strength: "prefer", hardBasis: "user_rule" },
  ],
};

const CATALOG = [VEGAN, G6PD, HALAL, PESCATARIAN_PLUS];

function view(props: Partial<React.ComponentProps<typeof DietaryProfilePickerView>> = {}) {
  return render(<DietaryProfilePickerView
    catalog={CATALOG} instances={[]} query="" busyId={null}
    onQueryChange={() => {}} onConfirm={() => {}} onRemove={() => {}}
    {...props}
  />);
}

describe("DietaryProfilePickerView", () => {
  it("shows nothing to search short of two characters, so a fresh screen is not a 124-row dump", () => {
    view({ query: "v" });
    expect(screen.queryByText("Vegan")).toBeNull();
  });

  it("matches on label and shows the catalog's own plain-language do/dont copy", () => {
    view({ query: "vegan" });
    expect(screen.getByText("Vegan")).toBeTruthy();
    expect(screen.getByText("Do: Offer plant-based proteins.")).toBeTruthy();
    expect(screen.getByText(/Treat honey as vegan\./)).toBeTruthy();
  });

  it("matches on a synonym the label does not contain", () => {
    view({ query: "favism" });
    expect(screen.getByText("G6PD deficiency")).toBeTruthy();
  });

  it("a non-medical match's add action confirms exactly its own non-medical items", () => {
    const onConfirm = vi.fn();
    view({ query: "vegan", onConfirm });
    fireEvent.click(screen.getByText("Add to my profile"));
    expect(onConfirm).toHaveBeenCalledWith("vegan", [
      { facet: "contains_animal_product", confirmed: true },
    ]);
  });

  it("a medical item's own confirm sends only that one facet, never bundled into the blanket add", () => {
    const onConfirm = vi.fn();
    view({ query: "g6pd", onConfirm });
    expect(screen.getByText(/Your clinician.s advice comes first/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledWith("g6pd_deficiency", [
      { facet: "fava_bean", confirmed: true },
    ]);
  });

  it("the blanket add for a profile with a medical item confirms only its non-medical items", () => {
    const onConfirm = vi.fn();
    view({ query: "g6pd", onConfirm });
    fireEvent.click(screen.getByText("Add to my profile"));
    expect(onConfirm).toHaveBeenCalledWith("g6pd_deficiency", [
      { facet: "protein_dense", confirmed: true },
    ]);
  });

  it("an item-level profile offers no blanket add: every hard rule is shown and tapped alone", () => {
    const onConfirm = vi.fn();
    view({ query: "halal", onConfirm });
    expect(screen.queryByText("Add to my profile")).toBeNull();
    for (const label of ["pork", "alcohol", "blood product"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Confirm alcohol" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("halal", [{ facet: "alcohol", confirmed: true }]);
  });

  it("an item-level profile's blanket add confirms only its soft items, never a hard rule", () => {
    const onConfirm = vi.fn();
    view({ query: "pescatarian", onConfirm });
    fireEvent.click(screen.getByText("Add to my profile"));
    expect(onConfirm).toHaveBeenCalledWith("pescatarian", [
      { facet: "fish_seafood", confirmed: true },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm meat" }));
    expect(onConfirm).toHaveBeenLastCalledWith("pescatarian", [{ facet: "meat", confirmed: true }]);
  });

  it("an added profile offers its yes/no variants; a tap sends only the flipped choice", () => {
    const onConfirm = vi.fn();
    const instance: ProfileInstance = {
      profileId: "halal", source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      rules: [], options: { zabiha_meat_only: true },
    };
    view({ query: "halal", instances: [instance], onConfirm });
    expect(screen.getByRole("button",
      { name: "Meat must be halal-slaughtered", pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button",
      { name: "Avoid carmine and insect ingredients", pressed: false }));
    expect(onConfirm).toHaveBeenCalledWith("halal", [], { no_carmine: true });
  });

  it("an already-added profile shows Added with a way to remove it, not the add action again", () => {
    const instance: ProfileInstance = {
      profileId: "vegan", source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      rules: [], options: {},
    };
    view({ query: "vegan", instances: [instance] });
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.queryByText("Add to my profile")).toBeNull();
  });

  it("a profile a legacy preference flag keeps active points there instead of offering Remove", () => {
    const instance: ProfileInstance = {
      profileId: "vegan", source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      rules: [], options: {},
    };
    view({ query: "vegan", instances: [instance], legacyProfileIds: ["vegan"] });
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.getByText("Set in your preferences")).toBeTruthy();
  });

  it("removing an added profile calls back with its id", () => {
    const onRemove = vi.fn();
    const instance: ProfileInstance = {
      profileId: "vegan", source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      rules: [], options: {},
    };
    view({ query: "vegan", instances: [instance], onRemove });
    fireEvent.click(screen.getByText("Remove"));
    expect(onRemove).toHaveBeenCalledWith("vegan");
  });
});

describe("DietaryProfilePickerView custom rule fallback", () => {
  it("says so when no profile matches and offers the typed text as the rule, still on this step", () => {
    view({ query: "garlic", onAddCustomRule: async () => true });
    expect(screen.getByText(/No profile matches “garlic”/)).toBeTruthy();
    expect((screen.getByLabelText("Custom food rule") as HTMLInputElement).value).toBe("garlic");
  });

  it("does not claim a miss while a profile matches", () => {
    view({ query: "vegan", onAddCustomRule: async () => true });
    expect(screen.queryByText(/No profile matches/)).toBeNull();
  });

  it("saves an ingredient rule that blocks, and clears the box once it saved", async () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "garlic", onAddCustomRule });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).toHaveBeenCalledWith({ kind: "ingredient", text: "garlic" });
    await waitFor(() => expect((screen.getByLabelText("Custom food rule") as HTMLInputElement).value).toBe(""));
  });

  it("guidance is labelled as not blocking foods, and saves as guidance", () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "garlic", onAddCustomRule });
    expect(screen.getByText(/Guidance only does not block foods/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Guidance only" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).toHaveBeenCalledWith({ kind: "guidance", text: "garlic" });
  });

  it("refuses a sentence as a blocking rule instead of saving a rule that never matches", () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "avoid garlic", onAddCustomRule });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).not.toHaveBeenCalled();
    expect(screen.getByText(/literal ingredient or cuisine name/)).toBeTruthy();
  });

  it("keeps the typed text and says so when the save fails", async () => {
    view({ query: "garlic", onAddCustomRule: async () => false });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.getByText(/did not save/)).toBeTruthy());
    expect((screen.getByLabelText("Custom food rule") as HTMLInputElement).value).toBe("garlic");
  });

  it("lists rules already added and is absent when the container gives no save path", () => {
    view({ query: "garlic", customRules: [{ id: "a", kind: "ingredient", text: "onion" }],
      onAddCustomRule: async () => true });
    expect(screen.getByText(/onion/)).toBeTruthy();
    cleanup();
    view({ query: "garlic" });
    expect(screen.queryByLabelText("Custom food rule")).toBeNull();
  });
});

describe("DietaryProfilePickerView custom rule review fixes", () => {
  it("refuses a phrase as a blocking rule, since the matcher needs the bare food name", () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "allergic to garlic", onAddCustomRule });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).not.toHaveBeenCalled();
    expect(screen.getByText(/literal ingredient or cuisine name/)).toBeTruthy();
  });

  it("never claims a miss, or pre-fills the miss, before the catalog has loaded", () => {
    view({ catalog: [], catalogReady: false, query: "peanut allergy", onAddCustomRule: async () => true });
    expect(screen.queryByText(/No profile matches/)).toBeNull();
    expect((screen.getByLabelText("Custom food rule") as HTMLInputElement).value).toBe("");
  });

  it("at the 30-rule cap, says so and disables the add instead of failing on every tap", () => {
    const rules = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, kind: "ingredient" as const, text: `food ${i}` }));
    view({ query: "garlic", customRules: rules, onAddCustomRule: async () => true });
    expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/30 custom rules/)).toBeTruthy();
  });

  it("pre-fills at most 80 characters, the most a rule can hold", () => {
    view({ query: "x".repeat(120), onAddCustomRule: async () => true });
    expect((screen.getByLabelText("Custom food rule") as HTMLInputElement).value).toHaveLength(80);
  });

  it("uses native radios for the rule type", () => {
    view({ query: "garlic", onAddCustomRule: async () => true });
    expect((screen.getByRole("radio", { name: "ingredient" }) as HTMLInputElement).type).toBe("radio");
  });
});

describe("DietaryProfilePickerView custom rule names", () => {
  it("saves a long literal name as an ingredient exclusion", () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "extra virgin olive oil", onAddCustomRule });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).toHaveBeenCalledWith({ kind: "ingredient", text: "extra virgin olive oil" });
  });

  it("refuses a list as an exclusion", () => {
    const onAddCustomRule = vi.fn(async () => true);
    view({ query: "garlic, onion", onAddCustomRule });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onAddCustomRule).not.toHaveBeenCalled();
  });
});
