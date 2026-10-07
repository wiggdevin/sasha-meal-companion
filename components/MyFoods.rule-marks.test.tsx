// @vitest-environment jsdom
/**
 * Foods › Eats says why an Eats food is not being suggested (2026-10-05, contract #380): the verified
 * eligible set's mark for that food, with its name, under the row, describing its Edit button. Clear
 * foods say nothing; the row stays and still opens. Fail closed and say so: a set the server could
 * not judge shows the unknown marks it sent, an unread or revoked set puts one line on the list, a
 * failed refetch keeps the marks it had, and a sync pass that changed no input reads nothing new.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Food } from "@/lib/foods";
import type { RuleMark } from "@/lib/types";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { foodRulesKey } from "@/lib/foods/rule-marks";

const seeded = vi.hoisted(() => ({ foods: {} as Record<string, Food> }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => ({ ...actual.defaultStore(), foods: seeded.foods }) };
});
const eligible = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/foods/eligible-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/eligible-client")>();
  return { ...actual, loadEligibleLocalFoodIds: eligible.load };
});

const { default: EatsFoods } = await import("./MyFoods");
const { eatsRuleMark, EATS_NOT_CHECKED, EATS_RULES_CHECKING, EATS_RULES_FIRST_CHECK, EATS_RULES_STALE,
  EATS_RULES_UNCHECKED, ELIGIBLE_REFRESH_MS, ELIGIBLE_RETRY_MS, UNJUDGED_RETRY_MS } = await import("./MyFoods.rule-marks");
const { SYNCED_EVENT } = await import("@/lib/sync/client");
const { StampedEligibleSet, eligibleLocalSentences } = await import("@/lib/foods/eligible-client");
const { foodRulesEpoch, noteFoodRulesChanged } = await import("@/lib/foods/rules-epoch");

function food(over: Partial<Food>): Food {
  return { id: "oats", name: "Oats", role: "carb", unit: "g",
    perUnit: { protein: 0.1, carbs: 0.6, fat: 0.07 }, status: "eats",
    updatedAt: "2026-09-20T00:00:00.000Z", ...over } as Food;
}
const PEANUT: RuleMark = { verdict: "blocked", reason: "has peanut, which your rules exclude." };
const UNCHECKED: RuleMark = { verdict: "unknown", reason: "could not be checked against your food rules." };

function stamped(ids: string[], marks: Record<string, RuleMark>,
  rulesKey = foodRulesKey({ dietPrefs: { flags: [] } }), sentences: Record<string, RuleMark> = {}) {
  return new StampedEligibleSet(ids, new Map(Object.entries(marks)), rulesKey, foodRulesEpoch(),
    undefined, undefined, undefined, new Map(Object.entries(sentences)));
}
const synced = () => act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
const notice = () => document.querySelector(".notice")?.textContent ?? null;

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  seeded.foods = Object.fromEntries([food({}),
    food({ id: "pb", name: "Peanut butter", role: "fat" }),
    food({ id: "bar", name: "Mystery bar", role: "carb" })].map((item) => [item.id, item]));
  eligible.load.mockReset();
});
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
const setVisibility = (next: DocumentVisibilityState) => act(() => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); visibility = "visible"; });

/** A clock the hook reads (Date.now) and timers it sets, moved together. */
function clock() {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    set: (ms: number) => { now += ms; },
    tick: async (ms: number) => { now += ms; await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); },
  };
}
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

const rowOf = (name: string) => screen.getByRole("button", { name: `Edit ${name}` })
  .closest("[data-food-row]")!.parentElement as HTMLElement;

describe("Eats rows and the rules", () => {
  it("shows a blocked and an unknown food's mark under its row, and nothing for a clear one", async () => {
    eligible.load.mockResolvedValue(stamped(["oats"], { pb: PEANUT, bar: UNCHECKED }));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    const peanut = rowOf("Peanut butter");
    expect(peanut.querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("blocked");
    expect(peanut.textContent).toContain("Off your rules");
    expect(peanut.textContent).toContain("Peanut butter has peanut, which your rules exclude.");
    expect(rowOf("Mystery bar").textContent).toContain("Mystery bar could not be checked against your food rules.");
    expect(rowOf("Mystery bar").querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("unknown");
    expect(rowOf("Oats").querySelector("[data-rule-mark]")).toBeNull();
    expect(notice()).toBeNull();
    // The mark describes the row's own Edit button; a clear row has no description.
    const edit = screen.getByRole("button", { name: "Edit Peanut butter" });
    const described = document.getElementById(edit.getAttribute("aria-describedby")!);
    expect(described?.textContent).toContain("Peanut butter has peanut, which your rules exclude.");
    expect(screen.getByRole("button", { name: "Edit Mystery bar" }).getAttribute("aria-describedby"))
      .not.toBe(edit.getAttribute("aria-describedby"));
    expect(screen.getByRole("button", { name: "Edit Oats" }).hasAttribute("aria-describedby")).toBe(false);
    // A mark never blocks the row: it still opens its food.
    fireEvent.click(screen.getByRole("button", { name: "Edit Peanut butter" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("says it is checking before the first answer, with no row marks yet", async () => {
    eligible.load.mockImplementation(() => new Promise(() => {}));
    render(<EatsFoods />);
    await waitFor(() => expect(notice()).toBe(EATS_RULES_FIRST_CHECK));
    expect(document.querySelector(".notice")?.getAttribute("role")).toBe("status");
    expect(document.querySelectorAll(".notice")).toHaveLength(1);
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
  });

  it("puts one line on the list when the set could not be read, never a cleared look", async () => {
    eligible.load.mockRejectedValue(new Error("offline"));
    render(<EatsFoods />);
    await waitFor(() => expect(notice()).toBe(EATS_RULES_UNCHECKED));
    expect(document.querySelectorAll(".notice")).toHaveLength(1);
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
  });

  it("shows the unknown marks an unjudged answer sent, and the line for rows it left bare", async () => {
    // The server could not read its evidence: every ref unknown, and no preferenceFlags.
    eligible.load.mockResolvedValue(stamped([], { pb: UNCHECKED, bar: UNCHECKED }, "unjudged-diet-flags"));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    expect(rowOf("Peanut butter").textContent).toContain("Peanut butter could not be checked against your food rules.");
    expect(rowOf("Mystery bar").querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("unknown");
    // Nothing it sent clears a row: the bare one is unchecked too, and the list says why.
    expect(rowOf("Oats").querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("unknown");
    expect(rowOf("Oats").textContent).toContain(EATS_NOT_CHECKED);
    expect(notice()).toBe(EATS_RULES_UNCHECKED);
  });

  it("reads again only when an input changed, and a failed refetch keeps the marks", async () => {
    const time = clock();
    eligible.load.mockResolvedValueOnce(stamped(["oats", "bar"], { pb: PEANUT }));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    synced(); synced(); synced();
    expect(eligible.load).toHaveBeenCalledTimes(1);
    // A new Eats food is a new input: one read, which is rate limited.
    seeded.foods = { ...seeded.foods, rice: food({ id: "rice", name: "Rice" }) };
    eligible.load.mockRejectedValue(new Error("429"));
    synced();
    await waitFor(() => expect(eligible.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Rice" })).toBeTruthy());
    expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("blocked");
    // The new food never reached a read: unchecked, not clear.
    expect(rowOf("Rice").querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("unknown");
    expect(rowOf("Rice").textContent).toContain(EATS_NOT_CHECKED);
    expect(rowOf("Oats").querySelector("[data-rule-mark]")).toBeNull();
    // The marks are the last good read's: the list says they may be out of date, and no more.
    expect(notice()).toBe(EATS_RULES_STALE);
    expect(document.querySelectorAll(".notice")).toHaveLength(1);
    // The same inputs after a failure wait out the retry interval.
    synced();
    expect(eligible.load).toHaveBeenCalledTimes(2);
    time.set(ELIGIBLE_RETRY_MS + 1);
    eligible.load.mockResolvedValueOnce(stamped(["oats", "bar", "rice"], { pb: PEANUT }));
    synced();
    await waitFor(() => expect(eligible.load).toHaveBeenCalledTimes(3));
    // A read that lands clears the line.
    await waitFor(() => expect(notice()).toBeNull());
    expect(rowOf("Rice").querySelector("[data-rule-mark]")).toBeNull();
  });

  it("refreshes a good read on a sync pass at most every two minutes", async () => {
    const time = clock();
    eligible.load.mockResolvedValue(stamped(["oats", "bar"], { pb: PEANUT }));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    time.set(60_000);
    synced();
    expect(eligible.load).toHaveBeenCalledTimes(1);
    // A rule changed on another device moves no local input; the bounded refresh still reads it.
    time.set(ELIGIBLE_REFRESH_MS - 60_000 + 1);
    eligible.load.mockResolvedValue(stamped(["oats", "bar", "pb"], {}));
    synced();
    await waitFor(() => expect(eligible.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector("[data-rule-mark]")).toBeNull());
    synced();
    expect(eligible.load).toHaveBeenCalledTimes(2);
  });

  it("refreshes an open, visible list every 2 min, and stops while hidden or closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const time = clock();
    eligible.load.mockResolvedValue(stamped(["oats", "bar"], { pb: PEANUT }));
    const view = render(<EatsFoods />);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(1);
    // No sync pass and no local change: the timer alone picks up rules changed elsewhere.
    await time.tick(ELIGIBLE_REFRESH_MS - 1_000);
    expect(eligible.load).toHaveBeenCalledTimes(1);
    eligible.load.mockResolvedValue(stamped(["oats", "bar", "pb"], {}));
    await time.tick(1_000);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
    await setVisibility("hidden");
    await time.tick(3 * ELIGIBLE_REFRESH_MS);
    expect(eligible.load).toHaveBeenCalledTimes(2);
    // Back in view after more than a step: read now, then on the timer again.
    await setVisibility("visible");
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(3);
    await time.tick(ELIGIBLE_REFRESH_MS);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(4);
    view.unmount();
    await time.tick(3 * ELIGIBLE_REFRESH_MS);
    expect(eligible.load).toHaveBeenCalledTimes(4);
  });

  it("reads an unjudged answer again on its own, after 30 s and then 2 min", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const time = clock();
    eligible.load.mockResolvedValue(stamped([], { bar: UNCHECKED }, "unjudged-diet-flags"));
    render(<EatsFoods />);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(1);
    await time.tick(UNJUDGED_RETRY_MS[0] - 1_000);
    expect(eligible.load).toHaveBeenCalledTimes(1);
    await time.tick(1_000);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(2);
    // Still unjudged: the next read waits the longer step.
    await time.tick(UNJUDGED_RETRY_MS[0]);
    expect(eligible.load).toHaveBeenCalledTimes(2);
    eligible.load.mockResolvedValue(stamped(["oats", "pb", "bar"], {}));
    await time.tick(UNJUDGED_RETRY_MS[1] - UNJUDGED_RETRY_MS[0]);
    await flush();
    expect(eligible.load).toHaveBeenCalledTimes(3);
    // Judged: no timer of its own any more.
    await time.tick(10 * 60_000);
    expect(eligible.load).toHaveBeenCalledTimes(3);
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
    expect(notice()).toBeNull();
  });

  it("drops a set's marks once a rule changes, then shows the re-read", async () => {
    eligible.load.mockResolvedValueOnce(stamped(["oats"], { pb: PEANUT }));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    let finish!: (value: unknown) => void;
    eligible.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { noteFoodRulesChanged(); });
    await waitFor(() => expect(document.querySelector("[data-rule-mark]")).toBeNull());
    expect(notice()).toBe(EATS_RULES_CHECKING);
    finish(stamped(["oats", "pb"], { bar: UNCHECKED }));
    await waitFor(() => expect(rowOf("Mystery bar").querySelector("[data-rule-mark]")).not.toBeNull());
    expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).toBeNull();
    expect(notice()).toBeNull();
  });
});

describe("the server's whole sentences", () => {
  it("shows an exclusion's mark.reason as sent, and names the fragment only when it is absent", async () => {
    eligible.load.mockResolvedValue(stamped(["oats"], { pb: PEANUT, bar: UNCHECKED }, undefined,
      { pb: { verdict: "blocked", reason: "Smooth peanut butter (store brand) has peanut, which your rules exclude." } }));
    render(<EatsFoods />);
    await waitFor(() => expect(rowOf("Peanut butter").querySelector("[data-rule-mark]")).not.toBeNull());
    expect(rowOf("Peanut butter").textContent)
      .toContain("Smooth peanut butter (store brand) has peanut, which your rules exclude.");
    expect(rowOf("Peanut butter").textContent).not.toContain("Peanut butter has peanut");
    // No sentence for this one (an older server): the fragment gets the food's own name.
    expect(rowOf("Mystery bar").textContent).toContain("Mystery bar could not be checked against your food rules.");
  });

  it("keeps a well-formed mark of the chosen verdict, and skips a malformed or mismatched one", () => {
    const foods = { pb: food({ id: "pb", name: "Peanut butter" }), bar: food({ id: "bar", name: "Mystery bar" }),
      oats: food({}), gum: food({ id: "gum", name: "Gum" }) };
    const refs = { pb: { userRefId: "r-pb" }, bar: { userRefId: "r-bar" }, oats: { userRefId: "r-oats" },
      gum: { userRefId: "r-gum" } } as unknown as Parameters<typeof eligibleLocalSentences>[1];
    const sentences = eligibleLocalSentences(foods, refs, [
      { refId: "r-pb", verdict: "blocked", mark: { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." } },
      { refId: "r-bar", verdict: "unknown", mark: { verdict: "unknown", reason: "" } },
      { refId: "r-gum", verdict: "unknown", mark: { verdict: "blocked", reason: "Gum is excluded." } },
      { refId: "r-oats", verdict: "blocked", mark: { verdict: "blocked", reason: "Oats is excluded." } },
    ], new Set(["oats"]));
    expect([...sentences]).toEqual([["pb", { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." }]]);
  });
});

describe("eatsRuleMark", () => {
  it("names the food, and marks only a food on Eats", () => {
    const view = { marks: new Map([["pb", PEANUT]]) };
    expect(eatsRuleMark(food({ id: "pb", name: "Peanut butter" }), view))
      .toEqual({ verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." });
    expect(eatsRuleMark(food({ id: "pb", name: "Peanut butter", status: "neutral" }), view)).toBeNull();
    expect(eatsRuleMark(food({ id: "oats" }), view)).toBeNull();
    expect(eatsRuleMark(food({ id: "pb" }), undefined)).toBeNull();
  });
});
