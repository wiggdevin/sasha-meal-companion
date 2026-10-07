/**
 * Phase 18 W5b (docs/specs/phase-18-open-world-foods.md §7.1, `POST /api/profile/prefs` extended):
 *
 * 1. The acceptance sentences give their expected chips at 0.8 or more on the RECORDED Jev answers
 *    (tests/fixtures/taste-jev-recorded.json, the exact request this route builds).
 * 2. Every keep-local sentence answers `route: "local"` and the Jev port is called 0 times; the plain
 *    sentences are sent.
 * 3. Zero writes: the route never touches the database.
 * 4. Jev down answers 200 with no chips (`jev: false`), so the flow continues manually.
 * Plus: the governed spend path (systemOne with the user id) and the fail-closed rate limit.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimJevCall } from "@/lib/ai/request-budget";
import { resetRateLimits, setRateLimitStore } from "@/lib/server/ratelimit";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS, PLAIN, REDTEAM_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

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
const { POST } = await import("@/app/api/profile/prefs/route");

type Recorded = { cases: { text: string; families: string[];
  request: { state: unknown; questions: unknown }; response: { answers: Record<string, { noul: number }> } }[] };
const RECORDED = JSON.parse(readFileSync("tests/fixtures/taste-jev-recorded.json", "utf8")) as Recorded;

const fromSpy = vi.fn(() => { throw new Error("the taste route must not touch the database"); });

function post(body: unknown): Request {
  return new Request("https://app.test/api/profile/prefs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
  resetRateLimits();
  systemOneMock.mockReset();
  fromSpy.mockClear();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: { from: fromSpy } as never });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("acceptance 1: recorded Jev answers give the expected chips at 0.8 or more", () => {
  const expected: Record<string, { list: "likes" | "dislikes" | "cuisines"; key: string }> = {
    "I can't stand mushy textures": { list: "dislikes", key: "t:soft" },
    "I grew up on Tex-Mex": { list: "cuisines", key: "latin_american" },
    "I love salmon": { list: "likes", key: "f:salmon" },
  };

  it("builds exactly the recorded request and reads the recorded answer into chips", async () => {
    expect(RECORDED.cases.map((c) => c.text).sort()).toEqual(Object.keys(expected).sort());
    for (const recorded of RECORDED.cases) {
      systemOneMock.mockReset();
      systemOneMock.mockResolvedValue(recorded.response.answers);
      const response = await POST(post({ taste: recorded.text }));
      const body = await response.json();
      expect(response.status).toBe(200);
      const [state, questions, options] = systemOneMock.mock.calls[0];
      expect(state).toEqual(recorded.request.state);
      expect(questions).toEqual(recorded.request.questions);
      expect(options).toEqual({ userId: "u1", purpose: "profile-taste" });
      const { list, key } = expected[recorded.text];
      const chip = body[list].find((c: { key: string }) => c.key === key);
      expect([recorded.text, chip?.p >= 0.8]).toEqual([recorded.text, true]);
      expect(body).toMatchObject({ route: "send", jev: true });
      for (const name of ["likes", "dislikes", "cuisines"] as const) {
        for (const c of body[name]) expect(c.p).toBeGreaterThanOrEqual(0.8);
      }
    }
  });
});

describe("acceptance 2: keep-local text never reaches Jev", () => {
  it("answers route local with the reason and the offer, and calls the Jev port 0 times", async () => {
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      resetRateLimits();
      const response = await POST(post({ taste: c.text }));
      expect([c.text, response.status, await response.json()]).toEqual([c.text, 200, {
        route: "local", reason: c.reason, offer: c.reason === "unsure" ? "plain_prefs" : "rule_editor",
      }]);
    }
    for (const text of REDTEAM_CORPUS) {
      resetRateLimits();
      const body = await (await POST(post({ taste: text }))).json();
      expect([text, body.route]).toEqual([text, "local"]);
    }
    expect(systemOneMock).toHaveBeenCalledTimes(0);
  });

  it("gates the dietary text ({ text }, purpose profile-prefs) the same way: 0 Jev calls on the corpus", async () => {
    for (const text of [...ACCEPTANCE_LOCAL.map((c) => c.text), ...HEALTH_CORPUS.map((c) => c.text), ...REDTEAM_CORPUS]) {
      resetRateLimits();
      const body = await (await POST(post({ text }))).json();
      expect([text, body.route, body.jev]).toEqual([text, "local", false]);
    }
    expect(systemOneMock).toHaveBeenCalledTimes(0);
  });

  it("sends the plain sentences, as typed", async () => {
    systemOneMock.mockResolvedValue(null);
    for (const text of PLAIN) {
      resetRateLimits();
      await POST(post({ taste: text }));
    }
    expect(systemOneMock.mock.calls.map(([state]) => (state as { text: string }).text)).toEqual(PLAIN);
  });
});

describe("acceptance 3 and 4", () => {
  it("writes nothing: the route never opens a table", async () => {
    systemOneMock.mockResolvedValue(RECORDED.cases[0].response.answers);
    await POST(post({ taste: "I love salmon" }));
    await POST(post({ taste: "I'm allergic to peanuts" }));
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("Jev down answers 200 with no chips so the flow continues manually", async () => {
    systemOneMock.mockResolvedValue(null);
    const response = await POST(post({ taste: "I love salmon" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: "send", jev: false, likes: [], dislikes: [], cuisines: [] });
  });
});

describe("the request boundary", () => {
  it("is dark unless TASTE_CHIPS_ENABLED=1: 404 and no Jev call", async () => {
    vi.stubEnv("TASTE_CHIPS_ENABLED", "");
    const response = await POST(post({ taste: "I love salmon" }));
    expect(response.status).toBe(404);
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("refuses a body with both texts, or an unknown field", async () => {
    for (const body of [{ text: "x", taste: "y" }, { taste: "I love salmon", profile: {} }, { taste: 7 }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("fails closed when the shared limiter is unavailable: 503 and no Jev call", async () => {
    setRateLimitStore({ hit: async () => { throw new Error("rate_limit_hit failed"); } });
    try {
      const response = await POST(post({ taste: "I love salmon" }));
      expect(response.status).toBe(503);
      expect(systemOneMock).not.toHaveBeenCalled();
    } finally {
      setRateLimitStore(null);
    }
  });

  it("runs inside one Jev request budget, as the coach route does", async () => {
    const claims: boolean[] = [];
    systemOneMock.mockImplementation(async () => {
      for (const key of ["a", "b", "c", "d"]) claims.push(claimJevCall("profile-taste", key));
      return null;
    });
    await POST(post({ taste: "I love salmon" }));
    expect(claims).toEqual([true, true, true, false]);
  });

  it("is rate limited per account and fails closed: the 31st call in a minute is 429 with no Jev call", async () => {
    systemOneMock.mockResolvedValue(null);
    for (let i = 0; i < 30; i += 1) expect((await POST(post({ taste: "I love salmon" }))).status).toBe(200);
    const calls = systemOneMock.mock.calls.length;
    const limited = await POST(post({ taste: "I love salmon" }));
    expect(limited.status).toBe(429);
    expect(systemOneMock.mock.calls.length).toBe(calls);
  });
});
