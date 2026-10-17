// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window.navigator, "vibrate", {
    configurable: true,
    value: vi.fn(() => true),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useActionFeedback", () => {
  it("marks a commit pending, then confirms it in the control for 1.6 s with one haptic and no toast", async () => {
    let finish!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { finish = resolve; });
    const { result } = renderHook(() => useActionFeedback());

    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.run(() => operation, {
        kind: "commit",
        successMessage: "Message sent.",
      });
    });
    expect(result.current.phase).toBe("pending");
    expect(result.current.controlProps["aria-busy"]).toBe(true);
    expect(result.current.controlProps["data-feedback-state"]).toBe("pending");

    await act(async () => { finish("saved"); await settled; });
    expect(result.current.phase).toBe("success");
    expect(result.current.notice).toBeNull();
    expect(window.navigator.vibrate).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_599));
    expect(result.current.phase).toBe("success");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.phase).toBe("idle");
  });

  it("keeps the toast for a success that offers Undo, or asks for one", async () => {
    const { result } = renderHook(() => useActionFeedback());
    await act(async () => {
      await result.current.run(async () => "ok", { kind: "commit", successMessage: "Removed.", undo: { action: () => {} } });
    });
    expect(result.current.notice?.message).toBe("Removed.");
    expect(result.current.notice?.action?.label).toBe("Undo");
    act(() => vi.advanceTimersByTime(6_000));
    await act(async () => {
      await result.current.run(async () => "ok", { kind: "commit", successMessage: "Sent.", confirm: "notice" });
    });
    expect(result.current.notice?.message).toBe("Sent.");
  });

  it("shows a failed action as an error notice without success haptics", async () => {
    const { result } = renderHook(() => useActionFeedback());

    let outcome!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      outcome = await result.current.run(async () => { throw new Error("offline"); }, {
        kind: "commit",
        failureMessage: "That did not send. Try again.",
      });
    });

    expect(outcome.ok).toBe(false);
    expect(result.current.phase).toBe("failed");
    expect(result.current.notice).toMatchObject({
      tone: "error",
      message: "That did not send. Try again.",
    });
    expect(window.navigator.vibrate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.phase).toBe("idle");
    expect(result.current.notice?.message).toBe("That did not send. Try again.");
  });

  it("coalesces overlapping runs so a rapid double press performs one commit", async () => {
    let finish!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { finish = resolve; });
    const perform = vi.fn(() => operation);
    const { result } = renderHook(() => useActionFeedback());

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.run(perform, { kind: "commit", successMessage: "Saved." });
      second = result.current.run(perform, { kind: "commit", successMessage: "Saved." });
    });

    expect(first).toBe(second);
    await act(async () => { await Promise.resolve(); });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.current.controlProps.disabled).toBe(true);

    await act(async () => { finish("saved"); await Promise.all([first, second]); });
    expect(window.navigator.vibrate).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.phase).toBe("idle");
  });

  it("keeps a changed control violet for four seconds and exposes Undo", async () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useActionFeedback());

    await act(async () => {
      await result.current.run(async () => "saved", {
        kind: "change",
        successMessage: "Meal changed.",
        undo: { label: "Undo", action: undo },
      });
    });

    expect(result.current.phase).toBe("changed");
    expect(result.current.controlProps["data-feedback-state"]).toBe("changed");
    expect(result.current.notice?.action?.label).toBe("Undo");
    expect(window.navigator.vibrate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(3_999));
    expect(result.current.phase).toBe("changed");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.phase).toBe("idle");
  });
});

describe("keyed action feedback", () => {
  it("lights only the control whose stable key started the write", async () => {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const { result } = renderHook(() => useActionFeedback());

    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.run(() => operation, { kind: "commit", key: "eaten:meal-1" });
    });
    expect(result.current.controlPropsFor("eaten:meal-1")["data-feedback-state"]).toBe("pending");
    expect(result.current.controlPropsFor("eaten:meal-2")["data-feedback-state"]).toBeUndefined();
    expect(result.current.phaseFor("eaten:meal-1")).toBe("pending");
    expect(result.current.phaseFor("eaten:meal-2")).toBe("idle");
    // One owner, one write at a time: a second key waits rather than joining the first write.
    expect(result.current.controlPropsFor("eaten:meal-2").disabled).toBe(true);

    await act(async () => { finish(); await settled; });
    expect(result.current.controlPropsFor("eaten:meal-1")["data-feedback-state"]).toBe("success");
    expect(result.current.controlPropsFor("eaten:meal-2")["data-feedback-state"]).toBeUndefined();
    expect(result.current.controlPropsFor("eaten:meal-2").disabled).toBe(false);
    expect(result.current.controlPropsFor("eaten:meal-2").className)
      .toBe(result.current.controlProps.className);
  });
});

describe("queued writes", () => {
  it("keeps an earlier failure on screen while a later queued write runs and succeeds", async () => {
    const { result } = renderHook(() => useActionFeedback());
    let finishSecond!: () => void;
    const second = new Promise<void>((resolve) => { finishSecond = resolve; });
    let firstRun!: Promise<unknown>;
    let secondRun!: Promise<unknown>;
    act(() => {
      firstRun = result.current.run(async () => { throw new Error("offline"); },
        { kind: "commit", queue: true, failureMessage: "First did not save." });
      secondRun = result.current.run(() => second,
        { kind: "commit", queue: true, successMessage: "Second saved." });
    });
    await act(async () => { await firstRun; await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.phase).toBe("pending");
    expect(result.current.notice).toMatchObject({ tone: "error", message: "First did not save." });
    await act(async () => { finishSecond(); await secondRun; });
    expect(result.current.phase).toBe("success");
    expect(window.navigator.vibrate).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toMatchObject({ tone: "error", message: "First did not save." });
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.notice).toMatchObject({ tone: "error", message: "First did not save." });
  });

  it("offers a queued success's Undo beside a standing error, then leaves the error alone", async () => {
    const { result } = renderHook(() => useActionFeedback());
    const undo = vi.fn();
    let firstRun!: Promise<unknown>;
    let secondRun!: Promise<unknown>;
    act(() => {
      firstRun = result.current.run(async () => { throw new Error("offline"); },
        { kind: "commit", queue: true, failureMessage: "First did not save." });
      secondRun = result.current.run(async () => "ok",
        { kind: "commit", queue: true, successMessage: "Second saved.", undo: { action: undo } });
    });
    await act(async () => { await firstRun; await secondRun; });
    expect(result.current.notice).toMatchObject({ tone: "error", message: "First did not save. Second saved.",
      action: { label: "Undo" } });
    act(() => { result.current.notice?.action?.action(); });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toEqual({ tone: "error", message: "First did not save." });
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.notice).toEqual({ tone: "error", message: "First did not save." });
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.notice).toEqual({ tone: "error", message: "First did not save." });
  });

  it("keeps the error through the toast's own Undo tap, and offers a later queued Undo too", async () => {
    const undo = vi.fn();
    function Host() {
      const feedback = useActionFeedback();
      return <>
        <button type="button" onClick={() => {
          void feedback.run(async () => { throw new Error("offline"); },
            { kind: "commit", queue: true, failureMessage: "First did not save." });
          void feedback.run(async () => "ok", { kind: "commit", queue: true, successMessage: "Second saved.",
            undo: { action: undo } });
        }}>go</button>
        <button type="button" onClick={() => {
          void feedback.run(async () => "ok", { kind: "commit", queue: true, successMessage: "Third saved.",
            undo: { action: undo } });
        }}>again</button>
        <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      </>;
    }
    render(<Host />);
    await act(async () => { fireEvent.click(screen.getByText("go")); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    await act(async () => { fireEvent.click(screen.getByText("again")); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(screen.getByText("First did not save. Third saved.")).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByText("First did not save.")).toBeTruthy();
  });

  it("still replaces an earlier success notice when the next write starts", async () => {
    const { result } = renderHook(() => useActionFeedback());
    await act(async () => {
      await result.current.run(async () => "ok", { kind: "change", successMessage: "First changed." });
    });
    let finish!: () => void;
    let next!: Promise<unknown>;
    act(() => {
      next = result.current.run(() => new Promise<void>((resolve) => { finish = resolve; }),
        { kind: "change", queue: true });
    });
    expect(result.current.notice).toBeNull();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); finish(); await next; });
  });
});

describe("a write whose context has gone", () => {
  it("settles quietly: no notice, no glow, no haptic, whichever way it ends", async () => {
    const { result } = renderHook(() => useActionFeedback());
    let gone = false;
    let fail!: (error: Error) => void;
    const operation = new Promise<void>((_resolve, reject) => { fail = reject; });
    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.run(() => operation, { kind: "commit", key: "meal:meal-1",
        successMessage: "Saved.", stale: () => gone });
    });
    await act(async () => { await Promise.resolve(); });
    gone = true;
    await act(async () => { fail(new Error("old account")); await settled; });
    expect(result.current.notice).toBeNull();
    expect(result.current.phase).toBe("idle");
    await act(async () => {
      await result.current.run(async () => "ok", { kind: "commit", successMessage: "Saved.", stale: () => true });
    });
    expect(result.current.notice).toBeNull();
    expect(window.navigator.vibrate).not.toHaveBeenCalled();
  });

  it("never starts a queued write whose context went while it waited", async () => {
    const { result } = renderHook(() => useActionFeedback());
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    let gone = false;
    const second = vi.fn(async () => "wrote under the next account");
    let firstRun!: Promise<unknown>;
    let secondRun!: Promise<unknown>;
    act(() => {
      firstRun = result.current.run(() => first, { kind: "commit", queue: true, key: "eaten:meal-1" });
      secondRun = result.current.run(second, { kind: "commit", queue: true, key: "eaten:meal-2",
        successMessage: "Meal 2 marked eaten.", failureMessage: "Meal 2 did not save.", stale: () => gone });
    });
    gone = true;
    await act(async () => { finishFirst(); await firstRun; });
    expect(window.navigator.vibrate).toHaveBeenCalledTimes(1);
    const outcome = await act(async () => secondRun);
    expect(second).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false });
    expect(result.current.notice).toBeNull();
    expect(result.current.phaseFor("eaten:meal-2")).toBe("idle");
    expect(window.navigator.vibrate).toHaveBeenCalledTimes(1);
  });
});

describe("notify", () => {
  it("confirms a write a closed sheet committed, without a second haptic or a glow", () => {
    const { result } = renderHook(() => useActionFeedback());
    act(() => result.current.notify({ tone: "success", message: "Logged." }));
    expect(result.current.notice).toMatchObject({ tone: "success", message: "Logged." });
    expect(result.current.phase).toBe("idle");
    expect(window.navigator.vibrate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.notice).toBeNull();
  });

  it("keeps a blocker until it is dismissed, like any failure", () => {
    const { result } = renderHook(() => useActionFeedback());
    act(() => result.current.notify({ tone: "error", message: "Mark this meal not eaten first." }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.notice?.message).toBe("Mark this meal not eaten first.");
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
  });

  it("keeps an Undo notice for five seconds", () => {
    const { result } = renderHook(() => useActionFeedback());
    act(() => result.current.notify({ tone: "success", message: "Note saved.",
      action: { label: "Undo", action: vi.fn() } }));
    act(() => vi.advanceTimersByTime(4_999));
    expect(result.current.notice?.action?.label).toBe("Undo");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.notice).toBeNull();
  });
});

describe("ActionFeedbackToast", () => {
  it("announces failure as an alert", () => {
    const dismiss = vi.fn();
    render(<ActionFeedbackToast notice={{ tone: "error", message: "Could not save." }}
      onDismiss={dismiss} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not save.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("runs an Undo action and dismisses the notice", () => {
    const action = vi.fn();
    const dismiss = vi.fn();
    render(<ActionFeedbackToast notice={{
      tone: "changed",
      message: "Meal changed.",
      action: { label: "Undo", action },
    }} onDismiss={dismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
