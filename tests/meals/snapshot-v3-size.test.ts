/**
 * W107: snapshot v3 size by section, and the build log line. Lengths and counts only: the line
 * names no food, no id and no account.
 */
import { describe, expect, it, vi } from "vitest";
import { snapshotV3Size, SNAPSHOT_V3_MAX_BYTES, SNAPSHOT_V3_SECTIONS } from "@/lib/meals/snapshot-v3";
import { checkByteBudget } from "@/lib/server/meal-snapshot-v3";
import { ITEMS, OPEN_ACCOUNT, openSnapshot, ownFood } from "@/tests/helpers/open-snapshot";

const CHICKEN = ownFood("11111111-1111-4111-8111-111111111111", "Chicken breast, grilled", "protein", [31, 0, 3.6]);

describe("snapshotV3Size", () => {
  it("measures the whole body and each section in UTF-8 JSON bytes, with entry counts", () => {
    const body = openSnapshot({ favored: [CHICKEN] });
    const size = snapshotV3Size(body);
    expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
    for (const name of SNAPSHOT_V3_SECTIONS) {
      expect(size.sections[name]).toBe(Buffer.byteLength(JSON.stringify(body[name]), "utf8"));
    }
    expect(size.counts.favored).toBe(1);
    expect(size.counts.universe).toBe(Object.values(body.foods).filter((entry) => entry.source === "universe").length);
    expect(size.counts.foods).toBe(size.counts.favored + size.counts.universe);
    expect(size.counts.excluded).toBe(body.excluded.length);
  });
});

describe("checkByteBudget build log", () => {
  it("logs build ms, bytes and sections once per body, with no name, id or account", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const body = openSnapshot({ favored: [CHICKEN] });
    expect(checkByteBudget(body, SNAPSHOT_V3_MAX_BYTES, 123.4)).toBe(body);
    expect(info).toHaveBeenCalledTimes(1);
    const [, fields] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ metric: "snapshot_v3_build", buildMs: 123, over: false });
    const line = JSON.stringify(info.mock.calls[0]);
    expect(line).not.toContain(OPEN_ACCOUNT);
    expect(line).not.toContain("Chicken");
    expect(line).not.toContain(CHICKEN.userRefId);
    expect(ITEMS.some((item) => line.includes(item.food.name))).toBe(false);
    info.mockRestore();
  });

  it("logs nothing when no build time is given (a plain cap check)", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    checkByteBudget(openSnapshot());
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("the overage line carries sizes and counts, never the account", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    checkByteBudget(openSnapshot({ favored: [CHICKEN] }), 1);
    const line = JSON.stringify(error.mock.calls[0]);
    expect(line).toContain("snapshot_v3_overage");
    expect(line).not.toContain(OPEN_ACCOUNT);
    error.mockRestore();
  });
});
