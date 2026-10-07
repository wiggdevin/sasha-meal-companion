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
import BodyDashboard, { type ProfileFailureProps } from "@/components/BodyDashboard";
import HealthSourcesSheet from "@/components/HealthSourcesSheet";
import { useBodyDashboard } from "@/lib/health/body-page";

/** Ingest is off, or the fetch came back empty: the shell the other empty states use. */
function BodyEmptyState() {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-2 p-4">
        <h2 className="m-0 text-subheading font-semibold text-charcoal">
          Nothing here yet
        </h2>
        <p className="m-0 text-tiny font-normal text-muted">
          Body data turns on once you connect a source in Settings.
        </p>
      </div>
    </section>
  );
}

export default function BodyPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { daily: state, chart, estimate, pendingProposal, profile, reload,
    onProposalDecided } = useBodyDashboard();
  // The retry travels with the flag, so the dashboard can never draw a button that does nothing
  // (split audit, finding 2). An unread profile is not a failure — it is just not answered yet.
  const profileFailure: ProfileFailureProps = profile.status === "error"
    ? { profileFailed: true, onRetryProfile: profile.retry }
    : {};

  return (
    <MotionConfig reducedMotion="user">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
        style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <h1 className="ground m-0 px-1 text-display-md font-light leading-none tracking-display-md">
          Body
        </h1>

        {/* Loading: the card it becomes, at E1 (a beige block on the ground read as sunken). */}
        {state === null && <div className="shell" aria-hidden="true"><div className="surface h-80" /></div>}

        {state !== null && (state.disabled || state.response === null) && <BodyEmptyState />}

        {state !== null && !state.disabled && state.response !== null && (
          <BodyDashboard response={state.response} chart={chart}
            fetchedAt={state.fetchedAt} offline={state.offline} estimate={estimate}
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
