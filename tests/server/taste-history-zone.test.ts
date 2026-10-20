/**
 * Audit A072: a manual shopping line is dated by the account's stored zone, like the logs and the
 * episodes it collapses with, never by the UTC date of its `updated_at`.
 */
import { describe, expect, it } from "vitest";
import { readTasteHistory } from "@/lib/server/taste-history";
import { A, LIST_A, REF, TODAY, tasteDb, tasteTables } from "@/tests/helpers/taste-fixture";
import type { Row } from "@/tests/helpers/occasion-fake-db";

function tables(zone: string | null, updatedAt: string): Record<string, Row[]> {
  return {
    ...tasteTables(),
    user_settings: zone ? [{ user_id: A, time_zone: zone }] : [],
    shopping_lines: [{ user_id: A, period_id: LIST_A, origin: "manual", name: "Bananas", identity: { foodRefId: REF.c902 },
      deleted_at: null, rev: 1, updated_at: updatedAt }],
  };
}

const choiceDates = async (zone: string | null, updatedAt: string) =>
  (await readTasteHistory(tasteDb(tables(zone, updatedAt)).client, A, TODAY)).choices
    .filter((choice) => choice.kind === "shopping_manual").map((choice) => choice.localDate);

describe("taste history: manual shopping lines by the account's day", () => {
  it("a line added at 21:00 Los Angeles time counts on that evening's date, not the next UTC day", async () => {
    // 2026-10-07T04:00Z is 21:00 on Oct 6 in Los Angeles (TODAY).
    expect(await choiceDates("America/Los_Angeles", "2026-10-07T04:00:00.000Z")).toEqual([TODAY]);
  });

  it("a line added at 08:00 Auckland time is dated that morning's date, a day after its UTC date", async () => {
    // 2026-10-05T19:00Z is 08:00 on Oct 6 in Auckland.
    expect(await choiceDates("Pacific/Auckland", "2026-10-05T19:00:00.000Z")).toEqual([TODAY]);
  });

  it("a line that falls after the account's today is not read yet", async () => {
    expect(await choiceDates("Pacific/Auckland", "2026-10-06T19:00:00.000Z")).toEqual([]);
  });

  it("an account with no stored zone dates by UTC", async () => {
    expect(await choiceDates(null, "2026-10-06T10:00:00.000Z")).toEqual([TODAY]);
    expect(await choiceDates(null, "2026-10-07T04:00:00.000Z")).toEqual([]);
  });
});
