"use client";

import { useEffect } from "react";
import Button, { buttonClasses } from "@/components/ui/Button";
import Surface from "@/components/ui/Surface";
import { reportClientError } from "@/lib/client-error-reporter";
import type { ClientErrorSource } from "@/lib/client-errors";

/**
 * The fallback for a crash (app/error.tsx, app/global-error.tsx; audit 2026-10-08 §5). It reports
 * the error once (lib/client-error-reporter.ts) and offers two ways on: Try again (the boundary's
 * own retry) and Go to Today (a full load of `/`, which also clears a broken client state). It
 * never shows the error's message, digest or stack: those go to the log, not the screen.
 */
export default function ErrorScreen({ error, onRetry, source }: {
  error: Error & { digest?: string };
  onRetry: () => void;
  source: ClientErrorSource;
}) {
  useEffect(() => { reportClientError(error, source); }, [error, source]);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-8">
      <Surface className="flex flex-col gap-3 p-5">
        <h1 className="m-0 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm text-charcoal">
          Something went wrong
        </h1>
        <p className="m-0 text-caption text-graphite">
          This screen hit a problem. Your logged meals are saved. Try again, or go back to Today.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <Button variant="primary" block onClick={onRetry}>Try again</Button>
          {/* A full load, not a client navigation: after a crash the router's own state may be the
              broken part, and global-error has no router context worth trusting. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className={buttonClasses({ variant: "tertiary", block: true })}>Go to Today</a>
        </div>
      </Surface>
    </main>
  );
}
