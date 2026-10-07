// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ActivityMismatchPrompt, {
  ActivityPromptProvider,
} from "@/components/ActivityMismatchPrompt";

const promptClient = vi.hoisted(() => ({
  load: vi.fn(),
  apply: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/lib/activity/prompt-client", () => ({
  activityPromptUiEnabled: () => true,
  loadActivityPromptSuggestion: promptClient.load,
  applyActivitySuggestion: promptClient.apply,
  dismissActivityPrompt: promptClient.dismiss,
}));

const SUGGESTION = {
  observed: "active" as const,
  saved: "light" as const,
  averageSteps: 10_000,
  observedDays: 14,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderBothPrompts() {
  return render(
    <ActivityPromptProvider>
      <ActivityMismatchPrompt />
      <ActivityMismatchPrompt />
    </ActivityPromptProvider>,
  );
}

describe("shared activity prompt state", () => {
  beforeEach(() => {
    promptClient.load.mockResolvedValue(SUGGESTION);
    promptClient.apply.mockResolvedValue(undefined);
    promptClient.dismiss.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads once and lets two mounts start only one target update", async () => {
    const pending = deferred();
    promptClient.apply.mockReturnValueOnce(pending.promise);
    renderBothPrompts();

    const updates = await screen.findAllByRole("button", { name: "Update to active" });
    expect(promptClient.load).toHaveBeenCalledOnce();

    fireEvent.click(updates[0]);
    fireEvent.click(updates[1]);

    await waitFor(() => {
      expect(promptClient.apply).toHaveBeenCalledOnce();
      // The button keeps its label and width and shows its pending dots (DESIGN.md §Buttons).
      expect(screen.getAllByRole("button", { name: "Update to active", busy: true }))
        .toHaveLength(2);
    });

    pending.resolve();
    await waitFor(() => {
      expect(screen.getAllByText("Activity level updated. Your targets were recalculated."))
        .toHaveLength(2);
    });
  });

  it("lets two mounts start only one dismissal and hides both after it settles", async () => {
    const pending = deferred();
    promptClient.dismiss.mockReturnValueOnce(pending.promise);
    renderBothPrompts();

    const dismissals = await screen.findAllByRole("button", { name: "Not now" });
    fireEvent.click(dismissals[0]);
    fireEvent.click(dismissals[1]);

    await waitFor(() => {
      expect(promptClient.dismiss).toHaveBeenCalledOnce();
    });
    pending.resolve();
    await waitFor(() => {
      expect(screen.queryByText("Activity check")).toBeNull();
    });
  });
});
