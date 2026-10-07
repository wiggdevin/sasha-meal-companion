// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DietBadge from "@/components/nutrition/DietBadge";
import RecipeFacets from "@/components/nutrition/RecipeFacets";
import { MacroDonut, MacroGauge, TargetMeter } from "@/components/nutrition/charts";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import { MACRO_SPEC, energySplit, spokenMacro } from "@/components/nutrition/spec";
import { recipeDietFacts } from "@/lib/recipes-hub/diet";

afterEach(cleanup);

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
const serving = { kcal: 508, protein: 51, carbs: 44, fat: 13 };

describe("the macro table", () => {
  it("names and colours each nutrient one way: persimmon, plum, sage, Dijon; PRO, CAR, FAT", () => {
    expect([MACRO_SPEC.kcal.ink, MACRO_SPEC.protein.ink, MACRO_SPEC.carbs.ink, MACRO_SPEC.fat.ink])
      .toEqual(["kcal", "macro-ink-protein", "macro-ink-carbs", "macro-ink-fat"]);
    expect([MACRO_SPEC.protein.abbr, MACRO_SPEC.carbs.abbr, MACRO_SPEC.fat.abbr]).toEqual(["PRO", "CAR", "FAT"]);
  });

  it("splits calories from the grams, and refuses a split while any macro is unknown", () => {
    const split = energySplit(serving)!;
    expect(split.protein + split.carbs + split.fat).toBeCloseTo(1);
    expect(Math.round(split.protein * 100)).toBe(41);
    expect(energySplit({ ...serving, fat: null })).toBeNull();
  });

  it("speaks a value in full and an unknown one as unknown", () => {
    expect(spokenMacro("protein", 51)).toBe("51 grams protein");
    expect(spokenMacro("kcal", 1891)).toBe("1,891 calories");
    expect(spokenMacro("fat", null)).toBe("Fat unknown");
  });
});

describe("macro text", () => {
  it("writes the figure in its ink with the unit tight and the label quiet, spoken in full", () => {
    const { container } = render(<MacroFigure macro="protein" value={51} />);
    expect(container.querySelector(".macro-ink-protein")?.textContent).toBe("51g");
    expect(container.textContent).toContain("PRO");
    expect(container.querySelector(".sr-only")?.textContent).toBe("51 grams protein");
  });

  it("lists calories first, then protein, carbs and fat", () => {
    const { container } = render(<MacroLine values={serving} />);
    expect(Array.from(container.querySelectorAll(".sr-only"), (part) => part.textContent))
      .toEqual(["508 calories", "51 grams protein", "44 grams carbs", "13 grams fat"]);
    expect(container.querySelector(".kcal")?.textContent).toBe("508");
  });
});

describe("diet facts", () => {
  const recipe = (over: Partial<Parameters<typeof recipeDietFacts>[0]> = {}) => ({
    dishTags: [], ingredients: [],
    nutritionPerServing: { kcal: known(500), protein: known(40), carbs: known(50), fat: known(15) }, ...over,
  }) as Parameters<typeof recipeDietFacts>[0];
  const ingredient = (evidence: Record<string, "present" | "absent" | "unknown">) =>
    ({ allergenEvidence: evidence }) as Parameters<typeof recipeDietFacts>[0]["ingredients"][number];

  it("calls a serving high protein when protein carries at least 30 % of its calories", () => {
    expect(recipeDietFacts(recipe())).toContain("high-protein");
    expect(recipeDietFacts(recipe({ nutritionPerServing: { kcal: known(445), protein: known(23), carbs: known(70), fat: known(8) } })))
      .not.toContain("high-protein");
  });

  const named = (name: string, evidence: Record<string, "present" | "absent" | "unknown"> = {}) =>
    ({ name, foodDbId: null, allergenEvidence: evidence }) as Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
  const plants = [named("Lentils, cooked"), named("Olive oil"), named("Broccoli, cooked")];

  it("badges vegan or vegetarian only when the tag and every ingredient's identity agree (F6)", () => {
    expect(recipeDietFacts(recipe({ dishTags: ["pasta", "vegetarian"], ingredients: plants }))).toContain("vegetarian");
    const vegan = recipeDietFacts(recipe({ dishTags: ["vegan", "vegetarian"], ingredients: plants }));
    expect(vegan).toContain("vegan");
    expect(vegan).not.toContain("vegetarian");
  });

  it("refuses a vegan tag on a recipe with beef, and a vegetarian tag on one with fish", () => {
    const beef = recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, named("Beef, ground, cooked")] }));
    expect(beef).not.toContain("vegan");
    expect(beef).not.toContain("vegetarian");
    expect(recipeDietFacts(recipe({ dishTags: ["vegetarian"], ingredients: [...plants, named("Salmon, baked")] })))
      .not.toContain("vegetarian");
  });

  it("drops vegan to vegetarian when an ingredient is egg or dairy", () => {
    const facts = recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, named("Egg, hard-boiled")] }));
    expect(facts).toContain("vegetarian");
    expect(facts).not.toContain("vegan");
  });

  it("claims no diet from a tag alone: no ingredients, or one it cannot identify", () => {
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"] }))).not.toContain("vegan");
    expect(recipeDietFacts(recipe({ dishTags: ["vegetarian"], ingredients: [...plants, named("House sauce")] })))
      .not.toContain("vegetarian");
  });

  it("judges every name an ingredient has: a refuting bundled food wins over a plant line name", () => {
    const line = (name: string, foodDbId: string | null) =>
      ({ name, foodDbId, allergenEvidence: {} }) as Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
    const beefBehindLentils = recipeDietFacts(recipe({ dishTags: ["vegan"],
      ingredients: [...plants, line("Lentils, cooked", "ground-beef-90-10-cooked")] }));
    expect(beefBehindLentils).not.toContain("vegan");
    expect(beefBehindLentils).not.toContain("vegetarian");
    // An unresolvable bundled id is an identity nobody checked: no badge on the friendly name alone.
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"],
      ingredients: [...plants, line("Lentils, cooked", "no-such-food")] }))).not.toContain("vegan");
    // Both names plant: the badge stands.
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"],
      ingredients: [...plants, line("Lentils, cooked", "lentils-cooked")] }))).toContain("vegan");
  });

  it("gives no badge when a bundled food's name does not classify, even under a plant line name", () => {
    const line = { name: "Lentils, cooked", foodDbId: "lentil-soup", allergenEvidence: {} } as
      Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, line] })))
      .not.toContain("vegan");
    const nameless = { name: " ", foodDbId: null, allergenEvidence: {} } as
      Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, nameless] })))
      .not.toContain("vegan");
  });

  it("lets a name refute what absent evidence would approve (review round 5 probes)", () => {
    const allAbsent = { meat: "absent", fish_seafood: "absent", shellfish: "absent",
      animal_product: "absent" } as const;
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [named("Beef stock", allAbsent)] })))
      .toEqual(expect.not.arrayContaining(["vegan", "vegetarian"]));
    expect(recipeDietFacts(recipe({ ingredients: [named("Milk", { dairy: "absent" })] })))
      .not.toContain("dairy-free");
    expect(recipeDietFacts(recipe({ ingredients: [named("Wheat flour", { gluten: "absent" })] })))
      .not.toContain("gluten-free");
    // The policy's own exclusions still hold: almond milk is not dairy.
    expect(recipeDietFacts(recipe({ ingredients: [named("Almond milk", { dairy: "absent" })] })))
      .toContain("dairy-free");
    // Complete absent evidence still covers an unclassifiable name nothing refutes.
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [named("House sauce", allAbsent)] })))
      .toContain("vegan");
  });

  it("judges a pinned catalog food's own description (review round 6 probe)", () => {
    const pinned = (catalogFoodName?: string) => ({ name: "Lentils, cooked", foodDbId: null,
      foodRefId: null, catalogFoodRevisionId: 42, ...(catalogFoodName ? { catalogFoodName } : {}),
      allergenEvidence: { gluten: "absent" } }) as unknown as Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
    const flour = recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [pinned("Wheat flour, white, all-purpose")] }));
    expect(flour).not.toContain("vegan");
    expect(flour).not.toContain("gluten-free");
    // The description was not loaded: the authored name alone cannot vouch for the pinned food.
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [pinned()] }))).not.toContain("vegan");
    // Review round 7 probe: even complete "absent" evidence on the line cannot stand in for the
    // pinned food's unseen name — no vegan, gluten-free or dairy-free badge.
    const allAbsent = { ...pinned(), allergenEvidence: { meat: "absent", fish_seafood: "absent",
      shellfish: "absent", animal_product: "absent", gluten: "absent", dairy: "absent" } } as
      Parameters<typeof recipeDietFacts>[0]["ingredients"][number];
    const facts = recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, allAbsent] }));
    expect(facts).toEqual(expect.not.arrayContaining(["vegan", "vegetarian", "gluten-free", "dairy-free"]));
    // A plant description that agrees with the line keeps the badge.
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [pinned("Lentils, cooked")] })))
      .toContain("vegan");
  });

  it("never lets absent evidence outvote a name that refutes", () => {
    const absent = { meat: "absent", fish_seafood: "absent", shellfish: "absent", animal_product: "absent" } as const;
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"],
      ingredients: [...plants, named("Beef, ground, cooked", absent)] }))).not.toContain("vegan");
  });

  it("lets stored facet evidence decide first: present refutes, all absent supports", () => {
    const absent = { meat: "absent", fish_seafood: "absent", shellfish: "absent", animal_product: "absent" } as const;
    expect(recipeDietFacts(recipe({ dishTags: ["vegan"], ingredients: [...plants, named("House sauce", absent)] })))
      .toContain("vegan");
    expect(recipeDietFacts(recipe({ dishTags: ["vegetarian"], ingredients: [named("Lentils, cooked", { meat: "present" })] })))
      .not.toContain("vegetarian");
  });

  it("claims free-from only when every ingredient's evidence says absent, never from missing evidence", () => {
    expect(recipeDietFacts(recipe({ ingredients: [ingredient({ gluten: "absent" }), ingredient({ gluten: "absent" })] })))
      .toContain("gluten-free");
    expect(recipeDietFacts(recipe({ ingredients: [ingredient({ gluten: "absent" }), ingredient({})] })))
      .not.toContain("gluten-free");
    expect(recipeDietFacts(recipe({ ingredients: [ingredient({ dairy: "present" }), ingredient({ dairy: "absent" })] })))
      .toContain("contains-dairy");
    expect(recipeDietFacts(recipe({ ingredients: [] }))).not.toContain("dairy-free");
  });

  it("badges with a label by default and names an icon-only badge for assistive tech", () => {
    render(<DietBadge fact="gluten-free" />);
    expect(screen.getByText("Gluten-free")).toBeTruthy();
    cleanup();
    render(<DietBadge fact="vegan" variant="icon" />);
    expect(screen.getByRole("img", { name: "Vegan" })).toBeTruthy();
  });
});

describe("recipe facets", () => {
  it("names cuisine, time in hours past an hour, and servings in words, each with its facet hue", () => {
    render(<RecipeFacets cuisine="American" minutes={488} servings={2} variant="line" />);
    const items = within(screen.getByRole("list", { name: "At a glance" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-facet"))).toEqual(["cuisine", "time", "servings"]);
    expect(items.map((item) => item.querySelector(".sr-only")?.textContent))
      .toEqual(["American cuisine", "Ready in 8 hr 8 min", "Serves 2"]);
    expect(items.every((item) => item.querySelector(".facet-glyph"))).toBe(true);
  });
});

describe("graphs", () => {
  it("draws a donut's split as three arcs in the gram macros' fills, calories in the middle", () => {
    const { container } = render(<MacroDonut values={serving} />);
    expect(Array.from(container.querySelectorAll("circle.stroke-current[class*='macro-']"), (arc) => arc.getAttribute("class")))
      .toEqual(expect.arrayContaining([expect.stringContaining("macro-protein"), expect.stringContaining("macro-carbs"),
        expect.stringContaining("macro-fat")]));
    expect(container.querySelector(".kcal")?.textContent).toBe("508");
  });

  it("speaks a gauge as its figure against its target", () => {
    const { container } = render(<MacroGauge macro="protein" value={99} target={195} />);
    expect(container.querySelector(".sr-only")?.textContent).toBe("99 grams protein of 195");
  });

  it("keeps a target bar decorative: the caller says the figures", () => {
    const { container } = render(<TargetMeter macro="fat" base={20} add={20} target={30} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
