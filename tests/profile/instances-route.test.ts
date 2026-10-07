/**
 * Phase 13 slice 4: app/api/profile/instances — the server boundary onboarding and the chat
 * confirm card write through (never a direct table write from the client). RLS-scoped `client`
 * from requireUser, same pattern as app/api/expenditure/route.ts; no admin client, so this route
 * needs no tests/tenancy/admin-entry-points.json entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const readAccountProfileInstances = vi.fn();
const mergeAccountProfileInstance = vi.fn();
/** What the account already has stored for the profile a PUT names (null: no row yet). */
const stored = { value: null as unknown };
const built: { input: Record<string, unknown> & { rules: Record<string, unknown>[] } }[] = [];
const deleteAccountProfileInstance = vi.fn();
const legacyBackedProfileIds = vi.fn();

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({
  enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a),
}));
vi.mock("@/lib/server/dietary-profiles", () => ({
  readAccountProfileInstances: (...a: unknown[]) => readAccountProfileInstances(...a),
  mergeAccountProfileInstance: (...a: unknown[]) => mergeAccountProfileInstance(...a),
  deleteAccountProfileInstance: (...a: unknown[]) => deleteAccountProfileInstance(...a),
  legacyBackedProfileIds: (...a: unknown[]) => legacyBackedProfileIds(...a),
}));

const { GET, PUT, DELETE } = await import("@/app/api/profile/instances/route");
const { HttpError } = await import("@/lib/server/auth");

const NOW = "2026-09-24T00:00:00.000Z";

function putRequest(body: unknown): Request {
  return new Request("https://x.test/api/profile/instances", {
    method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.useFakeTimers().setSystemTime(new Date(NOW));
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  readAccountProfileInstances.mockReset().mockResolvedValue([]);
  stored.value = null;
  built.length = 0;
  mergeAccountProfileInstance.mockReset().mockImplementation(
    async (_client, _userId, _profileId, build: (s: unknown) => typeof built[0]["input"]) => {
      const input = build(stored.value);
      built.push({ input });
      return input;
    });
  deleteAccountProfileInstance.mockReset().mockResolvedValue(undefined);
  legacyBackedProfileIds.mockReset().mockResolvedValue(new Set());
});

describe("GET /api/profile/instances", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await GET(new Request("https://x.test/api/profile/instances"))).status).toBe(401);
  });

  it("returns the account's merged instances scoped to the signed-in user", async () => {
    readAccountProfileInstances.mockResolvedValue([{ profileId: "vegan" }]);
    const res = await GET(new Request("https://x.test/api/profile/instances"));
    expect(readAccountProfileInstances).toHaveBeenCalledWith({}, "u1");
    await expect(res.json()).resolves.toMatchObject({ instances: [{ profileId: "vegan" }] });
  });

  it("names the profiles a legacy flag keeps active, so the picker offers no Remove for them", async () => {
    legacyBackedProfileIds.mockResolvedValue(new Set(["halal"]));
    const res = await GET(new Request("https://x.test/api/profile/instances"));
    await expect(res.json()).resolves.toMatchObject({ legacyProfileIds: ["halal"] });
  });

  it("carries the catalog's plain-language summaries alongside the instances", async () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "1");
    const res = await GET(new Request("https://x.test/api/profile/instances"));
    const body = await res.json() as { catalog: { id: string }[] };
    expect(body.catalog.length).toBeGreaterThan(100);
    expect(body.catalog.some((p) => p.id === "vegan")).toBe(true);
  });

  it("offers no condition pack while CONDITION_PACKS_ENABLED is off (§4)", async () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "");
    const res = await GET(new Request("https://x.test/api/profile/instances"));
    const body = await res.json() as { catalog: { id: string; category: string }[] };
    expect(body.catalog.some((p) => p.id === "g6pd_deficiency")).toBe(false);
    expect(body.catalog.some((p) => ["medical_condition", "clinician_directive"]
      .includes(p.category))).toBe(false);
  });

  it("offers the condition packs once the flag is on", async () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "1");
    const res = await GET(new Request("https://x.test/api/profile/instances"));
    const body = await res.json() as { catalog: { id: string }[] };
    expect(body.catalog.some((p) => p.id === "g6pd_deficiency")).toBe(true);
  });
});

describe("PUT /api/profile/instances", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await PUT(putRequest({ profileId: "vegan", confirmations: [] }))).status).toBe(401);
  });

  it("404s an id the catalog does not carry", async () => {
    const res = await PUT(putRequest({ profileId: "not_a_real_profile", confirmations: [] }));
    expect(res.status).toBe(404);
    expect(mergeAccountProfileInstance).not.toHaveBeenCalled();
  });

  it("confirms every non-medical hard item a single explicit tap names", async () => {
    const res = await PUT(putRequest({
      profileId: "allergy_peanut",
      confirmations: [{ facet: "contains_peanut", confirmed: true }],
    }));
    expect(res.status).toBe(200);
    const [, userId, profileId] = mergeAccountProfileInstance.mock.calls[0];
    const { input } = built[0];
    expect(userId).toBe("u1");
    expect(profileId).toBe("allergy_peanut");
    expect(input.profileId).toBe("allergy_peanut");
    expect(input.confirmedAt).toBe(NOW);
    expect(input.rules).toEqual([expect.objectContaining({
      facet: "contains_peanut", confirmation: "confirmed",
    })]);
  });

  it("404s a condition pack while CONDITION_PACKS_ENABLED is off, whatever the client sends", async () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "");
    const res = await PUT(putRequest({
      profileId: "g6pd_deficiency", confirmations: [{ facet: "fava_bean", confirmed: true }],
    }));
    expect(res.status).toBe(404);
    expect(mergeAccountProfileInstance).not.toHaveBeenCalled();
  });

  it("a medical item stays unconfirmed unless its own facet is named confirmed (R5)", async () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "1");
    // g6pd_deficiency is a user_confirmed_safety (medical) profile — nothing here confirms it.
    await PUT(putRequest({ profileId: "g6pd_deficiency", confirmations: [] }));
    const { input } = built[0];
    for (const rule of input.rules) {
      if (rule.strength === "never" && rule.hardBasis === "user_confirmed_safety") {
        expect(rule.confirmation).not.toBe("confirmed");
      }
    }
  });

  it("merges one medical tap into the stored row, never un-confirming an earlier tap", async () => {
    // pregnancy: alcohol and unpasteurized are separate user_confirmed_safety items, each its own
    // tap and its own request — the second must not wipe the first (sol BLOCK, p13-s4 review).
    stored.value = { profileId: "pregnancy", rules: [
      { facet: "alcohol", confirmation: "confirmed" },
      { facet: "high_mercury_fish", confirmation: "declined" },
    ] };
    await PUT(putRequest({
      profileId: "pregnancy", confirmations: [{ facet: "unpasteurized", confirmed: true }],
    }));
    const byFacet = new Map(built[0].input.rules.map((rule) => [rule.facet, rule.confirmation]));
    expect(byFacet.get("alcohol")).toBe("confirmed");
    expect(byFacet.get("unpasteurized")).toBe("confirmed");
    expect(byFacet.get("high_mercury_fish")).toBe("declined");
    expect(byFacet.get("high_listeria_risk")).toBe("unconfirmed");
  });

  it("an explicit decline in the request overrides an earlier stored confirmation", async () => {
    stored.value = { profileId: "pregnancy", rules: [{ facet: "alcohol", confirmation: "confirmed" }] };
    await PUT(putRequest({
      profileId: "pregnancy", confirmations: [{ facet: "alcohol", confirmed: false }],
    }));
    const alcohol = built[0].input.rules.find((rule) => rule.facet === "alcohol");
    expect(alcohol?.confirmation).toBe("declined");
  });

  it("stores a variant over the stored choices and the catalog defaults", async () => {
    stored.value = { profileId: "halal", rules: [], options: { no_non_fish_seafood: true } };
    const res = await PUT(putRequest({
      profileId: "halal", confirmations: [], options: { no_carmine: true },
    }));
    expect(res.status).toBe(200);
    expect(built[0].input.options).toEqual({
      zabiha_meat_only: true, no_non_fish_seafood: true, no_carmine: true,
    });
  });

  it("rejects a variant the profile does not offer as yes/no", async () => {
    for (const options of [{ not_an_option: true }, { gelatin_rule: true }]) {
      const res = await PUT(putRequest({ profileId: "halal", confirmations: [], options }));
      expect(res.status).toBe(400);
    }
    expect(mergeAccountProfileInstance).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised confirmation facet rather than silently dropping it", async () => {
    const res = await PUT(putRequest({
      profileId: "vegan", confirmations: [{ facet: "not_a_real_facet", confirmed: true }],
    }));
    expect(res.status).toBe(400);
    expect(mergeAccountProfileInstance).not.toHaveBeenCalled();
  });
});

describe("PUT /api/profile/instances — food preference (slice 7)", () => {
  it("writes a prefer rule under the shared food_preferences profile, never a catalog lookup", async () => {
    const res = await PUT(putRequest({
      foodPreference: { foodName: "Salmon", strength: "prefer", confirmed: true },
    }));
    expect(res.status).toBe(200);
    const [, userId, profileId] = mergeAccountProfileInstance.mock.calls[0];
    expect(userId).toBe("u1");
    expect(profileId).toBe("food_preferences");
    const { input } = built[0];
    expect(input.profileId).toBe("food_preferences");
    expect(input.rules).toEqual([expect.objectContaining({
      facet: "food_named:salmon", strength: "prefer", hardBasis: null, confirmation: "confirmed",
    })]);
  });

  it("writes an avoid rule that never carries a hard basis", async () => {
    const res = await PUT(putRequest({
      foodPreference: { foodName: "cilantro", strength: "avoid", confirmed: true },
    }));
    expect(res.status).toBe(200);
    expect(built[0].input.rules[0]).toMatchObject({
      facet: "food_named:cilantro", strength: "avoid", hardBasis: null,
    });
  });

  it("merges under the rev CAS: replaces the same food, keeps a sibling food's rule", async () => {
    const rule = (food: string, strength: string) => ({
      id: `food_preferences::food_named:${food}`, profileId: "food_preferences",
      facet: `food_named:${food}`, strength, hardBasis: null,
      evidenceStrength: "user_rule", confirmation: "confirmed", expiresAt: null,
    });
    stored.value = {
      profileId: "food_preferences", source: "user_stated", confirmedAt: NOW, options: {},
      rules: [rule("cilantro", "avoid"), rule("olives", "avoid")],
    };
    await PUT(putRequest({
      foodPreference: { foodName: "cilantro", strength: "prefer", confirmed: true },
    }));
    expect(built[0].input.rules).toEqual([
      expect.objectContaining({ facet: "food_named:olives", strength: "avoid" }),
      expect.objectContaining({ facet: "food_named:cilantro", strength: "prefer" }),
    ]);
  });

  it("a declined confirmation is stored declined, not silently dropped", async () => {
    await PUT(putRequest({
      foodPreference: { foodName: "olives", strength: "avoid", confirmed: false },
    }));
    expect(built[0].input.rules[0]).toMatchObject({ confirmation: "declined" });
  });
});

describe("DELETE /api/profile/instances", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    const res = await DELETE(new Request("https://x.test/api/profile/instances?profileId=vegan",
      { method: "DELETE" }));
    expect(res.status).toBe(401);
  });

  it("removes the named profile for the signed-in user only", async () => {
    const res = await DELETE(new Request("https://x.test/api/profile/instances?profileId=vegan",
      { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(deleteAccountProfileInstance).toHaveBeenCalledWith({}, "u1", "vegan");
  });

  it("409s a profile a legacy preference flag keeps active, instead of a Remove that comes back", async () => {
    legacyBackedProfileIds.mockResolvedValue(new Set(["halal"]));
    const res = await DELETE(new Request("https://x.test/api/profile/instances?profileId=halal",
      { method: "DELETE" }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "legacy_flag" });
    expect(legacyBackedProfileIds).toHaveBeenCalledWith({}, "u1");
    expect(deleteAccountProfileInstance).not.toHaveBeenCalled();
  });

  it("400s with no profileId", async () => {
    const res = await DELETE(new Request("https://x.test/api/profile/instances",
      { method: "DELETE" }));
    expect(res.status).toBe(400);
  });
});
