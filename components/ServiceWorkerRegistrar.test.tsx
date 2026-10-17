// @vitest-environment jsdom
/**
 * FluidVoice "Update availability": a waiting service worker never reloads an open tab by itself.
 * The page shows a persistent "Update available" notice with Reload; only that Reload messages the
 * waiting worker, and only the controller change this page asked for reloads it — once. Dismissal
 * lasts for this page session, registration and update errors never block the app, and an unsent
 * coach draft is untouched until the user chooses Reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (_handlers: SpeechHandlers) => ({ stop: vi.fn(), abort: vi.fn() }),
}));

type Listener = (event?: unknown) => void;
function target() {
  const listeners: Record<string, Set<Listener>> = {};
  return {
    listeners,
    addEventListener: vi.fn((type: string, fn: Listener) => { (listeners[type] ??= new Set()).add(fn); }),
    removeEventListener: vi.fn((type: string, fn: Listener) => { listeners[type]?.delete(fn); }),
    emit(type: string) { for (const fn of [...(listeners[type] ?? [])]) fn(); },
  };
}
function worker(state = "installed") {
  return { ...target(), state, postMessage: vi.fn() };
}
type Worker = ReturnType<typeof worker>;
type Registration = ReturnType<typeof target> & {
  waiting: Worker | null; installing: Worker | null; update: ReturnType<typeof vi.fn>;
};

let container: ReturnType<typeof target> & { register: ReturnType<typeof vi.fn>; controller: object | null };
let registration: Registration;

function install(waiting: Worker | null = null) {
  registration = { ...target(), waiting, installing: null, update: vi.fn(async () => undefined) };
  container = { ...target(), controller: {}, register: vi.fn(async () => registration) };
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: container });
}

/** Module state (the controller-change guard) is per page load, so each test loads its own copy. */
async function registrar() {
  vi.resetModules();
  return (await import("./ServiceWorkerRegistrar")).default;
}

async function mount(reload = vi.fn()) {
  const Registrar = await registrar();
  const view = render(<Registrar reload={reload} />);
  await act(async () => {});
  return { ...view, reload, Registrar };
}

beforeEach(() => install());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ServiceWorkerRegistrar update notice", () => {
  it("registers the worker and shows nothing while no worker is waiting", async () => {
    await mount();
    expect(container.register).toHaveBeenCalledWith("/sw.js");
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("shows a persistent notice with Reload when a worker is already waiting", async () => {
    install(worker());
    await mount();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Update available");
    const reload = screen.getByRole("button", { name: "Reload" });
    expect(reload.className).toContain("tap");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("shows the notice once an update found later finishes installing", async () => {
    await mount();
    const next = worker("installing");
    registration.installing = next;
    act(() => registration.emit("updatefound"));
    expect(screen.queryByText("Update available")).toBeNull();
    next.state = "installed";
    registration.waiting = next;
    registration.installing = null;
    act(() => next.emit("statechange"));
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("offers a worker that was already installing when registration resolved", async () => {
    const next = worker("installing");
    registration.installing = next;
    await mount();
    expect(screen.queryByText("Update available")).toBeNull();
    next.state = "installed";
    registration.waiting = next;
    registration.installing = null;
    act(() => next.emit("statechange"));
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("offers a worker that finished installing before the update-found listener could see it", async () => {
    await mount();
    const next = worker("installed");
    registration.installing = next;
    registration.waiting = next;
    act(() => registration.emit("updatefound"));
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("offers a worker that installed while the app was hidden, once the app is visible again", async () => {
    await mount();
    registration.waiting = worker("installed");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(registration.update).toHaveBeenCalled();
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("dismisses for this page session only", async () => {
    const waiting = worker();
    install(waiting);
    const { unmount, Registrar } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByText("Update available")).toBeNull();
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    unmount();
    // Same page session: the dismissal holds even if the registrar remounts.
    render(<Registrar reload={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByText("Update available")).toBeNull();
    cleanup();
    // A new page load starts a new session, and the same waiting worker is offered again.
    await mount();
    expect(screen.getByText("Update available")).toBeTruthy();
  });

  it("messages only the waiting worker on Reload and waits for the controller change", async () => {
    const waiting = worker();
    install(waiting);
    const { reload } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
    act(() => container.emit("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => { container.emit("controllerchange"); container.emit("controllerchange"); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for a controller change this page did not ask for", async () => {
    install(worker());
    const { reload } = await mount();
    act(() => container.emit("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount", async () => {
    install(worker());
    const { unmount } = await mount();
    unmount();
    expect(container.listeners.controllerchange?.size ?? 0).toBe(0);
    expect(registration.listeners.updatefound?.size ?? 0).toBe(0);
  });

  it("treats registration and update errors as non-blocking", async () => {
    container.register.mockRejectedValueOnce(new Error("blocked"));
    await mount();
    expect(screen.queryByText("Update available")).toBeNull();
    cleanup();
    install();
    registration.update.mockRejectedValue(new Error("offline"));
    await mount();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(registration.update).toHaveBeenCalled();
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("leaves an unsent coach draft untouched until Reload is chosen", async () => {
    // A focused text field anywhere on the page stands in for the dock's own ask field (the one
    // place a draft lives now); this test is about the update banner, not the field itself.
    const Registrar = await registrar();
    const reload = vi.fn();
    render(<><textarea aria-label="Message" /><Registrar reload={reload} /></>);
    await act(async () => {});
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    fireEvent.change(input, { target: { value: "half-written question" } });
    const next = worker("installing");
    registration.installing = next;
    act(() => registration.emit("updatefound"));
    next.state = "installed";
    registration.waiting = next;
    act(() => next.emit("statechange"));
    expect(screen.getByText("Update available")).toBeTruthy();
    expect(input.value).toBe("half-written question");
    expect(document.activeElement).toBe(input);
    act(() => container.emit("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    expect(next.postMessage).not.toHaveBeenCalled();
  });

  it("offers nothing on a first install, when no worker controls the page yet", async () => {
    install(worker());
    container.controller = null;
    await mount();
    expect(screen.queryByText("Update available")).toBeNull();
    const next = worker("installing");
    registration.installing = next;
    act(() => registration.emit("updatefound"));
    next.state = "installed";
    registration.waiting = next;
    act(() => next.emit("statechange"));
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("clears the notice when another tab activates the waiting worker, without reloading this one", async () => {
    const waiting = worker();
    install(waiting);
    const { reload } = await mount();
    expect(screen.getByText("Update available")).toBeTruthy();
    waiting.state = "activated";
    registration.waiting = null;
    act(() => { waiting.emit("statechange"); container.emit("controllerchange"); });
    expect(screen.queryByText("Update available")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });

  it("clears the notice when the waiting worker becomes redundant", async () => {
    const waiting = worker();
    install(waiting);
    await mount();
    waiting.state = "redundant";
    registration.waiting = null;
    act(() => waiting.emit("statechange"));
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("completes Reload once when the offered worker already activated before the tap", async () => {
    const waiting = worker();
    install(waiting);
    const { reload } = await mount();
    // Another tab took it over; the tap lands before this tab has processed either event.
    waiting.state = "activated";
    registration.waiting = null;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => { container.emit("controllerchange"); waiting.emit("statechange"); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once when the requested worker activates, whichever signal lands first", async () => {
    const waiting = worker();
    install(waiting);
    const { reload } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    waiting.state = "activated";
    act(() => waiting.emit("statechange"));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => container.emit("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers a superseding worker afresh when the requested one goes redundant", async () => {
    const first = worker();
    install(first);
    const { reload } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(first.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    // A newer build finished installing and replaced the one this page asked for.
    const second = worker();
    registration.waiting = second;
    first.state = "redundant";
    act(() => first.emit("statechange"));
    const again = screen.getByRole("button", { name: "Reload" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(second.postMessage).not.toHaveBeenCalled();
    fireEvent.click(again);
    expect(second.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    act(() => { container.emit("controllerchange"); container.emit("controllerchange"); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers a later superseding worker with Reload enabled, and forgets the abandoned request", async () => {
    const first = worker();
    install(first);
    const { reload } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    registration.waiting = null;
    first.state = "redundant";
    act(() => first.emit("statechange"));
    expect(screen.queryByText("Update available")).toBeNull();
    act(() => container.emit("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    const second = worker("installing");
    registration.installing = second;
    act(() => registration.emit("updatefound"));
    second.state = "installed";
    registration.waiting = second;
    act(() => second.emit("statechange"));
    const again = screen.getByRole("button", { name: "Reload" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    expect(second.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    act(() => container.emit("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
