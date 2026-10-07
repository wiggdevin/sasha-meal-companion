import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { profileDefinition } from "@/lib/policy/profiles/catalog";
import {
  BISPHOSPHONATE_TIMING, bisphosphonateCard, MAOI_TYRAMINE_LISTS, maoiTyramineFinding,
  medicationFoodFinding, medicationTimingCard,
} from "@/lib/policy/profiles/drug-interactions";
import { buildProfileInstance } from "@/lib/policy/profiles/loader";

const SOURCES = (JSON.parse(readFileSync("docs/research/dietary-profiles.draft.json", "utf8")) as {
  sources: Record<string, unknown>;
}).sources;

describe("MAOI tyramine label lists, per drug (§9 R6)", () => {
  it("phenelzine's list blocks its own label foods", () => {
    for (const food of ["aged cheese", "pickled herring", "wine", "liver", "yeast extract",
      "dry sausage", "fava pods", "yogurt"]) {
      expect(maoiTyramineFinding("phenelzine", `Contains ${food}`).outcome, food).toBe("present");
    }
  });

  it("tranylcypromine's list blocks its own label foods, including ones phenelzine's omits", () => {
    for (const food of ["sauerkraut", "soy sauce", "fermented soy", "cured meat", "tap beer",
      "red wine"]) {
      expect(maoiTyramineFinding("tranylcypromine", `Contains ${food}`).outcome, food).toBe("present");
    }
  });

  it("the two drugs' lists are not the same list", () => {
    expect(MAOI_TYRAMINE_LISTS.phenelzine.keywords).not.toEqual(MAOI_TYRAMINE_LISTS.tranylcypromine.keywords);
    // sauerkraut is on tranylcypromine's label wording but not phenelzine's per the map's citation
    expect(maoiTyramineFinding("phenelzine", "sauerkraut").outcome).toBe("unknown");
    expect(maoiTyramineFinding("tranylcypromine", "sauerkraut").outcome).toBe("present");
  });

  it("alcohol blocks either drug, even outside its own named list", () => {
    expect(maoiTyramineFinding("phenelzine", "red wine vinaigrette").outcome).toBe("present");
    expect(maoiTyramineFinding("tranylcypromine", "beer batter").outcome).toBe("present");
  });

  it("an unknown or unlisted MAOI (isocarboxazid) stays unverified, never falls back to a generic list", () => {
    expect(maoiTyramineFinding("isocarboxazid", "aged cheese").outcome).toBe("unknown");
    expect(maoiTyramineFinding("unknown", "aged cheese").outcome).toBe("unknown");
  });

  it("no ingredient text at all stays unverified, for either drug", () => {
    expect(maoiTyramineFinding("phenelzine", null).outcome).toBe("unknown");
    expect(maoiTyramineFinding("phenelzine", "").outcome).toBe("unknown");
  });

  it("both drugs' citations resolve in the research document's sources", () => {
    expect(SOURCES[MAOI_TYRAMINE_LISTS.phenelzine.citation]).toBeDefined();
    expect(SOURCES[MAOI_TYRAMINE_LISTS.tranylcypromine.citation]).toBeDefined();
  });
});

describe("bisphosphonate timing, per drug and formulation (§9 R6)", () => {
  it("each of the four known formulations has its own instructions", () => {
    const texts = Object.values(BISPHOSPHONATE_TIMING).map((t) => t.instructions);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("the Atelvia card (risedronate delayed-release) separates calcium, antacids and iron from the dose", () => {
    const card = bisphosphonateCard("risedronate_delayed_release_atelvia");
    expect(card.known).toBe(true);
    if (!card.known) return;
    expect(card.timing.separateFrom).toEqual(["calcium", "antacids", "iron"]);
    expect(card.timing.instructions).toContain("calcium");
    expect(card.timing.instructions).toContain("antacids");
    expect(card.timing.instructions).toContain("iron");
    expect(card.timing.instructions).toContain("after breakfast");
  });

  it("immediate-release risedronate has the opposite timing from Atelvia, and no mineral separation", () => {
    const card = bisphosphonateCard("risedronate_immediate_release");
    expect(card.known).toBe(true);
    if (!card.known) return;
    expect(card.timing.instructions).toContain("before your first food");
    expect(card.timing.separateFrom).toEqual([]);
  });

  it("an unknown formulation gives no timing advice, per the map's own unknown_drug rule", () => {
    const card = bisphosphonateCard("risedronate_unspecified");
    expect(card.known).toBe(false);
    if (card.known) return;
    expect(card.text).toBe("No timing advice until the exact product is known");
  });

  it("every formulation's citation resolves in the research document's sources", () => {
    for (const timing of Object.values(BISPHOSPHONATE_TIMING)) {
      expect(SOURCES[timing.citation], timing.citation).toBeDefined();
    }
  });
});

describe("drug guidance reaches a built profile instance (sol FIX, §9 R6)", () => {
  const params = { source: "user_stated" as const, confirmedAt: "2026-09-24T00:00:00Z" };
  const built = (profileId: string, drug?: string) =>
    buildProfileInstance(profileDefinition(profileId)!, { ...params, ...(drug ? { drug } : {}) });

  it("a bisphosphonate instance built with Atelvia carries the calcium/antacid/iron card", () => {
    const card = medicationTimingCard(built("bisphosphonate", "risedronate_delayed_release_atelvia"));
    expect(card).toMatchObject({ known: true, timing: { separateFrom: ["calcium", "antacids", "iron"] } });
  });

  it("a bisphosphonate instance with no exact product gives no timing advice", () => {
    expect(medicationTimingCard(built("bisphosphonate"))).toEqual({
      known: false, text: "No timing advice until the exact product is known",
    });
    expect(medicationTimingCard(built("bisphosphonate", "risedronate"))).toMatchObject({ known: false });
    expect(medicationTimingCard(built("bisphosphonate", "toString"))).toMatchObject({ known: false });
  });

  it("an MAOI instance checks food against its own drug's label list", () => {
    expect(medicationFoodFinding(built("maoi", "phenelzine"), "plain yogurt")?.outcome).toBe("present");
    expect(medicationFoodFinding(built("maoi", "tranylcypromine"), "plain yogurt")?.outcome).toBe("unknown");
    expect(medicationFoodFinding(built("maoi", "constructor"), "aged cheese")?.outcome).toBe("unknown");
    expect(medicationFoodFinding(built("maoi"), "aged cheese")).toEqual({
      outcome: "unknown", text: "Unknown MAOI — check with your pharmacist",
    });
  });

  it("a non-drug profile has no drug guidance", () => {
    expect(medicationTimingCard(built("kosher"))).toBeNull();
    expect(medicationFoodFinding(built("kosher"), "aged cheese")).toBeNull();
  });
});
