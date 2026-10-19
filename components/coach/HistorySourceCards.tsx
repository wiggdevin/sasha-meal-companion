"use client";

import { useCallback, useEffect, useState } from "react";
import { ASSISTANT_NAME } from "@/lib/brand";
import { titleOf } from "@/components/coach/conversations/list";
import type { HistoryEvidence } from "@/lib/coach-client";
import type { HistoryCitation } from "@/lib/coach/message-view";

function sourceDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved message"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export default function HistorySourceCards({ sources, readEvidence, onOpenConversation }: {
  sources: readonly HistoryCitation[];
  readEvidence: (sources: readonly HistoryCitation[]) => Promise<HistoryEvidence[]>;
  onOpenConversation?: (threadId: string) => void;
}) {
  const [evidence, setEvidence] = useState<HistoryEvidence[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    let live = true;
    void readEvidence(sources.slice(0, 4))
      .then((items) => { if (live) { setEvidence(items); setError(false); } })
      .catch(() => { if (live) { setEvidence(null); setError(true); } });
    return () => { live = false; };
  }, [sources, readEvidence, attempt]);
  return <section aria-label="History sources" className="shell mx-3">
    <div className="surface card-sm card-ivory flex flex-col">
      <h3 className="m-0 text-caption font-semibold text-charcoal">From your saved conversations</h3>
      {!evidence && !error && <p role="status" className="m-0 text-caption text-graphite">Checking sources…</p>}
      {error && <p role="alert" className="m-0 text-caption text-graphite">
        Couldn’t load these saved passages. <button type="button" onClick={load}
          className="tap min-h-11 underline">Retry</button>
      </p>}
      {evidence && sources.slice(0, 4).map((source, index) => {
        const item = evidence.find((candidate) => candidate.id === source.id
          && candidate.threadId === source.threadId);
        return <article key={`${source.threadId}:${source.id}`} className="well rounded-2xl p-3">
          <p className="m-0 text-tiny text-muted">Source {index + 1} · {item
            ? `${titleOf(item)} · ${sourceDate(item.createdAt)} · ${item.role === "user" ? "You" : ASSISTANT_NAME}`
            : "Source no longer available"}</p>
          {item && <>
            <blockquote className="m-0 mt-2 text-caption text-charcoal">“{item.excerpt}”</blockquote>
            <p className="m-0 mt-2 text-tiny text-muted">Historical conversation, not your current targets.</p>
            {onOpenConversation && <button type="button" onClick={() => onOpenConversation(item.threadId)}
              className="tap mt-2 min-h-11 text-caption text-graphite underline underline-offset-2">
              Open conversation
            </button>}
          </>}
        </article>;
      })}
    </div>
  </section>;
}
