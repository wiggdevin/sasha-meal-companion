import { describe, expect, it } from "vitest";
import { expandQuery } from "@/lib/search/query";
import { MISS_QUERIES, readSynonymsCsv, synonymMap } from "./recall-shared";

const SYNONYMS = new Map<string, string>([
  ["albacore", "tuna white"],
  ["canned albacore", "tuna white canned"],
  ["egg", "egg whole"],
  ["egg whites", "egg white raw"],
  ["chkn", "chicken"],
  ["brst", "breast"],
]);

describe("expandQuery", () => {
  it("returns the normalised query when nothing matches", () => {
    expect(expandQuery("grilled halibut", SYNONYMS)).toBe("grilled halibut");
  });

  it("lowercases and strips accents before matching", () => {
    expect(expandQuery("  ALBACORE  ", SYNONYMS)).toBe("tuna white");
    expect(expandQuery("Crème", SYNONYMS)).toBe("creme");
  });

  it("replaces each matching token", () => {
    expect(expandQuery("chkn brst", SYNONYMS)).toBe("chicken breast");
  });

  it("prefers a two-word term over its first token", () => {
    expect(expandQuery("egg whites", SYNONYMS)).toBe("egg white raw");
    expect(expandQuery("egg", SYNONYMS)).toBe("egg whole");
  });

  it("consumes both tokens of a matched pair", () => {
    expect(expandQuery("canned albacore chkn", SYNONYMS)).toBe("tuna white canned chicken");
  });

  it("does not expand an expansion a second time", () => {
    expect(expandQuery("albacore", new Map([["albacore", "egg"], ["egg", "egg whole"]]))).toBe("egg");
  });

  it("collapses runs of whitespace and returns empty for an empty query", () => {
    expect(expandQuery("chkn\t\n brst", SYNONYMS)).toBe("chicken breast");
    expect(expandQuery("   ", SYNONYMS)).toBe("");
  });
});

const SOURCES = ["miss", "typo", "unresolved", "guard", "kitchen"];

/**
 * "chicken thigh roasted" is exempt from the synonym-changes-every-miss check (controller
 * ruling A, 2026-09-11): `parseQuery` lifts "roasted" as a prep word before the RPC ever
 * sees the string, so this miss reaches SQL as "chicken thigh" — the same string as the
 * passing label "chicken thigh". A synonym keyed on "chicken thigh" cannot change one
 * without changing the other, so no CSV row can fix this miss without breaking a pass.
 */
const VOCAB_EXEMPT = ["chicken thigh roasted"];

/** The 5 with no row in any imported source. "mct oil" is deliberately left unmapped. */
const UNRESOLVED_QUERIES = ["jasmine rice", "avocado mayo", "fruit pouch", "mct oil", "duck fat"];

describe("docs/catalog/synonyms.csv", () => {
  const rows = readSynonymsCsv();

  it("carries at least 40 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it("keeps every term lowercase, unaccented and one or two tokens", () => {
    for (const r of rows) {
      expect(r.term).toBe(r.term.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
      expect(r.term.trim()).toBe(r.term);
      expect(r.term.split(" ").length).toBeLessThanOrEqual(2);
      expect(r.term.length).toBeGreaterThan(0);
      expect(r.expansion.trim()).toBe(r.expansion);
      expect(r.expansion.length).toBeGreaterThan(0);
      expect(SOURCES).toContain(r.source);
    }
  });

  it("names each term once", () => {
    expect(new Set(rows.map((r) => r.term)).size).toBe(rows.length);
  });

  it("never expands a term into itself", () => {
    for (const r of rows) expect(r.expansion).not.toBe(r.term);
  });

  it("changes every miss query in relevance.md", () => {
    const map = synonymMap();
    for (const q of MISS_QUERIES.filter((q) => !VOCAB_EXEMPT.includes(q))) {
      expect(expandQuery(q, map), `"${q}" is unchanged`).not.toBe(expandQuery(q, new Map()));
    }
  });

  it("changes every unresolved query except mct oil, which stays unmapped on purpose", () => {
    const map = synonymMap();
    for (const q of UNRESOLVED_QUERIES.filter((x) => x !== "mct oil")) {
      expect(expandQuery(q, map), `"${q}" is unchanged`).not.toBe(expandQuery(q, new Map()));
    }
    expect(expandQuery("mct oil", map)).toBe("mct oil");
  });
});
