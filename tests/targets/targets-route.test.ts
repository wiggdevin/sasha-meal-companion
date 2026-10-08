import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const activeTargets = vi.fn();
const authorTargets = vi.fn();
const writeTargetRevisionSet = vi.fn();
const restoreTargetRevision = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/targets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/targets")>("@/lib/server/targets");
  return { ...actual, activeTargets: (...a: unknown[]) => activeTargets(...a),
    authorTargets: (...a: unknown[]) => authorTargets(...a),
    writeTargetRevisionSet: (...a: unknown[]) => writeTargetRevisionSet(...a),
    restoreTargetRevision: (...a: unknown[]) => restoreTargetRevision(...a) };
});
const { GET, POST } = await import("@/app/api/targets/route");
const { FloorViolationError } = await import("@/lib/server/targets");
const { AdultOnlyError } = await import("@/lib/profile/rate-eligibility");

const post = (body: unknown) => new Request("https://x.test/api/targets", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const BODY = { mode: "grams", effectiveFrom: "2026-09-14", kcalTrain: 2200, kcalRest: 1750,
  grams: { proteinG: 135, fatG: 85, carbG: 200 } };

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  activeTargets.mockReset().mockResolvedValue(null);
  authorTargets.mockReset().mockResolvedValue({ id: "p2", mode: "grams", raisedToFloor: false,
    resolved: { training: { kcal: 2200, protein: 135, carbs: 204, fat: 85 },
      rest: { kcal: 1750, protein: 135, carbs: 91, fat: 85 } } });
  const revision = {
    id: "00000000-0000-4000-8000-000000000001", revision: 2, source: "derived",
    effectiveFrom: "2026-09-19",
    training: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
    rest: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
    pins: { trainingKcal: null, restKcal: null, proteinG: null },
    inputs: { effectiveDate: "2026-09-19", weightKg: 60, weightSource: "onboarding",
      trainingWeekdays: [1, 3, 4, 5], activity: "moderate", goal: "recomp",
      formulaName: "profile-energy-v1" },
  };
  writeTargetRevisionSet.mockReset().mockResolvedValue({ revision });
  restoreTargetRevision.mockReset().mockResolvedValue({ ...revision, revision: 3 });
});

describe("GET /api/targets", () => {
  it("returns the explicit needs-profile state when no revision is effective", async () => {
    const res = await GET(new Request("https://x.test/api/targets"));
    expect(enforceRateLimit).toHaveBeenCalledWith("targets:user:u1", 30, 60);
    await expect(res.json()).resolves.toEqual({ status: "needs_profile", target: null });
  });

  it("wraps an effective target in the ready state", async () => {
    activeTargets.mockResolvedValue({ id: "p1", resolved: {} });
    const res = await GET(new Request("https://x.test/api/targets"));
    await expect(res.json()).resolves.toMatchObject({ status: "ready", target: { id: "p1" } });
  });
});

describe("POST /api/targets", () => {
  it("writes an authored profile and returns the resolved grams", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "p2" });
  });
  it("rejects a body over 8 KB", async () => {
    const res = await POST(post({ ...BODY, effectiveFrom: "x".repeat(9000) }));
    expect(res.status).toBe(413);
  });
  it("rejects a bad shape with 400 and never echoes the body", async () => {
    const res = await POST(post({ mode: "vibes", effectiveFrom: "2026-09-14" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("vibes");
  });
  it("answers 422 naming the minimum percentage when a floor is broken", async () => {
    authorTargets.mockRejectedValue(new FloorViolationError("protein_below_floor", "under", 30.86, 25.72));
    const res = await POST(post({ ...BODY, mode: "percent", grams: undefined,
      percent: { proteinPct: 20, fatPct: 30, carbPct: 50 } }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "protein_below_floor", minProteinPct: 30.86, minFatPct: 25.72 });
  });

  it("answers 422 adult_only and writes nothing for an account under 18 (G2)", async () => {
    writeTargetRevisionSet.mockRejectedValue(new AdultOnlyError());
    const res = await POST(post({ operation: "derive", source: "derived", effectiveFrom: "2026-10-08",
      latestWeighInKg: null, trainingWeekdays: [],
      settings: { sex: "female", birthYear: 2010, heightCm: 160, weightKg: 50, bodyFatPct: null,
        activityLevel: "light", goal: "maintain", trainingKcal: null, restKcal: null, proteinG: null } }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "adult_only" });
  });

  it("derives and persists an authority revision server-side", async () => {
    const body = {
      operation: "derive",
      source: "derived",
      effectiveFrom: "2026-09-19",
      latestWeighInKg: null,
      trainingWeekdays: [1, 3, 4, 5],
      settings: { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
        bodyFatPct: null, activityLevel: "moderate", goal: "recomp",
        trainingKcal: null, restKcal: null, proteinG: null },
    };
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(writeTargetRevisionSet).toHaveBeenCalledWith({}, "u1", expect.objectContaining({
      operation: "derive",
      input: expect.objectContaining({
        today: "2026-09-19", latestWeighInKg: null, source: "derived",
      }),
    }), undefined);
    await expect(res.json()).resolves.toMatchObject({ revision: { revision: 2 } });
  });

  it("carries body-fat provenance into the derivation and refuses an unknown source", async () => {
    const settings = { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
      bodyFatPct: 24, bodyFatSource: "dexa", bodyFatMeasuredOn: "2026-09-01",
      activityLevel: "moderate", goal: "recomp", trainingKcal: null, restKcal: null,
      proteinG: null };
    const body = { operation: "derive", source: "derived", effectiveFrom: "2026-09-19",
      latestWeighInKg: null, trainingWeekdays: [1, 3], settings };
    expect((await POST(post(body))).status).toBe(200);
    expect(writeTargetRevisionSet).toHaveBeenLastCalledWith({}, "u1", expect.objectContaining({
      input: expect.objectContaining({ settings: expect.objectContaining({
        bodyFatSource: "dexa", bodyFatMeasuredOn: "2026-09-01" }) }),
    }), undefined);
    const bad = { ...body, settings: { ...settings, bodyFatSource: "guess" } };
    expect((await POST(post(bad))).status).toBe(400);
  });

  it("carries the confirmed rate into the derivation and refuses one off the goal's presets", async () => {
    const settings = { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
      bodyFatPct: null, activityLevel: "moderate", goal: "lose_fat", goalRateBpWeek: -25,
      trainingKcal: null, restKcal: null, proteinG: null };
    const body = { operation: "derive", source: "derived", effectiveFrom: "2026-09-19",
      latestWeighInKg: null, trainingWeekdays: [1, 3], settings };
    expect((await POST(post(body))).status).toBe(200);
    expect(writeTargetRevisionSet).toHaveBeenLastCalledWith({}, "u1", expect.objectContaining({
      input: expect.objectContaining({ settings: expect.objectContaining({
        goalRateBpWeek: -25 }) }),
    }), undefined);
    const wrongWay = { ...body, settings: { ...settings, goalRateBpWeek: 20 } };
    expect((await POST(post(wrongWay))).status).toBe(400);
    const notPreset = { ...body, settings: { ...settings, goalRateBpWeek: -40 } };
    expect((await POST(post(notPreset))).status).toBe(400);
    // 0 is the stored "not confirmed" value and must never block a later profile save.
    const unconfirmed = { ...body, settings: { ...settings, goalRateBpWeek: 0 } };
    expect((await POST(post(unconfirmed))).status).toBe(200);
  });

  it("restores a prior target revision through the same route", async () => {
    const revisionId = "00000000-0000-4000-8000-000000000001";
    const res = await POST(post({ operation: "restore", revisionId,
      effectiveFrom: "2026-09-20" }));
    expect(res.status).toBe(200);
    expect(restoreTargetRevision).toHaveBeenCalledWith({}, "u1", revisionId, "2026-09-20");
    await expect(res.json()).resolves.toMatchObject({ revision: { revision: 3 } });
  });

  it("rejects the removed ramp write operation", async () => {
    const body = {
      operation: "ramp",
      source: "manual",
      effectiveFrom: "2026-09-19",
      latestWeighInKg: 59.25,
      trainingWeekdays: [1, 3, 4, 5],
      settings: { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
        bodyFatPct: null, activityLevel: "moderate", goal: "recomp",
        trainingKcal: null, restKcal: null, proteinG: null },
    };
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(writeTargetRevisionSet).not.toHaveBeenCalled();
  });

  it("passes a first-write predecessor with the real revision in one server call", async () => {
    const body = {
      operation: "derive",
      requestId: "00000000-0000-4000-8000-000000000002",
      source: "derived",
      effectiveFrom: "2026-09-19",
      latestWeighInKg: 60,
      trainingWeekdays: [1, 3, 4, 5],
      settings: { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
        bodyFatPct: null, activityLevel: "moderate", goal: "recomp",
        trainingKcal: null, restKcal: null, proteinG: null },
      predecessor: {
        operation: "derive",
        requestId: "00000000-0000-4000-8000-000000000001",
        source: "manual",
        effectiveFrom: "2026-09-19",
        latestWeighInKg: null,
        trainingWeekdays: [1, 3, 4, 5],
        settings: { sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
          bodyFatPct: null, activityLevel: "moderate", goal: "recomp",
          trainingKcal: null, restKcal: null, proteinG: null },
      },
    };
    const res = await POST(post(body));

    expect(res.status).toBe(200);
    expect(writeTargetRevisionSet).toHaveBeenCalledOnce();
    expect(writeTargetRevisionSet).toHaveBeenCalledWith({}, "u1",
      expect.objectContaining({ operation: "derive", requestId: body.requestId }),
      expect.objectContaining({ operation: "derive", requestId: body.predecessor.requestId }));
  });
});
