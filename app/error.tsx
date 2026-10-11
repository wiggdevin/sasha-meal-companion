"use client";

import ErrorScreen from "@/components/ErrorScreen";

/**
 * The app-wide error boundary (audit 2026-10-08 §5): every route segment below the root layout
 * falls back here. `retry` re-fetches and re-renders the segment (this Next.js version's
 * recommended recovery); `reset` is the older re-render-only call, used when `retry` is absent.
 */
export default function AppError({ error, retry, reset }: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  return <ErrorScreen error={error} source="boundary" onRetry={() => (retry ?? reset)?.()} />;
}
