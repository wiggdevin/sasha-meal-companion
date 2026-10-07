import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { HttpError } from "@/lib/server/auth";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { DELETE: deleteThreadRoute, GET: getThreadRoute, PATCH: patchThreadRoute } =
  await import("@/app/api/coach/threads/[id]/route");
const { DELETE: clearRoute } = await import("@/app/api/coach/threads/[id]/messages/route");
const { GET: listOrSearchRoute } = await import("@/app/api/coach/threads/route");
const { GET: unreadRoute } = await import("@/app/api/coach/threads/unread/route");

const OWN_CHAT = "3f1b1a2c-0000-4000-8000-000000000001";
const OWN_PLAN = "3f1b1a2c-0000-4000-8000-000000000002";
const FOREIGN_CHAT = "3f1b1a2c-0000-4000-8000-000000000003";
const MSG_1 = "3f1b1a2c-0000-4000-8000-000000000011";
const MSG_2 = "3f1b1a2c-0000-4000-8000-000000000012";

type Row = Record<string, unknown>;

/** A small in-memory stand-in for the supabase-js query builder: enough chaining to exercise
 * select/update/delete with eq/is/in/textSearch/order/range/limit and maybeSingle. */
function makeClient(seed: { coach_threads: Row[]; coach_messages: Row[] }) {
  const data: Record<string, Row[]> = {
    coach_threads: seed.coach_threads.map((row) => ({ ...row })),
    coach_messages: seed.coach_messages.map((row) => ({ ...row })),
  };
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let mode: "select" | "update" | "delete" = "select";
    let patch: Row = {};
    let head = false;
    const matched = () => (data[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
    const apply = () => {
      const rows = matched();
      if (mode === "update") rows.forEach((row) => Object.assign(row, patch));
      if (mode === "delete") {
        data[table] = (data[table] ?? []).filter((row) => !rows.includes(row));
      }
      return rows;
    };
    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean; count?: string }) => {
        head = opts?.head === true && opts.count === "exact"; return chain;
      },
      update: (p: Row) => { mode = "update"; patch = p; return chain; },
      delete: () => { mode = "delete"; return chain; },
      eq: (col: string, val: unknown) => { filters.push((row) => row[col] === val); return chain; },
      is: (col: string, val: unknown) => {
        filters.push((row) => (row[col] ?? null) === val); return chain;
      },
      lt: (col: string, val: number) => { filters.push((row) => Number(row[col]) < val); return chain; },
      lte: (col: string, val: string) => {
        filters.push((row) => row[col] != null && Date.parse(String(row[col])) <= Date.parse(val));
        return chain;
      },
      not: (col: string, operator: string, val: unknown) => {
        if (operator !== "is" || val !== null) throw new Error(`unsupported not(${operator})`);
        filters.push((row) => (row[col] ?? null) !== null); return chain;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((row) => vals.includes(row[col])); return chain;
      },
      textSearch: (col: string, q: string) => {
        const needle = q.toLocaleLowerCase("en-US");
        filters.push((row) => String(row[col] ?? "").toLocaleLowerCase("en-US").includes(needle));
        return chain;
      },
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const rows = apply();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (value: { data: Row[] | null; error: null; count?: number }) => unknown) => {
        const rows = apply();
        return Promise.resolve(head ? { data: null, error: null, count: rows.length }
          : { data: rows, error: null }).then(resolve);
      },
    };
    return chain;
  };
  return { from } as never;
}

function seeded() {
  return makeClient({
    coach_threads: [
      { id: OWN_CHAT, user_id: "u1", title: "Tofu plans", kind: "chat",
        last_message_at: "2026-10-01T12:00:00Z", deleted_at: null, summary: "a running summary" },
      { id: OWN_PLAN, user_id: "u1", title: "Plan sheet", kind: "plan",
        last_message_at: "2026-10-01T10:00:00Z", deleted_at: null, summary: null },
      { id: FOREIGN_CHAT, user_id: "u2", title: "Someone else's chat", kind: "chat",
        last_message_at: "2026-10-01T09:00:00Z", deleted_at: null, summary: null },
    ],
    coach_messages: [
      { id: MSG_1, thread_id: OWN_CHAT, user_id: "u1", role: "user",
        content: "I really enjoy tofu for breakfast", seq: 1, created_at: "2026-10-01T12:00:00Z" },
      { id: MSG_2, thread_id: OWN_PLAN, user_id: "u1", role: "user",
        content: "tofu stir fry for dinner", seq: 1, created_at: "2026-10-01T10:00:00Z" },
    ],
  });
}

const deleteReq = (id: string) =>
  new Request(`https://app.test/api/coach/threads/${id}`, { method: "DELETE" });
const clearReq = (id: string) =>
  new Request(`https://app.test/api/coach/threads/${id}/messages`, { method: "DELETE" });
const patchReq = (id: string, body: unknown) =>
  new Request(`https://app.test/api/coach/threads/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const listReq = (q?: string) => new Request(
  `https://app.test/api/coach/threads${q !== undefined ? `?q=${encodeURIComponent(q)}` : ""}`);

beforeEach(() => {
  resetRateLimits();
  vi.stubEnv("COACH_ENABLED", "1");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("DELETE /api/coach/threads/[id]", () => {
  it("soft-deletes an owned chat", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await deleteThreadRoute(deleteReq(OWN_CHAT), { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s a plan thread, and a foreign chat, like an unknown id", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await deleteThreadRoute(deleteReq(OWN_PLAN),
      { params: Promise.resolve({ id: OWN_PLAN }) })).status).toBe(404);
    expect((await deleteThreadRoute(deleteReq(FOREIGN_CHAT),
      { params: Promise.resolve({ id: FOREIGN_CHAT }) })).status).toBe(404);
  });

  it("401s when the caller is not signed in", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await deleteThreadRoute(deleteReq(OWN_CHAT), { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/coach/threads/[id]/messages (clear)", () => {
  it("deletes every message, nulls the summary and last_message_at, keeps the title", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await clearRoute(clearReq(OWN_CHAT), { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(204);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const raw = client as any;
    const { data: threadRows } = await raw.from("coach_threads").select().eq("id", OWN_CHAT);
    expect(threadRows[0]).toMatchObject({ title: "Tofu plans", summary: null, last_message_at: null });
    const { data: messageRows } = await raw.from("coach_messages").select().eq("thread_id", OWN_CHAT);
    expect(messageRows).toHaveLength(0);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it("404s a plan thread and a foreign chat", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await clearRoute(clearReq(OWN_PLAN),
      { params: Promise.resolve({ id: OWN_PLAN }) })).status).toBe(404);
    expect((await clearRoute(clearReq(FOREIGN_CHAT),
      { params: Promise.resolve({ id: FOREIGN_CHAT }) })).status).toBe(404);
  });

  it("401s when the caller is not signed in", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await clearRoute(clearReq(OWN_CHAT), { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/coach/threads/[id] (rename)", () => {
  it("renames an owned chat and returns the thread summary shape", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await patchThreadRoute(patchReq(OWN_CHAT, { title: "New title" }),
      { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: OWN_CHAT, title: "New title", kind: "chat" });
  });

  it("400s an empty or over-long title", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await patchThreadRoute(patchReq(OWN_CHAT, { title: "" }),
      { params: Promise.resolve({ id: OWN_CHAT }) })).status).toBe(400);
    expect((await patchThreadRoute(patchReq(OWN_CHAT, { title: "x".repeat(81) }),
      { params: Promise.resolve({ id: OWN_CHAT }) })).status).toBe(400);
  });

  it("404s a plan thread and a foreign chat", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await patchThreadRoute(patchReq(OWN_PLAN, { title: "Nope" }),
      { params: Promise.resolve({ id: OWN_PLAN }) })).status).toBe(404);
    expect((await patchThreadRoute(patchReq(FOREIGN_CHAT, { title: "Nope" }),
      { params: Promise.resolve({ id: FOREIGN_CHAT }) })).status).toBe(404);
  });

  it("401s when the caller is not signed in", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await patchThreadRoute(patchReq(OWN_CHAT, { title: "Nope" }),
      { params: Promise.resolve({ id: OWN_CHAT }) });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/coach/threads?q= (search)", () => {
  it("matches a thread by title and a thread by message content, active chats only", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await listOrSearchRoute(listReq("tofu"));
    expect(res.status).toBe(200);
    const { results } = await res.json() as { results: { threadId: string; title: string | null;
      matches: { messageId: string; snippet: string; at: string }[] }[] };
    // Only the owned chat (OWN_PLAN is kind "plan" and FOREIGN_CHAT belongs to u2).
    expect(results).toHaveLength(1);
    expect(results[0].threadId).toBe(OWN_CHAT);
    expect(results[0].matches).toHaveLength(1);
    expect(results[0].matches[0]).toMatchObject({ messageId: MSG_1 });
  });

  it("a title-only match still appears, with an empty matches array", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await listOrSearchRoute(listReq("Tofu plans"));
    const { results } = await res.json() as { results: { threadId: string; matches: unknown[] }[] };
    expect(results.find((r) => r.threadId === OWN_CHAT)?.matches).toEqual([]);
  });

  it("400s a query shorter than 3 or longer than 100 characters", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await listOrSearchRoute(listReq("ab"))).status).toBe(400);
    expect((await listOrSearchRoute(listReq("x".repeat(101)))).status).toBe(400);
  });

  it("without q, behaves exactly like the existing listing", async () => {
    const client = seeded();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await listOrSearchRoute(listReq());
    const rows = await res.json() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([OWN_CHAT, OWN_PLAN]);
  });
});

describe("weekly-review unread badge (audit P2 #15)", () => {
  const WEEKLY = "3f1b1a2c-0000-4000-8000-000000000004";
  const FOREIGN_WEEKLY = "3f1b1a2c-0000-4000-8000-000000000005";
  const DELIVERED = "2026-10-12T00:30:00.000Z";

  function withReview() {
    return makeClient({
      coach_threads: [
        { id: OWN_CHAT, user_id: "u1", title: "Tofu plans", kind: "chat",
          last_message_at: "2026-10-01T12:00:00Z", deleted_at: null, unread_at: null },
        { id: WEEKLY, user_id: "u1", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: null, unread_at: DELIVERED },
        { id: FOREIGN_WEEKLY, user_id: "u2", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: null, unread_at: DELIVERED },
      ],
      coach_messages: [
        { id: MSG_1, thread_id: WEEKLY, user_id: "u1", role: "assistant",
          content: "Based on your logged week, logging was the strongest pattern.", seq: 1,
          created_at: DELIVERED, tool_calls: [] },
      ],
    });
  }
  const open = (id: string, query = "") => getThreadRoute(
    new Request(`https://app.test/api/coach/threads/${id}${query}`),
    { params: Promise.resolve({ id }) });
  const listed = async () => (await (await listOrSearchRoute(listReq())).json()) as
    { id: string; unread: boolean }[];

  it("lists a delivered review as unread, and only this account's threads", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: withReview() });
    const rows = await listed();
    expect(Object.fromEntries(rows.map((r) => [r.id, r.unread])))
      .toEqual({ [WEEKLY]: true, [OWN_CHAT]: false });
  });

  it("opening the thread clears the mark; the listing then reads it as read", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: withReview() });
    const res = await open(WEEKLY, "?limit=50");
    expect(res.status).toBe(200);
    const body = await res.json() as { thread: Record<string, unknown> };
    expect(body.thread).not.toHaveProperty("unread_at");
    expect((await listed()).find((r) => r.id === WEEKLY)?.unread).toBe(false);
  });

  it("loading an older page is not an open and leaves the mark", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: withReview() });
    expect((await open(WEEKLY, "?before=5&limit=20")).status).toBe(200);
    expect((await listed()).find((r) => r.id === WEEKLY)?.unread).toBe(true);
  });

  it("another account's review cannot be opened or cleared", async () => {
    const client = withReview();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await open(FOREIGN_WEEKLY)).status).toBe(404);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u2", client });
    expect((await listed()).map((r) => [r.id, r.unread])).toEqual([[FOREIGN_WEEKLY, true]]);
  });
});

describe("GET /api/coach/threads/unread", () => {
  const WEEKLY = "3f1b1a2c-0000-4000-8000-000000000004";
  const FOREIGN_WEEKLY = "3f1b1a2c-0000-4000-8000-000000000005";
  const DELETED_WEEKLY = "3f1b1a2c-0000-4000-8000-000000000006";
  const DELIVERED = "2026-10-12T00:30:00.000Z";
  const unreadReq = () => new Request("https://app.test/api/coach/threads/unread");

  function withReviews() {
    return makeClient({
      coach_threads: [
        { id: OWN_CHAT, user_id: "u1", title: "Tofu plans", kind: "chat",
          last_message_at: "2026-10-01T12:00:00Z", deleted_at: null, unread_at: null },
        { id: WEEKLY, user_id: "u1", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: null, unread_at: DELIVERED },
        { id: DELETED_WEEKLY, user_id: "u1", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: DELIVERED, unread_at: DELIVERED },
        { id: FOREIGN_WEEKLY, user_id: "u2", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: null, unread_at: DELIVERED },
      ],
      coach_messages: [],
    });
  }
  const count = async () => {
    const res = await unreadRoute(unreadReq());
    expect(res.status).toBe(200);
    return (await res.json()) as { unread: number };
  };

  it("counts only this account's live unread threads, never another account's", async () => {
    const client = withReviews();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect(await count()).toEqual({ unread: 1 });
    vi.mocked(requireUser).mockResolvedValue({ userId: "u3", client });
    expect(await count()).toEqual({ unread: 0 });
  });

  it("agrees with the listing and drops to zero once the thread is opened", async () => {
    const client = withReviews();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const listed = (await (await listOrSearchRoute(listReq())).json()) as { unread: boolean }[];
    expect((await count()).unread).toBe(listed.filter((row) => row.unread).length);
    await getThreadRoute(new Request(`https://app.test/api/coach/threads/${WEEKLY}`),
      { params: Promise.resolve({ id: WEEKLY }) });
    expect(await count()).toEqual({ unread: 0 });
    // Opening u1's review leaves the other account's mark alone.
    vi.mocked(requireUser).mockResolvedValue({ userId: "u2", client });
    expect(await count()).toEqual({ unread: 1 });
  });

  it("is rate limited per account at the thread list's 60 per minute", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: withReviews() });
    for (let i = 0; i < 60; i += 1) expect((await unreadRoute(unreadReq())).status).toBe(200);
    expect((await unreadRoute(unreadReq())).status).toBe(429);
  });

  it("answers 500 when the count cannot be read, and 404 with the coach off", async () => {
    const broken = { from: () => {
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: null, count: null, error: { message: "down" } }).then(resolve),
      };
      for (const name of ["select", "eq", "is", "not"]) chain[name] = () => chain;
      return chain;
    } } as never;
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: broken });
    expect((await unreadRoute(unreadReq())).status).toBe(500);
    vi.stubEnv("COACH_ENABLED", "0");
    expect((await unreadRoute(unreadReq())).status).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await unreadRoute(unreadReq())).status).toBe(401);
  });
});

describe("the weekly-review thread is managed like a chat (UI gap b)", () => {
  const WEEKLY = "3f1b1a2c-0000-4000-8000-000000000007";
  const DELIVERED = "2026-10-12T00:30:00.000Z";
  function withReviewThread() {
    return makeClient({
      coach_threads: [
        { id: WEEKLY, user_id: "u1", title: "Weekly review", kind: "weekly_review",
          last_message_at: DELIVERED, deleted_at: null, unread_at: DELIVERED, summary: "s" },
        { id: OWN_PLAN, user_id: "u1", title: "Plan sheet", kind: "plan",
          last_message_at: null, deleted_at: null, unread_at: null, summary: null },
      ],
      coach_messages: [
        { id: MSG_1, thread_id: WEEKLY, user_id: "u1", role: "assistant", content: "Your week",
          seq: 1, created_at: DELIVERED, review_week: "2026-10-05" },
      ],
    });
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rows = async (client: unknown, table: string, col: string, id: string) =>
    (await (client as any).from(table).select().eq(col, id)).data as Row[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("renames it", async () => {
    const client = withReviewThread();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    const res = await patchThreadRoute(patchReq(WEEKLY, { title: "Sunday notes" }), params(WEEKLY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: WEEKLY, title: "Sunday notes", kind: "weekly_review" });
  });

  it("clears its transcript and its unread mark, keeping the title", async () => {
    const client = withReviewThread();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await clearRoute(clearReq(WEEKLY), params(WEEKLY))).status).toBe(204);
    expect((await rows(client, "coach_threads", "id", WEEKLY))[0]).toMatchObject({
      title: "Weekly review", summary: null, last_message_at: null, unread_at: null });
    expect(await rows(client, "coach_messages", "thread_id", WEEKLY)).toHaveLength(0);
  });

  it("deletes it", async () => {
    const client = withReviewThread();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await deleteThreadRoute(deleteReq(WEEKLY), params(WEEKLY))).status).toBe(200);
    expect((await rows(client, "coach_threads", "id", WEEKLY))[0].deleted_at).toEqual(expect.any(String));
  });

  it("still 404s a plan thread on rename, clear and delete", async () => {
    const client = withReviewThread();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client });
    expect((await patchThreadRoute(patchReq(OWN_PLAN, { title: "x" }), params(OWN_PLAN))).status).toBe(404);
    expect((await clearRoute(clearReq(OWN_PLAN), params(OWN_PLAN))).status).toBe(404);
    expect((await deleteThreadRoute(deleteReq(OWN_PLAN), params(OWN_PLAN))).status).toBe(404);
  });

  it("still 404s another account's review thread", async () => {
    const client = withReviewThread();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u2", client });
    expect((await patchThreadRoute(patchReq(WEEKLY, { title: "x" }), params(WEEKLY))).status).toBe(404);
    expect((await clearRoute(clearReq(WEEKLY), params(WEEKLY))).status).toBe(404);
    expect((await deleteThreadRoute(deleteReq(WEEKLY), params(WEEKLY))).status).toBe(404);
  });
});

describe("GET /api/coach/threads/[id] says whether the unread mark was cleared (UI gap a)", () => {
  const WEEKLY = "3f1b1a2c-0000-4000-8000-000000000008";
  const DELIVERED = "2026-10-12T00:30:00.000Z";
  const seed = (unreadAt: string | null) => makeClient({
    coach_threads: [{ id: WEEKLY, user_id: "u1", title: "Weekly review", kind: "weekly_review",
      last_message_at: DELIVERED, deleted_at: null, unread_at: unreadAt }],
    coach_messages: [],
  });
  /** The same client, with every coach_threads update refused. */
  function refusingClears(client: unknown) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return { from: (table: string) => {
      const chain = (client as any).from(table);
      if (table !== "coach_threads") return chain;
      chain.update = () => {
        const failed: Record<string, unknown> = {
          eq: () => failed, lte: () => failed,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "down" } }).then(resolve),
        };
        return failed;
      };
      return chain;
    } } as never;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  const open = async (client: unknown, query = "") => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: client as never });
    const res = await getThreadRoute(new Request(`https://app.test/api/coach/threads/${WEEKLY}${query}`),
      { params: Promise.resolve({ id: WEEKLY }) });
    expect(res.status).toBe(200);
    return (await res.json()) as { cleared: boolean };
  };

  it("is true when the open cleared the mark", async () => {
    expect((await open(seed(DELIVERED))).cleared).toBe(true);
  });

  it("is true when there was nothing to clear", async () => {
    expect((await open(seed(null))).cleared).toBe(true);
  });

  it("is true for an older page, which is not an open and clears nothing", async () => {
    expect((await open(refusingClears(seed(DELIVERED)), "?before=5")).cleared).toBe(true);
  });

  it("is false, with the transcript still answered, when the clear write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await open(refusingClears(seed(DELIVERED)));
    expect(body.cleared).toBe(false);
    expect(body).toHaveProperty("messages");
    spy.mockRestore();
  });
});
