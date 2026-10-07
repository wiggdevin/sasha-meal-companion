import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSuggestionEvidenceMock } = vi.hoisted(() => ({
  loadSuggestionEvidenceMock: vi.fn(),
}));

vi.mock("@/lib/coach/suggest-policy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/suggest-policy")>(),
  loadSuggestionEvidence: loadSuggestionEvidenceMock,
}));
vi.mock("@/lib/server/log-duplicates", () => ({ recordFingerprint: vi.fn() }));
vi.mock("@/lib/server/day-totals", () => ({
  dayTotals: vi.fn(async () => ({ local_date: "2026-09-20", nutrients: [], micro_coverage_pct: 0 })),
}));

const { applyLogEntry } = await import("@/lib/server/log");

type Row = Record<string, unknown>;
const FOOD_REF = "00000000-0000-4000-8000-000000000003";

const rows: Record<string, Row[]> = {
  food_refs: [{ id: FOOD_REF }],
  catalog_ingredients: [{ food_revision_id: 467, allergen_tags: ["soy"] }],
  catalog_food_revisions: [{ id: 467, is_active: true }],
  user_food_prefs: [],
  media_objects: [],
  log_items: [{
    id: "00000000-0000-4000-8000-000000000002",
    entry_id: "00000000-0000-4000-8000-000000000001",
    seq: 0,
    food_ref_id: FOOD_REF,
    qty: 1,
    unit: "g",
    grams: 100,
    portion_id: null,
    food_revision_id: 467,
    was_edited: false,
    confidence: null,
    snapshot: {},
  }],
};

function client(opts: { userSettingsFails?: boolean; flags?: unknown } = {}) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table === "constraint_profiles") return { data: null, error: null };
        if (table === "user_settings") {
          if (opts.userSettingsFails) return { data: null, error: { message: "boom" } };
          return { data: { diet_prefs: { flags: "flags" in opts ? opts.flags : ["no_soy", "not-a-real-flag"] } }, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    });
    return chain;
  });
  return {
    from,
    rpc: vi.fn(async (name: string) => name === "apply_sync_op"
      ? { data: { status: "applied", rev: 1 }, error: null }
      : { data: null, error: null }),
  } as never;
}

describe("log commit policy when facet evidence is unavailable", () => {
  beforeEach(() => {
    loadSuggestionEvidenceMock.mockReset().mockResolvedValue({
      status: "unavailable", preferenceFlags: [], byIdentity: {},
    });
  });

  it("marks from normalized base preferences and still commits without throwing", async () => {
    const result = await applyLogEntry(client(), "user-1", {
      entry_id: "00000000-0000-4000-8000-000000000001",
      eaten_at: "2026-09-20T12:00:00.000Z",
      tz: "UTC",
      local_date: "2026-09-20",
      slot: "meal-2",
      method: "search",
      items: [{
        id: "00000000-0000-4000-8000-000000000002",
        seq: 0,
        food_ref_id: FOOD_REF,
        food_revision_id: 467,
        qty: 1,
        unit: "g",
        grams: 100,
      }],
    });

    expect(result).toMatchObject({
      status: "ok",
      flagged: [{ path: "items.0", message: "blocked:allergen:soy" }],
    });
  });

  /**
   * Owner ruling (2026-10-02): diet preference flags fail safe. loadCallerPreferenceFlags used to
   * destructure only `data` off the `user_settings` read, ignoring `error` entirely, and its
   * surrounding try/catch answered `[]` either way — so a failed read was indistinguishable from
   * "this account has no diet preferences at all" and the item above logged `allowed` with no
   * mark, even though its evidence (soy) could not be checked against whatever the account's real
   * flags are. A failed read now answers null, and the commit marks every item unverified for
   * "food_rules" instead of silently judging against an empty preference list.
   */
  it("marks every item unverified for food rules when the preference-flags read fails", async () => {
    const result = await applyLogEntry(client({ userSettingsFails: true }), "user-1", {
      entry_id: "00000000-0000-4000-8000-000000000001",
      eaten_at: "2026-09-20T12:00:00.000Z",
      tz: "UTC",
      local_date: "2026-09-20",
      slot: "meal-2",
      method: "search",
      items: [{
        id: "00000000-0000-4000-8000-000000000002",
        seq: 0,
        food_ref_id: FOOD_REF,
        food_revision_id: 467,
        qty: 1,
        unit: "g",
        grams: 100,
      }],
    });

    // user_settings also backs the legacy-flag synthesis readPolicyProfile reads
    // (lib/server/dietary-profiles.ts readLegacySettings), so the same outage fails BOTH fail-safe
    // paths at once: the diet-preference-flags fallback above, and the profile hard-rules read
    // (lib/server/log.ts loadCallerProfile) added for item 4's fix. Each reports its own notice.
    expect(result).toMatchObject({
      status: "ok",
      flagged: [
        { path: "items.0", message: "unverified:food_rules:Your food rules could not be checked." },
        { path: "items.0", message: "unverified:profile_rules:Your account's food rules could not be checked." },
      ],
    });
  });

  /** Grok audit round 9: `{ "flags": "halal" }` used to read as no flags at all. */
  it("marks food rules unverified when stored flags are not a list", async () => {
    const result = await applyLogEntry(client({ flags: "halal" }), "user-1", {
      entry_id: "00000000-0000-4000-8000-000000000001", eaten_at: "2026-09-20T12:00:00.000Z",
      tz: "UTC", local_date: "2026-09-20", slot: "meal-2", method: "search",
      items: [{ id: "00000000-0000-4000-8000-000000000002", seq: 0, food_ref_id: FOOD_REF,
        food_revision_id: 467, qty: 1, unit: "g", grams: 100 }],
    } as never);
    expect(JSON.stringify(result)).toContain("unverified:food_rules");
  });
});

