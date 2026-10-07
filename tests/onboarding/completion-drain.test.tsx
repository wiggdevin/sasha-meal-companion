// @vitest-environment jsdom
/**
 * The walkthrough's real defect (lanes/W2): an account that had just finished onboarding was sent
 * back to /onboarding step 1 by the very next page load.
 *
 * The gate opens on the SERVER's `user_settings.onboarded_at` (lib/profile/onboarding-state.ts's
 * accountDisposition + components/AuthGate.tsx), and the write that stamps it is queued locally
 * first (lib/sync/outbox.ts mutateUserSettings → enqueue). Leaving onboarding on the strength of a
 * queued op is a promise the server has not made yet: the reload reads a row whose `onboarded_at`
 * is still null and the account is forced back to step 1.
 *
 * So the flow has to drain before it navigates — on the answered path and on the skip — and a drain
 * that did not land has to leave the account where it is, with the retry it can act on.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const sync = vi.hoisted(() => ({ flushOutboxNow: vi.fn(async () => true) }));
/** The gate's second half: the mirrored `user_settings` row, read straight out of the phone's IDB. */
const mirror = vi.hoisted(() => {
  const ONBOARDED_AT = "2026-09-20T12:00:00.000Z";
  return {
    ONBOARDED_AT,
    mirroredOnboardedAt: vi.fn<() => Promise<string | null>>(async () => ONBOARDED_AT),
  };
});
const persistence = vi.hoisted(() => ({
  persistCompletedOnboarding:
    vi.fn<() => Promise<{ settings: unknown; constraintsSaved: boolean }>>(),
  persistSkippedOnboarding: vi.fn<() => Promise<unknown>>(),
  retryOnboardingConstraints: vi.fn(async () => true),
}));
const foodPersistence = vi.hoisted(() => ({ persistStarterSelection: vi.fn(async () => 6) }));
const foodAccess = vi.hoisted(() => ({
  status: "legacy" as "legacy" | "pilot" | "review" | "unavailable",
  revalidate: vi.fn<() => Promise<"legacy" | "pilot" | "review" | "unavailable">>(),
}));
const starterFixture = vi.hoisted(() => ({
  marks: { p1: "eats", p2: "eats", p3: "eats", p4: "eats", p5: "eats", p6: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" } as Record<string, string>,
}));

const STARTER_CHOICES = vi.hoisted(() => [
  { id: "p1", role: "protein" }, { id: "p2", role: "protein" }, { id: "p3", role: "protein" },
  { id: "p4", role: "protein" }, { id: "p5", role: "protein" }, { id: "p6", role: "protein" },
  { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
  { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
]);
// ONB2-RULE-REREAD: OnboardingFlow's save path now calls `starter.reread()` right before writing
// starter selections, instead of trusting this render's own `choices` — this double stands in for
// a fresh, still-passing re-read (tests/onboarding/useStarterStep.test.tsx covers the real one).
const rereadStarter = vi.hoisted(() => ({ reread: vi.fn(async () => STARTER_CHOICES) }));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: STARTER_CHOICES, marks: starterFixture.marks,
    mark: vi.fn(), retry: vi.fn(), reread: rereadStarter.reread, error: null }),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: foodAccess.status, retry: vi.fn(),
    revalidate: foodAccess.revalidate }),
}));
vi.mock("@/lib/foods/starter-client", () => ({ persistStarterSelection: foodPersistence.persistStarterSelection }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace }) }));
vi.mock("@/lib/sync/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/client")>()),
  flushOutboxNow: sync.flushOutboxNow,
}));
vi.mock("@/lib/profile/onboarding-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/onboarding-client")>()),
  persistCompletedOnboarding: persistence.persistCompletedOnboarding,
  persistSkippedOnboarding: persistence.persistSkippedOnboarding,
  mirroredOnboardedAt: mirror.mirroredOnboardedAt,
  retryOnboardingConstraints: persistence.retryOnboardingConstraints,
}));

import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import { ONBOARDING_SYNC_WARNING } from "@/lib/profile/onboarding-client";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

/** Every field the Plan step reads, so the primary action is live rather than disabled. */
function answeredProfile(): Settings {
  return {
    ...defaultSettings(),
    sex: "female",
    birthYear: 1996,
    heightCm: 165,
    weightKg: 60,
    activityLevel: "moderate",
    goal: "recomp",
  };
}

function openPlanStep(): void {
  render(<OnboardingFlow initial={5} initialSettings={answeredProfile()} returnTo="/" />);
}

function click(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

beforeEach(async () => {
  // Phase 9 §0.1: `OnboardingFlow` reads `accountHandle()` itself (lib/device/account.ts, not
  // mocked here), so a bound account is a precondition for the component even though every write
  // it drives (flushOutboxNow, persistCompletedOnboarding, persistSkippedOnboarding) is a double.
  await resetTestAccount();
  navigation.replace.mockReset();
  sync.flushOutboxNow.mockReset();
  sync.flushOutboxNow.mockResolvedValue(true);
  mirror.mirroredOnboardedAt.mockReset();
  mirror.mirroredOnboardedAt.mockResolvedValue(mirror.ONBOARDED_AT);
  persistence.persistCompletedOnboarding.mockReset();
  persistence.persistCompletedOnboarding.mockResolvedValue({
    settings: answeredProfile(), constraintsSaved: true,
  });
  persistence.persistSkippedOnboarding.mockReset();
  persistence.persistSkippedOnboarding.mockResolvedValue(answeredProfile());
  persistence.retryOnboardingConstraints.mockReset();
  persistence.retryOnboardingConstraints.mockResolvedValue(true);
  foodPersistence.persistStarterSelection.mockClear();
  rereadStarter.reread.mockClear();
  rereadStarter.reread.mockResolvedValue(STARTER_CHOICES);
  foodAccess.status = "legacy";
  foodAccess.revalidate.mockReset();
  foodAccess.revalidate.mockImplementation(async () => foodAccess.status);
  starterFixture.marks = { p1: "eats", p2: "eats", p3: "eats", p4: "eats", p5: "eats", p6: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
});

afterEach(() => {
  cleanup();
});

describe("leaving onboarding", () => {
  it("finishes an enabled plan with zero foods without persisting starter preferences", async () => {
    foodAccess.status = "pilot";
    starterFixture.marks = {};
    render(<OnboardingFlow initial={4} initialSettings={answeredProfile()} returnTo="/" />);
    expect(screen.getByText(/You can discover recipes right away/)).toBeTruthy();
    expect(screen.queryByText(/pilot|Eats/i)).toBeNull();
    expect(screen.queryByText("Find a starter food")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    click("Next");
    expect(screen.getByText(/You can discover recipes after setup/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this plan" }).hasAttribute("disabled")).toBe(false);
    click("Use this plan");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(foodAccess.revalidate).toHaveBeenCalledOnce();
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce();
    expect(foodPersistence.persistStarterSelection).not.toHaveBeenCalled();
    expect(sync.flushOutboxNow).toHaveBeenCalledOnce();
  });

  it("blocks zero-food completion when access is disabled after Foods", async () => {
    foodAccess.status = "pilot";
    starterFixture.marks = {};
    foodAccess.revalidate.mockResolvedValue("legacy");
    render(<OnboardingFlow initial={4} initialSettings={answeredProfile()} returnTo="/" />);
    click("Next");
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Go back to Foods"));
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
    expect(foodPersistence.persistStarterSelection).not.toHaveBeenCalled();
    expect(sync.flushOutboxNow).not.toHaveBeenCalled();
  });

  it("blocks zero-food completion when the fresh access read is unknown", async () => {
    foodAccess.status = "pilot";
    starterFixture.marks = {};
    foodAccess.revalidate.mockResolvedValue("unavailable");
    openPlanStep();
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("verify your food rules"));
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
    expect(sync.flushOutboxNow).not.toHaveBeenCalled();
  });

  it("retries the completion drain without rereading access or writing foods", async () => {
    foodAccess.status = "pilot";
    starterFixture.marks = {};
    sync.flushOutboxNow.mockResolvedValueOnce(false).mockResolvedValue(true);
    openPlanStep();
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ONBOARDING_SYNC_WARNING));
    click("Continue");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(foodAccess.revalidate).toHaveBeenCalledOnce();
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce();
    expect(foodPersistence.persistStarterSelection).not.toHaveBeenCalled();
    expect(sync.flushOutboxNow).toHaveBeenCalledTimes(2);
  });

  it("requires resolved pilot access before it can finish", () => {
    foodAccess.status = "unavailable";
    starterFixture.marks = {};
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()} returnTo="/" />);
    expect(screen.getByRole("button", { name: "Use this plan" }).hasAttribute("disabled")).toBe(true);
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
  });

  it("blocks a three-meal completion with two chosen proteins before any profile write, then permits two meals", async () => {
    for (const id of ["p3", "p4", "p5", "p6"]) delete starterFixture.marks[id];
    render(<OnboardingFlow initial={5} initialSettings={{ ...answeredProfile(), mealsPerDay: 3 }} returnTo="/" />);
    expect(screen.getByText(/2 of 3 distinct proteins/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this plan" }).hasAttribute("disabled")).toBe(true);
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
    click("Decrease Meals per day");
    expect(screen.getByRole("button", { name: "Use this plan" }).hasAttribute("disabled")).toBe(false);
    click("Use this plan");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce();
  });

  it("also blocks a direct Plan entry when Foods has fewer than two carbs or fats", () => {
    delete starterFixture.marks.c2;
    render(<OnboardingFlow initial={5} initialSettings={{ ...answeredProfile(), mealsPerDay: 2 }} returnTo="/" />);
    expect(screen.getByText(/choose at least two proteins, two carbs and two fats/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this plan" }).hasAttribute("disabled")).toBe(true);
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
  });

  it("drains the account's settings write before it navigates", async () => {
    const order: string[] = [];
    sync.flushOutboxNow.mockImplementation(async () => { order.push("drain"); return true; });
    navigation.replace.mockImplementation(() => { order.push("navigate"); });
    openPlanStep();

    click("Use this plan");

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual(["drain", "navigate"]);
  });

  it("offers devices only after the completed plan stamp lands", async () => {
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()}
      returnTo="/" deviceCapability={{ enabled: true, ouraConfigured: false }} />);
    click("Use this plan");
    // The heading's own focus() runs in a useEffect, which commits asynchronously after the DOM
    // mutation that waitFor's MutationObserver reacts to — under parallel-suite load the two can
    // land in different act() flushes, so the focus check has to be inside the same waitFor as the
    // heading it targets rather than asserted immediately after a waitFor that only proves mount.
    // Both the heading's existence and its focus are asserted on every poll, so neither check is
    // dropped — a heading that never mounts still fails loudly instead of satisfying only a
    // narrowed focus check.
    await waitFor(() => {
      const heading = screen.getByRole("heading", { name: "Connect a device" });
      expect(heading).toBeTruthy();
      expect(document.activeElement).toBe(heading);
    });
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set up Apple Health" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Oura" })).toBeNull();
    expect(screen.getByText(/cannot request Health access directly/)).toBeTruthy();
    click("Set up Apple Health");
    expect(screen.getByRole("dialog", { name: "Apple Health setup" })).toBeTruthy();
    expect(screen.getByText(/Most reliable \(Health Auto Export, paid app\)/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Apple Health setup" }))
      .getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getByRole("heading", { name: "Connect a device" })).toBeTruthy();
    click("Skip for now");
    expect(navigation.replace).toHaveBeenCalledWith("/");
  });

  it("never exposes devices before the completion drain succeeds", async () => {
    sync.flushOutboxNow.mockResolvedValue(false);
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()}
      returnTo="/" deviceCapability={{ enabled: true, ouraConfigured: true }} />);
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ONBOARDING_SYNC_WARNING));
    expect(screen.queryByRole("heading", { name: "Connect a device" })).toBeNull();
  });

  it("shows Oura when the server says it is configured", async () => {
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()}
      returnTo="/" deviceCapability={{ enabled: true, ouraConfigured: true }} />);
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Oura" })).toBeTruthy());
  });

  it("hides the device step entirely when ingest is off", async () => {
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()}
      returnTo="/" deviceCapability={{ enabled: false, ouraConfigured: true }} />);
    click("Use this plan");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("heading", { name: "Connect a device" })).toBeNull();
  });

  it("inherits the server capability for invite and Finish setup flows without an explicit prop", async () => {
    render(<CapabilitiesProvider value={{ coach: true, scan: false, captureMethods: [],
      device: { enabled: true, ouraConfigured: false } }}>
      <OnboardingFlow initial={5} initialSettings={answeredProfile()} returnTo="/settings" />
    </CapabilitiesProvider>);
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect a device" })).toBeTruthy());
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("leaves Redo setup without a second device offer", async () => {
    render(<CapabilitiesProvider value={{ coach: true, scan: false, captureMethods: [],
      device: { enabled: true, ouraConfigured: true } }}>
      <OnboardingFlow initial={5} initialSettings={answeredProfile()} returnTo="/settings"
        offerDevice={false} />
    </CapabilitiesProvider>);
    click("Use this plan");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/settings"));
    expect(screen.queryByRole("heading", { name: "Connect a device" })).toBeNull();
  });

  it("keeps the saved answers when the drain did not land: the retry only drains", async () => {
    sync.flushOutboxNow.mockResolvedValueOnce(false).mockResolvedValue(true);
    openPlanStep();

    click("Use this plan");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(ONBOARDING_SYNC_WARNING));
    expect(navigation.replace).not.toHaveBeenCalled();

    // The label says the persist half is done ("Continue", not "Use this plan" again), the action
    // stays live as the retry, and that retry re-enters the drain — never `persist*` a second time,
    // which would mint a second target revision and a second weigh-in.
    click("Continue");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledTimes(1);
    expect(sync.flushOutboxNow).toHaveBeenCalledTimes(2);
  });

  it("retries failed food rules without minting another target revision", async () => {
    persistence.persistCompletedOnboarding.mockResolvedValueOnce({
      settings: answeredProfile(), constraintsSaved: false,
    });
    persistence.retryOnboardingConstraints.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    openPlanStep();
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("allergen rules"));
    click("Continue");
    await waitFor(() => expect(persistence.retryOnboardingConstraints).toHaveBeenCalledTimes(1));
    expect(navigation.replace).not.toHaveBeenCalled();
    click("Continue");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledTimes(1);
  });

  it("drains before the account skips, and keeps it here when the drain did not land", async () => {
    const order: string[] = [];
    let accepted = true;
    sync.flushOutboxNow.mockImplementation(async () => { order.push("drain"); return accepted; });
    navigation.replace.mockImplementation(() => { order.push("navigate"); });
    openPlanStep();

    click("Skip for now");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual(["drain", "navigate"]);

    order.length = 0;
    accepted = false;
    navigation.replace.mockClear();
    click("Skip for now");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(ONBOARDING_SYNC_WARNING));
    expect(order).toEqual(["drain"]);
    expect(navigation.replace).not.toHaveBeenCalled();
    // Skip is the retry here, so it stays live — and the retry skipped the skip write.
    const skip = screen.getByRole("button", { name: "Skip for now" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(false);
    expect(persistence.persistSkippedOnboarding).toHaveBeenCalledTimes(1);
    expect(sync.flushOutboxNow).toHaveBeenCalledTimes(2);
  });

  it("stays when the drain emptied the queue but the server row never got the stamp", async () => {
    // `flushOutboxNow` answers "no whole-row op is queued", and a drop/unsupported settlement empties
    // the queue without the server row being written (lib/sync/settings-intents.ts:75) — so the
    // mirrored row has to carry `onboarded_at` before an account may leave.
    mirror.mirroredOnboardedAt.mockResolvedValue(null);
    openPlanStep();

    click("Use this plan");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(ONBOARDING_SYNC_WARNING));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledTimes(1);

    // The mirrored row catches up (the write really landed) and the retry leaves without saving twice.
    mirror.mirroredOnboardedAt.mockResolvedValue(mirror.ONBOARDED_AT);
    click("Continue");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistCompletedOnboarding).toHaveBeenCalledTimes(1);
    expect(sync.flushOutboxNow).toHaveBeenCalledTimes(2);
  });
});

describe("closing the flow at any step (2026-10-01)", () => {
  it("leaves a flow opened over Settings from its top close without writing anything", async () => {
    const onFinished = vi.fn();
    render(<OnboardingFlow initial={0} initialSettings={defaultSettings()} returnTo="/settings"
      onFinished={onFinished} />);
    const dialog = screen.getByRole("dialog", { name: "Profile setup" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(persistence.persistSkippedOnboarding).not.toHaveBeenCalled();
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
    expect(sync.flushOutboxNow).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("leaves on Escape, but not on an Escape meant for a sheet opened inside it", async () => {
    const onClose = vi.fn();
    render(<OnboardingFlow initial={2} initialSettings={answeredProfile()} returnTo="/settings"
      onFinished={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Profile setup" });
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    nested.appendChild(inner);
    dialog.appendChild(nested);
    fireEvent.keyDown(inner, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    nested.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("makes the first-run route's top close the same as Skip for now", async () => {
    openPlanStep();
    expect(screen.queryByRole("dialog", { name: "Profile setup" })).toBeNull();
    click("Close");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistSkippedOnboarding).toHaveBeenCalledTimes(1);
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
  });

  it("closes the optional device step from its top close", async () => {
    render(<OnboardingFlow initial={5} initialSettings={answeredProfile()}
      returnTo="/" deviceCapability={{ enabled: true, ouraConfigured: false }} />);
    click("Use this plan");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect a device" })).toBeTruthy());
    click("Close");
    expect(navigation.replace).toHaveBeenCalledWith("/");
  });
});
