/**
 * Phase 18 W5b acceptance 2 (docs/specs/phase-18-open-world-foods.md D9 item 3): the local safety
 * check keeps every health, symptom, rule and unsure sentence from Jev and every model, with zero false
 * negatives on the fixed corpus, and sends the plain sentences.
 */
import { describe, expect, it } from "vitest";
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { TASTE_TEXT_MAX, tasteTextRoute } from "@/lib/profile/taste-safety";
import { TASTE_WORDS } from "@/lib/profile/taste-words";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS, PLAIN, REDTEAM_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

describe("the keep-local corpus", () => {
  it("holds every acceptance 2 example and at least 60 more health and symptom sentences", () => {
    expect(ACCEPTANCE_LOCAL).toHaveLength(12);
    expect(ACCEPTANCE_LOCAL.find((c) => c.reason === "unsure" && c.text.length === 250)).toBeDefined();
    expect(HEALTH_CORPUS.filter((c) => c.reason !== "unsure").length).toBeGreaterThanOrEqual(60);
    expect(new Set(HEALTH_CORPUS.map((c) => c.text)).size).toBe(HEALTH_CORPUS.length);
  });

  it("keeps every sentence local (zero sends) with the expected reason", () => {
    const sent = [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS].filter((c) => tasteTextRoute(c.text).route === "send");
    expect(sent).toEqual([]);
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      expect([c.text, tasteTextRoute(c.text)]).toEqual([c.text, { route: "local", reason: c.reason }]);
    }
  });

  it("keeps every red-team sentence local (zero sends)", () => {
    expect(REDTEAM_CORPUS.length).toBeGreaterThanOrEqual(300);
    expect(REDTEAM_CORPUS.filter((text) => tasteTextRoute(text).route === "send")).toEqual([]);
  });

  it("keeps each sentence local in any case, with curly quotes, accents or extra spaces", () => {
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      for (const variant of [c.text.toUpperCase(), c.text.replaceAll("'", "’"), `  ${c.text.replaceAll(" ", "   ")} `]) {
        expect([variant, tasteTextRoute(variant).route]).toEqual([variant, "local"]);
      }
    }
  });
});

describe("plain sentences", () => {
  it("sends plain likes, dislikes and cuisines", () => {
    for (const text of PLAIN) expect([text, tasteTextRoute(text)]).toEqual([text, { route: "send" }]);
    for (const text of ["I love salmon", "I hate mushrooms", "I grew up on Tex-Mex"]) expect(PLAIN).toContain(text);
  });

  it("keeps blank text, text past 200 characters and unknown words local as unsure", () => {
    expect(TASTE_TEXT_MAX).toBe(200);
    for (const text of ["", "   ", `${"I love salmon ".repeat(15)}`, "I love zorbleflux", "I love salmon 🍣",
      "Me encanta el salmón"]) {
      expect([text, tasteTextRoute(text)]).toEqual([text, { route: "local", reason: "unsure" }]);
    }
  });

  it("reads a negation only as a plain dislike; any other negation is unsure", () => {
    expect(tasteTextRoute("I don't like olives").route).toBe("send");
    expect(tasteTextRoute("I can't stand okra").route).toBe("send");
    expect(tasteTextRoute("Not a fan of liver").route).toBe("send");
    for (const text of ["No olives", "Never olives", "Olives are not okay", "I won't touch okra"]) {
      expect([text, tasteTextRoute(text).route]).toEqual([text, "local"]);
    }
  });
});

describe("the word list", () => {
  it("knows every word of every universe family name", () => {
    const missing = new Set<string>();
    for (const entry of UNIVERSE) {
      const row = dbFood(entry.id);
      for (const word of baseFoodName(row?.name ?? "").split(/[^a-z'-]+/)) {
        if (word.length > 1 && !TASTE_WORDS.has(word)) missing.add(word);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("holds no word that is a rule or symptom on its own", () => {
    const flagged = [...TASTE_WORDS].filter((word) => tasteTextRoute(word).route === "local"
      && (tasteTextRoute(word) as { reason: string }).reason !== "unsure");
    // Food names that share a stem with a body word stay in the list; the check still keeps them local.
    expect(flagged.sort()).toEqual(["addicted", "carb", "carbs", "dry", "kidney", "skin"]);
  });
});
