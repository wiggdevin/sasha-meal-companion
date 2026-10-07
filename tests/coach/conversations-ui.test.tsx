// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CoachScreen from "@/app/coach/CoachScreen";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), mounts: 0,
  authListeners: [] as ((event: string, session: { user: { id: string } } | null) => void)[],
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "owner-a" } } } })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ auth: {
  getSession: mocks.getSession,
  onAuthStateChange: (listener: (event: string, session: { user: { id: string } } | null) => void) => {
    mocks.authListeners.push(listener);
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  },
} }) }));
vi.mock("@/lib/coach-client", async (original) => ({
  ...await original<typeof import("@/lib/coach-client")>(), listThreads: mocks.list,
}));
vi.mock("@/components/CaptureSheet", () => ({ default: () => null }));
vi.mock("@/components/CoachChat", async () => {
  const { useState } = await import("react");
  function MockCoachChat({ threadId, onThreadSaved, header, onBusyChange }: {
    threadId: string | null; onThreadSaved: (id: string) => void; header: React.ReactNode;
    onBusyChange: (busy: boolean) => void;
  }) {
    const [mount] = useState(() => ++mocks.mounts);
    return <div data-testid="chat" data-thread={threadId ?? "new"} data-mount={mount}>
      {header}
      <button type="button" onClick={() => onThreadSaved("saved-new")}>Simulate saved reply</button>
      <button type="button" onClick={() => onBusyChange(true)}>Simulate busy turn</button>
    </div>;
  }
  return { default: MockCoachChat };
});

const thread = (id: string) => ({ id, kind: "chat", title: `Chat ${id}`,
  lastMessageAt: "2026-09-27T12:00:00Z" });
const renderCoach = () => render(<CapabilitiesProvider value={{
  coach: true, scan: false, captureMethods: [],
}}><CoachScreen /></CapabilitiesProvider>);

beforeEach(() => {
  mocks.mounts = 0; mocks.list.mockReset(); mocks.authListeners.length = 0; localStorage.clear();
});
afterEach(cleanup);

it("opens owned conversations and remounts only on deliberate selection or New", async () => {
  mocks.list.mockResolvedValue([thread("a"), thread("b")]);
  renderCoach();
  await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("a"));
  const firstMount = screen.getByTestId("chat").getAttribute("data-mount");
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Chat b/ })
    .hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /^Chat b/ }));
  expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("b");
  expect(screen.getByTestId("chat").getAttribute("data-mount")).not.toBe(firstMount);
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  await waitFor(() => expect((screen.getByRole("button", {
    name: "New chat",
  }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const newMount = screen.getByTestId("chat").getAttribute("data-mount");
  expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("new");
  fireEvent.click(screen.getByRole("button", { name: "Simulate saved reply" }));
  expect(screen.getByTestId("chat").getAttribute("data-mount")).toBe(newMount);
  expect(localStorage.getItem("smc:coach:current:owner-a")).toBe("saved-new");
});

it("keeps all grandfathered chats selectable while blocking a ninth new chat", async () => {
  mocks.list.mockResolvedValue(Array.from({ length: 9 }, (_, i) => thread(String(i + 1))));
  renderCoach();
  await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  // At the limit the button says why and points at the list (2026-10-04 UI pass); it never starts a chat.
  const makeRoom = screen.getByRole("button", { name: "New chat · make room first" });
  expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  expect(screen.getByText(/Delete 2 to start a new chat/)).toBeTruthy();
  await waitFor(() => expect((makeRoom as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(makeRoom);
  expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("1");
  expect(screen.getByText("Delete a chat to make room")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Chat 9/ })).toBeTruthy();
});

it("keeps a busy turn in its current chat until it finishes", async () => {
  mocks.list.mockResolvedValue([thread("a"), thread("b")]);
  renderCoach();
  await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("a"));
  fireEvent.click(screen.getByRole("button", { name: "Simulate busy turn" }));
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  expect(screen.getByText("Finishing this reply…")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Chat b/ }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Chat b/ }));
  expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("a");
});

it("blocks switching until a refreshed conversation list arrives", async () => {
  let finishRefresh: (rows: ReturnType<typeof thread>[]) => void = () => {};
  mocks.list.mockResolvedValueOnce([thread("a"), thread("b")]);
  mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
  renderCoach();
  await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("a"));
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  expect(screen.getByRole("button", { name: /^Chat b/ }).hasAttribute("disabled")).toBe(true);
  finishRefresh([thread("a"), thread("b")]);
  await waitFor(() => expect(screen.getByRole("button", { name: /^Chat b/ })
    .hasAttribute("disabled")).toBe(false));
});

it("discards a late list from a previous account", async () => {
  let finishOld: (rows: ReturnType<typeof thread>[]) => void = () => {};
  mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  mocks.list.mockResolvedValueOnce([thread("account-b")]);
  mocks.list.mockResolvedValueOnce([thread("account-b")]);
  renderCoach();
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  mocks.authListeners[0]("SIGNED_IN", { user: { id: "owner-b" } });
  await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread"))
    .toBe("account-b"));
  finishOld([thread("account-a")]);
  fireEvent.click(screen.getByRole("button", { name: /^Conversations/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Chat account-b/ })).toBeTruthy());
  expect(screen.queryByRole("button", { name: /^Chat account-a/ })).toBeNull();
});
