// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import { CHAT_HISTORY_KEY } from "@/components/dock/chat-history";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

/**
 * U22 (2026-10-04): the dock's ask opens the chat over the page. The page keeps its state, is inert
 * and does not scroll while the card is up; Escape, the scrim, the close button and Back dismiss it;
 * every turn carries the page's scope. The conversation itself is a stand-in (it reaches the network).
 */

vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (_handlers: SpeechHandlers) => ({ stop: vi.fn(), abort: vi.fn() }),
}));
const nav = vi.hoisted(() => ({ path: "/foods", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));
vi.mock("@/components/CapabilitiesProvider", () => ({
  useCapabilities: () => ({ coach: true, scan: true, captureMethods: ["photo"] }),
}));
vi.mock("@/components/coach/CoachConversation", () => ({
  default: ({ scope, renderHeader }: { scope: unknown; renderHeader: (c: object) => React.ReactNode }) =>
    <div data-testid="conversation" data-scope={JSON.stringify(scope)}>
      {renderHeader({ thinking: false, count: 0, openConversations: () => {} })}
    </div>,
}));

beforeEach(() => { window.history.replaceState(null, "", "/foods"); });
afterEach(() => {
  cleanup();
  nav.path = "/foods";
  nav.push.mockReset();
  nav.replace.mockReset();
  document.body.style.overflow = "";
});

/** Closed for the user: hidden from assistive tech at once (its exit may still be playing). */
async function closed() {
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat with Sasha" })).toBeNull(), { timeout: 3000 });
}

function openChat() {
  render(<><main data-testid="page">Foods</main><TabBar /></>);
  fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach" }));
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  return screen.getByRole("dialog", { name: "Chat with Sasha" });
}

describe("the chat overlay", () => {
  it("opens over the page without a route change, with the page inert and its scroll held", () => {
    const overlay = openChat();
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("page").closest("[inert]")).not.toBeNull();
    expect(overlay.closest("[inert]")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Primary" }).closest("[inert]")).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.position).toBe("");
    expect(typeof (window.history.state as Record<string, unknown>)[CHAT_HISTORY_KEY]).toBe("number");
  }, 20_000); // the first open pays the overlay's cold import under CI load

  it("carries the page's scope and shows it in the header", () => {
    openChat();
    expect(JSON.parse(screen.getByTestId("conversation").getAttribute("data-scope")!))
      .toEqual({ kind: "page", page: "foods" });
    expect(screen.getByText("On Foods")).toBeTruthy();
  });

  it("names the day Today is showing", () => {
    nav.path = "/";
    window.history.replaceState(null, "", "/?d=2026-10-02");
    openChat();
    expect(JSON.parse(screen.getByTestId("conversation").getAttribute("data-scope")!))
      .toEqual({ kind: "page", page: "today", date: "2026-10-02" });
  });

  it("closes on Escape and gives the page back", async () => {
    openChat();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await closed();
    expect(screen.getByTestId("page").closest("[inert]")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes from the close button and from the scrim", async () => {
    openChat();
    fireEvent.click(screen.getAllByRole("button", { name: "Close chat" }).at(-1)!);
    await closed();
    cleanup();
    openChat();
    fireEvent.click(screen.getAllByRole("button", { name: "Close chat" })[0]);
    await closed();
  });

  it("closes on Back (popstate) without leaving the page", async () => {
    openChat();
    window.history.back();
    await closed();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("opens the full chat in place of its own history entry", () => {
    openChat();
    fireEvent.click(screen.getByRole("button", { name: "Open full chat" }));
    expect(nav.replace).toHaveBeenCalledWith("/coach");
  });
});
