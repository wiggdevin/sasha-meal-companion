"use client";

import "./globals.css";
import ErrorScreen from "@/components/ErrorScreen";

/**
 * The last boundary (audit 2026-10-08 §5): a crash in the root layout itself lands here. It
 * replaces the root layout, so it draws its own <html>/<body> and imports the global styles; the
 * fonts fall back to the stacks in the tokens.
 */
export default function GlobalError({ error, retry, reset }: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-paper text-charcoal antialiased">
        <title>Something went wrong</title>
        <div className="harvest-ground" aria-hidden="true" />
        <ErrorScreen error={error} source="global-boundary" onRetry={() => (retry ?? reset)?.()} />
      </body>
    </html>
  );
}
