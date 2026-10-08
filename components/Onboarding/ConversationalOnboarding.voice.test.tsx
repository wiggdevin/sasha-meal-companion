// @vitest-environment jsdom
/**
 * Voice in onboarding v2 (GOAL item 1: "talk from the first second, voice first, typing always
 * available"). The dock's mic runs the capture box's own stack — `HoldController` on the
 * `dictationIo()` ports — driven here through the real controller and speech adapter with a fake
 * `SpeechRecognition` (a browser tab) or a fake `MediaRecorder` (the iOS / installed-app recorder
 * fallback). The transcript only fills the box; Send is the typed answer's own path, so the local
 * safety gate and the extract budget apply to a spoken answer exactly as to a typed one.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/lib/store";
import { MIC_OFF_COPY, MIC_UNAVAILABLE_COPY } from "@/components/DictateMic";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/profile/onboarding-client", () => ({
  loadOnboardingSettings: async () => defaultSettings(),
  persistSkippedOnboarding: async () => defaultSettings(),
  persistCompletedOnboarding: async () => ({ settings: defaultSettings(), constraintsSaved: true }),
  mirroredOnboardedAt: async () => "2026-10-08T00:00:00.000Z",
  retryOnboardingConstraints: async () => true,
  ONBOARDING_SYNC_WARNING: "sync warning",
  CONSTRAINT_SAVE_WARNING: "constraint warning",
}));
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: async () => true }));
const account = vi.hoisted(() => ({
  accountFetch: vi.fn(async (..._args: unknown[]): Promise<Response> => { throw new Error("offline in tests"); }),
  accountJson: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
}));
vi.mock("@/lib/device/account", () => ({
  accountHandle: vi.fn(() => ({ userId: "u1" })),
  currentAccountOrNull: vi.fn(() => ({ userId: "u1", epoch: 1 })),
  onAccountReady: (fn: (h: { userId: string; epoch: number }) => void) => { fn({ userId: "u1", epoch: 1 }); return () => {}; },
  onAccountGone: () => () => {},
  accountFetch: (...args: unknown[]) => account.accountFetch(...args),
  accountJson: (...args: unknown[]) => account.accountJson(...args),
  rethrowAccountChanged: vi.fn(),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: "unavailable", retry: vi.fn(), revalidate: vi.fn(async () => "unavailable") }),
}));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: null, marks: {}, error: null, mark: vi.fn(), retry: vi.fn(), reread: vi.fn(async () => null) }),
}));
vi.mock("@/lib/onboarding/save-plan", () => ({
  saveOnboardingPlan: vi.fn(async () => ({ ok: true })),
  RATE_NOT_ELIGIBLE_ERROR: "held",
}));
/** The recorder fallback's server leg (sign, upload, `/api/coach/transcribe`). */
const transcribeClip = vi.hoisted(() => vi.fn(async (_clip: Blob) => ({ ok: true as const, text: "lose fat 34", ms: 900 })));
vi.mock("@/lib/coach-transcribe-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coach-transcribe-client")>()),
  transcribeClip: (clip: Blob) => transcribeClip(clip),
}));

import ConversationalOnboarding from "./ConversationalOnboarding";

type Handler = ((event?: unknown) => void) | null;
class FakeRecognition {
  static made: FakeRecognition[] = [];
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 1;
  onresult: Handler = null; onerror: Handler = null; onend: Handler = null;
  onstart: Handler = null; onaudiostart: Handler = null;
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  constructor() { FakeRecognition.made.push(this); }
  say(text: string, isFinal = true): void {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

/** A recorder that hands back one non-empty chunk on stop — iOS Safari's `audio/mp4` only. */
class FakeMediaRecorder {
  static made: FakeMediaRecorder[] = [];
  static isTypeSupported = (type: string) => type.startsWith("audio/mp4");
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, readonly options: { mimeType: string }) { FakeMediaRecorder.made.push(this); }
  start(): void { this.state = "recording"; }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.options.mimeType }) });
    this.onstop?.();
  }
}
const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };

const box = () => screen.getByRole("textbox", { name: "Tell Sasha" }) as HTMLTextAreaElement;
const mic = () => screen.getByRole("button", { name: "Say it" });
const pose = () => document.querySelector("[data-pose]")?.getAttribute("data-pose");
const line = () => screen.queryByTestId("composer-line")?.textContent ?? null;

/** Tap the mic, hear `words`, tap Stop: the words wait in the box for review. */
function dictate(words: string): void {
  fireEvent.click(mic());
  const recognition = FakeRecognition.made.at(-1)!;
  act(() => { recognition.onstart?.(); recognition.say(words); });
  fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
  act(() => { recognition.onend?.(); });
}

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  FakeRecognition.made = [];
  FakeMediaRecorder.made = [];
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("onboarding voice", () => {
  it("tap to start, live words in the box, tap to stop, and only Send reads them", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    render(<ConversationalOnboarding />);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    expect(pose()).toBe("wave");

    fireEvent.click(mic());
    const recognition = FakeRecognition.made[0];
    expect(recognition.start).toHaveBeenCalledTimes(1);
    act(() => { recognition.onstart?.(); recognition.say("lose fat and I'm", false); });

    // The partial transcript is visible while Sprout listens; the box is the mic's, with no Send.
    expect(box().value).toBe("lose fat and I'm");
    expect(box().readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(pose()).toBe("listening");
    expect(line()).toBe("Listening. Tap the mic when you are done.");
    const stop = screen.getByRole("button", { name: "Stop dictation" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(stop.className).toMatch(/size-11/); // 44 px target

    act(() => { recognition.say("lose fat and I'm 34 years old"); });
    fireEvent.click(stop);
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    act(() => { recognition.onend?.(); });

    // Stopped: the words wait for review. Nothing was read or sent on its own.
    expect(box().value).toBe("lose fat and I'm 34 years old");
    expect(box().readOnly).toBe(false);
    expect(account.accountFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Tell Sasha" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Prefer not to say" });
    expect(screen.getByTestId("facts-recap").textContent).toMatch(/34/);
    // The facts beat keeps the mic: every free-text beat takes voice.
    expect(mic()).toBeTruthy();
  });

  it("a spoken health or allergy detail is never read: Send opens the safety card", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    render(<ConversationalOnboarding />);
    dictate("I have a peanut allergy");
    expect(screen.queryByTestId("safety-round")).toBeNull(); // nothing moves until Send
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByTestId("safety-round");
    screen.getByText(/health or allergy detail/);
    expect(account.accountFetch).not.toHaveBeenCalled();
  });

  it("a spoken answer spends the same extract budget a typed one does", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    account.accountFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
    account.accountJson.mockImplementation(async () => ({ status: "failed" }));
    render(<ConversationalOnboarding />);

    dictate("I want to feel stronger");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(account.accountFetch).toHaveBeenCalledTimes(1));
    await screen.findByText(/didn’t catch that/);

    fireEvent.change(box(), { target: { value: "" } });
    dictate("I just want more energy");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(account.accountFetch).toHaveBeenCalledTimes(2));

    const sent = account.accountFetch.mock.calls.map((call) =>
      JSON.parse(String((call[2] as RequestInit).body)) as { text: string; callsUsedThisSession: number });
    expect(sent.map((body) => body.callsUsedThisSession)).toEqual([0, 1]);
    expect(sent[1].text).toBe("I just want more energy");
  });

  it("a denied microphone leaves the text box and one plain line", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    render(<ConversationalOnboarding />);
    fireEvent.change(box(), { target: { value: "lose fat" } });
    fireEvent.click(mic());
    act(() => { FakeRecognition.made[0].onerror?.({ error: "not-allowed" }); });

    expect(line()).toBe(MIC_OFF_COPY);
    expect(box().value).toBe("lose fat");
    expect(box().readOnly).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("How old are you?");
  });

  it("with no recogniser and no recorder there is no mic: typing works, one plain line says so", async () => {
    // jsdom has neither SpeechRecognition nor MediaRecorder.
    render(<ConversationalOnboarding />);
    expect(screen.queryByRole("button", { name: "Say it" })).toBeNull();
    expect(line()).toBe(MIC_UNAVAILABLE_COPY);
    fireEvent.change(box(), { target: { value: "build muscle" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("How old are you?");
  });

  it("the installed app records (iOS audio/mp4) and the transcript waits in the box", async () => {
    // A recogniser exists, but a home-screen PWA uses the recorder only (lib/voice/dictation-io.ts).
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true, value: { getUserMedia: vi.fn(async () => fakeStream) },
    });
    try {
      render(<ConversationalOnboarding />);
      fireEvent.click(mic());
      await vi.waitFor(() => expect(FakeMediaRecorder.made).toHaveLength(1));
      expect(FakeRecognition.made).toHaveLength(0);
      expect(FakeMediaRecorder.made[0].options.mimeType).toMatch(/^audio\/mp4/);
      await vi.waitFor(() => expect(pose()).toBe("listening"));
      expect(box().readOnly).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
      await vi.waitFor(() => expect(transcribeClip).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(box().value).toBe("lose fat 34"));
      expect(box().readOnly).toBe(false);
      expect(account.accountFetch).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });
});
