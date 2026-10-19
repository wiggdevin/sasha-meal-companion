"use client";

/**
 * `/body`. T11b (Sol audit finding 5): one fetch spans `TDEE_WINDOW_DAYS` (15 inclusive days), so
 * the TDEE lines see a weigh-in up to 14 days old; the sparklines get `chartDays()` of the same
 * fetch — the latest 7 — so the wider window widens the formula, not the chart. The profile comes
 * from the shared `useBodyProfile()` read, so a Settings save updates this screen in place.
 *
 * Third round (Sol audit finding 7): the state and effects moved to `useBodyDashboard()` in
 * `lib/health/body-page.ts`, so this file is the view and no function here runs long. A rejected
 * profile read shows its retry on the dashboard itself (finding 6), and the read's `state` rides
 * with it so the TDEE panel withholds the lines it cannot stand on (eighth-round finding 5).
 */
import { useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import Notice from "@/components/ui/Notice";
import CardFrame from "@/components/ui/CardFrame";
import PageTitle from "@/components/ui/PageTitle";
import BodyDashboard, { type ProfileFailureProps } from "@/components/BodyDashboard";
import HealthSourcesSheet from "@/components/HealthSourcesSheet";
import { useBodyDashboard } from "@/lib/health/body-page";

/** Ingest is off, or the fetch came back empty: the shell the other empty states use. */
function BodyEmptyState() {
  return (
    <CardFrame as="section" size="sm" title="Nothing here yet"
      meta="Body data turns on once you connect a source in Settings." />
  );
}

/** The read failed and nothing is cached: say so, and never claim no source is connected
 *  (UI audit 2026-10-18). */
function BodyOfflineState({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice tone="attention" title="Couldn't reach the server"
      action={{ label: "Try again", onClick: onRetry }}>
      Nothing has changed with your connected sources. Your body data shows here once you are back online.
    </Notice>
  );
}

export default function BodyPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { daily: state, chart, estimate, estimateStatus, retryEstimate, pendingProposal, profile,
    reload, onProposalDecided } = useBodyDashboard();
  const unreachable = state !== null && !state.disabled && state.offline && state.response === null;
  // The retry travels with the flag, so the dashboard can never draw a button that does nothing
  // (split audit, finding 2). An unread profile is not a failure — it is just not answered yet.
  const profileFailure: ProfileFailureProps = profile.status === "error"
    ? { profileFailed: true, onRetryProfile: profile.retry }
    : {};

  return (
    <MotionConfig reducedMotion="user">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
        style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <PageTitle title="Body" />

        {/* Loading: the card it becomes, at E1 (a beige block on the ground read as sunken). */}
        {state === null && <div className="shell" aria-hidden="true"><div className="surface h-80" /></div>}

        {unreachable && <BodyOfflineState onRetry={() => { void reload(); }} />}

        {state !== null && !unreachable && (state.disabled || state.response === null)
          && <BodyEmptyState />}

        {state !== null && !state.disabled && state.response !== null && (
          <BodyDashboard response={state.response} chart={chart}
            fetchedAt={state.fetchedAt} offline={state.offline} estimate={estimate}
            estimateStatus={estimateStatus} onRetryEstimate={retryEstimate}
            pendingProposal={pendingProposal} onProposalDecided={onProposalDecided}
            profile={profile.state} {...profileFailure} onOpenSources={() => setSheetOpen(true)} />
        )}

        <AnimatePresence>
          {sheetOpen && state?.response && (
            <HealthSourcesSheet sources={state.response.sources}
              onClose={() => setSheetOpen(false)} onChanged={() => { void reload(); }} />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
