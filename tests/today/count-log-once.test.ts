/**
 * Audit b4b #2: a Plan-panel log on a slot leaves an empty eaten meal on the FILED day, writes
 * nothing once the account changed, retries each write once, and never leaves the user a message
 * that tells them to tick the planned meal eaten (that counts the plan and the log).
 */
import { describe, expect, it, vi } from "vitest";
import { COUNT_LOG_FAILURE, countLogOnce, loggedShell } from "@/lib/today/count-log-once";
import { EATEN_LOGGED_NAME } from "@/lib/plan/eaten-estimate";

const AT = "2026-10-04T12:00:00.000Z";
const slot = { eaten: false, baseMealId: "lunch-bowl", before: { baseMealId: null, components: [], time: "12:30" } };

function writes(over: Partial<Parameters<typeof countLogOnce>[1]> = {}) {
  return { isCurrent: () => true, saveOverride: vi.fn(async () => {}), saveEaten: vi.fn(async () => {}), ...over };
}

describe("countLogOnce", () => {
  it("writes the empty meal, then ticks it eaten", async () => {
    const w = writes();
    expect(await countLogOnce(slot, w, () => AT)).toBe("counted");
    expect(w.saveOverride).toHaveBeenCalledWith({ baseMealId: "lunch-bowl", title: EATEN_LOGGED_NAME,
      components: [], time: "12:30" });
    expect(w.saveEaten).toHaveBeenCalledWith(AT);
  });

  // 2026-10-04 re-audit MAJOR 2: a ticked slot still gets the empty meal, so the log is the only
  // record (an eaten recipe snapshot no longer counts beside it). Only the empty meal itself is done.
  it("writes the empty meal on a slot already ticked eaten, without a second eaten mark", async () => {
    const w = writes();
    expect(await countLogOnce({ ...slot, eaten: true }, w)).toBe("counted");
    expect(w.saveOverride).toHaveBeenCalledTimes(1);
    expect(w.saveEaten).not.toHaveBeenCalled();
  });

  it("does nothing when the ticked slot already is the empty meal", async () => {
    const w = writes();
    const before = { baseMealId: "lunch-bowl", title: EATEN_LOGGED_NAME, components: [] };
    expect(await countLogOnce({ ...slot, eaten: true, before }, w)).toBe("already-eaten");
    expect(w.saveOverride).not.toHaveBeenCalled();
  });

  it("writes nothing more once the account has changed", async () => {
    let current = true;
    const w = writes({ isCurrent: () => current,
      saveOverride: vi.fn(async () => { current = false; }) });
    expect(await countLogOnce(slot, w)).toBe("stale");
    expect(w.saveEaten).not.toHaveBeenCalled();
  });

  it("retries a failed write once", async () => {
    const w = writes({ saveOverride: vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined) });
    expect(await countLogOnce(slot, w)).toBe("counted");
    expect(w.saveOverride).toHaveBeenCalledTimes(2);
  });

  it("keeps the plan when the empty meal cannot save, and never writes the eaten mark", async () => {
    const w = writes({ saveOverride: vi.fn(async () => { throw new Error("quota"); }) });
    expect(await countLogOnce(slot, w)).toBe("plan-kept");
    expect(w.saveEaten).not.toHaveBeenCalled();
  });

  it("leaves the empty meal (no food in it) when only the eaten mark fails", async () => {
    const w = writes({ saveEaten: vi.fn(async () => { throw new Error("quota"); }) });
    expect(await countLogOnce(slot, w)).toBe("eaten-unsaved");
    expect(w.saveOverride).toHaveBeenCalledTimes(1);
    expect(w.saveEaten).toHaveBeenCalledTimes(2);
  });

  it("never tells the user to tick the meal eaten", () => {
    expect(COUNT_LOG_FAILURE).not.toMatch(/tick it eaten by hand/i);
    expect(COUNT_LOG_FAILURE).toMatch(/Don.t tick it eaten/);
  });

  it("keeps an added meal added and falls back to the earlier override's meal id", () => {
    expect(loggedShell({ eaten: false, baseMealId: null,
      before: { baseMealId: "m1", components: [], added: true } })).toMatchObject({ baseMealId: "m1", added: true });
  });
});
