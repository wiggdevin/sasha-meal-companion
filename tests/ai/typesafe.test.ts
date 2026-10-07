import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminClientMock } = vi.hoisted(() => ({ adminClientMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: adminClientMock }));

import { withJevBudget } from "@/lib/ai/request-budget";
import { facetPayload, suggestPayload, verifyPayload } from "@/lib/ai/payloads";
import { VERIFY_QUESTIONS } from "@/lib/coach/verify-question";
import { systemOne } from "@/lib/ai/typesafe";
import { spendAdmin, spendAdminByUser, withSpendRpc } from "./spend-admin";

/** The fixed coach-verify question set: what every J(...) payload below asks. */
const questions = VERIFY_QUESTIONS;

/**
 * A builder-made payload carrying `state` as text (Phase 13 §9 R3: systemOne takes nothing else,
 * and the builder owns the questions). `food_facets` builds a budget-exempt facet payload; any
 * other label is an ordinary budgeted coach-verify call.
 */
function J(state: unknown, label = "coach-verify") {
  const text = JSON.stringify(state);
  if (label === "food_facets") {
    return facetPayload({ foods: [{ food: { name: text }, facets: ["contains_gluten"] }] });
  }
  return verifyPayload({ reply: text, actions: [], toolNames: [] });
}

const providerBody = (answers: Record<string, unknown> = {
  claims_unlisted_action: { type: "noul", noul: 0.99 },
}) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 421, output_tokens: 76 },
});

/** Answers every question the request actually asked, as nouls: for mixed-purpose batches. */
function answerAll(init?: RequestInit) {
  const asked = JSON.parse(String(init?.body)).questions as Record<string, unknown>;
  return providerBody(Object.fromEntries(Object.keys(asked)
    .map((key) => [key, { type: "noul", noul: 0.99 }])));
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("TypeSafe SystemOne adapter", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    vi.stubGlobal("fetch", vi.fn());
    adminClientMock.mockReset();
    adminClientMock.mockReturnValue(spendAdmin([]));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it("posts the payload's state and questions verbatim with the Jev model and bearer credential", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody()));
    const state = { reply: "Logged your lunch.", actions: [],
      tools_ran: { access: "read_only", names: [] } };

    await expect(systemOne(verifyPayload({ reply: "Logged your lunch.", actions: [], toolNames: [] }),
      { userId: "user-1" }))
      .resolves.toEqual(providerBody().answers);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer test-typesafe-key",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ state, model: "jev-latest", questions });
  });

  it("returns null when the request exceeds its deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined));

    const pending = systemOne(J({ message: "hello" }, "test"), { userId: "user-1", deadlineMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[typesafe] request timed out");
  });

  it("retries one 429 after 400 ms and returns the second answer", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(jsonResponse(providerBody()));

    const pending = systemOne(J({ message: "hello" }, "test"), { userId: "user-1" });
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toEqual(providerBody().answers);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns null after a second retryable response", async () => {
    vi.useFakeTimers();
    // A fresh Response per request, as a real fetch gives: the body of each is read once.
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({ error: "overloaded" }, 529));

    const pending = systemOne(J({ message: "hello" }, "test"), { userId: "user-1" });
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[typesafe] HTTP 529: {\"error\":\"overloaded\"}");
  });

  it("warns once with the HTTP status and first 200 body characters", async () => {
    const body = "x".repeat(220);
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 400 }));

    await expect(systemOne(J({ message: "hello" }, "test"), { userId: "user-1" }))
      .resolves.toBeNull();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(`[typesafe] HTTP 400: ${"x".repeat(200)}`);
    expect(String(warn.mock.calls[0][0])).not.toContain("test-typesafe-key");
  });

  it("returns null when the response does not match the question answer shapes", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody({
      claims_unlisted_action: { type: "noul", noul: 4 },
    })));

    await expect(systemOne(J({ message: "hello" }, "test"), { userId: "user-1" }))
      .resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[typesafe] malformed answer");
  });

  it("treats a score outside its legend's 0..n-1 range as malformed", async () => {
    const payload = suggestPayload({ slot: { id: "m2", label: "Lunch" }, wish: "",
      candidates: [{ index: 0, foods: [{ name: "egg", grams: 100 }],
        macros: { kcal: 150, protein: 12, carbs: 1, fat: 10 } }] } as never, "meal");
    const legend = Object.fromEntries(
      (Object.values(payload.questions)[0] as unknown as { criteria: string[] }).criteria
        .map((level, index) => [String(index), level]));
    const scoreAnswer = (value: number) => providerBody({ plausible_0: { type: "score", score: value,
      legend, probabilities: { 0: 0, 1: 0, 2: 1 }, confidence: 0.9 } });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(scoreAnswer(3)));
    await expect(systemOne(payload, { userId: "user-1" })).resolves.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(scoreAnswer(-1)));
    await expect(systemOne(payload, { userId: "user-1" })).resolves.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(scoreAnswer(1.6)));
    await expect(systemOne(payload, { userId: "user-1" })).resolves.not.toBeNull();
  });

  it("returns null without calling fetch when no key is configured", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");

    await expect(systemOne(J({ message: "hello" }, "test"), { userId: "user-1" }))
      .resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[typesafe] TYPESAFE_API_KEY is not configured");
  });

  it("refuses a value that no payload builder made, before any HTTP request", async () => {
    const forged = { purpose: "coach-verify", state: { message: "hello" }, questions } as never;
    await expect(systemOne(forged, { userId: "user-1" })).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[typesafe] refused: the payload was not made by this purpose's payload builder");
  });

  it("returns null without HTTP when shared daily provider spend reaches the cap", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    adminClientMock.mockReturnValue(spendAdmin([0.4, 0.1]));

    const cappedCall = () => systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" });
    await expect(cappedCall()).resolves.toBeNull();
    await expect(cappedCall()).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[typesafe] skipped: daily cap");
  });

  it("blocks user A at the cap while user B with no spend reaches the provider", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    const queriedUsers: string[] = [];
    adminClientMock.mockReturnValue(spendAdminByUser({
      "user-a": [0.4, 0.1],
      "user-b": [],
    }, queriedUsers));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody()));

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-a" })).resolves.toBeNull();
    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-b" })).resolves.toEqual(providerBody().answers);

    expect(queriedUsers).toEqual(["user-a", "user-b"]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("proceeds without a ledger read and warns once when userId is missing", async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(providerBody()));

    const missingUserCall = () => systemOne(J({ message: "hello" }, "coach-verify"));
    await expect(missingUserCall()).resolves.toEqual(providerBody().answers);
    await expect(missingUserCall()).resolves.toEqual(providerBody().answers);

    expect(adminClientMock).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[typesafe] systemOne without userId: daily cap not enforced",
    );
  });

  it("skips the call when adminClient is unavailable (scale S2: spend checks fail closed)", async () => {
    const error = new Error("database unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    adminClientMock.mockImplementation(() => { throw error; });
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody()));

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" })).resolves.toBeNull();

    expect(adminClientMock).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "ai spend ledger unavailable; skipping the Jev call (fail closed)",
      { error },
    );
    consoleError.mockRestore();
  });

  it("allows only three logical calls inside one request budget", async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(providerBody()));

    const results = await withJevBudget(() => Promise.all([
      systemOne(J({ call: 1 }, "intent"), { userId: "user-1" }),
      systemOne(J({ call: 2 }, "ranking"), { userId: "user-1" }),
      systemOne(J({ call: 3 }, "sanity"), { userId: "user-1" }),
      systemOne(J({ call: 4 }, "verification"), { userId: "user-1" }),
    ]));

    expect(results.slice(0, 3)).toEqual([
      providerBody().answers, providerBody().answers, providerBody().answers,
    ]);
    expect(results[3]).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith("[typesafe] skipped: request budget");
  });

  it("does not charge the internal 429 retry as another logical call", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
      .mockImplementation(async () => jsonResponse(providerBody()));

    const pending = withJevBudget(async () => {
      const first = systemOne(J({ call: 1 }, "intent"), { userId: "user-1" });
      await vi.advanceTimersByTimeAsync(400);
      return [
        await first,
        await systemOne(J({ call: 2 }, "ranking"), { userId: "user-1" }),
        await systemOne(J({ call: 3 }, "sanity"), { userId: "user-1" }),
        await systemOne(J({ call: 4 }, "verification"), { userId: "user-1" }),
      ];
    });

    await expect(pending).resolves.toEqual([
      providerBody().answers, providerBody().answers, providerBody().answers, null,
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("charges an explicit same-payload retry once and a changed payload separately", async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(providerBody()));

    const results = await withJevBudget(async () => [
      await systemOne(J({ call: "same" }, "intent"), { userId: "user-1" }),
      await systemOne(J({ call: "same" }, "intent"), { userId: "user-1" }),
      await systemOne(J({ call: "different-1" }, "intent"), { userId: "user-1" }),
      await systemOne(J({ call: "different-2" }, "intent"), { userId: "user-1" }),
      await systemOne(J({ call: "different-3" }, "intent"), { userId: "user-1" }),
    ]);

    expect(results.slice(0, 4).every((result) => result !== null)).toBe(true);
    expect(results[4]).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("exempts facet warming from the request budget", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => jsonResponse(answerAll(init)));

    const results = await withJevBudget(async () => [
      await systemOne(J({ call: 1 }, "intent"), { userId: "user-1" }),
      await systemOne(J({ call: 2 }, "ranking"), { userId: "user-1" }),
      await systemOne(J({ call: 3 }, "sanity"), { userId: "user-1" }),
      await systemOne(J({ warm: 1 }, "food_facets"), { userId: "user-1" }),
      await systemOne(J({ warm: 2 }, "food_facets"), { userId: "user-1" }),
      await systemOne(J({ call: 4 }, "verification"), { userId: "user-1" }),
    ]);

    expect(results.slice(0, 5).every((result) => result !== null)).toBe(true);
    expect(results[5]).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("records one successful usage row with Jev input-token cost", async () => {
    const rows: Record<string, unknown>[] = [];
    adminClientMock.mockReturnValue(spendAdmin([], rows));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody()));

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" })).resolves.toEqual(providerBody().answers);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      purpose: "coach-verify",
      provider: "typesafe",
      model_id: "jev-1.13.0",
      input_tokens: 421,
      output_tokens: 76,
      cost_estimate: 421 * 0.042 / 1_000_000,
      status: "ok",
      error: null,
    });
  });

  it("returns a valid answer when its usage row cannot be written", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = spendAdmin([]);
    adminClientMock.mockReturnValue(withSpendRpc({ from: (table: string) => ({ ...admin.from(table),
      insert: async () => { throw new Error("database unavailable"); } }) }));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody()));

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" })).resolves.toEqual(providerBody().answers);

    expect(warn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("ai_calls insert failed", expect.objectContaining({
      user_id: "user-1", provider: "typesafe" }));
    consoleError.mockRestore();
  });

  it("records a failed call as one classified row with no cost", async () => {
    const rows: Record<string, unknown>[] = [];
    adminClientMock.mockReturnValue(spendAdmin([], rows));
    vi.mocked(fetch).mockResolvedValue(new Response("bad request", { status: 400 }));

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" }))
      .resolves.toBeNull();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "typesafe", model_id: "jev-latest",
      status: "provider_error", error: "HTTP 400: bad request", cost_estimate: 0 });
  });

  it("returns null without HTTP while the Jev circuit is open", async () => {
    const admin = spendAdmin([]);
    const openCircuit = { eq: () => openCircuit, neq: () => openCircuit, in: () => openCircuit,
      gte: async () => ({ data: Array.from({ length: 5 }, () => ({ created_at: "now" })), error: null }) };
    adminClientMock.mockReturnValue({ from: (table: string) => ({ ...admin.from(table),
      select: (columns: string) => (columns === "created_at"
        ? openCircuit : admin.from(table).select(columns)) }) });

    await expect(systemOne(J({ message: "hello" }, "coach-verify"), { userId: "user-1" }))
      .resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/circuit open for typesafe/));
  });
});
