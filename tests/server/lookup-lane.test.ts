/**
 * Phase 13 §3.3, §9 R8 (slice 6): the `lookup` lane's own server orchestration. `generateGrounded`
 * itself — the spend cap, the circuit breaker, the ai_calls row and the grounding cost line — is
 * covered in lib/ai/adapter.test.ts; this file is the boundary above it: subject validation,
 * catalog resolution, the deadline, and the evidence cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodHit } from "@/lib/coach/executors";

const generateGrounded = vi.fn();
vi.mock("@/lib/ai/gemini-grounded", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/gemini-grounded")>()),
  generateGrounded,
}));

const { runLookup } = await import("@/lib/server/lookup-lane");

const admin = {} as never;

function hit(over: Partial<FoodHit> = {}): FoodHit {
  return { foodRefId: "food-1", name: "Wheat Thins", brand: null, kcalPer100g: 480,
    prefStatus: null, catalogFoodRevisionId: 11, ...over };
}

describe("runLookup", () => {
  beforeEach(() => {
    generateGrounded.mockReset();
  });

  it("refuses a subject that fails the D0 validator without a catalog read or a model call", async () => {
    const searchFoods = vi.fn();
    const out = await runLookup(admin, "u1", "my sore stomach", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "my sore stomach", refusal: "first_person" });
    expect(searchFoods).not.toHaveBeenCalled();
    expect(generateGrounded).not.toHaveBeenCalled();
  });

  it("refuses a subject the catalog cannot resolve, without a model call (§9 R8)", async () => {
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const out = await runLookup(admin, "u1", "some random snack nobody sells", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "some random snack nobody sells", refusal: "unresolved" });
    expect(searchFoods).toHaveBeenCalledWith("u1", "some random snack nobody sells", 2);
    expect(generateGrounded).not.toHaveBeenCalled();
  });

  it("refuses when the only hit is not a catalog row", async () => {
    const searchFoods = vi.fn(async () => [hit({ foodRefId: null, brand: null, catalogFoodRevisionId: null })]);
    const out = await runLookup(admin, "u1", "Wheat Thins", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "Wheat Thins", refusal: "unresolved" });
    expect(generateGrounded).not.toHaveBeenCalled();
  });

  it("resolves to a catalog product and sends only the catalog's own name to the model", async () => {
    const searchFoods = vi.fn(async () => [hit({ foodRefId: "food-1", name: "Wheat Thins, Original" })]);
    generateGrounded.mockResolvedValue({
      text: "A wheat cracker.", groundingMetadata: null, inputTokens: 1, outputTokens: 1,
      webSearchQueries: 0,
    });
    const out = await runLookup(admin, "u1", "wheat thins", { searchFoods });
    expect(out).toMatchObject({ ok: true, resolvedName: "Wheat Thins, Original", foodRefId: "food-1" });
    const call = generateGrounded.mock.calls[0][0];
    expect(call.payload.parts.at(-1)?.text).toBe("Wheat Thins, Original");
    expect(call.timeoutMs).toBe(8_000);
  });

  it("refuses a user-authored food, whatever its name (review r1, sol BLOCK)", async () => {
    // searchExactUserFood's shape: a real food ref, but no catalog revision — the name and brand
    // are the user's own text, which may carry health context, so it never reaches the search.
    const searchFoods = vi.fn(async () => [hit({
      foodRefId: "user-ref", name: "Wheat Thins", brand: "Sam kidney diet", catalogFoodRevisionId: null,
    })]);
    const out = await runLookup(admin, "u1", "Wheat Thins", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "Wheat Thins", refusal: "unresolved" });
    expect(generateGrounded).not.toHaveBeenCalled();
  });

  it("skips an exact user-food match for the catalog hit behind it", async () => {
    const searchFoods = vi.fn(async () => [
      hit({ foodRefId: "user-ref", name: "wheat thins for my IBS", catalogFoodRevisionId: null }),
      hit({ foodRefId: "food-1", name: "Wheat Thins, Original", catalogFoodRevisionId: 11 }),
    ]);
    generateGrounded.mockResolvedValue({
      text: "A wheat cracker.", groundingMetadata: null, inputTokens: 1, outputTokens: 1,
      webSearchQueries: 0,
    });
    const out = await runLookup(admin, "u1", "wheat thins", { searchFoods });
    expect(out).toMatchObject({ ok: true, resolvedName: "Wheat Thins, Original", foodRefId: "food-1" });
    expect(generateGrounded.mock.calls[0][0].payload.parts.at(-1)?.text).toBe("Wheat Thins, Original");
  });

  it("resolves a catalog row whose food ref could not be minted, by its catalog brand", async () => {
    const searchFoods = vi.fn(async () => [hit({ foodRefId: null, brand: "Chick-fil-A" })]);
    generateGrounded.mockResolvedValue({
      text: "A grilled sandwich.", groundingMetadata: null, inputTokens: 1, outputTokens: 1,
      webSearchQueries: 0,
    });
    const out = await runLookup(admin, "u1", "Chick-fil-A sandwich", { searchFoods });
    expect(out).toMatchObject({ ok: true, foodRefId: null, brand: "Chick-fil-A" });
  });

  it("returns an unavailable refusal, not a throw, when the grounded call fails", async () => {
    const searchFoods = vi.fn(async () => [hit()]);
    generateGrounded.mockRejectedValue(new Error("the provider did not answer within 8000ms"));
    const out = await runLookup(admin, "u1", "Wheat Thins", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "Wheat Thins", refusal: "unavailable" });
  });

  it("stays inside its own budget when the adapter call hangs — a refusal, not a hang", async () => {
    const searchFoods = vi.fn(async () => [hit()]);
    // The real bound comes from generateGrounded's own withDeadline (tested in lib/ai/adapter.test.ts);
    // here the double just proves runLookup reads a slow-adapter rejection as a clean refusal,
    // never an uncaught throw that could hang the coach turn's tool batch.
    generateGrounded.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(
        () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), 5)),
    );
    const started = Date.now();
    const out = await runLookup(admin, "u1", "Wheat Thins", { searchFoods });
    expect(out).toEqual({ ok: false, subject: "Wheat Thins", refusal: "unavailable" });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("hands the turn's abort signal to the grounded call (review r1, sol BLOCK)", async () => {
    const searchFoods = vi.fn(async () => [hit()]);
    generateGrounded.mockResolvedValue({
      text: "A wheat cracker.", groundingMetadata: null, inputTokens: 1, outputTokens: 1,
      webSearchQueries: 0,
    });
    const turn = new AbortController();
    await runLookup(admin, "u1", "Wheat Thins", { searchFoods }, {}, { signal: turn.signal });
    expect(generateGrounded.mock.calls[0][0].signal).toBe(turn.signal);
  });

  it("caps a lookup fact at unverified — it never clears a hard allergen block (§9 R8)", async () => {
    const searchFoods = vi.fn(async () => [hit()]);
    generateGrounded.mockResolvedValue({
      // The model itself claims peanut-free; the tool result must not carry that as evidence.
      text: "This snack is peanut-free.", groundingMetadata: null, inputTokens: 1, outputTokens: 1,
      webSearchQueries: 0,
    });
    const out = await runLookup(admin, "u1", "Wheat Thins", { searchFoods });
    expect(out).toMatchObject({ ok: true, answer: "This snack is peanut-free." });
    if (out.ok) expect(out.evidence).toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("passes the caller's condition and allergen context into the subject validator", async () => {
    const searchFoods = vi.fn();
    const out = await runLookup(admin, "u1", "peanut butter cups", { searchFoods },
      { allergens: ["peanut"] });
    expect(out).toEqual({ ok: false, subject: "peanut butter cups", refusal: "allergy" });
    expect(searchFoods).not.toHaveBeenCalled();
  });
});
