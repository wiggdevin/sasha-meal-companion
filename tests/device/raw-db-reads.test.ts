// @vitest-environment jsdom
/**
 * Phase 9 slice 1, audit plan r2 finding 7: code that opens an account database and runs its own
 * transaction checks the handle after its reads, so a read that finishes after a switch is dropped.
 */
import "fake-indexeddb/auto";
import { readFileSync, readdirSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { closeAllAccountDbs, openAccountDb, putRow } from "@/lib/sync/idb";
import { restoreCachedPlanDays } from "@/lib/sync/plan-cache";
import { loadStore, resetStoreCache } from "@/lib/store";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  resetStoreCache();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("raw account-database users check their handle", () => {
  it("every client file that opens an account database also checks the handle", () => {
    const offenders = ["lib", "components", "app"].flatMap((d) =>
      (readdirSync(d, { recursive: true }) as string[]).map((f) => `${d}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f))
      .filter((f) => f !== "lib/sync/idb.ts")
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes("openAccountDb(") && !/assertCurrent\(|isCurrent/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it("restoreCachedPlanDays for A restores nothing once B binds while its read is pending", async () => {
    const a = bindAccount(A);
    await putRow(a, "plan_days", "2026-09-22", {
      local_date: "2026-09-22", user_id: A, rev: 1, floor_day: true, swaps: {}, slot_notes: {},
      item_overrides: {}, day_type_override: null,
    });
    await openAccountDb(a);
    const pending = restoreCachedPlanDays(a);
    bindAccount(B);
    await expect(pending.catch(() => 0)).resolves.toBe(0);
    expect(Object.keys(loadStore().days)).toEqual([]);
    expect(localStorage.getItem(`smc:u:${B}:store`)).toBeNull();
  });
});
