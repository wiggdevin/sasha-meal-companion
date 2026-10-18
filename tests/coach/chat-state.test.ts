import {
  describe, expect, it } from "vitest"; import { createElement } from "react"; import { renderToStaticMarkup } from "react-dom/server"; import CoachChat, {   COMPOSER_OFFLINE_COPY, CoachComposedCards, CoachErrorNotice, initialChatState, nextChatState, nextPendingAction,
} from "@/components/CoachChat";
import { draftForSuggestion } from "@/components/CoachSuggestions";
import CoachActionCard from "@/components/CoachActionCard";
import CoachComposedCard from "@/components/CoachComposedCard";
import type { CoachDraft, CoachSuggestion } from "@/lib/coach/types";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";

const moveAction: CoachAction = {
  actionId: "a1", kind: "move_slot", date: "2026-09-16", slot: "meal-3",
  time: "19:30", flagged: [],
};

const composedMeal: ComposedMeal = {
  wish: "chicken bowl", slot: "meal-2", anchorProtein: "Chicken",
  items: [{
    name: "Chicken", foodRefId: "3f1b1a2c-0000-4000-8000-000000000001",
    catalogFoodRevisionId: 1, grams: 150, kcalPer100g: 200, proteinPer100g: 25,
    carbsPer100g: 10, fatPer100g: 5,
    macros: { kcal: 300, protein: 37.5, carbs: 15, fat: 7.5 }, verdict: "allowed",
  }],
  totals: { kcal: 300, protein: 37.5, carbs: 15, fat: 7.5 },
  target: { kcal: 300, protein: 37.5, carbs: 15, fat: 7.5 },
  flagged: [], fitsTarget: true, fitNote: "Fits 100 % of the target", rankNote: "fits 100 %",
};

describe("nextChatState", () => {
  it("adds an optimistic user bubble and shows the typing row on send", () => {
    const state = nextChatState(initialChatState("t1"),
      { type: "send", messageId: "m1", text: "what should I eat" });
    expect(state.messages.at(-1)).toMatchObject({ id: "m1", role: "user", pending: true });
    expect(state.typing).toBe(true);
    expect(state.error).toBeNull();
  });

  it("replaces the optimistic bubble with the server turn and clears typing", () => {
    const sent = nextChatState(initialChatState("t1"), { type: "send", messageId: "m1", text: "hi" });
    const done = nextChatState(sent, { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [], draft: null, deflected: false, toolsUsed: [],
      model: { provider: "gemini", modelId: "gemini-3.8-flash" },
      messages: [{ id: "m1", role: "user", content: "hi", seq: 1 },
                 { id: "m2", role: "assistant", content: "eat rice", seq: 2 }],
    } });
    expect(done.typing).toBe(false);
    expect(done.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(done.messages.every((m) => !m.pending)).toBe(true);
  });

  it("attaches turn actions to its assistant message as pending", () => {
    const done = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [moveAction], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "gemini-3.8-flash" },
      messages: [{ id: "m1", role: "user", content: "move dinner", seq: 1 },
        { id: "m2", role: "assistant", content: "Dinner is at 7:30.", seq: 2 }],
    } });
    expect(done.actions).toEqual([{ action: moveAction, status: "pending", messageId: "m2" }]);
  });

  it("keeps three composed reply items as three separately renderable cards", () => {
    const meals = [1, 2, 3].map((number) => ({
      ...composedMeal,
      anchorProtein: `Protein ${number}`,
      items: composedMeal.items.map((item) => ({ ...item, name: `Protein ${number}` })),
    }));
    const done = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: ["suggest_options"], model: { provider: "gemini", modelId: "model" },
      messages: [{ id: "m2", role: "assistant", content: "Here are three.", seq: 2 }],
      composed: meals,
    } });
    const markup = renderToStaticMarkup(createElement(CoachComposedCards, {
      meals: done.composed, tz: "UTC", onAction: () => {},
    }));

    expect(done.composed).toHaveLength(3);
    expect(markup.match(/Log it/g)).toHaveLength(3);
    expect(markup.match(/Save as recipe/g)).toHaveLength(3);
  });

  it("stamps each tapped card's action with its saved message and original card index", () => {
    const meals = [1, 2, 3].map((number) => ({ ...composedMeal, anchorProtein: `Protein ${number}` }));
    const done = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: ["suggest_options"], model: { provider: "gemini", modelId: "model" },
      messages: [{ id: "m2", role: "assistant", content: "Here are three.", seq: 2 }],
      composed: meals,
    } });
    const first = nextChatState(done, { type: "compose_action",
      action: { ...moveAction, actionId: "tap-1" }, messageId: "m2", cardIndex: 1 });
    // Card 2 is now at position 1 of the list; its source is still card 2 of message m2.
    const second = nextChatState(first, { type: "compose_action",
      action: { ...moveAction, actionId: "tap-2" }, messageId: "m2", cardIndex: 1 });
    expect(second.actions.map((entry) => entry.source)).toEqual([
      { messageId: "m2", cardIndex: 1 }, { messageId: "m2", cardIndex: 2 }]);
  });

  it("applies only the tapped suggestion card and leaves the other two usable", () => {
    const meals = [1, 2, 3].map((number) => ({
      ...composedMeal,
      anchorProtein: `Protein ${number}`,
      items: composedMeal.items.map((item) => ({ ...item, name: `Protein ${number}` })),
    }));
    const withCards = { ...initialChatState("t1"), composed: meals };
    const tapped = nextChatState(withCards, {
      type: "compose_action", action: moveAction, messageId: "m2", cardIndex: 1,
    });
    const applied = nextChatState(tapped, {
      type: "action_applied", actionId: moveAction.actionId, token: {} as never,
    });
    const markup = renderToStaticMarkup(createElement(CoachComposedCards, {
      meals: applied.composed, tz: "UTC", onAction: () => {},
    }));

    expect(applied.actions[0].status).toBe("applied");
    expect(applied.composed.map((meal) => meal.anchorProtein)).toEqual(["Protein 1", "Protein 3"]);
    expect(markup.match(/Log it/g)).toHaveLength(2);
    expect(markup.match(/Save as recipe/g)).toHaveLength(2);
  });

  it("queues a transcript block's tap under its own message once and keeps composed cards", () => {
    const withCards = { ...initialChatState("t1"), composed: [composedMeal] };
    const tapped = nextChatState(withCards, {
      type: "compose_action", action: moveAction, messageId: "m-ideas",
    });
    const again = nextChatState(tapped, {
      type: "compose_action", action: moveAction, messageId: "m-ideas",
    });

    expect(again.actions).toEqual([{ action: moveAction, status: "pending", messageId: "m-ideas" }]);
    expect(again.composed).toEqual([composedMeal]);
    expect(nextPendingAction(again.actions)?.action.actionId).toBe("a1");
  });

  it("renders one composed item byte-for-byte as the existing single card", () => {
    const done = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: ["compose_meal"], model: { provider: "gemini", modelId: "model" },
      messages: [{ id: "m2", role: "assistant", content: "Here it is.", seq: 2 }],
      composed: composedMeal,
    } });
    const props = { tz: "UTC", onAction: () => {}, newId: () => "id", now: () => new Date(0) };

    expect(renderToStaticMarkup(createElement(CoachComposedCards, {
      meals: done.composed, ...props,
    }))).toBe(renderToStaticMarkup(createElement(CoachComposedCard, {
      meal: composedMeal, ...props,
    })));
  });

  it("carries an action through applied, failed, retry and undone states", () => {
    const pending = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [moveAction], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "model" },
      messages: [{ id: "m2", role: "assistant", content: "Moved.", seq: 2 }],
    } });
    const token = { kind: "move_slot" as const, date: "2026-09-16", slot: "meal-3" as const,
      baseMealId: "dinner", planned: [], previous: null };
    const applied = nextChatState(pending, { type: "action_applied", actionId: "a1", token });
    expect(applied.actions[0]).toMatchObject({ status: "applied", token });
    const failed = nextChatState(applied,
      { type: "action_failed", actionId: "a1", reason: "Undo did not save." });
    expect(failed.actions[0]).toMatchObject({ status: "failed", reason: "Undo did not save.", token });
    const retried = nextChatState(failed, { type: "action_retry", actionId: "a1" });
    expect(retried).toBe(failed);
    const undone = nextChatState(applied, { type: "action_undone", actionId: "a1" });
    expect(undone.actions[0]).toMatchObject({ status: "undone" });
    expect(undone.actions[0].token).toBeUndefined();
  });

  it("keeps an applied save's notices on its entry, and a later apply without any clears them", () => {
    const pending = nextChatState(initialChatState("t1"), { type: "turn", response: {
      threadId: "t1", suggestions: [], actions: [moveAction], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "model" },
      messages: [{ id: "m2", role: "assistant", content: "Moved.", seq: 2 }],
    } });
    const notices = ["Left out Brie: not verified."];
    const applied = nextChatState(pending, { type: "action_applied", actionId: "a1", token: {} as never, notices });
    expect(applied.actions[0].notices).toEqual(notices);
    const again = nextChatState(applied, { type: "action_applied", actionId: "a1", token: {} as never });
    expect(again.actions[0].notices).toBeUndefined();
  });

  it("marks an undo in flight and disables its card action", () => {
    const token = { kind: "move_slot" as const, date: "2026-09-16", slot: "meal-3" as const,
      baseMealId: "dinner", planned: [], previous: null };
    const applied = { ...initialChatState("t1"), actions: [
      { action: moveAction, status: "applied" as const, token, messageId: "m2" },
    ] };
    const undoing = nextChatState(applied, { type: "action_undo_started", actionId: "a1" });
    expect(undoing.actions[0]).toMatchObject({ status: "undoing", token });
    const markup = renderToStaticMarkup(createElement(CoachActionCard, {
      action: moveAction, status: "undoing", canUndo: true,
      onRetry: () => {}, onUndo: () => {},
    }));
    expect(markup).toContain("Undoing…");
    expect(markup).toContain("disabled");
  });

  it("restores cached action state and never queues a restored applied action", () => {
    const token = { kind: "move_slot" as const, date: "2026-09-16", slot: "meal-3" as const,
      baseMealId: "dinner", planned: [], previous: null };
    const restored = nextChatState(initialChatState("t1"), {
      type: "restore",
      messages: [{ id: "m2", role: "assistant", content: "Moved.", seq: 2 }],
      actions: [{ action: moveAction, status: "applied", token, messageId: "m2" }],
    });
    expect(restored.actions).toEqual([
      { action: moveAction, status: "applied", token, messageId: "m2" },
    ]);
    expect(nextPendingAction(restored.actions)).toBeUndefined();
  });

  it("restores an interrupted pending action as failed instead of applying it again", () => {
    const restored = nextChatState(initialChatState("t1"), {
      type: "restore", messages: [],
      actions: [{ action: moveAction, status: "pending", messageId: "m2" }],
    });
    expect(restored.actions[0]).toMatchObject({ status: "failed" });
    expect(nextPendingAction(restored.actions)).toBeUndefined();
  });

  it("offers a retry on 503 and keeps the text so nothing is retyped", () => {
    const sent = nextChatState(initialChatState("t1"), { type: "send", messageId: "m1", text: "hi" });
    const failed = nextChatState(sent,
      { type: "error", status: 503, code: "coach_unavailable", message: "down" });
    expect(failed.retryable).toBe(true);
    expect(failed.pendingText).toBe("hi");
    expect(failed.typing).toBe(false);
  });

  it("preserves the first-turn message ID when the network loses its response", () => {
    const sent = nextChatState(initialChatState(null),
      { type: "send", messageId: "m1", text: "What did I pack?" });
    const failed = nextChatState(sent,
      { type: "error", status: 0, code: "network", message: "Connection lost", messageId: "m1" });
    expect(failed.retryable).toBe(true);
    expect(failed.pendingMessageId).toBe("m1");
    expect(failed.pendingText).toBe("What did I pack?");
  });

  it("does not offer a retry on 429 and shows the wait", () => {
    const sent = nextChatState(initialChatState("t1"), { type: "send", messageId: "m1", text: "hi" });
    const limited = nextChatState(sent,
      { type: "error", status: 429, code: "rate_limited", message: "slow", retryAfterSeconds: 600 });
    expect(limited.retryable).toBe(false);
    expect(limited.error).toContain("10 minutes");
  });

  it("disables the composer offline with the stated copy", () => {
    const offline = nextChatState(initialChatState("t1"), { type: "connection", online: false });
    expect(offline.composerDisabled).toBe(true);
    expect(COMPOSER_OFFLINE_COPY).toBe("Sasha needs a connection");
  });

  it("clears the offline notice and enables the composer on reconnect", () => {
    const offline = nextChatState(initialChatState("t1"), { type: "connection", online: false });
    const online = nextChatState(offline, { type: "connection", online: true });
    expect(online.composerDisabled).toBe(false);
    expect(online.error).toBeNull();
  });

  it("preserves a genuine coach error and retry state when connectivity returns", () => {
    const offline = nextChatState(initialChatState("t1"), { type: "connection", online: false });
    const failed = nextChatState(offline,
      { type: "error", status: 503, code: "coach_unavailable", message: "The coach is unavailable." });
    const online = nextChatState(failed, { type: "connection", online: true });
    expect(online.composerDisabled).toBe(false);
    expect(online.error).toBe("The coach is unavailable.");
    expect(online.retryable).toBe(true);
  });

  it("only offers 'Log this' on the suggestion whose food is actually in the draft", () => {
    // One turn names two allowed foods (rice cake, grilled chicken) but the model only ever
    // drafted the chicken + rice meal — the rice cake was never logged anywhere.
    const riceCake: CoachSuggestion = {
      foodRefId: "food-rice-cake", name: "rice cake", grams: 20, reason: null, verdict: "allowed",
    };
    const chicken: CoachSuggestion = {
      foodRefId: "food-chicken", name: "grilled chicken", grams: 150, reason: null, verdict: "allowed",
    };
    const draft: CoachDraft = {
      draftId: "d1", slot: "meal-2",
      items: [
        { foodRefId: "food-chicken", name: "grilled chicken", grams: 150, catalogFoodRevisionId: null },
        { foodRefId: "food-rice", name: "white rice", grams: 100, catalogFoodRevisionId: null },
      ],
    };

    expect(draftForSuggestion(chicken, draft)).toBe(draft);
    expect(draftForSuggestion(riceCake, draft)).toBeNull();
  });

  it("announces failures and keeps the retry action accessible", () => {
    const markup = renderToStaticMarkup(
      createElement(CoachErrorNotice, {
        message: "The coach is unavailable.", retryable: true, onRetry: () => {},
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The coach is unavailable.");
    expect(markup).toContain("Try again");
  });

  it("clears the specific pending bubble on a failed turn instead of leaving a permanent ghost", () => {
    const sent = nextChatState(initialChatState("t1"), { type: "send", messageId: "m1", text: "hi" });
    const failed = nextChatState(sent,
      { type: "error", status: 503, code: "coach_unavailable", message: "down", messageId: "m1" });
    expect(failed.messages.find((m) => m.id === "m1")).toBeUndefined();
  });

  it("does not stack a second pending bubble when retrying after a failed turn", () => {
    const sent = nextChatState(initialChatState("t1"), { type: "send", messageId: "m1", text: "hi" });
    const failed = nextChatState(sent,
      { type: "error", status: 503, code: "coach_unavailable", message: "down", messageId: "m1" });
    const retried = nextChatState(failed, { type: "send", messageId: "m2", text: "hi" });
    expect(retried.messages).toHaveLength(1);
    expect(retried.messages[0]).toMatchObject({ id: "m2", pending: true });
  });

  it("announces new coach turns through one polite status line, not the whole transcript", () => {
    const markup = renderToStaticMarkup(createElement(CoachChat, {
      userId: "u1", threadId: null, onOpenDraft: () => {}, onThreadSaved: () => {},
    }));
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain('role="region" aria-label="Conversation"');
    expect(markup.match(/aria-live=/g)).toHaveLength(1);
  });
});
