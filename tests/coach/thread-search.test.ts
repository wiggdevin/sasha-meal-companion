/**
 * W038 (audit A124): chat search ranks each thread's own hits before the 20-thread limit, so one
 * chatty thread with hundreds of newer matches cannot hide an older chat's matches.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const { searchChatThreads } = await import("@/lib/server/coach-threads");

type Row = Record<string, unknown>;
const USER = "account";

function fake(tables: Record<string, Row[]>, failMessages = false): SupabaseClient {
  return { from: (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let limit = 1000;
    let desc: string | null = null;
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column])); return query; },
      textSearch: (column: string, q: string) => {
        filters.push((row) => String(row[column]).includes(q)); return query; },
      order: (column: string) => { desc ??= column; return query; },
      range: () => query,
      limit: (n: number) => { limit = n; return query; },
      then: (resolve: (value: unknown) => unknown) => {
        if (failMessages && table === "coach_messages") {
          return Promise.resolve({ data: null, error: { message: "down" } }).then(resolve);
        }
        const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
        if (desc) rows.sort((a, b) => String(b[desc!]).localeCompare(String(a[desc!])));
        return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve);
      },
    };
    return query;
  } } as unknown as SupabaseClient;
}

function seed(): Record<string, Row[]> {
  const threads = [
    { id: "busy", user_id: USER, kind: "chat", title: "Daily log", deleted_at: null,
      last_message_at: "2026-10-10T00:00:00Z" },
    { id: "quiet", user_id: USER, kind: "chat", title: "Dinner ideas", deleted_at: null,
      last_message_at: "2026-09-01T00:00:00Z" },
  ];
  const busy = Array.from({ length: 300 }, (_, i) => ({ id: `b-${String(i).padStart(3, "0")}`,
    user_id: USER, thread_id: "busy", content: "chicken again",
    created_at: `2026-10-0${1 + (i % 9)}T00:00:${String(i % 60).padStart(2, "0")}Z` }));
  const quiet = [1, 2].map((n) => ({ id: `q-${n}`, user_id: USER, thread_id: "quiet",
    content: "a chicken curry", created_at: `2026-08-0${n}T00:00:00Z` }));
  return { coach_threads: threads, coach_messages: [...busy, ...quiet] };
}

describe("searchChatThreads", () => {
  it("returns an older chat's matches even when another chat has 300 newer ones", async () => {
    const results = await searchChatThreads(fake(seed()), USER, "chicken");
    expect(results.map((row) => row.threadId)).toEqual(["busy", "quiet"]);
    expect(results[0].matches).toHaveLength(3);
    expect(results[1].matches.map((match) => match.messageId)).toEqual(["q-2", "q-1"]);
  });

  it("keeps a title-only hit with no matches", async () => {
    const results = await searchChatThreads(fake(seed()), USER, "Dinner");
    expect(results).toEqual([{ threadId: "quiet", title: "Dinner ideas", matches: [] }]);
  });

  it("fails the whole search when a message read fails", async () => {
    await expect(searchChatThreads(fake(seed(), true), USER, "chicken"))
      .rejects.toMatchObject({ status: 503, code: "history_unavailable" });
  });
});
