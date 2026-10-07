/**
 * One commit belongs to one date (Grok pass 16, HIGH 2).
 *
 * The sheet drew its optimistic card on the date the REQUEST carries — today, because the entry is
 * eaten now — while the page filed the same entry on the day she happened to be looking at. With a
 * past day open that is two cards for one tap, on two different days, and both days' rings count
 * the meal.
 *
 * The date the server files is `local_date`, so that is the one date: the card, the request and
 * the page's own `onAdd` all take it. The first test is what the day looks like when they do; the
 * two below pin the wiring in the sheet and the page, which no node test can click.
 */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommitRequest } from "@/lib/log-client";
import { commitLogEntry, committedEntry } from "@/lib/log-commit-client";
import { getDay, loadStore, saveStore, upsertExtra } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";


vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

/** The day she is looking at: a past one, which is where the second card used to land. */
const VIEWED = "2026-10-29";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const FOOD_REF = "cccccccc-3333-4333-8333-333333333333";

const ENTRY: LoggedFood = {
  id: ENTRY_ID, foodId: FOOD_REF, name: "Greek yogurt", portionLabel: "100 g",
  qty: 1, grams: 100, macros: { kcal: 100, protein: 10, carbs: 5, fat: 2 },
  at: "2026-11-02T17:00:00.000Z",
};

function source(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
}

beforeEach(async () => {
  await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
});

describe("the date a logged card is filed on", () => {
  it("is the request's own, on every day she may be looking at", async () => {
    const at = new Date("2026-11-02T17:00:00.000Z");
    const req = buildCommitRequest({
      entryId: ENTRY_ID, eatenAt: at, tz: "UTC", slot: "meal-2",
      items: [{ id: ITEM_ID, foodRefId: FOOD_REF, revision: { revision_id: null },
        grams: 100, qty: 1, unit: "g" }],
    });
    const answers = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 1 }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await commitLogEntry(req, { fetchImpl: answers, optimistic: { date: req.local_date, entry: ENTRY } });
    // What the page does with the answer, with the past day still open.
    upsertExtra(req.local_date, committedEntry(req.local_date, ENTRY));

    expect(req.local_date).not.toBe(VIEWED);
    expect(getDay(VIEWED)?.extras ?? []).toHaveLength(0);
    expect(getDay(req.local_date)?.extras ?? []).toHaveLength(1);
  });

  it("is the only date the log sheet uses for a commit", () => {
    const sheet = source("components/LogFoodSheet.tsx");
    // One name, taken from the request, for the card and for what the page is handed.
    expect(sheet).toMatch(/const filed = \w+\.local_date/);
    expect(sheet).toMatch(/optimistic: \{ date: filed/);
    expect(sheet).toMatch(/onAdd\(committedEntry\(filed, entry\), filed\)/);
    // The clock read a second time is where the two dates came from.
    expect(sheet).not.toMatch(/localDateOf\(at\)/);
  });

  it("is the date the page files the card on, not the day on screen", () => {
    const page = source("app/page.tsx");
    expect(page).toMatch(/function logFood\(entry: LoggedFood, date\?: string[,)]/);
    expect(page).toMatch(/upsertExtra\(date \?\? viewedDate, entry\)/);
  });
});
