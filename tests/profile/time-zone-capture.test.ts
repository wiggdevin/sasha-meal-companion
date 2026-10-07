import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { captureTimeZone, resolvedTimeZone } from "@/lib/sync/settings";
import { USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { settingsProfileFromRow, settingsProfileToRow } from "@/lib/sync/user-settings";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/**
 * D1 §6.4. The server default is UTC and nothing in code names a region — the zone an account
 * keeps is the zone its own first device reported, captured on the first authenticated online
 * open and queued through the ordinary settings-intent path.
 */
describe("capturing the browser time zone", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("queues exactly one intent, for the zone alone", async () => {
    expect(await captureTimeZone(h, "Europe/Lisbon")).toBe(true);

    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: "user_settings", entity_id: USER_SETTINGS_KEY });
    expect(ops[0].payload).toEqual({ time_zone: "Europe/Lisbon" });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ time_zone: "Europe/Lisbon" });
  });

  it("leaves a zone the account already chose alone, so a second device cannot rewrite it", async () => {
    await putRow(h, "user_settings", USER_SETTINGS_KEY, { time_zone: "Europe/Lisbon", rev: 4 });

    expect(await captureTimeZone(h, "America/Denver")).toBe(false);
    expect(await allOps(h)).toHaveLength(0);
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ time_zone: "Europe/Lisbon" });
  });

  it("treats a blank stored zone as no zone", async () => {
    await putRow(h, "user_settings", USER_SETTINGS_KEY, { time_zone: "   ", rev: 4 });

    expect(await captureTimeZone(h, "Asia/Tokyo")).toBe(true);
    expect((await allOps(h))[0].payload).toEqual({ time_zone: "Asia/Tokyo" });
  });

  it("is idempotent: a repeated open queues nothing more", async () => {
    await captureTimeZone(h, "Asia/Tokyo");
    expect(await captureTimeZone(h, "Asia/Tokyo")).toBe(false);
    expect(await allOps(h)).toHaveLength(1);
  });

  it("reads the browser's own zone, and falls back to UTC rather than to a region", () => {
    const zone = resolvedTimeZone();
    expect(typeof zone).toBe("string");
    expect(zone.length).toBeGreaterThan(0);
    expect(zone).not.toBe("America/New_York");
  });

  it("round-trips through the user_settings profile mapping the sync row uses", () => {
    expect(settingsProfileToRow({ ...settingsProfileFromRow({ time_zone: null }),
      timeZone: "Europe/Lisbon" })).toMatchObject({ time_zone: "Europe/Lisbon" });
    expect(settingsProfileFromRow({ time_zone: "Europe/Lisbon" }).timeZone)
      .toBe("Europe/Lisbon");
  });
});
