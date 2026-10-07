"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { activityLevelLabel, type ActivitySuggestion } from "@/lib/activity/prompt";
import Button from "@/components/ui/Button";
import {
  activityPromptUiEnabled, applyActivitySuggestion, dismissActivityPrompt,
  loadActivityPromptSuggestion,
} from "@/lib/activity/prompt-client";

export type ActivityPromptState = "ready" | "saving" | "success" | "failure";

type ActivityPromptContextValue = {
  suggestion: ActivitySuggestion | null;
  state: ActivityPromptState;
  load: () => void;
  update: () => void;
  dismiss: () => void;
};

const ActivityPromptContext = createContext<ActivityPromptContextValue | null>(null);

export function ActivityPromptProvider({ children }: { children: ReactNode }) {
  const [suggestion, setSuggestion] = useState<ActivitySuggestion | null>(null);
  const [state, setState] = useState<ActivityPromptState>("ready");
  const loadStarted = useRef(false);
  const action = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void loadActivityPromptSuggestion().then(setSuggestion, () => { setSuggestion(null); });
  }, []);

  const run = useCallback((work: () => Promise<void>, onSuccess: () => void) => {
    if (action.current) return;
    setState("saving");
    const pending = Promise.resolve()
      .then(work)
      .then(onSuccess, () => { setState("failure"); })
      .finally(() => {
        if (action.current === pending) action.current = null;
      });
    action.current = pending;
  }, []);

  const update = useCallback(() => {
    if (!suggestion) return;
    run(
      () => applyActivitySuggestion(suggestion.observed),
      () => { setState("success"); },
    );
  }, [run, suggestion]);

  const dismiss = useCallback(() => {
    if (!suggestion) return;
    run(
      dismissActivityPrompt,
      () => { setSuggestion(null); },
    );
  }, [run, suggestion]);

  const value = useMemo(() => ({ suggestion, state, load, update, dismiss }),
    [dismiss, load, state, suggestion, update]);

  return <ActivityPromptContext.Provider value={value}>{children}</ActivityPromptContext.Provider>;
}

const EYEBROW = "text-tiny font-medium tracking-widest uppercase text-graphite";
const BODY = "text-caption font-normal leading-label-md text-charcoal";
const META = "text-tiny font-normal text-muted";

export function ActivityMismatchPromptView({ suggestion, state, onUpdate, onDismiss }: {
  suggestion: ActivitySuggestion;
  state: ActivityPromptState;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  const observed = activityLevelLabel(suggestion.observed);
  const saved = activityLevelLabel(suggestion.saved);
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <p className={`m-0 ${EYEBROW}`}>Activity check</p>
        {state === "success" ? (
          <p className={`m-0 ${BODY}`} role="status">
            Activity level updated. Your targets were recalculated.
          </p>
        ) : (
          <>
            <p className={`m-0 ${BODY}`}>
              Your steps look {observed}, but your profile says {saved}. Update your activity level?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button status={state === "saving" ? "pending" : undefined} onClick={onUpdate}>
                {`Update to ${observed}`}
              </Button>
              <Button variant="tertiary" disabled={state === "saving"} onClick={onDismiss}>Not now</Button>
            </div>
            {state === "failure" && (
              <p className={`m-0 ${META}`} role="alert">That did not save. Try again.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default function ActivityMismatchPrompt() {
  const enabled = activityPromptUiEnabled();
  const prompt = useContext(ActivityPromptContext);

  useEffect(() => {
    if (enabled) prompt?.load();
  }, [enabled, prompt]);

  if (!enabled || !prompt?.suggestion) return null;

  return <ActivityMismatchPromptView suggestion={prompt.suggestion} state={prompt.state}
    onUpdate={prompt.update} onDismiss={prompt.dismiss} />;
}
