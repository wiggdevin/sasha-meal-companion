/**
 * Review WARN, 2026-10-05: the label sheet closed before the serving was logged, so a refusal
 * lost the typed draft. `settleLabelLog` closes only on a committed or local result; a refusal
 * returns its message and the sheet keeps the draft (tests/foods/add-food-label-once.test.tsx).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LABEL_STILL_SAVING, labelAttempts, settleLabelLog, type LabelPorts,
} from "@/components/LogFoodSheet.picks";
import { getDay } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const CARD: LoggedFood = {
  id: "c1", foodId: "bar", name: "Protein bar", portionLabel: "1 oz", qty: 1, grams: 28.3495,
  macros: { kcal: 70, protein: 6, carbs: 7, fat: 2 }, at: "2026-11-02T17:00:00.000Z",
};

function ports() {
  return { viewedDate: "2026-11-01", close: vi.fn<() => void>(), refresh: vi.fn<() => void>(),
    confirmLogged: vi.fn<() => void>(), notify: vi.fn<LabelPorts["notify"]>() } satisfies LabelPorts;
}

beforeEach(async () => { await resetTestAccount(); });

describe("settleLabelLog", () => {
  it("keeps the sheet open on a refusal and hands its message back", () => {
    const p = ports();
    expect(settleLabelLog({ kind: "refused", message: "The server would not take that one. Try again." }, p))
      .toBe("The server would not take that one. Try again.");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notify).not.toHaveBeenCalled();
  });

  it("closes on a committed log and files the card on its commit date", () => {
    const p = ports();
    expect(settleLabelLog({ kind: "committed", date: "2026-11-02", entry: CARD, message: null }, p)).toBeUndefined();
    expect(p.close).toHaveBeenCalledOnce();
    expect(p.confirmLogged).toHaveBeenCalledOnce();
    expect(getDay("2026-11-02")?.extras).toEqual([CARD]);
  });

  it("closes on a local log, files it on the day on screen and says it stayed on the phone", () => {
    const p = ports();
    settleLabelLog({ kind: "local", entry: CARD, message: "Saved on this phone only." }, p);
    expect(p.close).toHaveBeenCalledOnce();
    expect(getDay("2026-11-01")?.extras).toEqual([CARD]);
    expect(p.notify).toHaveBeenCalledWith({ tone: "error", message: "Saved on this phone only." });
  });

  it("is what Today settles a label log with, and Today closes the sheet nowhere else", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    const body = page.slice(page.indexOf("async function logLabelServing"), page.indexOf("async function logWater"));
    expect(body).toMatch(/return settleLabelLog\(logged, \{[^}]*close: \(\) => \{ if \(isCurrentSheet\(\)\) setLabelOpen\(false\)/);
    expect(body.match(/setLabelOpen\(false\)/g)).toHaveLength(1);
  });
});

describe("labelAttempts", () => {
  function deferred() {
    let resolve: (value: string | void) => void = () => undefined;
    const promise = new Promise<string | void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("reports an overlapping submit as still saving, never as a success", async () => {
    const attempts = labelAttempts();
    attempts.opened();
    const slow = deferred();
    const run = vi.fn(() => slow.promise);
    const first = attempts.submit(run);
    expect(await attempts.submit(run)).toBe(LABEL_STILL_SAVING);
    expect(run).toHaveBeenCalledOnce();
    slow.resolve(undefined);
    expect(await first).toBeUndefined();
    // Once it settles, the next submit runs.
    attempts.opened();
    await attempts.submit(async () => undefined);
  });

  it("lets an old attempt close only the sheet it came from", async () => {
    const attempts = labelAttempts();
    attempts.opened();
    const slow = deferred();
    let isCurrentSheet: () => boolean = () => false;
    const first = attempts.submit((current) => { isCurrentSheet = current; return slow.promise; });
    expect(isCurrentSheet()).toBe(true);
    // The user closes that sheet and opens a new one while the first log is still saving.
    attempts.opened();
    expect(isCurrentSheet()).toBe(false);
    slow.resolve(undefined);
    await first;
    const fresh = vi.fn(async (current: () => boolean) => { expect(current()).toBe(true); });
    await attempts.submit(fresh);
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("is what Today scopes the label log with", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    expect(page).not.toMatch(/labelLogging/);
    expect(page).toMatch(/labelLog\.opened\(\)/);
    expect(page).toMatch(/labelLog\.submit\(/);
    expect(page).toMatch(/close: \(\) => \{ if \(isCurrentSheet\(\)\) setLabelOpen\(false\); \}/);
  });
});
