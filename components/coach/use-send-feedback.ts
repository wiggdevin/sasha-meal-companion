"use client";

import { useCallback } from "react";
import { useActionFeedback } from "@/components/ui/ActionFeedback";
import { CoachError, NO_CONNECTION_COPY } from "@/lib/coach-client";

export function useSendFeedback() {
  const feedback = useActionFeedback();
  const baseRun = feedback.run;
  const run = useCallback(<T,>(operation: () => Promise<T>) => baseRun(operation, {
    kind: "commit",
    failureMessage: (error) => `Could not confirm this message was sent. ${error instanceof CoachError
      ? error.message : NO_CONNECTION_COPY}`,
  }), [baseRun]);
  return { ...feedback, run };
}
