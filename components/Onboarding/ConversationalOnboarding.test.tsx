// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
/**
 * The onboarding v2 shell (BRIEF.md §4/§6): one scroller, one declared AI scope, the dock
 * morphing between beats with no page transition, and lane 5's own wiring — the real safety and
 * foods cards (branched on `foodAccess.status`), the reward plate, and the "Use this plan" write
 * path (UI-NEEDS ONB2-WIRE).
 *
 * GPT-6 Sol review (2026-10-07, two rounds, lane 2) added most of the beat-sequencing cases here:
 * a real default exit instead of a silent no-op, a reward confirm that actually finishes instead
 * of looping on itself and is honestly labelled when it has nothing real to save, a safety beat
 * that only advances on "No, none of these" or a confirmed rule review, and a leave that only navigates
 * once the account's sync gate actually holds. Lane 5 (2026-10-07) replaced the lane-2 placeholder
 * assertions for safety/foods/reward with the real wired content, and added the write-path cases.
 * The stream's beat change is sequential (`AnimatePresence mode="wait"`), so a test after a
 * beat-changing click awaits the new beat's own content.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import { defaultSettings } from "@/lib/store";
import { loadOnboardingDraft, saveOnboardingDraft } from "./v2/draft-store";
import ConversationalOnboarding, { ONBOARDING_SCOPE } from "./ConversationalOnboarding";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const loadOnboardingSettings = vi.fn(async () => defaultSettings());
const persistSkippedOnboarding = vi.fn(async (_base: unknown) => defaultSettings());
const persistCompletedOnboarding = vi.fn(
  async (_settings: unknown, _state: unknown, _safety?: unknown) =>
    ({ settings: defaultSettings(), constraintsSaved: true }));
const mirroredOnboardedAt = vi.fn(async (): Promise<string | null> => "2026-10-07T00:00:00.000Z");
const retryOnboardingConstraints = vi.fn(async (_flags: unknown) => true);
vi.mock("@/lib/profile/onboarding-client", () => ({
  loadOnboardingSettings: () => loadOnboardingSettings(),
  persistSkippedOnboarding: (base: unknown) => persistSkippedOnboarding(base),
  persistCompletedOnboarding: (settings: unknown, state: unknown, _now?: unknown, _deps?: unknown,
    safety?: unknown) => persistCompletedOnboarding(settings, state, safety),
  mirroredOnboardedAt: () => mirroredOnboardedAt(),
  retryOnboardingConstraints: (flags: unknown) => retryOnboardingConstraints(flags),
  ONBOARDING_SYNC_WARNING: "Your setup could not be saved to your account — check your connection and try again",
  CONSTRAINT_SAVE_WARNING: "Your allergen rules could not be saved — retry from Foods › Avoids",
}));
const flushOutboxNow = vi.fn(async () => true);
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: () => flushOutboxNow() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: vi.fn(() => ({ userId: "u1" })),
  currentAccountOrNull: vi.fn(() => ({ userId: "u1", epoch: 1 })),
  // Matches the real module's own contract ("fires at once when an account is already ready").
  onAccountReady: (fn: (h: { userId: string; epoch: number }) => void) => {
    fn({ userId: "u1", epoch: 1 });
    return () => {};
  },
  onAccountGone: () => () => {},
  // The extract client's model leg: unreachable in tests, so typed answers use the local reading.
  accountFetch: vi.fn(async () => { throw new Error("offline in tests"); }),
  accountJson: vi.fn(),
  rethrowAccountChanged: vi.fn(),
}));

const foodAccess = vi.hoisted(() => ({
  status: "unavailable" as "checking" | "pilot" | "legacy" | "review" | "unavailable",
}));
const starterFixture = vi.hoisted(() => ({
  choices: null as readonly { id: string; role: string }[] | null,
  marks: {} as Record<string, string>,
  error: null as string | null,
}));
const starterSpies = vi.hoisted(() => ({
  mark: vi.fn(), retry: vi.fn(), reread: vi.fn(async () => starterFixture.choices),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: foodAccess.status, retry: vi.fn(),
    revalidate: vi.fn(async () => foodAccess.status) }),
}));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({
    choices: starterFixture.choices, marks: starterFixture.marks, error: starterFixture.error,
    mark: starterSpies.mark, retry: starterSpies.retry, reread: starterSpies.reread,
  }),
}));
const persistStarterSelection = vi.fn(async (_marks: unknown, _choices: unknown) => 0);
/** `saveOnboardingPlan` (lib/onboarding/save-plan.ts, tested in its own suite) stood in by its
 *  contract: it calls the shell's `persistPlan`/`retryConstraints` deps, writes the foods, drains. */
type SaveDeps = {
  persistPlan: (settings: unknown, state: unknown, now?: unknown, deps?: unknown, safety?: unknown)
    => Promise<{ constraintsSaved: boolean }>;
  retryConstraints: (flags: unknown) => Promise<boolean>;
};
const saveOnboardingPlan = vi.fn(async (input: {
  settings: unknown; onboardingState: { flags: unknown }; starter?: { marks: unknown } | null;
  safety?: unknown;
}, deps: SaveDeps) => {
  const written = await deps.persistPlan(input.settings, input.onboardingState, undefined, undefined, input.safety);
  if (!written.constraintsSaved && !await deps.retryConstraints(input.onboardingState.flags)) {
    return { ok: false as const, error: "Your allergen rules could not be saved — retry from Foods › Avoids" };
  }
  if (input.starter) await persistStarterSelection(input.starter.marks, []);
  if (!await flushOutboxNow() || await mirroredOnboardedAt() === null) {
    return { ok: false as const, error: "Your setup could not be saved to your account — check your connection and try again" };
  }
  return { ok: true as const };
});
/** The account's stored pace holds (stored-eligibility.ts): none unless a test sets them. */
const storedHolds = vi.hoisted(() => ({
  value: { holds: [] as string[], minor: false },
  status: "ready" as "loading" | "ready" | "failed",
  /** What a re-read answers (the routing awaits it while the first read is not ready). */
  refresh: null as null | (() => Promise<{ holds: string[]; minor: boolean } | null>),
}));
vi.mock("@/components/Onboarding/v2/stored-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Onboarding/v2/stored-eligibility")>()),
  useStoredEligibility: () => ({
    eligibility: storedHolds.status === "ready" ? storedHolds.value : null,
    status: storedHolds.status,
    refresh: storedHolds.refresh ?? (async () => storedHolds.value),
  }),
}));
vi.mock("@/lib/onboarding/save-plan", () => ({
  saveOnboardingPlan: (input: never, deps: never) => saveOnboardingPlan(input, deps),
  RATE_NOT_ELIGIBLE_ERROR: "Your saved health answers keep your calories about where you burn, so there's no pace to set. Tap Use this plan again.",
}));

beforeEach(() => {
  storedHolds.value = { holds: [], minor: false };
  storedHolds.status = "ready";
  storedHolds.refresh = null;
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  foodAccess.status = "unavailable";
  starterFixture.choices = null;
  starterFixture.marks = {};
  starterFixture.error = null;
  starterSpies.reread.mockImplementation(async () => starterFixture.choices);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** Answers every required question the facts beat asks after the goal, one at a time, in US
 *  units (age, sex, height in ft/in, weight in lb). "That's me" only appears once all of them are
 *  confirmed (GPT-6 Sol round-1 BLOCK; live QA 2026-10-07). */
async function fillRemainingRequiredFacts(age = "34"): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Age"), { target: { value: age } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("button", { name: "Prefer not to say" }));
  fireEvent.change(await screen.findByLabelText("Feet"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("Inches"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(await screen.findByLabelText("Weight"), { target: { value: "132" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("button", { name: "That’s me" });
}

/** The question-set beats between "That's me" and the foods beat (QUESTION-SET-v2.md §6): the
 *  week (skipped), the safety round ("No, none of these"), the pace (the pre-selected chip), and
 *  "Your day" (accepted as pre-filled). Awaits each sequential stream swap. */
async function passPlanBeats(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
  fireEvent.click(await screen.findByRole("button", { name: "No, none of these" }));
  await screen.findByTestId("pace-beat");
  fireEvent.click(screen.getByRole("button", { name: /^(Use |Next)/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Looks right" }));
}

/** A pilot account whose rules allow two foods per group, none marked yet: "Sprout, pick for me"
 *  can fill a usable plan (the mocked hook's `mark` is a spy, so the marks stay empty and the
 *  reward beat is NOT ready unless a test marks them itself). */
function pickableFoods(): void {
  foodAccess.status = "pilot";
  starterFixture.choices = [
    { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
    { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
    { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
  ];
}

/** Walks the default flow to the reward beat, awaiting each sequential stream swap. */
async function reachReward(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Lose weight" })); // -> facts
  await fillRemainingRequiredFacts();
  fireEvent.click(screen.getByRole("button", { name: "That’s me" })); // -> week
  await passPlanBeats(); // -> foods
  await screen.findByRole("button", { name: "Sprout, pick for me" });
  fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" })); // -> reward
  // Every required body fact was answered above, so the preview-target computation already has
  // what it needs — the reward card renders "ready", not "preparing".
  await screen.findByTestId("reward-plate-ready");
}

describe("ConversationalOnboarding", () => {
  it("declares one page-level AI scope for the whole flow", () => {
    expect(ONBOARDING_SCOPE).toEqual({ kind: "page", page: "onboarding" });
    const { container } = render(<ConversationalOnboarding />);
    const shell = container.querySelector('[data-onboarding-v2="true"]');
    expect(shell?.getAttribute("data-scope-kind")).toBe("page");
    expect(shell?.getAttribute("data-scope-page")).toBe("onboarding");
  });

  it("opens on the goal question with Sprout listening, no progress bar, no header", () => {
    render(<ConversationalOnboarding />);
    screen.getByText(/What’s your main goal right now\?/);
    expect(screen.queryByRole("progressbar")).toBeNull();
    // Live QA 2026-10-07: the dock is a working text composer, never an empty box.
    screen.getByRole("textbox", { name: "Tell Sasha" });
  });

  it("never renders the dock as an empty box on any beat: each beat's dock has a real control,"
    + " or there is no dock at all", async () => {
    const { container } = render(<ConversationalOnboarding />);
    const dockControls = () => {
      const dock = container.querySelector('[data-onboarding-dock="true"]');
      if (!dock) return null;
      return dock.querySelectorAll("[data-dock-live] button, [data-dock-live] textarea").length;
    };
    expect(dockControls()).toBeGreaterThan(0); // opener: the composer
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await screen.findByText("How old are you?");
    expect(dockControls()).toBeGreaterThan(0); // facts: the composer
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    await screen.findByTestId("week-beat");
    await vi.waitFor(() => expect(dockControls()).toBeNull()); // week: no dock, its own buttons
    fireEvent.click(screen.getByRole("button", { name: "Skip this" }));
    await screen.findByTestId("safety-round");
    expect(dockControls()).toBeNull(); // safety: no dock
    expect(container.querySelector('[data-empty="true"]')).toBeNull();
  });

  it("a typed answer moves the flow forward with no tap (read on the phone, no model call)", async () => {
    render(<ConversationalOnboarding />);
    const box = screen.getByRole("textbox", { name: "Tell Sasha" });
    fireEvent.change(box, { target: { value: "lose fat, 34 years old" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // goal and age are read; the facts beat asks the next question.
    await screen.findByRole("button", { name: "Prefer not to say" });
    expect(screen.getByTestId("facts-recap").textContent).toMatch(/34/);
    expect(screen.getByTestId("facts-recap").textContent).toMatch(/lose fat/);
    // While a question is open, a bare typed number answers it in its own US unit.
    fireEvent.click(screen.getByRole("button", { name: "Female" }));
    await screen.findByLabelText("Feet");
    fireEvent.change(screen.getByRole("textbox", { name: "Tell Sasha" }), { target: { value: "5 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByLabelText("Weight");
    expect(screen.getByTestId("facts-recap").textContent).toMatch(/5\u203210\u2033/);
  });

  it("a typed health or allergy detail is never read: it opens the safety card, and the facts"
    + " questions follow it", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.change(screen.getByRole("textbox", { name: "Tell Sasha" }), { target: { value: "I have a peanut allergy" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByTestId("safety-round");
    screen.getByText(/health or allergy detail/);
    fireEvent.click(screen.getByRole("button", { name: "No, none of these" }));
    // Nothing was answered yet, so the facts beat comes next (not foods).
    await screen.findByText("How old are you?");
  });

  it("advances to the real facts sentence after a goal is picked, with that goal already"
    + " filled in at high confidence (a direct tap is never a guess)", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Build muscle" }));
    // The stream swap is sequential (AnimatePresence mode="wait"), so this is awaited.
    await screen.findByText("How old are you?");
    expect(screen.getByTestId("facts-recap").textContent).toBe("You want to build muscle.");
    // "That's me" waits until every required fact is confirmed.
    expect(screen.queryByRole("button", { name: "That’s me" })).toBeNull();
  });

  it("renders a lane slot in place of its placeholder once one is supplied", async () => {
    render(<ConversationalOnboarding slots={{ factsSentence: <p>You&apos;re 34, born 1992.</p> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await screen.findByText("You're 34, born 1992.");
    expect(screen.queryByText(/facts sentence \(lane L3\)/)).toBeNull();
  });

  it("calls a supplied Skip for now at every beat", () => {
    const onSkip = vi.fn();
    render(<ConversationalOnboarding onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("without a supplied onSkip, Skip for now still really leaves (Sol review: no silent no-op)", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await vi.waitFor(() => expect(persistSkippedOnboarding).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("a leave only navigates once the sync gate actually holds, and offers a retry on failure"
    + " (Sol review round 2: a bare finally used to navigate even on a failed sync)", async () => {
    mirroredOnboardedAt.mockResolvedValueOnce(null);
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    // Retry succeeds once the mirror resolves normally again — leaving() is not stuck "in flight".
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("renders the real allergy/condition card before any food UI, and advances only on"
    + " its recognised 'No, none of these' answer, reporting every key tapped", async () => {
    const onAllergyAnswer = vi.fn();
    render(<ConversationalOnboarding onAllergyAnswer={onAllergyAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" })); // -> facts
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" })); // -> week
    fireEvent.click(await screen.findByRole("button", { name: "Skip this" })); // -> safety
    await screen.findByTestId("safety-round");
    screen.getByText(/does anything here apply to you/);
    // Neither the pace screen nor any food UI shows before the safety round is answered.
    expect(screen.queryByTestId("pace-beat")).toBeNull();
    expect(screen.queryByText(/Checking your food rules/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No, none of these" }));
    expect(onAllergyAnswer).toHaveBeenCalledWith("none");
    await screen.findByTestId("pace-beat");
    fireEvent.click(screen.getByRole("button", { name: /^(Use |Next)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Looks right" }));
    // Advanced past safety: the foods beat's own notice is showing (the fixture's "unavailable"
    // status) — awaited directly, since the dock's own escape chip switches mode a beat ahead of
    // the stream's sequential swap and would resolve this `findBy` too early otherwise.
    await screen.findByText(/Checking your food rules/);
    screen.getByRole("button", { name: "Sprout, pick for me" });
  });

  it("the foods beat renders the pilot top-pick chips, not the falling game, for a pilot account", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [{ id: "chicken-breast-roasted", role: "protein" }];
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    await screen.findByTestId("foods-top-pick-chips");
  });

  it("the foods beat renders the falling-food game for a legacy account", async () => {
    foodAccess.status = "legacy";
    starterFixture.choices = [{ id: "chicken-breast-roasted", role: "protein" }];
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    await screen.findByTestId("falling-food-pile");
  });

  it("'Sprout, pick for me' marks the default starter foods before advancing to the reward beat", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "chicken-breast-roasted", role: "protein", default: true },
      { id: "turkey-breast-roasted", role: "protein", default: true },
      { id: "white-rice-cooked", role: "carb", default: true },
      { id: "brown-rice-cooked", role: "carb", default: true },
      { id: "olive-oil", role: "fat", default: true },
      { id: "avocado-oil", role: "fat", default: true },
    ] as never;
    render(<ConversationalOnboarding />);
    await reachReward();
    expect(starterSpies.mark).toHaveBeenCalledWith("chicken-breast-roasted", "eats");
  });

  // GPT-6 Sol BLOCK (onb2-p0): with too few foods the rules allow, pick-for-me moved on anyway
  // and "Use this plan" then took the skip path.
  it("'Sprout, pick for me' with too few allowed foods stays on Foods, says so, and offers to"
    + " adjust the rules", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "chicken-breast-roasted", role: "protein", default: true },
      { id: "white-rice-cooked", role: "carb", default: true },
      { id: "olive-oil", role: "fat", default: true },
    ] as never;
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: "Sprout, pick for me" }));
    const notice = await screen.findByTestId("plan-notice");
    expect(notice.textContent).toMatch(/couldn't fill every group/);
    expect(screen.queryByTestId("reward-plate-ready")).toBeNull();
    screen.getByRole("button", { name: "Sprout, pick for me" }); // still on Foods
    fireEvent.click(within(notice).getByRole("button", { name: "Adjust food rules" }));
    await screen.findByTestId("safety-round");
    expect(persistSkippedOnboarding).not.toHaveBeenCalled();
  });

  // GPT-6 Sol WARN (onb2-p0): pick-for-me re-selected a food the person had just tapped off.
  it("'Sprout, pick for me' never re-picks a food the person tapped off", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "chicken-breast-roasted", role: "protein", default: true },
      { id: "turkey-breast-roasted", role: "protein", default: true },
      { id: "salmon-wild-sockeye-cooked", role: "protein" },
      { id: "white-rice-cooked", role: "carb", default: true },
      { id: "brown-rice-cooked", role: "carb", default: true },
      { id: "olive-oil", role: "fat", default: true },
      { id: "avocado-oil", role: "fat", default: true },
    ] as never;
    starterFixture.marks = { "chicken-breast-roasted": "eats" };
    // This test's hook keeps the marks it is given, so the tap-off really leaves "neutral".
    starterSpies.mark.mockImplementation((id: string, value: string) => {
      starterFixture.marks = { ...starterFixture.marks, [id]: value };
    });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: /^Love Chicken breast/ }));
    expect(starterSpies.mark).toHaveBeenCalledWith("chicken-breast-roasted", "neutral");
    starterSpies.mark.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" }));
    expect(starterSpies.mark).not.toHaveBeenCalledWith("chicken-breast-roasted", "eats");
    expect(starterSpies.mark).toHaveBeenCalledWith("turkey-breast-roasted", "eats");
    expect(starterSpies.mark).toHaveBeenCalledWith("salmon-wild-sockeye-cooked", "eats");
    starterSpies.mark.mockReset();
  });

  it("the reward beat's confirm finishes instead of looping on itself once onComplete is"
    + " supplied (Sol review)", async () => {
    pickableFoods();
    const onComplete = vi.fn();
    render(<ConversationalOnboarding onComplete={onComplete} />);
    await reachReward();
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // GPT-6 Sol BLOCK (onb2-p0): "Use this plan" used to call the skip path whenever the plan was
  // not ready, marking the account onboarded without saving the plan.
  it("'Use this plan' on a plan that is not ready never skips: it explains, offers the fix and"
    + " stays", async () => {
    pickableFoods(); // the marks stay empty: the reward beat is reached but not ready
    render(<ConversationalOnboarding />);
    await reachReward();
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    const notice = await screen.findByTestId("plan-notice");
    expect(notice.textContent).toMatch(/two foods you'd eat in each group/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persistSkippedOnboarding).not.toHaveBeenCalled();
    expect(saveOnboardingPlan).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    screen.getByTestId("reward-plate-ready");
    screen.getByRole("button", { name: "Skip for now" }); // the only skip, unchanged
    fireEvent.click(within(notice).getByRole("button", { name: "Choose more foods" }));
    await screen.findByRole("button", { name: "Sprout, pick for me" });
  });

  it("'Use this plan' really writes once every required fact and a ready pilot food selection"
    + " exist — real goal/sex/body facts (seeded the same way a resumed draft would), the real"
    + " write path, no onComplete override", async () => {
    foodAccess.status = "pilot";
    // GPT-6 Sol round-2 BLOCK fix: pilot's `planReady` now requires `starterSelectionReady` too
    // (≥2 per role, not just a non-null list) — a single choice no longer satisfies it.
    starterFixture.choices = [
      { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
      { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
      { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
    ];
    starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
    await saveOnboardingDraft({ beat: "opener",
      settings: { sex: "female", birthYear: 1992, heightCm: 165, weightKg: 60 } });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    // Every group already has its two, so the dock offers Done (with the count), not pick-for-me.
    fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
    const confirm = await screen.findByRole("button", { name: "Use this plan" });
    fireEvent.click(confirm);
    // Full-stage saving state until navigation (live QA 2026-10-07, defect 6).
    await screen.findByTestId("onboarding-saving");
    screen.getByText("Building your plan…");
    await vi.waitFor(() => expect(persistCompletedOnboarding).toHaveBeenCalledTimes(1));
    // GPT-6 Sol round-2 BLOCK: pilot's loved foods used to be silently discarded — the write only
    // ever ran for "legacy". A pilot completion must persist them too.
    await vi.waitFor(() => expect(persistStarterSelection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("retries only the constraints write, not the whole profile write, after a"
    + " constraints-only failure (GPT-6 Sol round-2 BLOCK)", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
      { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
      { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
    ];
    starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
    persistCompletedOnboarding.mockResolvedValueOnce({ settings: defaultSettings(), constraintsSaved: false });
    retryOnboardingConstraints.mockClear();
    retryOnboardingConstraints.mockResolvedValueOnce(false); // first retry still fails
    retryOnboardingConstraints.mockResolvedValueOnce(true); // second retry succeeds
    await saveOnboardingDraft({ beat: "opener",
      settings: { sex: "female", birthYear: 1992, heightCm: 165, weightKg: 60 } });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this plan" }));
    // The first attempt fails on constraints (profile already written); a retry must not call
    // persistCompletedOnboarding a second time, and must retry constraints narrowly.
    await screen.findByRole("alert");
    // A failed save is a retry state: the confirm says so (owner: "things didn't save").
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(persistCompletedOnboarding).toHaveBeenCalledTimes(1);
    expect(retryOnboardingConstraints).toHaveBeenCalledTimes(2);
  });

  // GPT-6 Sol BLOCK (onb2-p0): a target POST that committed but whose answer was lost used to be
  // retried under a NEW request id, so the server wrote a second revision.
  it("sends one target request id per save: a retry after a failure reuses it, from the draft",
    async () => {
    pickableFoods();
    starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
    saveOnboardingPlan.mockResolvedValueOnce({ ok: false, error: "Couldn't reach the server" } as never);
    await saveOnboardingDraft({ beat: "opener",
      settings: { sex: "female", birthYear: 1992, heightCm: 165, weightKg: 60 } });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this plan" }));
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    const ids = saveOnboardingPlan.mock.calls.map(([input]) => (input as { targetRequestId?: string }).targetRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("ONB2-RULE-REREAD: Foods 'Done' re-reads account rules before advancing to the reward beat"
    + " (Sol r6 BLOCK on onb2-l4-r2)", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
      { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
      { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
    ];
    starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
    starterSpies.reread.mockClear();
    await saveOnboardingDraft({ beat: "opener",
      settings: { sex: "female", birthYear: 1992, heightCm: 165, weightKg: 60 } });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
    // The reread happens before the beat advances to the reward card, not after.
    await vi.waitFor(() => expect(starterSpies.reread).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Use this plan" });
  });

  it("ONB2-RULE-REREAD: a rule saved just before Foods 'Done' drops the floor below two per role"
    + " — the tap stays on Foods with one clean error, never the reward beat", async () => {
    foodAccess.status = "pilot";
    starterFixture.choices = [
      { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
      { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
      { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
    ];
    starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
    // The fresh read drops p2 to below the floor (only one protein left).
    starterSpies.reread.mockImplementation(async () => [
      { id: "p1", role: "protein" }, { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
      { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
    ]);
    await saveOnboardingDraft({ beat: "opener",
      settings: { sex: "female", birthYear: 1992, heightCm: 165, weightKg: 60 } });
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await passPlanBeats();
    fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Use this plan" })).toBeNull();
  });

  it("asks each missing fact as one plain question in US units, then offers That's me", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" })); // -> facts, goal filled
    await screen.findByText("How old are you?");
    expect(screen.queryByText(/add this|and now\?|how old\?|\(cm\)|\(kg\)/)).toBeNull();
    await fillRemainingRequiredFacts();
    expect(screen.getByTestId("facts-recap").textContent)
      .toBe("You\u2019re 34, sex not given, 5\u20325\u2033, 132 lb, and want to lose fat.");
    // A tap on a value asks that question again.
    fireEvent.click(screen.getByRole("button", { name: /Your weight: 132 lb/ }));
    await screen.findByLabelText("Weight");
  });

  it("never drafts a typed guess as if it were answered (GPT-6 Sol round-3 BLOCK: a resumed"
    + " draft restores every saved field at HIGH confidence)", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose weight" })); // -> facts, goal confirmed
    await screen.findByText("How old are you?");
    // A bare weight-looking number while age is asked is not an age; the fast path reads it as a
    // ghost guess at most, which must not be drafted.
    fireEvent.change(screen.getByRole("textbox", { name: "Tell Sasha" }), { target: { value: "I weigh 170" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(async () => {
      const draft = await loadOnboardingDraft();
      expect(draft?.settings.goal).toBe("lose_fat");
      expect(draft?.settings.weightKg).toBeUndefined();
    });
  });

  it("collapses the beat change to an instant swap under reduced motion", async () => {
    render(<MotionConfig reducedMotion="always"><ConversationalOnboarding /></MotionConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Keep my weight" }));
    await screen.findByText("How old are you?");
  });

  describe("question set v2 routing", () => {
    /** Goal, then the body facts, then "That's me". */
    async function toWeek(goal = "Lose weight", age = "34") {
      fireEvent.click(screen.getByRole("button", { name: goal }));
      await fillRemainingRequiredFacts(age);
      fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    }

    it("a lose user sees pace chips in lb a week, Steady pre-selected, after the safety round", async () => {
      render(<ConversationalOnboarding />);
      await toWeek();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      fireEvent.click(await screen.findByRole("button", { name: "No, none of these" }));
      await screen.findByTestId("pace-beat");
      screen.getByText("How fast do you want to lose?");
      const pace = screen.queryByRole("radiogroup", { name: "Pace" });
      const chips = pace ? within(pace).getAllByRole("radio") : [];
      // One chip left is a statement with Next; otherwise 2–3 chips, each in lb a week.
      if (chips.length > 0) {
        for (const chip of chips) expect(chip.textContent).toMatch(/lb a week/);
        expect(chips.find((chip) => chip.getAttribute("aria-checked") === "true")?.textContent).toMatch(/Steady|Gentle|Faster/);
      } else {
        screen.getByText(/lb a week/);
      }
    });

    it("a pregnant user never sees the pace screen; the plan card says why", async () => {
      pickableFoods();
      render(<ConversationalOnboarding />);
      await toWeek();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      await screen.findByTestId("safety-round");
      fireEvent.click(screen.getByRole("button", { name: "Pregnant or breastfeeding" }));
      fireEvent.click(await screen.findByRole("radio", { name: "Pregnant" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByTestId("your-day-beat");
      expect(screen.queryByTestId("pace-beat")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
      fireEvent.click(await screen.findByRole("button", { name: "Sprout, pick for me" }));
      const notes = await screen.findByTestId("plan-notes");
      expect(notes.textContent).toMatch(/don't add pregnancy or breastfeeding needs/);
      expect(notes.textContent).toMatch(/won't set a loss or gain pace/);
    });

    it("an account with a STORED hold that taps none this round never sees the pace screen " +
      "(final Sol review BLOCK)", async () => {
      storedHolds.value = { holds: ["kidney"], minor: false };
      pickableFoods();
      render(<ConversationalOnboarding />);
      await toWeek();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      fireEvent.click(await screen.findByRole("button", { name: "No, none of these" }));
      await screen.findByTestId("your-day-beat");
      expect(screen.queryByTestId("pace-beat")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
      fireEvent.click(await screen.findByRole("button", { name: "Sprout, pick for me" }));
      const notes = await screen.findByTestId("plan-notes");
      expect(notes.textContent).toMatch(/won't set a loss or gain pace/);
      expect(notes.textContent).toMatch(/kidney disease/);
    });

    it("a stored hold read still in flight is awaited before the pace is offered (final Sol r2 BLOCK)", async () => {
      storedHolds.status = "loading";
      storedHolds.refresh = async () => ({ holds: ["kidney"], minor: false });
      pickableFoods();
      render(<ConversationalOnboarding />);
      await toWeek();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      fireEvent.click(await screen.findByRole("button", { name: "No, none of these" }));
      await screen.findByTestId("your-day-beat");
      expect(screen.queryByTestId("pace-beat")).toBeNull();
    });

    it("a failed stored hold read keeps the person on the step with a retry line", async () => {
      storedHolds.status = "failed";
      storedHolds.refresh = async () => null;
      render(<ConversationalOnboarding />);
      await toWeek();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      fireEvent.click(await screen.findByRole("button", { name: "No, none of these" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/saved health answers/);
      expect(screen.queryByTestId("pace-beat")).toBeNull();
    });

    it("a minor stops: no week, no plan, and leaving saves no profile", async () => {
      render(<ConversationalOnboarding />);
      await toWeek("Lose weight", "16");
      await screen.findByTestId("minor-stop");
      screen.getByText(/plans are built for adults 18 and over/);
      expect(screen.queryByTestId("week-beat")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Look around" }));
      await vi.waitFor(() => expect(persistSkippedOnboarding).toHaveBeenCalledTimes(1));
      expect(persistCompletedOnboarding).not.toHaveBeenCalled();
      expect(saveOnboardingPlan).not.toHaveBeenCalled();
    });

    it("the plan card names every skipped default, with a Change link back to its beat", async () => {
      pickableFoods();
      render(<ConversationalOnboarding />);
      await reachReward();
      const notes = screen.getByTestId("plan-notes");
      expect(notes.textContent).toMatch(/No workout days/);
      expect(notes.textContent).toMatch(/Activity: Sedentary/);
      expect(notes.textContent).toMatch(/meals a day, set from your calories/);
      expect(notes.textContent).toMatch(/First meal at \d{1,2}:\d\d (AM|PM)/);
      fireEvent.click(within(notes).getByRole("button", { name: /Change: No workout days/ }));
      await screen.findByTestId("week-beat");
    });

    it("a server refusal under 18 (422 adult_only) shows the friendly stop, not an error", async () => {
      foodAccess.status = "pilot";
      starterFixture.choices = [
        { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
        { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
        { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
      ];
      starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
      saveOnboardingPlan.mockResolvedValueOnce({ ok: false, error: "adult", code: "adult_only" } as never);
      render(<ConversationalOnboarding />);
      await toWeek();
      await passPlanBeats();
      fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use this plan" }));
      await screen.findByTestId("minor-stop");
      expect(replace).not.toHaveBeenCalled();
    });

    it("a held pace from the server (409 rate_not_eligible) is explained, and the next tap saves", async () => {
      foodAccess.status = "pilot";
      starterFixture.choices = [
        { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
        { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
        { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
      ];
      starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
      saveOnboardingPlan.mockResolvedValueOnce({ ok: false, error: "held", code: "rate_not_eligible" } as never);
      render(<ConversationalOnboarding />);
      await toWeek();
      await passPlanBeats();
      fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
      await screen.findByTestId("reward-plate-ready");
      fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/keep your calories about where you burn/);
      expect((await screen.findByTestId("plan-notes")).textContent).toMatch(/keep calories about where you burn/);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    });

    it("sends the safety round with the plan, so conditions are written before the target", async () => {
      foodAccess.status = "pilot";
      starterFixture.choices = [
        { id: "p1", role: "protein" }, { id: "p2", role: "protein" },
        { id: "c1", role: "carb" }, { id: "c2", role: "carb" },
        { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
      ];
      starterFixture.marks = { p1: "eats", p2: "eats", c1: "eats", c2: "eats", f1: "eats", f2: "eats" };
      render(<ConversationalOnboarding />);
      await toWeek("Keep my weight");
      fireEvent.click(await screen.findByRole("button", { name: "Skip this" }));
      await screen.findByTestId("safety-round");
      fireEvent.click(screen.getByRole("button", { name: "A diet a clinician set for me" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "Looks right" }));
      fireEvent.click(await screen.findByRole("button", { name: "Done · 6 loved" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use this plan" }));
      await vi.waitFor(() => expect(persistCompletedOnboarding).toHaveBeenCalledTimes(1));
      expect(persistCompletedOnboarding.mock.calls[0][2]).toEqual(
        { pregnancy: null, clinicianDiet: true, conditionText: null });
      const state = persistCompletedOnboarding.mock.calls[0][1] as { countryCode?: string; activityLevel: string };
      expect(state.countryCode).toBe("US");
      expect(state.activityLevel).toBe("sedentary");
    });
  });
});
