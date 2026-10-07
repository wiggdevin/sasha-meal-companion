// @vitest-environment jsdom
/**
 * A photo of foods in the recipe widget becomes a coach turn built from the photo model's read. The
 * read's provenance rides with that turn, so the answer and its cards keep their "AI" label even
 * when the turn itself was written without a model; an ask that is not from a photo keeps its own.
 */
import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { BY_APP, byJev, byModel } from "@/lib/provenance";
import type { Provenance } from "@/lib/types";

const postTurn = vi.hoisted(() => vi.fn());
const uploadPlanPhoto = vi.hoisted(() => vi.fn());
const readPlanPhoto = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/plan/inspire-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/inspire-client")>()), uploadPlanPhoto, readPlanPhoto,
}));
vi.mock("@/lib/coach/apply-client", () => ({ applyCoachAction: vi.fn() }));
vi.mock("@/lib/resolve", () => ({ resolveDay: vi.fn(() => { throw new Error("not read here"); }) }));
vi.mock("@/lib/store", () => ({ loadStore: () => ({}) }));
vi.mock("@/components/CoachComposedCard", async () => {
  const { default: AiLabel } = await import("@/components/ui/AiLabel");
  return { default: ({ meal, provenance }: { meal: { wish: string }; provenance?: Provenance }) =>
    <div data-testid="composed-card">{meal.wish}<AiLabel provenance={provenance} /></div> };
});

import HubAnswer from "@/components/recipes-hub/HubAnswer";
import { answerProvenance, useHubAsk } from "@/components/recipes-hub/useHubAsk";
import type { HubDay } from "@/components/recipes-hub/useHubDay";

const DAY: HubDay = { date: "2026-10-05", remaining: { kcal: 600, protein: 40, carbs: 60, fat: 20 },
  slot: "meal-2", time: "12:00", label: "Meal 2" };
const PHOTO_READ = byModel("plan-photo");

function turnAnswer(provenance: Provenance | undefined) {
  return { threadId: "3f1b1a2c-0000-4000-8000-0000000000aa", suggestions: [], actions: [], draft: null,
    composed: [{ wish: "Spinach omelette", items: [{ foodRefId: "f1" }] }], deflected: false, toolsUsed: [],
    messages: [{ id: "a", role: "assistant", content: "Try this." }], ...(provenance ? { provenance } : {}) };
}

const handle: { current: ReturnType<typeof useHubAsk> | null } = { current: null };
function Harness() {
  const ask = useHubAsk({ day: DAY, recipesOn: false });
  useEffect(() => { handle.current = ask; });
  return <HubAnswer ask={ask} day={DAY} />;
}
const hub = () => handle.current!;

const labels = () => Array.from(document.querySelectorAll("[data-ai-label]"))
  .map((node) => [node.getAttribute("data-ai-label"), node.textContent]);

beforeEach(() => {
  unbindAccount();
  bindAccount("user-a");
  postTurn.mockReset();
  uploadPlanPhoto.mockReset().mockResolvedValue({ image: new Blob(), mediaPath: "m1" });
  readPlanPhoto.mockReset().mockResolvedValue({ kind: "ingredients", title: null,
    ingredients: ["eggs", "spinach"], provenance: PHOTO_READ });
});
afterEach(() => { cleanup(); });

describe("answerProvenance", () => {
  it("keeps the turn's own label, and falls back to the photo read only when the turn has none", () => {
    expect(answerProvenance(byModel("coach-turn"), PHOTO_READ)).toEqual(byModel("coach-turn"));
    expect(answerProvenance(byJev("suggest-options"), PHOTO_READ)).toEqual(byJev("suggest-options"));
    expect(answerProvenance(byJev("intent"), PHOTO_READ)).toEqual(PHOTO_READ);
    expect(answerProvenance(BY_APP, PHOTO_READ)).toEqual(PHOTO_READ);
    expect(answerProvenance(undefined, PHOTO_READ)).toEqual(PHOTO_READ);
    expect(answerProvenance(byJev("intent"), null)).toEqual(byJev("intent"));
    expect(answerProvenance(undefined, null)).toBeUndefined();
    expect(answerProvenance(undefined, BY_APP)).toEqual(BY_APP);
  });
});

describe("a photo of foods in the recipe widget", () => {
  it("labels the answer and each card AI from the photo read, once each, when the turn wrote no words", async () => {
    postTurn.mockResolvedValue(turnAnswer(byJev("intent")));
    render(<Harness />);
    await act(async () => { await hub().readPhoto(new Blob()); });
    await waitFor(() => expect(screen.getByTestId("composed-card")).toBeTruthy());
    expect(postTurn).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual([["model", "AIWritten by AI"], ["model", "AIWritten by AI"]]);
  });

  it("keeps the photo read's label on a retry of the same ask", async () => {
    postTurn.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(turnAnswer(undefined));
    render(<Harness />);
    await act(async () => { await hub().readPhoto(new Blob()); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    await act(async () => { hub().retry(); });
    await waitFor(() => expect(screen.getByTestId("composed-card")).toBeTruthy());
    expect(labels().map(([source]) => source)).toEqual(["model", "model"]);
  });

  it("drops the photo read's label for the next typed ask", async () => {
    postTurn.mockResolvedValue(turnAnswer(byJev("intent")));
    render(<Harness />);
    await act(async () => { await hub().readPhoto(new Blob()); });
    await waitFor(() => expect(labels()).toHaveLength(2));
    await act(async () => { await hub().send("Something with chicken"); });
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("composed-card")).toBeTruthy());
    expect(labels()).toEqual([]);
  });
});
