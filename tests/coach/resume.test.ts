import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cachedCoachThread, rememberCoachThread, resumeChat, subscribeCoachResume } from "@/app/coach/CoachScreen";
import { initialChatState, nextChatState, threadRestoreFailure } from "@/components/CoachChat";
import { CoachError } from "@/lib/coach-client";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), list: vi.fn(), unsubscribe: vi.fn(),
  authChanged: null as null | ((event: string, session: { user: { id: string } } | null) => void) }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ auth: {
  getSession: mocks.getSession,
  onAuthStateChange: (callback: typeof mocks.authChanged) => {
    mocks.authChanged = callback;
    return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  },
} }) }));
vi.mock("@/lib/coach-client", async (original) => ({
  ...await original<typeof import("@/lib/coach-client")>(), listThreads: mocks.list,
}));
vi.mock("@/components/CaptureSheet", () => ({ default: () => null }));
const session = (id: string) => ({ user: { id } });
const thread = (id: string, kind = "chat", lastMessageAt: string | null = "2026-09-15T12:00:00Z") =>
  ({ id, kind, lastMessageAt, title: "Synthetic" });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  mocks.getSession.mockResolvedValue({ data: { session: session("a") } });
  mocks.list.mockResolvedValue([]);
});
afterEach(() => cleanup.splice(0).forEach((stop) => stop()));

it("resumes the latest owned chat across route remounts and reloads, skipping empty and weekly threads", async () => {
  mocks.list.mockResolvedValue([thread("weekly", "weekly_review"), thread("recent"),
    thread("older"), thread("empty", "chat", null)]);
  const changes = vi.fn();
  const stop = subscribeCoachResume(changes);
  await flush();
  expect(changes).toHaveBeenLastCalledWith({ userId: "a", threadId: "recent", loading: false, error: null });
  expect(cachedCoachThread("a")).toBe("recent");
  stop();
  cleanup.push(subscribeCoachResume(changes));
  await flush();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(changes.mock.lastCall?.[0].threadId).toBe("recent");
});

it("keeps a thread picked while the first list was loading, even one that list does not hold", async () => {
  const first = deferred<ReturnType<typeof thread>[]>();
  mocks.list.mockReturnValueOnce(first.promise);
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  rememberCoachThread("a", "fresh"); // chosen after the list was asked for
  first.resolve([thread("recent"), thread("older")]);
  await flush();
  expect(changes.mock.lastCall?.[0]).toEqual({ userId: "a", threadId: "fresh", loading: false, error: null });
  expect(cachedCoachThread("a")).toBe("fresh");
});

it("keeps a new chat started while the first list was loading", async () => {
  const first = deferred<ReturnType<typeof thread>[]>();
  mocks.list.mockReturnValueOnce(first.promise);
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  rememberCoachThread("a", null);
  first.resolve([thread("recent")]);
  await flush();
  expect(changes.mock.lastCall?.[0].threadId).toBeNull();
  expect(cachedCoachThread("a")).toBeNull();
});

it("keeps the selected chat across reloads and never trusts a stale or plan pointer", () => {
  const chats = [thread("plan", "plan"), thread("new"), thread("old"), thread("empty", "chat", null)];
  expect(resumeChat(chats, "old")).toBe("old");
  expect(resumeChat(chats, "empty")).toBe("empty");
  expect(resumeChat(chats, "plan")).toBe("new");
  expect(resumeChat(chats, "deleted")).toBe("new");
  expect(resumeChat([thread("draft", "chat", null)], null)).toBe("draft");
});

it("keeps a failed first turn threadless and never invents a resume pointer", async () => {
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  expect(changes.mock.lastCall?.[0].threadId).toBeNull();
  const sending = nextChatState(initialChatState(null), { type: "send", messageId: "m", text: "snack" });
  const failed = nextChatState(sending, { type: "error", status: 503, code: "coach_unavailable",
    message: "Try again", messageId: "m" });
  expect(failed.threadId).toBeNull(); expect(failed.messages).toEqual([]);
  expect(cachedCoachThread("a")).toBeNull();
});

it("clears the view on account change and ignores the old account's late thread response", async () => {
  const pending = deferred<ReturnType<typeof thread>[]>();
  mocks.list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([thread("b-thread")]);
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  mocks.authChanged!("SIGNED_IN", session("b"));
  expect(changes).toHaveBeenLastCalledWith({ userId: "b", threadId: null, loading: true, error: null });
  await flush(); pending.resolve([thread("a-private")]); await flush();
  expect(changes.mock.lastCall?.[0].threadId).toBe("b-thread");
  expect(cachedCoachThread("a")).toBeNull();
  mocks.authChanged!("SIGNED_OUT", null);
  expect(changes).toHaveBeenLastCalledWith({ userId: null, threadId: null, loading: false, error: null });
});

it("does not let a late initial session overwrite a newer auth event", async () => {
  const pending = deferred<{ data: { session: ReturnType<typeof session> } }>();
  mocks.getSession.mockReturnValue(pending.promise);
  mocks.list.mockResolvedValue([thread("b-thread")]);
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes));
  mocks.authChanged!("SIGNED_IN", session("b")); await flush();
  pending.resolve({ data: { session: session("a") } }); await flush();
  expect(changes.mock.lastCall?.[0].userId).toBe("b");
  expect(mocks.list).toHaveBeenCalledOnce();
});

it("uses only that account's resume pointer when offline, and never uses it after auth denial", async () => {
  rememberCoachThread("a", "a-private");
  mocks.list.mockRejectedValue(new TypeError("offline"));
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  expect(changes.mock.lastCall?.[0].threadId).toBe("a-private");
  mocks.authChanged!("SIGNED_IN", session("b")); await flush();
  expect(changes.mock.lastCall?.[0].threadId).toBeNull();
  mocks.list.mockRejectedValue(new CoachError(401, "unauthorized", "Sign in"));
  mocks.authChanged!("SIGNED_IN", session("a")); await flush();
  expect(changes.mock.lastCall?.[0]).toMatchObject({ userId: null, threadId: null });
});

it("discards a thread result after navigating away", async () => {
  const pending = deferred<ReturnType<typeof thread>[]>(); mocks.list.mockReturnValue(pending.promise);
  const changes = vi.fn(); const stop = subscribeCoachResume(changes); await flush(); stop();
  const count = changes.mock.calls.length; pending.resolve([thread("late")]); await flush();
  expect(changes).toHaveBeenCalledTimes(count); expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});

it("retries a failed listing when the same account refreshes its session", async () => {
  mocks.list.mockRejectedValueOnce(new CoachError(401, "unauthorized", "Expired"))
    .mockResolvedValueOnce([thread("restored")]);
  const changes = vi.fn(); cleanup.push(subscribeCoachResume(changes)); await flush();
  expect(changes.mock.lastCall?.[0].userId).toBeNull();
  mocks.authChanged!("TOKEN_REFRESHED", session("a")); await flush();
  expect(changes.mock.lastCall?.[0]).toMatchObject({ userId: "a", threadId: "restored", error: null });
});

it("distinguishes inaccessible and deleted transcripts from a retryable connection failure", () => {
  for (const status of [401, 403]) expect(threadRestoreFailure(new CoachError(status, "auth", "Denied"))).toBe("denied");
  for (const status of [404, 410]) expect(threadRestoreFailure(new CoachError(status, "missing", "Gone"))).toBe("missing");
  expect(threadRestoreFailure(new CoachError(503, "offline", "Later"))).toBe("transient");
  expect(threadRestoreFailure(new TypeError("Failed to fetch"))).toBe("transient");
  const reset = nextChatState({ ...initialChatState("deleted"), composerDisabled: true, messages: [
    { id: "old", seq: 1, role: "assistant", content: "Previous account" },
  ] }, { type: "reset" });
  expect(reset.threadId).toBeNull(); expect(reset.messages).toEqual([]);
  expect(reset.composerDisabled).toBe(true);
});
