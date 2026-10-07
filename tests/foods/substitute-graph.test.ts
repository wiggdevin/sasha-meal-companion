/**
 * Phase 18 W1b and W4: the typed substitute graph (docs/specs/phase-18-open-world-foods.md D8
 * part 4). Every edge joins two universe foods that share a plate part, carries only licence-safe
 * terms, scores sub = 0.40 tax + 0.25 nutr + 0.15 ctx with the absent terms adding nothing, and no
 * food keeps more than eight neighbours. `ctx` comes from the FNDDS dish ingredient lists (W4
 * acceptance 4) and the manifest names its source and licence.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE } from "@/lib/foods/universe/prior";
import { parseManifest, parseSubstituteGraph } from "@/lib/foods/universe/artifact-schema";
import { MAX_NEIGHBOURS, neighboursOf, substituteScore } from "@/lib/foods/universe/substitutes";

const items = new Map(UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null)
  .map((item) => [item.entry.id, item]));
const raw = JSON.parse(readFileSync(path.join(ARTIFACT_DIR, GRAPH_FILE), "utf8"));
const graph = parseSubstituteGraph(raw, new Set(items.keys()))!;

describe("the substitute graph", () => {
  it("parses under the strict schema with universe keys only", () => {
    expect(graph).not.toBeNull();
    expect(graph.type).toBe("substitute");
    expect(graph.edges.length).toBeGreaterThan(items.size);
  });

  it("keeps the withheld terms absent and recomputes every score from its terms", () => {
    expect([...graph.absent].sort()).toEqual(["comp", "like"]);
    for (const edge of graph.edges) {
      expect(edge.like ?? edge.comp).toBeUndefined();
      expect(edge.sub).toBe(substituteScore({ tax: edge.tax, nutr: edge.nutr, ctx: edge.ctx }));
      expect(edge.sub).toBeLessThanOrEqual(0.8);
    }
  });

  it("carries ctx from the FNDDS dish ingredient lists, and the manifest names its source and licence (W4)", () => {
    const withCtx = graph.edges.filter((edge) => edge.ctx !== undefined);
    expect(withCtx.length).toBeGreaterThan(500);
    for (const edge of withCtx) expect(edge.ctx).toBeGreaterThan(0);
    const manifest = parseManifest(JSON.parse(readFileSync(path.join(ARTIFACT_DIR, MANIFEST_FILE), "utf8")))!;
    expect(manifest.graph.terms.ctx).toEqual({ sources: ["fndds-2021-2023"], licences: ["cc0-1.0"] });
    expect(manifest.sources.find((source) => source.id === "fndds-2021-2023")?.licence).toBe("cc0-1.0");
    expect(manifest.graph.context.dishes).toBeGreaterThan(1000);
    // Beans that go into the same dishes are context neighbours.
    expect(neighboursOf(graph, "black-beans-cooked").find((edge) => edge.to === "pinto-beans-cooked")?.ctx)
      .toBeGreaterThan(0.5);
  });

  it("joins only foods that share a plate part, at most eight per food", () => {
    for (const edge of graph.edges) {
      const from = items.get(edge.from)!, to = items.get(edge.to)!;
      expect(from.parts.some((part) => to.parts.includes(part))).toBe(true);
    }
    for (const key of items.keys()) expect(neighboursOf(graph, key).length).toBeLessThanOrEqual(MAX_NEIGHBOURS);
  });

  it("links bison to other red meats by taxonomy and nutrients", () => {
    const near = neighboursOf(graph, "bison-cooked").map((edge) => edge.to);
    expect(near.some((key) => /lamb|beef|steak|goat|veal/.test(key))).toBe(true);
  });

  it("rejects an extra top-level field, an edge with an extra field or a ninth neighbour", () => {
    expect(parseSubstituteGraph({ ...raw, respondents: [{ id: 1 }] })).toBeNull();
    expect(parseSubstituteGraph({ ...raw, edges: [{ ...raw.edges[0], cooccur: 0.3 }] })).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => ({ from: "a", to: `b${i}`, sub: 0.3, tax: 0.5, nutr: 0.4 }));
    expect(parseSubstituteGraph({ ...raw, edges: nine })).toBeNull();
  });
});
