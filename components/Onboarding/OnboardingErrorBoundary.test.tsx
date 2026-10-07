// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultSettings } from "@/lib/store";
import OnboardingErrorBoundary from "./OnboardingErrorBoundary";
import { saveOnboardingDraft } from "./v2/draft-store";

const accountSettings = vi.hoisted(() => ({ loadOnboardingSettings: vi.fn() }));
vi.mock("@/lib/profile/onboarding-client", () => ({
  loadOnboardingSettings: () => accountSettings.loadOnboardingSettings(),
}));

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  bindAccount("11111111-1111-4111-8111-111111111111");
  accountSettings.loadOnboardingSettings.mockReset();
  accountSettings.loadOnboardingSettings.mockResolvedValue({ ...defaultSettings(), mealsPerDay: 5 });
});

const flowProps = vi.hoisted(() => ({ last: null as { initial?: number; initialSettings?: unknown } | null }));
vi.mock("@/components/Onboarding/OnboardingFlow", () => ({
  default: (props: { initial?: number; initialSettings?: unknown }) => {
    flowProps.last = props;
    return <div data-testid="legacy-form">legacy form</div>;
  },
}));

function Bomb(): never {
  throw new Error("chat path crashed");
}

afterEach(() => { cleanup(); flowProps.last = null; unbindAccount(); });

describe("OnboardingErrorBoundary", () => {
  it("passes children through when nothing crashes", () => {
    render(<OnboardingErrorBoundary><p>chat shell</p></OnboardingErrorBoundary>);
    screen.getByText("chat shell");
  });

  it("falls back to the legacy form at step 0 when the chat path throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<OnboardingErrorBoundary><Bomb /></OnboardingErrorBoundary>);
    await waitFor(() => screen.getByTestId("legacy-form"));
    expect(flowProps.last?.initial).toBe(0);
    spy.mockRestore();
  });

  it("pre-fills the legacy form from whatever the chat path had already drafted, layered onto"
    + " the account's own real settings (Sol round-1 WARN: used to discard them)", async () => {
    await saveOnboardingDraft({ beat: "safety", settings: { goal: "recomp", heightCm: 170 } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<OnboardingErrorBoundary><Bomb /></OnboardingErrorBoundary>);
    await waitFor(() => screen.getByTestId("legacy-form"));
    expect((flowProps.last?.initialSettings as { goal?: string })?.goal).toBe("recomp");
    expect((flowProps.last?.initialSettings as { heightCm?: number })?.heightCm).toBe(170);
    // A field the draft never touched still comes from the account's real settings, not a bare
    // default — this is the field the WARN was about.
    expect((flowProps.last?.initialSettings as { mealsPerDay?: number })?.mealsPerDay).toBe(5);
    spy.mockRestore();
  });

  it("falls back to bare defaults only if the account's real settings cannot be read either", async () => {
    accountSettings.loadOnboardingSettings.mockRejectedValueOnce(new Error("offline"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<OnboardingErrorBoundary><Bomb /></OnboardingErrorBoundary>);
    await waitFor(() => screen.getByTestId("legacy-form"));
    // `defaultSettings()` stamps its own fresh `updatedAt`, so a second call a moment later never
    // deep-equals the first — compare everything else instead.
    expect({ ...(flowProps.last?.initialSettings as object), updatedAt: undefined })
      .toEqual({ ...defaultSettings(), updatedAt: undefined });
    spy.mockRestore();
  });
});
