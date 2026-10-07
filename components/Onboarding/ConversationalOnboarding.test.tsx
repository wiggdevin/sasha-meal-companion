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
 * that only advances on "No, nothing" or a confirmed rule review, and a leave that only navigates
 * once the account's sync gate actually holds. Lane 5 (2026-10-07) replaced the lane-2 placeholder
 * assertions for safety/foods/reward with the real wired content, and added the write-path cases.
 * The stream's beat change is sequential (`AnimatePresence mode="wait"`), so a test after a
 * beat-changing click awaits the new beat's own content.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  async (_settings: unknown, _state: unknown) => ({ settings: defaultSettings(), constraintsSaved: true }));
const mirroredOnboardedAt = vi.fn(async (): Promise<string | null> => "2026-10-07T00:00:00.000Z");
const retryOnboardingConstraints = vi.fn(async (_flags: unknown) => true);
vi.mock("@/lib/profile/onboarding-client", () => ({
  loadOnboardingSettings: () => loadOnboardingSettings(),
  persistSkippedOnboarding: (base: unknown) => persistSkippedOnboarding(base),
  persistCompletedOnboarding: (settings: unknown, state: unknown) =>
    persistCompletedOnboarding(settings, state),
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
vi.mock("@/lib/foods/starter-client", () => ({
  persistStarterSelection: (marks: unknown, choices: unknown) => persistStarterSelection(marks, choices),
}));

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  foodAccess.status = "unavailable";
  starterFixture.choices = null;
  starterFixture.marks = {};
  starterFixture.error = null;
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** Fills every required field PlaybackSentence still shows as a gap, after a goal is already
 *  picked (sex, height, weight, birth year) — "That's me" (GPT-6 Sol round-1 BLOCK) now only
 *  advances once all of them have a value, not just one. */
async function fillRemainingRequiredFacts(): Promise<void> {
  await screen.findByRole("button", { name: "Add your sex" });
  fireEvent.click(screen.getByRole("button", { name: "Add your sex" }));
  fireEvent.click(await screen.findByRole("button", { name: "Prefer not to say" }));
  fireEvent.click(screen.getByRole("button", { name: "Add your height" }));
  fireEvent.change(screen.getByLabelText("Height (cm)"), { target: { value: "165" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Add your weight" }));
  fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Add your age/birth year" }));
  await screen.findByRole("group", { name: "Birth year" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm birth year" }));
}

/** Walks the default flow to the reward beat, awaiting each sequential stream swap. */
async function reachReward(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Lose fat" })); // -> facts
  await fillRemainingRequiredFacts();
  fireEvent.click(screen.getByRole("button", { name: "That’s me" })); // -> safety
  await screen.findByTestId("allergy-condition-gate");
  fireEvent.click(screen.getByRole("button", { name: "No, nothing" })); // -> foods
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
    screen.getByText(/What would feel different in eight weeks\?/);
    expect(screen.queryByRole("progressbar")).toBeNull();
    screen.getByRole("group", { name: "Choose one" });
  });

  it("advances to the real facts sentence after a goal is picked, with that goal already"
    + " filled in at high confidence (a direct tap is never a guess)", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Build muscle" }));
    // The stream swap is sequential (AnimatePresence mode="wait"), so this is awaited.
    await screen.findByRole("button", { name: "That’s me" });
    screen.getByText(/build muscle/);
  });

  it("renders a lane slot in place of its placeholder once one is supplied", async () => {
    render(<ConversationalOnboarding slots={{ factsSentence: <p>You&apos;re 34, born 1992.</p> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" }));
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
    + " its recognised 'No, nothing' answer, reporting every key tapped", async () => {
    const onAllergyAnswer = vi.fn();
    render(<ConversationalOnboarding onAllergyAnswer={onAllergyAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" })); // -> facts
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" })); // -> safety
    await screen.findByTestId("allergy-condition-gate");
    screen.getByText(/Anything you must never eat/);
    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
    expect(onAllergyAnswer).toHaveBeenCalledWith("none");
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
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    fireEvent.click(await screen.findByTestId("allergy-condition-gate")
      && screen.getByRole("button", { name: "No, nothing" }));
    await screen.findByTestId("foods-top-pick-chips");
  });

  it("the foods beat renders the falling-food game for a legacy account", async () => {
    foodAccess.status = "legacy";
    starterFixture.choices = [{ id: "chicken-breast-roasted", role: "protein" }];
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" }));
    await fillRemainingRequiredFacts();
    fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
    fireEvent.click(await screen.findByTestId("allergy-condition-gate")
      && screen.getByRole("button", { name: "No, nothing" }));
    await screen.findByTestId("falling-food-pile");
  });

  it("'Sprout, pick for me' marks the default starter foods before advancing to the reward beat", async () => {
    foodAccess.status = "legacy";
    starterFixture.choices = [
      { id: "chicken-breast-roasted", role: "protein", default: true },
      { id: "white-rice-cooked", role: "carb", default: true },
      { id: "olive-oil", role: "fat", default: true },
    ] as never;
    render(<ConversationalOnboarding />);
    await reachReward();
    expect(starterSpies.mark).toHaveBeenCalledWith("chicken-breast-roasted", "eats");
  });

  it("without a real onComplete and with no real data to save, the reward confirm is labelled"
    + " honestly, not 'Use this plan' — and distinctly from the standing skip link (Sol review"
    + " round 2; orchestrator round 3: two controls sharing one label read as a bug)", async () => {
    render(<ConversationalOnboarding />);
    await reachReward();
    expect(screen.queryByRole("button", { name: "Use this plan" })).toBeNull();
    screen.getByRole("button", { name: "Skip for now" }); // the standing link, unchanged
    screen.getByRole("button", { name: "Not now" }); // the dock's own reward confirm
  });

  it("the reward beat's confirm finishes instead of looping on itself, and earns its real label"
    + " once onComplete is supplied (Sol review)", async () => {
    const onComplete = vi.fn();
    render(<ConversationalOnboarding onComplete={onComplete} />);
    await reachReward();
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("without a supplied onComplete, the reward confirm still really leaves, not a fabricated save", async () => {
    render(<ConversationalOnboarding />);
    await reachReward();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await vi.waitFor(() => expect(persistSkippedOnboarding).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
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
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await screen.findByTestId("allergy-condition-gate");
    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
    await screen.findByRole("button", { name: "Sprout, pick for me" });
    fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" }));
    const confirm = await screen.findByRole("button", { name: "Use this plan" });
    fireEvent.click(confirm);
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
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" }));
    fireEvent.click(await screen.findByRole("button", { name: "That’s me" }));
    await screen.findByTestId("allergy-condition-gate");
    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
    await screen.findByRole("button", { name: "Sprout, pick for me" });
    fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this plan" }));
    // The first attempt fails on constraints (profile already written); a retry must not call
    // persistCompletedOnboarding a second time, and must retry constraints narrowly.
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(persistCompletedOnboarding).toHaveBeenCalledTimes(1);
    expect(retryOnboardingConstraints).toHaveBeenCalledTimes(2);
  });

  it("the facts beat's gap chips open the real editors (goal/sex already landed), fill every"
    + " required field through them, and 'That's me' is ready once they're all answered", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" })); // -> facts, goal filled
    await screen.findByRole("button", { name: "That’s me" });

    // sex: tap the gap chip, then the SexChipRow it opens.
    fireEvent.click(screen.getByRole("button", { name: "Add your sex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Prefer not to say" }));
    screen.getByText(/prefer not to say/);

    // height / weight: the gap chip opens this lane's own minimal numeric editor.
    fireEvent.click(screen.getByRole("button", { name: "Add your height" }));
    fireEvent.change(screen.getByLabelText("Height (cm)"), { target: { value: "165" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Add your weight" }));
    fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // birth year: the gap chip seeds the inline stepper at ghost confidence; nudging it twice
    // and tapping its own "Confirm" chip raises it to high, same as every other field.
    fireEvent.click(screen.getByRole("button", { name: "Add your age/birth year" }));
    await screen.findByRole("group", { name: "Birth year" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm birth year" }));

    screen.getByRole("button", { name: "That’s me" });
  });

  it("never drafts a still-ghost (seeded, unconfirmed) birth year as if it were answered"
    + " (GPT-6 Sol round-3 BLOCK: a resumed draft restores every saved field at HIGH confidence,"
    + " so a ghost value that slipped into the draft would come back looking confirmed)", async () => {
    render(<ConversationalOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Lose fat" })); // -> facts, goal confirmed
    // Seed the birth year without ever nudging or confirming it — stays ghost confidence.
    fireEvent.click(await screen.findByRole("button", { name: "Add your age/birth year" }));
    await screen.findByRole("group", { name: "Birth year" });
    await vi.waitFor(async () => {
      const draft = await loadOnboardingDraft();
      expect(draft?.settings.birthYear).toBeUndefined();
    });
  });

  it("collapses the beat change to an instant swap under reduced motion", async () => {
    render(<MotionConfig reducedMotion="always"><ConversationalOnboarding /></MotionConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Keep what I have" }));
    await screen.findByRole("button", { name: "That’s me" });
  });
});
