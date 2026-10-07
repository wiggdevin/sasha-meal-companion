// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import { useCoachDockSubmit } from "@/components/coach/use-dock-submit";
import { useDockIntents, type DockIntent } from "@/components/coach/attachments/dock-handoff";
import { useBroadcastDockComposerState, type DockComposerState } from "@/components/coach/use-dock-composer-state";
import { COMPOSER_OFFLINE_COPY } from "@/lib/coach/chat-state";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

/** Stands in for CoachShell broadcasting its own composer state (the hook's real production
 *  path) rather than crafting the window event by hand — a render this file's own `cleanup()`
 *  (RTL's, run in `afterEach`) tears down, resetting the broadcast exactly as unmounting
 *  CoachShell does. */
function Broadcaster({ state }: { state: DockComposerState }) {
  useBroadcastDockComposerState(state);
  return null;
}
function broadcastDockState(state: DockComposerState) {
  return render(<Broadcaster state={state} />);
}

const speech = vi.hoisted(() => ({ handlers: [] as SpeechHandlers[] }));
vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (handlers: SpeechHandlers) => {
    speech.handlers.push(handlers);
    return { stop: vi.fn(), abort: vi.fn() };
  },
}));

const nav = vi.hoisted(() => ({ path: "/coach", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

// The chat overlay's own conversation reaches the network; here it is only the surface that
// opens (U22, 2026-10-04: the dock's ask opens the chat over the page instead of routing).
vi.mock("@/components/dock/ChatOverlay", () => ({
  default: ({ scope }: { scope: unknown }) =>
    <div role="dialog" aria-label="Chat with Sasha" data-scope={JSON.stringify(scope)} />,
}));

/** A stand-in for a mounted chat: it takes the dock's event and says so, as useCoachDockSubmit
 *  and useDockIntents do, so nothing is parked for a later test. */
function listen<T>(type: string, take: (detail: T) => void): () => void {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<T & { received?: boolean }>).detail;
    detail.received = true;
    take(detail);
  };
  window.addEventListener(type, receive);
  return () => window.removeEventListener(type, receive);
}

// Camera and Upload follow the server's photo capture flag; the barcode capability is read by the
// chat's own receiver (U18: no Scan tile).
vi.mock("@/components/CapabilitiesProvider", () => ({
  useCapabilities: () => ({ coach: true, scan: true, captureMethods: ["photo"] }),
}));

afterEach(() => {
  // cleanup() unmounts every Broadcaster this file rendered too, which resets the dock-composer-
  // state broadcast exactly as unmounting CoachShell does — nothing leaks into the next test.
  cleanup();
  speech.handlers.length = 0;
  nav.path = "/coach";
  nav.push.mockReset();
});

const field = () => screen.getByRole("searchbox", { name: "Ask Sasha" }) as HTMLTextAreaElement;
const form = () => field().closest("form")!;

describe("the Sasha bubble on /coach", () => {
  it("says nothing about thinking while the transcript above shows the turn, and carries no spark logo", () => {
    broadcastDockState({ disabled: true, scanDisabled: false, offline: false, thinking: true });
    render(<TabBar />);
    // The transcript's own line and the header mark say it; the field keeps its placeholder (Kimi K5).
    expect(document.querySelector("[data-dock-thinking]")).toBeNull();
    expect(screen.queryByText(/is thinking/)).toBeNull();
    expect(field().placeholder).toBe("Ask Sasha");
    // No spark before the words (owner, 2026-10-04): the field's only glyphs are its controls'.
    const glyphs = form().querySelectorAll("svg");
    for (const svg of Array.from(glyphs)) expect(svg.closest("button")).not.toBeNull();
  });

  it("starts stretched into the composer with the capsule folded beside it", () => {
    render(<TabBar />);
    expect(form().hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("button", { name: "Attach" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all tabs" })).toBeTruthy();
  });

  it("keeps Record beside a distinct Send while the caret sits at the draft's end", () => {
    // Grok audit 2026-10-02, finding 1: readyToSend used to be `hasText && !listening`, so the
    // dock's one control became Send the instant the box held anything — a dictated transcript
    // could never be appended to. Restored from the old composer (components/coach/Composer.tsx):
    // typing leaves the caret at the end, so Record stays put and a reachable Send sits beside it.
    render(<TabBar />);
    expect(screen.getByRole("button", { name: "Record message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    fireEvent.change(field(), { target: { value: "Is rice okay tonight?" } });
    expect(screen.getByRole("button", { name: "Record message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(field().value).toBe("");
  });

  it("collapses to one Send control once the caret leaves the draft's end", async () => {
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "Add oats" } });
    const box = field();
    box.setSelectionRange(0, 0);
    fireEvent.select(box);

    expect(screen.queryByRole("button", { name: "Record message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    // The distinct Send button exits on its own spring (AnimatePresence); it leaves the document
    // once that settles.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send message" })).toBeNull());
  });

  it("lets Record come back after a dictated transcript lands, so more speech can be appended", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Record message" }));
    act(() => speech.handlers[0].onSegment({ text: "add avocado", final: true }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    act(() => speech.handlers[0].onEnd());

    // Landing a transcript (not an active edit) leaves the single control as Send.
    expect(field().value).toBe("add avocado");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record message" })).toBeNull();

    // Tapping back into the field to keep speaking must bring Record back, with Send beside it.
    fireEvent.focus(field());
    expect(screen.getByRole("button", { name: "Record message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("clears the text from its own control", async () => {
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "never mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear text" }));
    expect(field().value).toBe("");
    expect(screen.getByRole("button", { name: "Record message" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear text" })).toBeNull());
  });

  it("grows the attach tray from + and hands a camera photo to the coach page", () => {
    let intent: unknown = null;
    const stop = listen<DockIntent>("coach:dock-attach", (detail) => { intent = { kind: detail.kind, file: detail.file }; });
    const { container } = render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByRole("button", { name: "Hide attach options" }).getAttribute("aria-expanded")).toBe("true");
    const tiles = screen.getByRole("group", { name: "Add to your question" });
    expect(within(tiles).getAllByRole("button").map((b) => b.getAttribute("aria-label")))
      .toEqual(["Take a photo", "Upload a photo", "Weigh in", "Open chat"]);
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const photo = new File(["x"], "label.jpg", { type: "image/jpeg" });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"][capture]')!, { target: { files: [photo] } });
    expect(intent).toEqual({ kind: "photo", file: photo });
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-expanded")).toBe("false");
    stop();
  });

  it("closes the tray and returns focus to the composer when Chat is tapped already on /coach", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(field());
  });

  it("hands a typed draft to the coach turn pipeline when Chat is tapped on /coach", () => {
    let received = "";
    const stop = listen<{ text: string }>("coach:dock-submit", (detail) => { received = detail.text; });
    render(<TabBar />);

    fireEvent.change(field(), { target: { value: "Swap bread for a tortilla" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    expect(received).toBe("Swap bread for a tortilla");
    expect(field().value).toBe("");
    expect(nav.push).not.toHaveBeenCalled();
    stop();
  });

  // U19 (2026-10-04): a weigh-in is logged directly (WeighInField.test.tsx); only its follow-ups ask.
  it("sends a weigh-in follow-up through the same turn pipeline as typed text", async () => {
    let received = "";
    const stop = listen<{ text: string }>("coach:dock-submit", (detail) => { received = detail.text; });
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    expect(screen.getByRole("textbox", { name: "Weight in lb" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send weigh-in/ })).toBeNull();
    stop();
    expect(received).toBe("");
  });

  it("carries the turn's own pending/success glow onto the field's one control", () => {
    // The page composer had a separate Send button to show this; the dock's CoachMic is the only
    // control, so it has to carry the glow (and the aria-label announcement) itself.
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "Swap bread for a tortilla" } });
    // Grok audit 2026-10-02, finding 1 restored the caret-sensitive toggle, so right after typing
    // (caret at the end) CoachMic itself reads as Record; it is CoachMic's own feedback state,
    // tracked by this stable attribute rather than its name, that carries the glow regardless.
    const send = form().querySelector("[data-composer-main]") as HTMLButtonElement;

    const broadcast = broadcastDockState({ disabled: false, scanDisabled: false, offline: false,
      sendFeedbackState: "pending", sendFeedbackClassName: "feedback-control" });
    expect(send.getAttribute("aria-label")).toBe("Sending message");
    expect(send.className).toContain("feedback-control");
    expect((send as HTMLButtonElement).disabled).toBe(true);

    act(() => broadcast.rerender(<Broadcaster state={{ disabled: false, scanDisabled: false,
      offline: false, sendFeedbackState: "success", sendFeedbackClassName: "feedback-control" }} />));
    expect(screen.getByRole("button", { name: "Message sent" })).toBe(send);
  });

  it("keeps showing send feedback once the real send has already cleared the draft", () => {
    // DeepSeek audit 2026-10-02, finding 1: CoachMic used to gate the glow on `mode === "send"`,
    // which `use-composer-input`'s own `send()` flips to "record" the moment it clears the box —
    // before CoachShell's async turn ever reaches "pending". Submitting for real (not just typing)
    // is what exposes the gap a hand-set draft cannot.
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "Swap bread for a tortilla" } });
    fireEvent.submit(form());
    expect(field().value).toBe("");
    const control = form().querySelector("[data-composer-main]") as HTMLButtonElement;

    const broadcast = broadcastDockState({ disabled: false, scanDisabled: false, offline: false,
      sendFeedbackState: "pending", sendFeedbackClassName: "feedback-control" });
    expect(control.getAttribute("data-feedback-state")).toBe("pending");
    expect(control.getAttribute("aria-label")).toBe("Sending message");
    expect(control.disabled).toBe(true);

    act(() => broadcast.rerender(<Broadcaster state={{ disabled: false, scanDisabled: false,
      offline: false, sendFeedbackState: "success", sendFeedbackClassName: "feedback-control" }} />));
    expect(control.getAttribute("aria-label")).toBe("Message sent");
  });

  it("keeps the typed draft when the coach declines the dock submission", () => {
    // DeepSeek audit 2026-10-02, finding 2: AssistantField's submitText always returned true, so
    // the box cleared even when CoachShell's send() bailed early (restoring, typing, disabled, or
    // the "ask about another conversation" intercept). useCoachDockSubmit's callback result now
    // travels back onto the dock-submit event so the field only clears on a real acceptance.
    render(<TabBar />);
    function Coach() {
      useCoachDockSubmit(() => false, true);
      return null;
    }
    render(<Coach />);

    fireEvent.change(field(), { target: { value: "What about my other conversation?" } });
    fireEvent.submit(form());

    expect(field().value).toBe("What about my other conversation?");
  });

  it("clears the typed draft once the coach accepts the dock submission", () => {
    render(<TabBar />);
    function Coach() {
      useCoachDockSubmit(() => true, true);
      return null;
    }
    render(<Coach />);

    fireEvent.change(field(), { target: { value: "What goes with salmon?" } });
    fireEvent.submit(form());

    expect(field().value).toBe("");
  });

  it("disables the field, the tray, and shows the offline copy", () => {
    render(<TabBar />);
    const broadcast = broadcastDockState({ disabled: true, scanDisabled: false, offline: true });

    expect(field().disabled).toBe(true);
    expect(field().placeholder).toBe(COMPOSER_OFFLINE_COPY);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect((screen.getByRole("button", { name: "Take a photo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Weigh in" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Open chat" }) as HTMLButtonElement).disabled).toBe(false);

    act(() => broadcast.rerender(<Broadcaster
      state={{ disabled: false, scanDisabled: false, offline: false }} />));
    expect(field().disabled).toBe(false);
    expect(field().placeholder).toBe("Ask Sasha");
  });

  it("brings the capsule back from the folded icon and shrinks the field to its bubble", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show all tabs" }));
    expect(form().hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Ask Sasha" })).toBeTruthy();
    for (const label of ["Body", "Foods", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
  });

  it("submits the dock query to the coach turn pipeline", () => {
    let received = "";
    const stop = listen<{ text: string }>("coach:dock-submit", (detail) => { received = detail.text; });
    render(<TabBar />);

    fireEvent.change(field(), { target: { value: "Swap bread for a tortilla" } });
    fireEvent.submit(form());

    expect(received).toBe("Swap bread for a tortilla");
    expect(field().value).toBe("");
    expect(nav.push).not.toHaveBeenCalled();
    stop();
  });

  it("clears the current query on Escape", () => {
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "liquid glass" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("");
  });

  it("puts voice dictation directly into the dock field for review", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Record message" }));
    act(() => speech.handlers[0].onSegment({ text: "add avocado", final: true }));
    expect(field().value).toBe("add avocado");
  });
});

describe("the Sasha bubble on every other screen", () => {
  it("rests as a bubble and stretches into a focused field when tapped", () => {
    nav.path = "/";
    render(<TabBar />);
    expect(form().hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("link", { name: "Body" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    expect(form().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(field());
    expect(screen.getByRole("button", { name: "Show all tabs" })).toBeTruthy();
  });

  it("opens the chat over the page with the question, page-scoped, and hands it over once the chat can send", () => {
    nav.path = "/foods";
    const { unmount } = render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.change(field(), { target: { value: "What goes with salmon?" } });
    fireEvent.submit(form());
    expect(nav.push).not.toHaveBeenCalled();
    const overlay = screen.getByRole("dialog", { name: "Chat with Sasha" });
    expect(JSON.parse(overlay.getAttribute("data-scope")!)).toEqual({ kind: "page", page: "foods" });
    unmount();

    const sent: string[] = [];
    function Coach({ ready }: { ready: boolean }) {
      useCoachDockSubmit((text) => { sent.push(text); }, ready);
      return null;
    }
    const coach = render(<Coach ready={false} />);
    expect(sent).toEqual([]);
    coach.rerender(<Coach ready />);
    expect(sent).toEqual(["What goes with salmon?"]);
    coach.rerender(<Coach ready />);
    expect(sent).toHaveLength(1);
  });

  it("keeps a meal photo picked on another screen on that screen, in the chat over it", () => {
    nav.path = "/";
    const { container, unmount } = render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const camera = container.querySelector<HTMLInputElement>('input[type="file"][capture]')!;
    const photo = new File(["x"], "plate.jpg", { type: "image/jpeg" });
    fireEvent.change(camera, { target: { files: [photo] } });
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Chat with Sasha" })).toBeTruthy();
    unmount();

    const received: DockIntent[] = [];
    function Coach() { useDockIntents((intent) => { received.push(intent); }, true); return null; }
    render(<Coach />);
    expect(received).toEqual([{ kind: "photo", file: photo }]);
  });

  it("opens the chat over the page when Chat is tapped in the attach tray", () => {
    nav.path = "/foods";
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Chat with Sasha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("carries a typed draft to the chat over the page when Chat is tapped instead of Send", () => {
    nav.path = "/foods";
    const { unmount } = render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.change(field(), { target: { value: "What goes with salmon?" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByRole("dialog", { name: "Chat with Sasha" })).toBeTruthy();
    unmount();

    const sent: string[] = [];
    function Coach({ ready }: { ready: boolean }) {
      useCoachDockSubmit((text) => { sent.push(text); }, ready);
      return null;
    }
    const coach = render(<Coach ready={false} />);
    expect(sent).toEqual([]);
    coach.rerender(<Coach ready />);
    expect(sent).toEqual(["What goes with salmon?"]);
  });

  it("puts the tray away on Escape before touching the text", () => {
    render(<TabBar />);
    fireEvent.change(field(), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-expanded")).toBe("false");
    expect(field().value).toBe("keep me");
  });

  it("folds back when Escape is pressed on an empty field", () => {
    nav.path = "/";
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(form().hasAttribute("inert")).toBe(true);
  });

  it("ignores the coach's disabled broadcast away from /coach", () => {
    nav.path = "/foods";
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));

    broadcastDockState({ disabled: true, scanDisabled: true, offline: true });

    expect(field().disabled).toBe(false);
    expect(field().placeholder).toBe("Ask Sasha");
  });

});
