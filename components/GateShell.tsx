"use client";

import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";
import Button, { buttonClasses } from "@/components/ui/Button";

/** The neutral full-screen shell. No tabs, no data, no name — D1 §1.2 and §6.6. */
export function GateShell({ body, children }: { body: string; children?: ReactNode }) {
  return (
    <main
      aria-busy={children === undefined}
      className="flex min-h-dvh items-center justify-center bg-paper px-5 text-charcoal"
    >
      <div className="shell w-full max-w-sm">
        <div className="surface flex flex-col gap-3.5 p-6">
          <p className="ground-muted m-0 text-tiny uppercase tracking-[0.08em]">{APP_NAME}</p>
          <p className="m-0 text-caption font-normal text-graphite">{body}</p>
          {children}
        </div>
      </div>
    </main>
  );
}

/**
 * The departing account's edit exists only in memory and no storage took it (or the session could
 * not be removed), so the page does not reload and nothing changes. Nothing of either account is
 * shown; Retry tries to save it again (lib/device/departure.ts).
 */
export function UnsavedChangesCard({ onRetry }: { onRetry: () => void }) {
  return (
    <GateShell body="Changes on this phone could not be saved yet. Free up some space on this phone, then tap Retry.">
      <Button variant="primary" size="lg" block className="mt-2" onClick={onRetry}>Retry</Button>
    </GateShell>
  );
}

/**
 * This account is open in another tab of this browser, which is the one that writes
 * (lib/device/writer-lock.ts). Nothing of the account is shown here; "Use here" asks that tab to
 * save and hand over.
 */
export function OtherTabCard({ waiting, onUseHere }: { waiting: boolean; onUseHere: () => void }) {
  return (
    <GateShell body={waiting
      ? "Waiting for the other tab to save…"
      : `${APP_NAME} is open in another tab.`}>
      {waiting ? null : (
        <Button variant="primary" size="lg" block className="mt-2" onClick={onUseHere}>Use here</Button>
      )}
    </GateShell>
  );
}

/** The signed-out card; `href` is where sign-in goes (AuthGate.signedOutHref). */
export function SignedOutCard({ href }: { href: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper px-5 text-charcoal">
      <div className="shell w-full max-w-sm">
        <div className="surface flex flex-col gap-3.5 p-6">
          <h1 className=" text-heading-sm font-medium text-charcoal">Signed out</h1>
          <p className="text-caption font-normal text-graphite">
            Your session ended. Sign in again and everything comes back.
          </p>
          {/* A link, so it keeps link semantics; `Button` renders only <button>, so the anchor wears
              the same primary lg recipe (components/ui gap: no link form yet). No `tap`: its unlayered
              44 px minimum would beat the lg height. */}
          <a href={href} className={buttonClasses({ variant: "primary", size: "lg", block: true, className: "mt-2" })}>
            Sign in
          </a>
        </div>
      </div>
    </main>
  );
}
