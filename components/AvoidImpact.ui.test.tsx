// @vitest-environment jsdom
/**
 * FluidVoice A09: the affected-meals review keeps its count, its instance list with Edit, Remove and
 * Remix, and its eaten-history protection, and gains a free-text Ask Sasha field that sends the
 * user's own wording with the bounded affected-meal ids. The fixed shortcut still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { coachTurnRequestSchema } from "@/lib/coach/types";

const io = vi.hoisted(() => ({
  postTurn: vi.fn(async (..._args: unknown[]) => ({ suggestions: [],
    messages: [{ role: "assistant", content: "Keep the pasta; swap the garlic." }] })),
  saveItemOverride: vi.fn(async (..._args: unknown[]) => undefined),
  syncOnce: vi.fn(async (..._args: unknown[]) => ({ push: { failed: false } })),
  days: {} as Record<string, unknown>,
  recipes: [] as unknown[],
}));
vi.mock("@/lib/coach-client", () => ({ postTurn: io.postTurn }));
vi.mock("@/lib/plan-day-client", () => ({ saveItemOverride: io.saveItemOverride }));
vi.mock("@/lib/sync/client", () => ({ SYNCED_EVENT: "meal-companion:synced", syncOnce: io.syncOnce }));
vi.mock("@/lib/sync/idb", () => ({ allOps: async () => [] }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => ({ ...actual.defaultStore(), foods: {}, days: io.days }) };
});
vi.mock("@/lib/recipe-catalog-client", () => ({
  searchCatalogRecipes: async () => ({ recipes: io.recipes, count: io.recipes.length, limitations: [] }),
  getCatalogRecipe: vi.fn(),
}));
vi.mock("@/components/MyFoods", () => ({ AvoidFoods: () => <section aria-label="Avoid list" /> }));
vi.mock("@/components/AvoidRules", () => ({ default: () => null }));
vi.mock("@/components/RecipePlanFlow", () => ({ default: () => null }));

const { default: AvoidImpact } = await import("./AvoidImpact");

type Instance = { date: string; slot: string; title: string; source: "recipe" | "edited"; matched: string };
const instance = (day: number, slot = "meal-1"): Instance => ({
  date: `2026-10-${String(day).padStart(2, "0")}`, slot, title: `Garlic pasta ${day}`,
  source: "edited", matched: "garlic" });
let instances: Instance[] = [];

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  io.postTurn.mockClear(); io.saveItemOverride.mockClear(); io.syncOnce.mockClear();
  io.days = {};
  io.recipes = [];
  instances = [instance(1), instance(2, "meal-2")];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.method === "POST" ? { byId: {} }
      : { instances, count: instances.length, complete: true, scope: "saved future meals",
        checkedFrom: "2026-09-28" };
    return new Response(JSON.stringify(body), { status: 200,
      headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openAffected() {
  render(<AvoidImpact />);
  fireEvent.change(screen.getByRole("textbox", { name: "Food or cuisine to check" }),
    { target: { value: "garlic" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
  fireEvent.click(screen.getByRole("button", { name: `${instances.length} affected saved future meals` }));
  return screen.getByRole("dialog", { name: "Affected saved meals" });
}

const question = () => screen.getByRole("textbox", { name: "Ask Sasha about these meals" });
const send = () => screen.getByRole("button", { name: "Send to Sasha" });

describe("affected meals review", () => {
  it("opens the matching instance list with Edit, Remove and Remix on each", async () => {
    const dialog = await openAffected();
    for (const item of instances) {
      const card = within(dialog).getByText(`${item.date} · ${item.slot} · ${item.title}`)
        .closest("div") as HTMLElement;
      for (const action of ["Remove", "Remix", "Edit"]) {
        expect(within(card).getByRole("button", { name: action })).toBeTruthy();
      }
    }
  });

  it("sends the user's own words and the affected ids to the existing coach path", async () => {
    await openAffected();
    fireEvent.change(question(), { target: { value: "  Can I keep the pasta if I skip garlic?  " } });
    await act(async () => { fireEvent.click(send()); });
    expect(io.postTurn).toHaveBeenCalledTimes(1);
    const text = (io.postTurn.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain("Can I keep the pasta if I skip garlic?");
    expect(text).toContain("2026-10-01:meal-1");
    expect(text).toContain("2026-10-02:meal-2");
    expect(screen.getByText("Keep the pasta; swap the garlic.")).toBeTruthy();
  });

  it("bounds the ids sent with a question to the request limit", async () => {
    instances = Array.from({ length: 14 }, (_, i) => instance(i + 1));
    await openAffected();
    fireEvent.change(question(), { target: { value: "Which of these can stay?" } });
    await act(async () => { fireEvent.click(send()); });
    const text = (io.postTurn.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain("2026-10-12:meal-1");
    expect(text).not.toContain("2026-10-13:meal-1");
    expect(screen.queryByText(/Select up to 12/)).toBeNull();
  });

  it("does not send blank text", async () => {
    await openAffected();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(question(), { target: { value: "   " } });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(send()); });
    expect(io.postTurn).not.toHaveBeenCalled();
  });

  it("keeps the fixed shortcut working without any typed question", async () => {
    await openAffected();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask Sasha for selected replacements" }));
    });
    expect(io.postTurn).toHaveBeenCalledTimes(1);
    const text = (io.postTurn.mock.calls[0][0] as { text: string }).text;
    expect(text).toMatch(/^Suggest similar meal replacements for these exact future plan instances/);
  });

  it("keeps an eaten affected meal's protection: Remove refuses and writes nothing", async () => {
    io.days = { "2026-10-01": { eaten: { "meal-1": true } } };
    const dialog = await openAffected();
    const card = within(dialog).getByText("2026-10-01 · meal-1 · Garlic pasta 1")
      .closest("div") as HTMLElement;
    expect(["Remove", "Remix", "Edit"].every((name) =>
      within(card).queryByRole("button", { name }))).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Remove future instance" }));
    });
    expect(io.saveItemOverride).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent)
      .toBe("This meal was already eaten and stays in your history.");
  });
});

/**
 * Review fix round 1: the coach turn accepts at most 2 000 characters. The worst case — a full
 * 500-character question, 12 meals with long titles and two long verified options each — must
 * still validate, with the question and every id intact.
 */
describe("the Ask Sasha request at its worst case", () => {
  const long = (label: string, n: number) => `${label} `.padEnd(n, "x");
  const option = (i: number) => ({ recipeId: `r${i}`, revisionId: `r${i}-v1`,
    name: long(`Lemon chicken and rice bowl ${i}`, 120), cuisine: "American", dishTags: [],
    totalMinutes: 20, eligibility: { status: "eligible", reasons: [] },
    ingredients: [{ name: "rice", foodRefId: null, foodDbId: null }] });

  beforeEach(() => {
    instances = Array.from({ length: 12 }, (_, i) => ({
      ...instance(i + 1), title: long(`Garlic pasta ${i + 1}`, 120) }));
    io.recipes = [option(1), option(2), option(3)];
  });

  it("keeps a full question and every id inside the coach transport limit", async () => {
    await openAffected();
    const words = long("Can these meals stay on the plan if I swap the garlic for something milder", 500);
    fireEvent.change(question(), { target: { value: words } });
    await act(async () => { fireEvent.click(send()); });
    expect(io.postTurn).toHaveBeenCalledTimes(1);
    const request = io.postTurn.mock.calls[0][0] as { text: string };
    expect(coachTurnRequestSchema.safeParse(request).success).toBe(true);
    expect(request.text.length).toBeLessThanOrEqual(2000);
    expect(request.text).toContain(words);
    for (const item of instances) expect(request.text).toContain(`${item.date}:${item.slot}`);
  });

  it("keeps the fixed shortcut inside the limit too", async () => {
    await openAffected();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask Sasha for selected replacements" }));
    });
    const request = io.postTurn.mock.calls[0][0] as { text: string };
    expect(coachTurnRequestSchema.safeParse(request).success).toBe(true);
    expect(request.text).toMatch(/^Suggest similar meal replacements for these exact future plan instances/);
  });
});
