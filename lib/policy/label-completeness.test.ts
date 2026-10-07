/**
 * Phase 13 §9 R1, ORCHESTRATOR RULING (round 7): the one strict predicate every allergen-evidence
 * path uses to decide whether a label statement is COMPLETE. See lib/policy/label-completeness.ts
 * for the five conditions. Table-driven per the ruling's own required cases.
 */
import { describe, expect, it } from "vitest";
import { isCompleteLabelStatement } from "@/lib/policy/label-completeness";

const verbatim = (text: string | null) => isCompleteLabelStatement({ text, verbatim: true });

describe("isCompleteLabelStatement: the ORCHESTRATOR's required table", () => {
  it.each<[string, string | null, boolean]>([
    ["a garbled token ('???') makes the whole statement incomplete, no majority rule",
      "Water, ???, salt.", false],
    ["a foreign, unrecognized word ('leche') makes the whole statement incomplete",
      "Sugar, leche salt water.", false],
    ["a garbled token adjacent to a real word in the same item ('??? salt') makes the whole " +
      "statement incomplete — it must not be dropped as a non-word and let the real word carry " +
      "the item",
      "Water, ??? salt, sugar.", false],
    ["a cropped 'may contain' with nothing after it is not a terminator",
      "Water, sugar, may contain", false],
    ["a cropped 'Contains.' — the trailing period sits right after an empty Contains clause — is " +
      "not a terminator; the period must not short-circuit past an unnamed Contains/May-contain " +
      "clause",
      "Water, sugar, salt, natural flavor. Contains.", false],
    ["a cropped 'May contain.' — same crop, 'May contain' spelling — is not a terminator",
      "Water, sugar, salt. May contain.", false],
    ["one word alone never clears the three-item floor, however short and terminated",
      "Water", false],
    ["a complete, terminated, three-item statement followed by a Contains clause naming " +
      "something is complete",
      "Sugar, salt, natural flavor. Contains: soy.", true],
  ])("%s: %j -> %s", (_label, text, expected) => {
    expect(verbatim(text)).toBe(expected);
  });

  it("a joined list of parsed ingredient NAMES (no raw_text) is incomplete regardless of shape " +
    "— condition (a), verbatim only", () => {
    expect(isCompleteLabelStatement({
      text: "Sugar, salt, natural flavor. Contains: soy.", verbatim: false,
    })).toBe(false);
  });

  it("a text that arrived through a lossy path is incomplete even when verbatim and otherwise " +
    "well-formed — condition (e)", () => {
    expect(isCompleteLabelStatement({
      text: "Sugar, salt, natural flavor. Contains: soy.", verbatim: true, lossy: true,
    })).toBe(false);
  });
});

describe("isCompleteLabelStatement: the individual conditions", () => {
  it("(b) a final period terminates a three-item list", () => {
    expect(verbatim("Water, rice flour, salt.")).toBe(true);
  });

  it("(b) no terminator at all fails, even with three-plus items and a recognized vocabulary", () => {
    expect(verbatim("Water, rice flour, salt")).toBe(false);
  });

  it("(b) a 'May contain' clause that names something is a terminator", () => {
    expect(verbatim("Water, rice flour, salt. May contain milk")).toBe(true);
  });

  it("(b) a trailing '!' alone is not a terminator — only a final period or a Contains/May " +
    "contain clause naming something counts", () => {
    expect(verbatim("Water, rice flour, salt!")).toBe(false);
  });

  it("(b) a Contains clause left unnamed is not a terminator even though the statement ends in " +
    "a period", () => {
    expect(verbatim("Water, rice flour, salt. Contains.")).toBe(false);
  });

  it("(c) two items, even terminated, never clears the three-item floor", () => {
    expect(verbatim("Water, sugar.")).toBe(false);
  });

  it("(c) three items clears the floor once terminated", () => {
    expect(verbatim("Water, rice flour, salt.")).toBe(true);
  });

  it("(d) an empty item (a stray double comma) is never resolved", () => {
    expect(verbatim("Water, , salt.")).toBe(false);
  });

  it("(d) every word of every item must resolve — a bilingual gloss in parens does not save it",
    () => {
      expect(verbatim("Agua con sal (salt), leche con arroz (rice), sugar.")).toBe(false);
    });

  it("null/empty/too-short text is never complete", () => {
    expect(verbatim(null)).toBe(false);
    expect(verbatim("")).toBe(false);
    expect(verbatim("  ")).toBe(false);
  });
});
