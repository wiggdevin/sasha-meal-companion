/**
 * UI makeover W8 §7.3: the Ingredients deck's Jev order (lib/server/shopping-build-rank.ts, purpose
 * `shopping-build-rank`). Jev may only reorder: every input id comes back exactly once, nothing
 * else is admitted, an omitted id keeps its input place after the rated ones, and any Jev failure
 * is the plain order with app provenance. The payload carries the food names under the builder's
 * own positional ids, and nothing else: no caller id, budget, place, country or profile field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

import { CALL_REGISTRY } from "@/lib/ai/call-registry";
import { jevCarriesHealth, jevProvenance, shoppingRankPayload } from "@/lib/ai/payloads";
import type { ScoreAnswer } from "@/lib/ai/jev-types";
import {
  rankShoppingCandidates, reorderOnly, type ShoppingRankPort, type ShoppingRankRequest,
} from "@/lib/server/shopping-build-rank";

afterEach(() => { vi.unstubAllEnvs(); });

const USER = "00000000-0000-4000-8000-000000000001";
const REQUEST: ShoppingRankRequest = { candidates: [
  { id: "food:11111111-1111-4111-8111-111111111111", name: "Saffron" },
  { id: "catalog:42", name: "Eggs" },
  { id: "food:22222222-2222-4222-8222-222222222222", name: "Spinach" },
  { id: "universe:oat", name: "Rolled oats" },
] };
const ids = REQUEST.candidates.map((c) => c.id);
const answer = (score: number, confidence = 0.9): ScoreAnswer => ({
  type: "score", score, confidence, legend: { 0: "a", 1: "b", 2: "c" }, probabilities: { 0: 0, 1: 0, 2: 1 },
});
const JEV = { ai: true, source: "jev", purpose: "shopping-build-rank" };
const APP = { ai: false, source: "app" };

describe("the purpose", () => {
  it("is registered for Jev as D1 with its one builder", () => {
    expect(CALL_REGISTRY["shopping-build-rank"]).toEqual(
      { provider: "typesafe", dataClass: "D1", builder: "shoppingRankPayload" });
    expect(jevProvenance(shoppingRankPayload({ names: ["Eggs"] }))).toBe("shopping-build-rank");
  });

  it("the payload is the names under positional ids and one fixed question each", () => {
    const payload = shoppingRankPayload({ names: REQUEST.candidates.map((c) => c.name) });
    expect(payload.state).toEqual({ foods: [
      { id: "f0", name: "Saffron" }, { id: "f1", name: "Eggs" }, { id: "f2", name: "Spinach" },
      { id: "f3", name: "Rolled oats" }] });
    expect(Object.keys(payload.questions as object)).toEqual(["buy_0", "buy_1", "buy_2", "buy_3"]);
  });

  it("carries no budget, place, country, caller id, profile or health field, even when smuggled", () => {
    const smuggled = { names: ["Eggs"], budget: 80, currency: "USD", area: "94110", zip: "94110",
      country: "US", country_code: "US", lat: 37.76, lon: -122.41, sex: "female", birth_year: 1990,
      conditions: ["kidney disease"], ids: ["food:secret"], userId: USER };
    const text = JSON.stringify(shoppingRankPayload(smuggled as unknown as { names: string[] }));
    for (const needle of ["budget", "80", "USD", "94110", "\"US\"", "country", "37.76", "-122.41", "female",
      "sex", "1990", "kidney", "condition", "food:secret", USER, "lat", "lon"]) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it("takes 1 to 30 names", () => {
    expect(() => shoppingRankPayload({ names: [] })).toThrow();
    expect(() => shoppingRankPayload({ names: Array.from({ length: 31 }, (_, i) => `Food ${i}`) })).toThrow();
    expect(() => shoppingRankPayload({ names: Array.from({ length: 30 }, (_, i) => `Food ${i}`) })).not.toThrow();
  });

  it("OD12: with the health gate on, a name the local check does not clear goes as \"a food\"", () => {
    vi.stubEnv("JEV_HEALTH_GATE", "1");
    const gated = shoppingRankPayload({ names: ["Eggs", "Kerrygold butter"] });
    expect(gated.state).toEqual({ foods: [{ id: "f0", name: "Eggs" }, { id: "f1", name: "a food" }] });
    expect(jevCarriesHealth(gated)).toBe(false);
    vi.unstubAllEnvs();
    const open = shoppingRankPayload({ names: ["Eggs", "Kerrygold butter"] });
    expect(JSON.stringify(open.state)).toContain("Kerrygold butter");
    expect(jevCarriesHealth(open)).toBe(true);
    expect(jevCarriesHealth(shoppingRankPayload({ names: ["Eggs", "Spinach"] }))).toBe(false);
  });
});

describe("reorderOnly", () => {
  it("never admits an unknown id, never repeats one, and appends what was left out in input order", () => {
    expect(reorderOnly(["a", "b", "c", "d"], ["c", "zzz", "a", "c", 7, null, "a"])).toEqual(["c", "a", "b", "d"]);
    expect(reorderOnly(["a", "b"], [])).toEqual(["a", "b"]);
    expect(reorderOnly(["a", "b"], ["x", "y"])).toEqual(["a", "b"]);
  });
});

describe("rankShoppingCandidates", () => {
  it("sorts by Jev's staple score, highest first, with jev provenance", async () => {
    const port: ShoppingRankPort = vi.fn(async () => ({
      buy_0: answer(0), buy_1: answer(2), buy_2: answer(1), buy_3: answer(2),
    }));
    const result = await rankShoppingCandidates(REQUEST, USER, port);
    expect(result).toEqual({ order: [ids[1], ids[3], ids[2], ids[0]], provenance: JEV });
    expect(port).toHaveBeenCalledWith(expect.anything(), { userId: USER, deadlineMs: 3_000 });
  });

  it("never sends the caller's ids to Jev", async () => {
    const port = vi.fn<ShoppingRankPort>(async () => null);
    await rankShoppingCandidates(REQUEST, USER, port);
    const sent = JSON.stringify(port.mock.calls[0][0]);
    for (const id of ids) expect(sent).not.toContain(id);
  });

  it("keeps every input id exactly once: an unrated or unsure food keeps its input place after the rated", async () => {
    const port: ShoppingRankPort = vi.fn(async () => ({
      buy_0: answer(2, 0.3), buy_1: answer(1), buy_2: answer(2), buy_3: answer(0, 0.2),
      buy_9: answer(2), extra: answer(2),
    }) as unknown as Record<string, ScoreAnswer>);
    const result = await rankShoppingCandidates(REQUEST, USER, port);
    expect(result.order).toEqual([ids[2], ids[1], ids[0], ids[3]]);
    expect([...result.order].sort()).toEqual([...ids].sort());
    expect(result.provenance).toEqual(JEV);
  });

  it("an answer with no usable score is the plain order with app provenance", async () => {
    const port: ShoppingRankPort = vi.fn(async () => ({ buy_0: answer(2, 0.1) }));
    expect(await rankShoppingCandidates(REQUEST, USER, port)).toEqual({ order: ids, provenance: APP });
  });

  it("Jev down (null: no key, timeout, open circuit, spend cap) → plain order, app provenance", async () => {
    expect(await rankShoppingCandidates(REQUEST, USER, vi.fn(async () => null)))
      .toEqual({ order: ids, provenance: APP });
  });

  it("a port that throws → plain order, app provenance", async () => {
    expect(await rankShoppingCandidates(REQUEST, USER, vi.fn(async () => { throw new Error("boom"); })))
      .toEqual({ order: ids, provenance: APP });
  });

  it("the real systemOne with no TYPESAFE_API_KEY makes no request and answers the plain order", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await rankShoppingCandidates(REQUEST, USER)).toEqual({ order: ids, provenance: APP });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
