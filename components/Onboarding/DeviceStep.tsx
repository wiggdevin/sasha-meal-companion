"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import HealthSourcesSheet from "@/components/HealthSourcesSheet";
import { accountHandle } from "@/lib/device/account";
import { connectOura } from "@/lib/health-client";
import CloseButton from "@/components/ui/CloseButton";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";

export type DeviceCapability = { enabled: boolean; ouraConfigured: boolean };

export default function DeviceStep({ capability, onFinish, returnTo }: {
  capability: DeviceCapability; onFinish: () => void; returnTo: string;
}) {
  const [appleOpen, setAppleOpen] = useState(false);
  const [appleStarted, setAppleStarted] = useState(false);
  const [ouraBusy, setOuraBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);

  async function startOura(): Promise<void> {
    setError(null);
    setOuraBusy(true);
    try { await connectOura(accountHandle(), { returnTo }); }
    catch { setError("Couldn’t start Oura. Check your connection and try again."); }
    finally { setOuraBusy(false); }
  }

  if (!capability.enabled) return null;
  return (
    <main className="fixed inset-0 z-50 overflow-y-auto bg-paper px-4 text-charcoal"
      style={{ paddingTop: "calc(var(--safe-top) + 16px)",
        paddingBottom: "calc(var(--safe-bottom) + 16px)" }}>
      <div className="shell mx-auto flex min-h-full w-full max-w-md flex-col">
        <div className="surface flex flex-1 flex-col gap-5 p-4"
          style={{ background: "var(--color-surface)" }}>
          <header className="flex flex-col gap-3">
            <div className="-mr-1 -mt-1 flex items-center justify-between gap-3">
              <p className="m-0 uppercase tracking-[0.2em] text-text-faint text-caption">
                Plan saved · optional setup
              </p>
              {/* The plan is already saved: closing is the same as "Skip for now". */}
              <CloseButton onClick={onFinish} />
            </div>
            <h1 ref={heading} tabIndex={-1}
              className="m-0 text-display-md font-light leading-none tracking-display-md">
              Connect a device
            </h1>
            <p className="m-0 text-body-md text-graphite">
              Bring your activity and sleep into your plan. You can do this later in Settings.
            </p>
          </header>
          <div className="flex flex-1 flex-col gap-3">
            <section className="well flex flex-col gap-3 p-4">
              <h2 className="m-0 text-heading-sm font-semibold">Apple Health</h2>
              <p className="m-0 text-caption text-graphite">
                Connect through Health Auto Export on your iPhone. It needs its own app and setup;
                this web app cannot request Health access directly.
              </p>
              <Button block onClick={() => setAppleOpen(true)}>
                {appleStarted ? "Continue Apple Health setup" : "Set up Apple Health"}
              </Button>
              {appleStarted && <Notice tone="success"
                title="Connection code created. Finish setup in Health Auto Export and run a manual export." />}
            </section>
            {capability.ouraConfigured && <section className="well flex flex-col gap-3 p-4">
              <h2 className="m-0 text-heading-sm font-semibold">Oura</h2>
              <p className="m-0 text-caption text-graphite">
                Continue to Oura to approve the connection.
              </p>
              <Button block status={ouraBusy ? "pending" : undefined} onClick={() => { void startOura(); }}>
                Connect Oura
              </Button>
            </section>}
            {error && <Notice tone="error" title={error} />}
          </div>
          {/* Once a connection is under way, finishing is the step's primary; until then it is a skip. */}
          <Button variant={appleStarted ? "primary" : "ghost"} block onClick={onFinish}>
            {appleStarted ? "Continue to Today" : "Skip for now"}
          </Button>
        </div>
      </div>
      <AnimatePresence>
        {appleOpen && <HealthSourcesSheet key="apple" appleOnly sources={[]}
          onClose={() => setAppleOpen(false)} onChanged={() => setAppleStarted(true)} />}
      </AnimatePresence>
    </main>
  );
}
