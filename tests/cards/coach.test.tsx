// @vitest-environment jsdom
/**
 * Design §8.3 — the render spec for every state the coach's cards support: the unavailable card,
 * a turn failed, a message pending, the action card's five statuses plus the forward-compatible
 * unknown kind (§8.5), the composed card empty / fitting / missing the slot, and the suggestion
 * card blocked, unverified and allowed.
 *
 * Static renders, except the one state that needs a press: the weigh-in box only says a number
 * is invalid after a submit, so this file runs in jsdom and that one state is typed. The other
 * interactive halves of the coach — the composer, the shell and the draft editors — keep their own
 * specs under `tests/coach/`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import CoachScreen from "@/app/coach/CoachScreen";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import CoachActionCard, { type CoachActionStatus } from "@/components/CoachActionCard";
import CoachComposedCard, { FIT_FALLBACK } from "@/components/CoachComposedCard";
import CoachMessage from "@/components/CoachMessage";
import CoachSuggestions from "@/components/CoachSuggestions";
import { CoachErrorNotice } from "@/components/coach/CoachShell";
import SanityNotices from "@/components/coach/editors/SanityNotices";
import WeighInField from "@/components/coach/attachments/WeighInField";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { CoachSuggestion } from "@/lib/coach/types";
import type { SanityAnnotation } from "@/lib/log/sanity-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: () => {}, push: () => {}, replace: () => {} }),
}));

const ACTION = {
  kind: "log_water", ml: 250, actionId: "a-1", flagged: [],
} as unknown as CoachAction;

const MEAL: ComposedMeal = {
  wish: "something with chicken", slot: "meal-2",
  items: [{ foodRefId: "r1", name: "Chicken", grams: 150 },
    { foodRefId: "r2", name: "Rice", grams: 180 }] as ComposedMeal["items"],
  totals: { kcal: 620, protein: 48, carbs: 62, fat: 14 },
  target: { kcal: 650, protein: 45, carbs: 65, fat: 18 },
  flagged: [], fitsTarget: true,
};

const suggestion = (over: Partial<CoachSuggestion>): CoachSuggestion => ({
  foodRefId: "r1", name: "Greek yoghurt", grams: 170, reason: null, verdict: "allowed", ...over });

function card(status: CoachActionStatus, action: CoachAction = ACTION): string {
  return renderToStaticMarkup(<CoachActionCard action={action} status={status} canUndo
    onRetry={() => {}} onUndo={() => {}} />);
}

/** The screen, rendered on one capability answer. No effect runs, so no client is reached. */
function coachScreen(coach: boolean): string {
  return renderToStaticMarkup(
    <CapabilitiesProvider value={{ coach, scan: false, captureMethods: [] }}>
      <CoachScreen />
    </CapabilitiesProvider>);
}

describe("the coach-unavailable card", () => {
  it("says so once, with no retry button to press in vain", () => {
    const markup = coachScreen(false);
    expect(markup).toContain("Sasha is unavailable right now. Try again in a minute.");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("Retry loading");
  });

  it("gives way to the conversation once the coach is available", () => {
    const markup = coachScreen(true);
    expect(markup).not.toContain("Sasha is unavailable right now");
    expect(markup).toContain("Loading your conversation…");
  });
});

/* The sentence `lib/server/coach-turn/model-loop.ts` sends when generation fails, verbatim. */
const TURN_FAILED = "Sasha is unavailable right now. Try again in a minute.";

/** The notice CoachShell renders in its transcript footer after a failed turn. */
function turnFailed(retryable = true): string {
  return renderToStaticMarkup(
    <CoachErrorNotice message={TURN_FAILED} retryable={retryable} onRetry={() => {}} />);
}

describe("the turn-failure notice", () => {
  /*
   * The walkthrough's baseline screenshot: 12 px grey text flush against the left viewport edge on
   * the dark ground, with a faint underlined "Try again" — unreadable. R5 wants the padded light
   * surface the coach's other blocks use, in the app's own tokens.
   */
  it("renders a turn failed as a light notice card, not grey text on the bare ground", () => {
    const markup = turnFailed();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(TURN_FAILED);
    expect(markup).toMatch(/class="[^"]*\bnotice\b[^"]*"/);
    expect(markup).toContain('data-tone="error"');
    const body = /<p\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(body).toContain("text-caption");
    expect(body).not.toContain("color:");
  });

  it("offers Try again as a real 44 px button, not an underlined word", () => {
    const button = /<button[^>]*>Try again<\/button>/.exec(turnFailed())?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).toContain("min-h-11");
    expect(button).not.toContain("underline");
  });

  it("says what happened and offers no action when the turn cannot be retried", () => {
    const markup = turnFailed(false);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(TURN_FAILED);
    expect(markup).not.toContain("<button");
  });
});

describe("CoachMessage", () => {
  it("renders the text of both sides as inert characters, never markup", () => {
    const markup = renderToStaticMarkup(
      <CoachMessage role="assistant" content="Try <b>oats</b> https://x.test" />);
    expect(markup).toContain("&lt;b&gt;oats&lt;/b&gt;");
    expect(markup).not.toContain("<a ");
  });

  // 2026-10-04 (Kimi audit): a bubble on its way is the pale outline of the one it becomes, ink on
  // paper, never a 60 % fade that took the words under 4.5:1.
  it("marks a pending bubble without fading its words, and leaves a settled one alone", () => {
    const pending = renderToStaticMarkup(
      <CoachMessage role="user" content="two eggs" pending />);
    const settled = renderToStaticMarkup(<CoachMessage role="user" content="two eggs" />);
    expect(pending).toContain('data-pending="true"');
    expect(pending).toContain("text-charcoal");
    expect(pending).not.toContain("opacity-60");
    expect(settled).not.toContain("data-pending");
    expect(settled).toContain("text-on-primary");
  });
});

describe("CoachActionCard", () => {
  it.each([
    ["pending", "Applying…"],
    ["applied", "Done"],
    ["failed", "Failed"],
    ["undoing", "Undoing…"],
    ["undone", "Undone"],
  ])("names the %s status on the card", (status, copy) => {
    expect(card(status as CoachActionStatus)).toContain(copy);
  });

  it("shows the assistant thinking while it applies, inside its one status line", () => {
    const pending = card("pending");
    expect(pending).toContain('data-thinking="compact"');
    expect(pending).not.toContain("animate-spin");
    expect(pending.match(/role="status"/g)).toHaveLength(1);
  });

  it("sets the calorie total of its macro strip in the shared calorie colour", () => {
    const food = { name: "chicken", grams: 150, foodRefId: "33333333-3333-4333-8333-333333333333",
      catalogFoodRevisionId: 77, kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
      verdict: "allowed" as const };
    const meal = { actionId: "m-1", kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [food], flagged: [] } as unknown as CoachAction;
    const markup = card("applied", meal);
    expect(markup).toContain('<span aria-hidden="true" class="font-semibold kcal">248</span>');
  });

  it("says what it is doing while it is pending, and what it did once applied", () => {
    expect(card("pending")).toContain("Logging 1 cup (8 oz) of water");
    expect(card("applied")).toContain("Logged 1 cup (8 oz) of water");
  });

  /* t23 #7/#8: a coach save whose nutrition could not be checked says so once, and an Undo that
     found the action already undone gets its own line instead of reading like a fresh Undo. */
  it("says nutrition was not checked on an applied save, and that an Undo was already done", () => {
    const UNCHECKED = "Saved. Nutrition not fully checked.";
    const ALREADY = "This was already undone.";
    const unchecked = renderToStaticMarkup(<CoachActionCard action={ACTION} status="applied" canUndo
      nutritionUnchecked onRetry={() => {}} onUndo={() => {}} />);
    expect(unchecked).toContain(UNCHECKED);
    expect(card("applied")).not.toContain(UNCHECKED);
    const already = renderToStaticMarkup(<CoachActionCard action={ACTION} status="undone" canUndo
      already onRetry={() => {}} onUndo={() => {}} />);
    expect(already).toContain(ALREADY);
    expect(card("undone")).not.toContain(ALREADY);
  });

  /* ApplyResult.notices: what a save left out (a recipe's refused ingredients) reaches its card. */
  it("shows each save notice as a muted line on the applied card, and only while applied", () => {
    const notices = ["Left out Peanuts: on your Avoid list.", "Left out Brie: not verified."];
    const at = (status: "applied" | "undone" | "pending") => renderToStaticMarkup(<CoachActionCard action={ACTION}
      status={status} canUndo notices={notices} onRetry={() => {}} onUndo={() => {}} />);
    for (const notice of notices) expect(at("applied")).toContain(notice);
    expect(at("undone")).not.toContain(notices[0]);
    expect(at("pending")).not.toContain(notices[0]);
  });

  it("offers Undo on an applied action, and a way back on one that failed", () => {
    expect(card("applied")).toContain("Undo");
    const failed = card("failed");
    expect(failed).toContain("That did not save.");
    expect(failed).toContain("Undo again");
  });

  /* Design §8.5 — a kind this build has no case for still gets an honest title. */
  it("titles an unknown kind rather than drawing a blank line", () => {
    const unknown = {
      kind: "rearrange_pantry", actionId: "a-2", flagged: [],
    } as unknown as CoachAction;
    expect(card("applied", unknown)).toContain("Updated your plan");
  });

  /* sol BLOCK (s2 round 3, deferred to t2b): an item the policy left unverified for missing or
     incomplete allergen evidence showed nothing on the card unless a preference flag was set. */
  const logged = (item: Partial<GroundedActionItem>) => ({ actionId: "a-3", kind: "log_meal",
    date: "2026-09-16", slot: "meal-2", flagged: [], items: [{ name: "Crackers", grams: 30,
      foodRefId: "r1", catalogFoodRevisionId: null, kcalPer100g: null, proteinPer100g: null,
      carbsPer100g: null, fatPer100g: null, verdict: "unverified", ...item }] }) as CoachAction;

  it("says to check the label on an item unverified for allergen evidence, with no preference",
    () => {
      expect(card("applied", logged({}))).toContain("Crackers: not verified. Check the label.");
      expect(card("applied", logged({ marks: [{ facet: "peanut", source: "floor",
        outcome: "unknown" }] }))).toContain("Crackers: not verified. Check the label.");
    });

  it("keeps the preference line for a preference gap, and stays quiet on an allowed item", () => {
    const preference = card("applied", logged({ sanity: { status: "unknown", warnings: [] },
      marks: [{ facet: "vegetarian", source: "jev", outcome: "unknown" }] }));
    expect(preference).toContain("We could not verify this food for your preferences.");
    expect(preference).not.toContain("Check the label.");
    expect(card("applied", logged({ verdict: "allowed" }))).not.toContain("Check the label.");
  });

  /* sol FIX (t2b review): any unverified item the preference line did not explain said "Check the
     label.", even when no label check could resolve it. Only a checkable allergen gap says so. */
  it("says to check the label only for a checkable allergen gap", () => {
    const quiet = (marks: GroundedActionItem["marks"]) =>
      expect(card("applied", logged({ marks }))).not.toContain("Check the label.");
    quiet([{ facet: "vegetarian", source: "jev", outcome: "unknown" }]);
    quiet([{ facet: "halal", source: "profile", outcome: "unknown" }]);
    quiet([{ facet: "tuna_mercury", source: "floor", outcome: "unknown" }]);
    quiet([{ facet: "peanut", source: "floor", outcome: "absent" }]);
    expect(card("applied", logged({ marks: [{ facet: "allergens", source: "ingredient",
      outcome: "unknown" }] }))).toContain("Crackers: not verified. Check the label.");
    expect(card("applied", logged({ marks: [{ facet: "vegetarian", source: "jev",
      outcome: "unknown" }, { facet: "sesame", source: "floor", outcome: "unknown" }] })))
      .toContain("Crackers: not verified. Check the label.");
  });
});

describe("CoachComposedCard", () => {
  it("renders nothing at all when the composer came back empty", () => {
    const markup = renderToStaticMarkup(
      <CoachComposedCard meal={{ ...MEAL, items: [] }} tz="UTC" onAction={() => {}} />);
    expect(markup).toBe("");
  });

  it("says the meal fits what is left when it does", () => {
    const markup = renderToStaticMarkup(
      <CoachComposedCard meal={MEAL} tz="UTC" onAction={() => {}} />);
    expect(markup).toContain("fits what is left");
    expect(markup).toContain('<span aria-hidden="true" class="font-semibold kcal">620</span>');
    expect(markup).not.toContain(FIT_FALLBACK);
  });

  it("says so in the warning colour when the meal misses the slot", () => {
    const markup = renderToStaticMarkup(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, fitsTarget: false, fitNote: "22 g over on protein" }} />);
    expect(markup).toContain("22 g over on protein");
    expect(markup).toContain('target <span class="kcal font-semibold tabular-nums">650</span> kcal');
  });

  it("falls back to one plain sentence when an older turn carries no fit note", () => {
    const markup = renderToStaticMarkup(<CoachComposedCard tz="UTC" onAction={() => {}}
      meal={{ ...MEAL, fitsTarget: false }} />);
    expect(markup).toContain(FIT_FALLBACK);
  });
});

describe("CoachSuggestions", () => {
  const list = (suggestions: CoachSuggestion[]) => renderToStaticMarkup(
    <CoachSuggestions suggestions={suggestions} draft={null} onOpenDraft={() => {}} />);

  it("strikes a blocked suggestion through and says why in plain words", () => {
    const markup = list([suggestion({ verdict: "blocked", reason: "allergen:dairy" })]);
    expect(markup).toContain("line-through");
    expect(markup).toContain("Contains dairy");
    expect(markup).not.toContain("Log this");
  });

  it("marks an unverified suggestion without blocking it", () => {
    const markup = list([suggestion({ verdict: "unverified" })]);
    expect(markup).toContain("Unverified");
    expect(markup).not.toContain("line-through");
  });

  it("offers Log this on an allowed suggestion whose own food is in the draft", () => {
    const withDraft = renderToStaticMarkup(
      <CoachSuggestions suggestions={[suggestion({})]} onOpenDraft={() => {}}
        draft={{ draftId: "d1", slot: "snack", items: [
          { foodRefId: "r1", name: "Greek yoghurt", grams: 170, catalogFoodRevisionId: null },
        ] } as never} />);
    expect(withDraft).toContain("Log this");
    expect(withDraft).toContain("Greek yoghurt");
  });

  it("renders the card allowed without a draft, minus a button that would open nothing", () => {
    const markup = list([suggestion({})]);
    expect(markup).toContain("Greek yoghurt");
    expect(markup).not.toContain("Log this");
    expect(markup).not.toContain("line-through");
  });
});

describe("SanityNotices", () => {
  const portion: SanityAnnotation = { status: "warn", warnings: [{ itemId: "i1",
    kind: "portion", level: "large", message: "large" }] };

  it("stays silent when the item carries no warning and no mark", () => {
    expect(renderToStaticMarkup(<SanityNotices sanity={undefined} grams={150}
      policy={{ verdict: "allowed", marks: [] }} />)).toBe("");
  });

  it("puts a portion warning on its own pill, in words rather than a level", () => {
    const markup = renderToStaticMarkup(<SanityNotices sanity={portion} grams={400}
      policy={{ verdict: "allowed", marks: [] }} />);
    expect(markup).toContain("Looks like a large portion for one serving.");
    expect(markup).not.toContain("large</span>");
  });

  it("says a food is not verified rather than passing it silently", () => {
    const markup = renderToStaticMarkup(
      <SanityNotices grams={150} sanity={{ status: "unknown", warnings: [] }}
        policy={{ verdict: "unverified",
          marks: [{ facet: "vegetarian", outcome: "unknown" }] }} />);
    expect(markup).toContain("We could not verify this food for your preferences.");
  });

  it("offers the typical serving beside a portion warning, and only with one", () => {
    const offered = renderToStaticMarkup(<SanityNotices sanity={portion} grams={400}
      policy={{ verdict: "allowed", marks: [] }}
      typicalServing={{ grams: 150, label: "1 bowl" }} onUseTypical={() => {}} />);
    expect(offered).toContain("Use typical serving");
    const silent = renderToStaticMarkup(<SanityNotices sanity={undefined} grams={400}
      policy={{ verdict: "allowed", marks: [] }}
      typicalServing={{ grams: 150, label: "1 bowl" }} onUseTypical={() => {}} />);
    expect(silent).toBe("");
  });
});

describe("WeighInField", () => {
  const props = { value: "", onValueChange: () => {}, onAsk: () => {}, onClose: () => {} };

  it("offers the weigh-in box idle, with its own label and no complaint", () => {
    const markup = renderToStaticMarkup(<WeighInField unit="kg" {...props} />);
    expect(markup).toContain('aria-label="Weight in kg"');
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).not.toContain("NaN");
  });

  // U19 (2026-10-04): a weigh-in is logged straight through the weight path, never a chat turn, so
  // a bad number is named in place and nothing is written.
  it("names an invalid number instead of logging it, and keeps the box open", () => {
    const writer = { log: vi.fn(), undo: vi.fn() };
    const onClose = vi.fn();
    render(<WeighInField unit="kg" {...props} value="0" onClose={onClose} writer={writer} />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter your weight in kg.");
    expect(writer.log).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("the coach block specs already of record", () => {
  it.each([
    "tests/coach/blocks-client/log-draft.test.tsx",
    "tests/coach/blocks-client/chart.test.tsx",
    "tests/coach/blocks-client/food-search.test.tsx",
    "tests/coach/blocks-client/food-ideas.test.tsx",
    "tests/coach/blocks-client/quick-replies.test.tsx",
    "tests/coach/editors/editor-fields.test.tsx",
    "tests/coach/editors/sanity.test.tsx",
    "tests/coach/attachments.test.ts",
  ])("keeps %s as the spec of record", (spec) => {
    // `path`, not a URL: jsdom's own `URL` is not the one `node:fs` accepts.
    expect(existsSync(path.join(process.cwd(), spec))).toBe(true);
  });
});
