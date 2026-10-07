import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import {
  ThreadsError, ThreadsUnavailable, cleanTitle, clearThreadMessages, countUnreadThreads, deleteThread, renameThread,
  searchThreads,
} from "@/lib/coach/threads-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  unbindAccount();
  bindAccount(A);
});

function reply(status: number, body?: unknown, contentType = "application/json") {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
    body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": contentType } }));
  return fetchImpl as unknown as typeof fetch & typeof fetchImpl;
}

describe("deleteThread", () => {
  it("sends DELETE for the thread and reads 204 as deleted", async () => {
    const fetchImpl = reply(204);
    await expect(deleteThread("t 1", { fetchImpl })).resolves.toBe("deleted");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/coach/threads/t%201");
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("x-smc-account")).toBe(A);
  });

  it("reads the JSON not_found as already gone", async () => {
    await expect(deleteThread("t1", { fetchImpl: reply(404, { error: "not_found" }) }))
      .resolves.toBe("missing");
  });

  it("reads a 405 or a page 404 as a server without the route", async () => {
    await expect(deleteThread("t1", { fetchImpl: reply(405, "") })).rejects.toBeInstanceOf(ThreadsUnavailable);
    await expect(deleteThread("t1", { fetchImpl: reply(404, "<html>", "text/html") }))
      .rejects.toBeInstanceOf(ThreadsUnavailable);
  });

  it("surfaces any other refusal with the server's words", async () => {
    await expect(deleteThread("t1", { fetchImpl: reply(429, { error: "rate_limited", message: "Slow down." }) }))
      .rejects.toMatchObject({ name: "ThreadsError", status: 429, message: "Slow down." });
  });

  it("turns a network failure into a plain message", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(deleteThread("t1", { fetchImpl })).rejects.toMatchObject({ message: "No connection. Try again." });
  });
});

describe("clearThreadMessages", () => {
  it("deletes the thread's messages, not the thread", async () => {
    const fetchImpl = reply(204);
    await expect(clearThreadMessages("t1", { fetchImpl })).resolves.toBe("cleared");
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/coach/threads/t1/messages");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("reads the missing messages route as unavailable", async () => {
    await expect(clearThreadMessages("t1", { fetchImpl: reply(404, "Not found", "text/plain") }))
      .rejects.toBeInstanceOf(ThreadsUnavailable);
  });
});

describe("renameThread", () => {
  it("trims the title and sends one PATCH", async () => {
    const fetchImpl = reply(200, { id: "t1", title: "Dinner ideas", kind: "chat", lastMessageAt: null });
    await expect(renameThread("t1", "  Dinner   ideas ", { fetchImpl }))
      .resolves.toEqual({ id: "t1", title: "Dinner ideas", kind: "chat", lastMessageAt: null });
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Dinner ideas" });
  });

  it("refuses an empty or over-long title before sending", async () => {
    const fetchImpl = reply(200, {});
    await expect(renameThread("t1", "   ", { fetchImpl })).rejects.toBeInstanceOf(ThreadsError);
    await expect(renameThread("t1", "x".repeat(81), { fetchImpl })).rejects.toBeInstanceOf(ThreadsError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cleanTitle("x".repeat(80))).toHaveLength(80);
  });

  it("says when the chat is gone", async () => {
    await expect(renameThread("t1", "New", { fetchImpl: reply(404, { error: "not_found" }) }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("searchThreads", () => {
  const results = [{ threadId: "t1", title: "Salmon", matches: [
    { messageId: "m1", snippet: "…grilled salmon with rice…", at: "2026-10-01T12:00:00Z" },
  ] }];

  it("asks the server from three characters and returns its hits", async () => {
    const fetchImpl = reply(200, { results });
    await expect(searchThreads(" salm ", { fetchImpl })).resolves.toEqual(results);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/coach/threads?q=salm");
  });

  it("never sends a query the route would refuse", async () => {
    const fetchImpl = reply(200, { results });
    await expect(searchThreads("sa", { fetchImpl })).resolves.toEqual([]);
    await expect(searchThreads("x".repeat(101), { fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the plain thread list of an older server as unavailable", async () => {
    await expect(searchThreads("salmon", { fetchImpl: reply(200, [{ id: "t1" }]) }))
      .rejects.toBeInstanceOf(ThreadsUnavailable);
  });

  it("drops malformed hits", async () => {
    const fetchImpl = reply(200, { results: [...results, { title: "no id" }, null] });
    await expect(searchThreads("salmon", { fetchImpl })).resolves.toEqual(results);
  });
});

describe("countUnreadThreads", () => {
  it("reads the count through the account's fetch, never cached", async () => {
    const fetchImpl = reply(200, { unread: 2 });
    await expect(countUnreadThreads({ fetchImpl })).resolves.toBe(2);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/coach/threads/unread");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("x-smc-account")).toBe(A);
  });

  it("reads a 404 as the coach being off", async () => {
    await expect(countUnreadThreads({ fetchImpl: reply(404, { error: "not_found" }) })).resolves.toBeNull();
  });

  it("throws on any other refusal or a body that is not a count", async () => {
    await expect(countUnreadThreads({ fetchImpl: reply(429, { error: "rate_limited" }) }))
      .rejects.toBeInstanceOf(ThreadsError);
    await expect(countUnreadThreads({ fetchImpl: reply(200, { unread: "2" }) })).rejects.toBeInstanceOf(ThreadsError);
    await expect(countUnreadThreads({ fetchImpl: reply(200, { unread: -1 }) })).rejects.toBeInstanceOf(ThreadsError);
  });
});
