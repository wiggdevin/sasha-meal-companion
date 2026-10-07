/**
 * Phase 13 §5 and §9 R1/R2 (slice 2): three evidence levels per food revision and allergen, and
 * what each allows. Named (non-FALCPA) allergens and cross-contact are tested separately (R2).
 */
import { describe, expect, it } from "vitest";
import {
  allergenFinding, allergenKey, allergenRule, CROSS_CONTACT_NOTE, deriveEvidence,
  evidenceFromInputs, labelEvidence, looksLikeCompleteList, mergeEvidence, mergeStoredEvidence,
  namedAllergenHints, textNames, withCrustaceanAllowance,
} from "@/lib/policy/allergens";

const COMPLETE = "Water, rice flour, sunflower oil, salt.";

describe("deriveEvidence: listed / not_listed / no_evidence", () => {
  it("listed when the ingredient text names any form of the allergen", () => {
    expect(deriveEvidence("dairy", { ingredientsText: "Oats, whey powder, salt", labelComplete: true }))
      .toEqual({ level: "listed", labelComplete: true });
    expect(deriveEvidence("tree-nut", { ingredientsText: "Almonds, honey", labelComplete: false }))
      .toMatchObject({ level: "listed" });
  });

  it("not_listed only from a complete ingredient list that names no form of it", () => {
    expect(deriveEvidence("dairy", { ingredientsText: COMPLETE, labelComplete: true }))
      .toEqual({ level: "not_listed", labelComplete: true });
    expect(deriveEvidence("dairy", { ingredientsText: COMPLETE, labelComplete: false }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("no_evidence without an ingredient list, and a legacy empty tag list is not evidence", () => {
    expect(deriveEvidence("dairy", { ingredientsText: null, labelComplete: true, tags: [] }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("a legacy tag escalates to listed", () => {
    expect(deriveEvidence("gluten", { ingredientsText: null, labelComplete: false,
      tags: ["gluten"] })).toMatchObject({ level: "listed" });
  });

  // Phase 18 W2a: Jev facets are no longer an input. The full fixture set lives in
  // tests/policy/facet-escalation-removal.test.ts.
  it("evidenceFromInputs takes no Jev input: text and tags still list, nothing else does", () => {
    expect(evidenceFromInputs({ ingredientsText: null, labelComplete: false }).gluten)
      .toEqual({ level: "no_evidence", labelComplete: false });
    expect(evidenceFromInputs({ ingredientsText: "Wheat flour, rice", labelComplete: true })
      .gluten).toMatchObject({ level: "listed" });
    expect(evidenceFromInputs({ ingredientsText: null, labelComplete: false, tags: ["gluten"] })
      .gluten).toMatchObject({ level: "listed" });
  });

  it("a stored listed finding survives a fresh re-derivation with no evidence (merge)", () => {
    const stored = { level: "listed" as const, labelComplete: false };
    const fresh = evidenceFromInputs({ ingredientsText: null, labelComplete: false }).gluten;
    expect(fresh).toEqual({ level: "no_evidence", labelComplete: false });
    expect(mergeEvidence(stored, fresh)).toMatchObject({ level: "listed" });
  });

  it("matches whole words and skips phrases that are not the allergen", () => {
    expect(textNames("dairy", "cocoa butter, sugar")).toBe(false);
    expect(textNames("dairy", "butter, sugar")).toBe(true);
    expect(textNames("tree-nut", "nutmeg, coconut")).toBe(false);
    expect(textNames("tree-nut", "mixed nuts")).toBe(true);
    expect(textNames("egg", "eggplant")).toBe(false);
    expect(allergenKey(" Milk ")).toBe("dairy");
  });

  it("merges sources with listed first", () => {
    expect(mergeEvidence({ level: "not_listed", labelComplete: true },
      { level: "listed", labelComplete: false })).toEqual({ level: "listed", labelComplete: true });
    expect(mergeEvidence(undefined, { level: "no_evidence", labelComplete: false }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });
});

describe("allergenFinding: the nine major allergens (R1)", () => {
  it("listed blocks", () => {
    expect(allergenFinding("dairy", { stored: { level: "listed", labelComplete: true } }))
      .toMatchObject({ outcome: "present", text: "Contains dairy" });
  });

  it("not_listed allows with 'No <allergen> listed on the label', never 'safe'", () => {
    const finding = allergenFinding("egg", { stored: { level: "not_listed", labelComplete: true } });
    expect(finding).toMatchObject({ outcome: "absent", text: "No egg listed on the label" });
    expect(finding.text.toLowerCase()).not.toContain("safe");
  });

  it("no_evidence is unverified: 'Check the label'", () => {
    expect(allergenFinding("sesame", {})).toMatchObject({ outcome: "unknown",
      text: "Check the label for sesame", checkable: true });
  });

  it("a legacy empty tag list does not clear", () => {
    expect(allergenFinding("dairy", { tags: [] })).toMatchObject({ outcome: "unknown" });
  });

  it("the live text can add listed but never downgrade a stronger stored level", () => {
    expect(allergenFinding("soy", { stored: { level: "not_listed", labelComplete: true },
      ingredientsText: "soy lecithin" })).toMatchObject({ outcome: "present" });
    expect(allergenFinding("soy", { stored: { level: "listed", labelComplete: false },
      ingredientsText: COMPLETE })).toMatchObject({ outcome: "present" });
  });

  it("r3 FIX: a genuinely complete label independently clears a major allergen with no stored " +
    "evidence at all — search and detail no longer have to wait on a separate warm pass", () => {
    expect(allergenFinding("soy", { ingredientsText: COMPLETE }))
      .toMatchObject({ outcome: "absent", text: "No soy listed on the label" });
  });

  it("an incomplete (unterminated, cropped-looking) live text still cannot clear on its own", () => {
    expect(allergenFinding("soy", { ingredientsText: "Water, sugar" }))
      .toMatchObject({ outcome: "unknown" });
  });

  it("r4 BLOCK 'Also FIX' (reproduced), superseded by the ORCHESTRATOR RULING (round 7): a bare " +
    "single-word read can never clear a major allergen on any path now — the warehoused path's " +
    "old single-item exemption is gone; at least three items, everywhere.", () => {
    expect(allergenFinding("dairy", { ingredientsText: "Water" }))
      .toMatchObject({ outcome: "unknown" });
    expect(looksLikeCompleteList("Water")).toBe(false);
  });

  it("sol BLOCK (r5): `isLabelText: false` — a self-authored custom food's own editable text — " +
    "can still ESCALATE to listed (it may genuinely name an allergen) but can never CLEAR one " +
    "by looking complete; only a real printed/scanned label (the default) may do that (§9 R2: " +
    "\"a client-created custom food is never a complete label\", facet-warm.ts's own rule)",
    () => {
      expect(allergenFinding("soy", { ingredientsText: COMPLETE, isLabelText: false }))
        .toMatchObject({ outcome: "unknown" });
      expect(allergenFinding("soy", { ingredientsText: COMPLETE }))
        .toMatchObject({ outcome: "absent" });
      expect(allergenFinding("dairy", { ingredientsText: "Milk, sugar", isLabelText: false }))
        .toMatchObject({ outcome: "present", text: "Contains dairy" });
      // A stored `not_listed` row (the warehoused path, which already gates on the food's own
      // kind) is untouched — `isLabelText` only narrows what a LIVE read on top of it may do.
      expect(allergenFinding("soy", {
        stored: { level: "not_listed", labelComplete: true }, isLabelText: false,
      })).toMatchObject({ outcome: "absent" });
    });
});

describe("allergenFinding: named allergens outside the nine (R1)", () => {
  it("not_listed stays unverified for gluten, shellfish and account-named allergens", () => {
    for (const name of ["gluten", "shellfish", "mustard", "kiwi"]) {
      expect(allergenFinding(name, { stored: { level: "not_listed", labelComplete: true } }))
        .toMatchObject({ outcome: "unknown", checkable: true });
    }
  });

  it("an account-named allergen matches the ingredient text deterministically", () => {
    expect(allergenFinding("mustard", { ingredientsText: "Vinegar, mustard seed, salt" }))
      .toMatchObject({ outcome: "present", text: "Contains mustard" });
    expect(allergenFinding("mustard", { ingredientsText: COMPLETE }))
      .toMatchObject({ outcome: "unknown" });
  });

  it("the user marking that exact product checked allows it", () => {
    expect(allergenFinding("mustard", { stored: { level: "not_listed", labelComplete: true },
      userChecked: true })).toMatchObject({ outcome: "absent",
      text: "You checked this label for mustard" });
  });

  it("a check never overrides a listing", () => {
    expect(allergenFinding("gluten", { tags: ["gluten"], userChecked: true }))
      .toMatchObject({ outcome: "present" });
  });
});

describe("looksLikeCompleteList: a short unterminated fragment is not a finished label (finding #9)", () => {
  it("rejects a two-item fragment with no terminal punctuation", () => {
    expect(looksLikeCompleteList("Water, sugar")).toBe(false);
  });

  it("ORCHESTRATOR RULING (round 7): a two-item list never clears the three-item floor, however " +
    "it is terminated", () => {
    expect(looksLikeCompleteList("Water, sugar.")).toBe(false);
    expect(looksLikeCompleteList("Water, sugar. May contain milk")).toBe(false);
  });

  it("finding #4: a crop can land on ANY item, not just the second — three or more items with " +
    "nothing closing the sentence read as unfinished too, the same as a two-item crop", () => {
    expect(looksLikeCompleteList("Water, rice flour, salt")).toBe(false);
  });

  it("a three-item list reads complete once it carries a terminator", () => {
    expect(looksLikeCompleteList("Water, rice flour, salt.")).toBe(true);
  });

  it("ORCHESTRATOR RULING (round 7): a single item with no comma never clears the three-item " +
    "floor either — the old short-whole-statement exemption is gone", () => {
    expect(looksLikeCompleteList("Onion")).toBe(false);
  });

  it("a two-item fragment cannot allow a major allergen (regression: it must read as unverified)",
    () => {
      expect(deriveEvidence("peanut", { ingredientsText: "Water, sugar",
        labelComplete: looksLikeCompleteList("Water, sugar") }))
        .toEqual({ level: "no_evidence", labelComplete: false });
    });

  it("a three-item, unterminated crop cannot allow a major allergen either (finding #4)", () => {
    expect(deriveEvidence("peanut", { ingredientsText: "Water, sugar, salt",
      labelComplete: looksLikeCompleteList("Water, sugar, salt") }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("finding #3: a list with words outside the ingredient lexicon reads as incomplete, even " +
    "when one item happens to share a common English word", () => {
    expect(looksLikeCompleteList("Agua, leche, sugar.")).toBe(false);
    expect(deriveEvidence("dairy", { ingredientsText: "Agua, leche, sugar.",
      labelComplete: looksLikeCompleteList("Agua, leche, sugar.") }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("r4 BLOCK #3 (reproduced): a bare DESCRIPTOR word ('natural') cannot satisfy an item on its " +
    "own — only a word that itself names a substance can, so dairy ('leche') is still caught", () => {
    const text = "Agua natural, leche natural, sugar.";
    expect(looksLikeCompleteList(text)).toBe(false);
    expect(allergenFinding("dairy", { ingredientsText: text })).toMatchObject({ outcome: "unknown" });
  });
});

describe("ORCHESTRATOR RULING (round 7): the required table, straight from the ruling itself", () => {
  it.each<[string, string, boolean]>([
    ["a garbled token ('???') makes the whole statement incomplete, no majority rule",
      "Water, ???, salt.", false],
    ["a foreign, unrecognized word ('leche') makes the whole statement incomplete",
      "Sugar, leche salt water.", false],
    ["a cropped 'may contain' with nothing after it is not a terminator",
      "Water, sugar, may contain", false],
    ["one word alone never clears the three-item floor", "Water", false],
    ["a complete, terminated, three-item statement followed by a Contains clause is complete",
      "Sugar, salt, natural flavor. Contains: soy.", true],
  ])("%s", (_label, text, expected) => {
    expect(looksLikeCompleteList(text)).toBe(expected);
  });

  it("joined parsed names with no raw_text are incomplete regardless of shape (verbatim: false)",
    () => {
      expect(looksLikeCompleteList("Sugar, salt, natural flavor. Contains: soy.",
        { verbatim: false })).toBe(false);
    });

  it("facet-warm must persist a bare 'Water' as unverified (no_evidence), never not_listed — the " +
    "level a clear-but-too-short label collapses to, not a false clearance", () => {
    expect(deriveEvidence("dairy", { ingredientsText: "Water",
      labelComplete: looksLikeCompleteList("Water") }))
      .toEqual({ level: "no_evidence", labelComplete: false });
  });
});

describe("crustacean allowance (finding #9): the ninth FALCPA major allergen, alongside the " +
  "existing combined `shellfish` key", () => {
  it("keeps the existing combined key working: shellfish itself stays non-major, so a complete " +
    "label naming none of it stays unverified rather than clearing", () => {
    expect(allergenRule("shellfish").major).toBe(false);
    expect(allergenFinding("shellfish", { ingredientsText: "Water, rice flour, salt." }))
      .toMatchObject({ outcome: "unknown", checkable: true });
  });

  it("a complete label naming no crustacean reads allowed for the crustacean rule (R1's ninth " +
    "major allergen)", () => {
    expect(allergenRule("crustacean").major).toBe(true);
    expect(allergenFinding("crustacean", { ingredientsText: "Water, rice flour, salt." }))
      .toMatchObject({ outcome: "absent", text: "No crustacean shellfish listed on the label" });
  });

  it("a crustacean word in the text lists it", () => {
    expect(allergenFinding("crustacean", { ingredientsText: "Water, shrimp, salt." }))
      .toMatchObject({ outcome: "present", text: "Contains crustacean shellfish" });
  });

  it("a mollusc word alone does not list crustacean, and molluscs stay non-major on the combined " +
    "shellfish key (clam is not one of the nine)", () => {
    // A complete list (label_complete supplied directly, the way a stored row would carry it,
    // rather than routed through the generic-English crop guard clam itself is not in).
    const text = "Water, clam, salt";
    expect(deriveEvidence("crustacean", { ingredientsText: text, labelComplete: true }))
      .toEqual({ level: "not_listed", labelComplete: true });
    // The combined key still reads it LISTED (a mollusc is still "shellfish"), never cleared —
    // just never treated as one of the nine on its own.
    expect(deriveEvidence("shellfish", { ingredientsText: text, labelComplete: true }))
      .toMatchObject({ level: "listed" });
  });

  it("r4 BLOCK #2 (reproduced): a stored crustacean `listed` (a legacy shrimp tag, an earlier " +
    "warm) survives a fresh read's merge even when the account only avoids the combined " +
    "`shellfish` setting and this read's own text never repeats it", () => {
    const stored = { crustacean: { level: "listed" as const, labelComplete: false } };
    // withCrustaceanAllowance is what makes `live` carry a crustacean key at all — without it,
    // mergeStoredEvidence (which only ever merges the keys `live` already has) silently drops it.
    const live = labelEvidence(withCrustaceanAllowance(["shellfish"]), "Water, rice flour, salt.");
    expect(live).toHaveProperty("crustacean");
    const merged = mergeStoredEvidence(live, stored);
    expect(merged.crustacean).toMatchObject({ level: "listed" });
  });

  it("sol FIX (review round 1, phase 13 slice 2): the FALCPA name itself, \"crustacean " +
    "shellfish\", normalizes to the crustacean-ONLY key, not the broader combined `shellfish` " +
    "key — an account naming the specific major allergen must get R1's not_listed clearance on a " +
    "complete label with no crustacean present, not stay stuck unverified under the broader, " +
    "non-major combined rule", () => {
    expect(allergenKey("crustacean shellfish")).toBe("crustacean");
    expect(allergenFinding("crustacean shellfish", { ingredientsText: "Water, rice flour, salt." }))
      .toMatchObject({ outcome: "absent" });
  });
});

describe("cross-contact (R1/R2), tested apart from named allergens", () => {
  it("a 'may contain' line lists the allergen", () => {
    expect(allergenFinding("peanut", { ingredientsText: "Oats. May contain peanuts." }))
      .toMatchObject({ outcome: "present" });
  });

  it("silence about cross-contact is never read as clearance: the note says labels need not warn",
    () => {
      const finding = allergenFinding("peanut", { stored: { level: "not_listed", labelComplete: true } });
      expect(finding.text).toBe("No peanut listed on the label");
      expect(CROSS_CONTACT_NOTE).toMatch(/do not have to warn about cross-contact/);
      expect(finding.text.toLowerCase()).not.toMatch(/safe|free/);
    });

  it("sol BLOCK: a Spanish-labeled peanut ingredient (cacahuate) must not clear the peanut " +
    "allergen just because the rest of a short list reads as English", () => {
    // "Ground cacahuate, water." is a complete-looking, terminated, two-item list; the peanut
    // keyword list only recognized the English words, so this used to derive `not_listed` (the
    // ingredient is simply not there as far as the parser could tell) and clear peanut outright.
    expect(textNames("peanut", "Ground cacahuate, water.")).toBe(true);
    expect(allergenFinding("peanut", { ingredientsText: "Ground cacahuate, water." }))
      .toMatchObject({ outcome: "present", text: "Contains peanut" });
  });
});

describe("namedAllergenHints (finding #10): a LISTED-only keyword scan over arbitrary text, " +
  "never a completeness judgment", () => {
  it("names every allergen key the text matches", () => {
    expect(namedAllergenHints("peanut, water, salt")).toContain("peanut");
    expect(namedAllergenHints("peanut, water, salt")).not.toContain("dairy");
  });

  it("is empty for null/empty text, and never throws", () => {
    expect(namedAllergenHints(null)).toEqual([]);
    expect(namedAllergenHints("")).toEqual([]);
  });

  it("r4 follow-up: also matches an account-defined allergen outside the fixed vocabulary, via " +
    "extraKeys", () => {
    expect(namedAllergenHints("mustard, water, salt", ["mustard"])).toContain("mustard");
    expect(namedAllergenHints("mustard, water, salt")).not.toContain("mustard");
  });
});

describe("follow-up review (s2-sol-r4-followup.md): deeper variants of the round-4 fixes", () => {
  it("BLOCK #2 follow-up: withCrustaceanAllowance normalizes case/whitespace itself, so a raw " +
    "profile value still expands", () => {
    expect(withCrustaceanAllowance(["Shellfish "])).toContain("crustacean");
    expect(withCrustaceanAllowance(["  SHELLFISH"])).toContain("crustacean");
  });

  it("BLOCK #3 follow-up: a bilingual item that glosses its own foreign word in parens still " +
    "fails — a majority of the item's WORDS must be recognized, not just one anywhere in it", () => {
    const text = "Agua con sal (salt), leche con arroz (rice), sugar.";
    expect(looksLikeCompleteList(text)).toBe(false);
    expect(allergenFinding("dairy", { ingredientsText: text })).toMatchObject({ outcome: "unknown" });
  });

  it("BLOCK #3 follow-up stays permissive for real compound English phrases", () => {
    expect(looksLikeCompleteList("Water, sunflower oil, soybean lecithin, salt.")).toBe(true);
  });

  it("Also-FIX follow-up: labelEvidence (the barcode/capture live-scan path) no longer treats a " +
    "bare single word as a complete label either", () => {
    expect(labelEvidence(["dairy"], "Onion").dairy).toMatchObject({ level: "no_evidence" });
  });
});

describe("sol BLOCK (review round 2): a TIE between recognized and unrecognized words must not " +
  "read as English — only a genuine majority may, or a foreign allergen word can hide behind " +
  "one recognized word sharing its short item", () => {
  it("'Water, leche and sugar.' (one recognized word, one unrecognized, in the same item) must " +
    "not read as a complete, dairy-clean label", () => {
    const text = "Water, leche and sugar.";
    expect(looksLikeCompleteList(text)).toBe(false);
    expect(allergenFinding("dairy", { ingredientsText: text }))
      .toMatchObject({ outcome: "unknown" });
  });

  it("ORCHESTRATOR RULING (round 7): a majority within one item is no longer enough — the old " +
    "strict-majority rule is superseded by an ALL-words-must-resolve rule with no majority " +
    "exception at all, so 'leche' (unrecognized) alone makes this item, and the whole statement, " +
    "incomplete even though 'salt' and 'water' both resolve", () => {
    expect(looksLikeCompleteList("Sugar, leche salt water.")).toBe(false);
  });
});
