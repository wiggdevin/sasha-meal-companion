import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const {
  COOKING_EFFORT_CHOICES, COOKING_EFFORT_SUGGESTION_THRESHOLD, POST, PREF_QUESTIONS,
} = await import("@/app/api/profile/prefs/route");

function post(body: unknown): Request {
  return new Request("https://app.test/api/profile/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function answers(
  values: Partial<Record<string, number>>,
  cookingEffort: keyof typeof COOKING_EFFORT_CHOICES = "unstated",
  confidence = 0.99,
) {
  return {
    ...Object.fromEntries([
    "vegetarian", "vegan", "pescatarian", "no_pork", "no_beef", "no_shellfish",
    "no_eggs", "no_soy", "no_peanuts", "low_fodmap", "halal", "kosher",
    "mentions_specific_foods",
    ].map((key) => [key, { type: "noul", noul: values[key] ?? 0.01 }])),
    cooking_effort: {
      type: "choice",
      choice: cookingEffort,
      probabilities: Object.fromEntries(Object.keys(COOKING_EFFORT_CHOICES)
        .map((key) => [key, key === cookingEffort ? confidence : 0])),
      confidence,
    },
  };
}

describe("POST /api/profile/prefs", () => {
  beforeEach(() => {
    resetRateLimits();
    systemOneMock.mockReset();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} as never });
  });

  it("returns Jev probabilities for text the local check sends", async () => {
    systemOneMock.mockResolvedValue(answers({ vegetarian: 0.98, no_shellfish: 0.97, vegan: 0.08,
      mentions_specific_foods: 0.91 }));

    const response = await POST(post({ text: "I love Italian food" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ jev: true, mentionsFoods: 0.91, route: "send" });
    expect(body.flags.vegetarian).toBeGreaterThanOrEqual(0.8);
    expect(body.flags.no_shellfish).toBeGreaterThanOrEqual(0.8);
    expect(body.flags.vegan).toBeLessThan(0.8);
    expect(systemOneMock).toHaveBeenCalledWith(
      { text: "I love Italian food" },
      expect.any(Object),
      { userId: "u1", purpose: "profile-prefs" },
    );
  });

  it("keeps rule and health text local: no Jev call, the empty answer plus the local route (Phase 18 W5b)", async () => {
    const response = await POST(post({ text: "I'm vegetarian and can't do shellfish" }));
    expect(await response.json()).toEqual({ flags: {}, cookingEffortSuggestion: null, mentionsFoods: 0,
      jev: false, route: "local", reason: "rules", offer: "rule_editor" });
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("asks Jev about peanuts rather than generic nuts", () => {
    const question = JSON.stringify(PREF_QUESTIONS.no_peanuts).toLowerCase();
    expect(question).toContain("peanuts");
    expect(question).not.toContain("nuts or peanuts");
    expect(question).not.toMatch(/\bnuts are excluded/);
  });

  it("asks a typed cooking-effort Choice with unstated as the no-match option", () => {
    expect(PREF_QUESTIONS.cooking_effort).toEqual(expect.objectContaining({
      type: "choice",
      criteria: COOKING_EFFORT_CHOICES,
    }));
    expect(Object.keys(PREF_QUESTIONS.cooking_effort.criteria))
      .toEqual(["none", "minimal", "full", "unstated"]);
    expect(PREF_QUESTIONS.cooking_effort.instructions).toContain("Never infer");
  });

  it("returns cooking effort only above the suggestion threshold and never for unstated", async () => {
    systemOneMock.mockResolvedValueOnce(answers({}, "minimal",
      COOKING_EFFORT_SUGGESTION_THRESHOLD));
    const suggested = await POST(post({ text: "I enjoy cooking" }));
    expect(await suggested.json()).toMatchObject({ cookingEffortSuggestion: "minimal" });

    systemOneMock.mockResolvedValueOnce(answers({}, "full",
      COOKING_EFFORT_SUGGESTION_THRESHOLD - 0.01));
    const lowConfidence = await POST(post({ text: "I enjoy food" }));
    expect(await lowConfidence.json()).toMatchObject({ cookingEffortSuggestion: null });

    systemOneMock.mockResolvedValueOnce(answers({}, "unstated", 1));
    const unstated = await POST(post({ text: "I love salmon" }));
    expect(await unstated.json()).toMatchObject({ cookingEffortSuggestion: null });
  });

  it("degrades to a successful empty answer when Jev is down", async () => {
    systemOneMock.mockResolvedValue(null);

    const response = await POST(post({ text: "I love salmon" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      flags: {}, cookingEffortSuggestion: null, mentionsFoods: 0, jev: false, route: "send",
    });
  });

  it("returns 401 without a signed-in user", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));

    const response = await POST(post({ text: "Vegetarian" }));

    expect(response.status).toBe(401);
  });

  it("returns 413 for a body over 2 KB", async () => {
    const response = await POST(post({ text: "x".repeat(2_100) }));

    expect(response.status).toBe(413);
    expect(systemOneMock).not.toHaveBeenCalled();
  });
});
