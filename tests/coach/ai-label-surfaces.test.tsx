// @vitest-environment jsdom
/**
 * Where the AI label shows (PR #373 provenance): once per item on an assistant bubble, a suggestion
 * card and a capture review; never on app-written content or a legacy row that carries none.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachComposedCard from "@/components/CoachComposedCard";
import CoachMessage from "@/components/CoachMessage";
import LogDraftBlock from "@/components/coach/blocks/log_draft";
import type { LogDraftBlockContext, LogDraftBlockV1 } from "@/components/coach/blocks";
import IdeaCard from "@/components/plan/IdeaCard";
import FoodIdeasBlock from "@/components/coach/blocks/food_ideas";
import type { CoachBlockContext } from "@/components/coach/blocks/context";
import PanelReview from "@/components/plan/PanelReview";
import { DocumentOther } from "@/components/plan/DocumentPlan";
import { footerMeals } from "@/components/coach/ShellComposedCards";
import type { CoachShellMessage } from "@/components/coach/attachments/shell-state";
import type { ComposedMeal } from "@/lib/coach/compose";
import { BY_APP, byJev, byModel } from "@/lib/provenance";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const labels = (root: ParentNode = document) => Array.from(root.querySelectorAll("[data-ai-label]"))
  .map((node) => node.getAttribute("data-ai-label"));

const MEAL: ComposedMeal = {
  wish: "Salmon and rice", slot: "meal-2",
  items: [{ foodRefId: "r1", name: "Salmon", grams: 140 },
    { foodRefId: "r2", name: "Rice", grams: 180 }] as ComposedMeal["items"],
  totals: { kcal: 520, protein: 38, carbs: 50, fat: 16 },
  target: { kcal: 650, protein: 45, carbs: 65, fat: 18 },
  flagged: [], fitsTarget: true,
} as ComposedMeal;

describe("the assistant bubble", () => {
  it("carries one AI label at its foot when a model wrote it", () => {
    render(<CoachMessage role="assistant" content="Here is a lunch idea." provenance={byModel()} />);
    expect(labels()).toEqual(["model"]);
    expect(screen.getByText("Written by AI")).toBeTruthy();
  });

  it("carries none without provenance, for app-written replies, or on the user's own bubble", () => {
    render(<>
      <CoachMessage role="assistant" content="Legacy reply" />
      <CoachMessage role="assistant" content="Deflected" provenance={BY_APP} />
      <CoachMessage role="user" content="Mine" provenance={byModel()} />
    </>);
    expect(labels()).toEqual([]);
  });
});

describe("suggestion cards", () => {
  it("a Jev-ranked coach card says AI ranked once; a fit-ordered card says nothing", () => {
    const { container: ranked } = render(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, rankNote: "fits 92 %, natural meal", provenance: byJev("suggest-options") }} />);
    expect(labels(ranked)).toEqual(["jev"]);
    const { container: fit } = render(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, rankNote: "fits 92 %", provenance: BY_APP }} provenance={byModel()} />);
    expect(labels(fit)).toEqual([]);
  });

  it("a compose_meal card with no provenance of its own takes its turn's", () => {
    const { container } = render(<CoachComposedCard tz="UTC" onAction={() => {}} meal={MEAL}
      provenance={byModel()} />);
    expect(labels(container)).toEqual(["model"]);
  });

  it("a ranked card that cannot say how it was ranked claims nothing, even under a model turn", () => {
    const { container: unstamped } = render(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, rankNote: "a good fit" }} provenance={byModel()} />);
    expect(labels(unstamped)).toEqual([]);
    const { container: fitNote } = render(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, rankNote: "fits 92 %" }} provenance={byModel()} />);
    expect(labels(fitNote)).toEqual([]);
    const { container: jevNote } = render(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, rankNote: "fits 92 %, natural meal" }} />);
    expect(labels(jevNote)).toEqual(["jev"]);
  });

  it("the Plan sheet's idea card: jev vs app", () => {
    const props = { label: "Meal 2", busy: false, placing: false, onPlace: () => {}, onSkip: () => {} };
    const { container: ranked } = render(<IdeaCard {...props} meal={{ ...MEAL, provenance: byJev("suggest-options") }} />);
    expect(labels(ranked)).toEqual(["jev"]);
    const { container: fit } = render(<IdeaCard {...props} meal={{ ...MEAL, provenance: BY_APP }} />);
    expect(labels(fit)).toEqual([]);
  });
});

describe("the capture review", () => {
  const at = { localDate: "2026-10-04", tz: "UTC", eatenAt: new Date("2026-10-04T12:00:00Z") };
  const review = (draft: typeof captureProposal) => render(<MotionConfig reducedMotion="always">
    <PanelReview pending={{ draft, slot: "meal-2", at }} label="Meal 2"
      onConfirm={async () => null} onCancel={() => {}} onDone={() => {}} />
  </MotionConfig>);

  it("the Plan panel's review is labelled for a model read, and not for a draft without provenance", () => {
    const { container } = review({ ...captureProposal, provenance: byModel("capture-photo") });
    expect(labels(container)).toEqual(["model"]);
    cleanup();
    const { container: legacy } = review(captureProposal);
    expect(labels(legacy)).toEqual([]);
  });

  const ctx: LogDraftBlockContext = {
    tz: "UTC", onBlockStatus: vi.fn(), onSearchManually: vi.fn(), rerunAsLabel: vi.fn(),
  };
  const block: LogDraftBlockV1 = {
    kind: "log_draft", v: 1, id: "b1", source: "barcode", localDate: "2026-10-04", slot: "meal-2",
    draft: barcodeResponse, policy: { blocked: false }, status: "pending",
  };

  it("a coach log draft: a capture read says AI, a barcode match says nothing", () => {
    const { container: capture } = render(<LogDraftBlock ctx={ctx}
      block={{ ...block, id: "b2", source: "capture", draft: captureProposal,
        provenance: byModel() }} />);
    expect(labels(capture)).toEqual(["model"]);
    const { container: barcode } = render(<LogDraftBlock ctx={ctx}
      block={{ ...block, provenance: BY_APP }} />);
    expect(labels(barcode)).toEqual([]);
  });
});

describe("each live meal card renders once", () => {
  const reply = (blocks: CoachShellMessage["blocks"]): CoachShellMessage =>
    ({ id: "m1", role: "assistant", content: "Ideas", seq: 2, blocks, provenance: byModel() });
  const other = { ...MEAL, wish: "Eggs and toast" };

  it("skips a composed meal the reply already shows as a food_ideas card, and keeps the rest", () => {
    const shown = reply([{ kind: "food_ideas", v: 1, id: "b1", ideas: [{ ...MEAL }] }]);
    expect(footerMeals([MEAL, other], shown, true)).toEqual([{ meal: other, index: 1 }]);
  });

  it("the food_ideas card takes its message's provenance, once", () => {
    const ctx = { tz: "UTC", provenance: byModel(), applyAction: vi.fn(), sendText: vi.fn() } as unknown as CoachBlockContext;
    const { container } = render(<FoodIdeasBlock ctx={ctx}
      block={{ kind: "food_ideas", v: 1, id: "b1", ideas: [{ ...MEAL }] }} />);
    expect(labels(container)).toEqual(["model"]);
  });

  it("keeps every composed meal when no food_ideas block carries it, or when blocks are not drawn", () => {
    expect(footerMeals([MEAL, other], reply([]), true).map(({ index }) => index)).toEqual([0, 1]);
    const shown = reply([{ kind: "food_ideas", v: 1, id: "b1", ideas: [{ ...MEAL }] }]);
    expect(footerMeals([MEAL], shown, false)).toEqual([{ meal: MEAL, index: 0 }]);
  });
});

describe("the remaining model reads", () => {
  it("a document with nothing usable says AI for a model read and nothing for the app", () => {
    const { container } = render(<DocumentOther provenance={byModel("plan-document")} />);
    expect(labels(container)).toEqual(["model"]);
    const { container: app } = render(<DocumentOther provenance={BY_APP} />);
    expect(labels(app)).toEqual([]);
  });

  it("a Jev intent fast path (a templated reply or a chart from logs) carries no label", () => {
    render(<>
      <CoachMessage role="assistant" content="Here is your week." provenance={byJev("coach-intent")} />
      <CoachMessage role="assistant" content="Moving lunch." provenance={byJev()} />
    </>);
    expect(labels()).toEqual([]);
  });
});
