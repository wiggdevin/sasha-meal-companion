"use client";

/**
 * React view of the tri-state body capability (Sol audit, T11a). `unknown` is a real state: the
 * header renders nothing body-related until one authoritative probe answers. `/sign-in` never
 * probes — the tab bar sits outside `AuthGate`, and there is no session to ask with.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { probeBodyCapability, readBodyCapability, type BodyCapability } from "@/lib/health/capability";

/** `useLayoutEffect` warns and no-ops during SSR; fall back to `useEffect` there — mirrors the
 *  standard "isomorphic layout effect" shim (React itself renders this "use client" component
 *  during Next.js's server pass, not just in the browser). */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** The tab bar renders on `/sign-in` too, and a signed-out probe would 401 for no reason. */
export function shouldProbeBody(pathname: string | null): boolean {
  return pathname !== "/sign-in";
}

export function useBodyCapability(): BodyCapability {
  const pathname = usePathname();
  const mayProbe = shouldProbeBody(pathname);
  // Hard-coded to "unknown", matching what the server always renders (readBodyCapability()
  // has no `window` there). A lazy initializer that read the cache here would answer
  // "enabled"/"disabled" for a session that already probed earlier, diverging from the
  // server markup on the client's own first (hydration-time) render — a genuine hydration
  // mismatch, not just a later update: React discards and client-renders the subtree,
  // which can reproduce the very column-count jump this hook exists to prevent. See
  // app/week/page.tsx, app/settings/page.tsx and components/InstallPrompt.tsx for the same
  // rule elsewhere in this codebase (an effect, never a lazy initializer, does the read).
  const [capability, setCapability] = useState<BodyCapability>("unknown");

  // Correct a warm cache before the browser paints, so a session that already knows the
  // answer does not sit at "unknown" for a visible frame. A layout effect runs after
  // hydration has already matched the server (no mismatch to trigger), and — unlike a
  // plain `useEffect`, which the referenced house pattern uses where no such jump risk
  // exists — commits synchronously before paint, so this is the one case that needs it.
  useIsomorphicLayoutEffect(() => {
    if (!mayProbe) return;
    const cached = readBodyCapability();
    if (cached !== "unknown") setCapability(cached);
  }, [mayProbe]);

  useEffect(() => {
    if (!mayProbe) return;
    let live = true;
    // The setter sits behind a promise on both paths, the house shape for a one-shot client read
    // (see components/FavoritesStrip.tsx): a cache hit resolves on the same tick it is read.
    void Promise.resolve()
      .then(() => readBodyCapability() !== "unknown" ? readBodyCapability() : probeBodyCapability())
      .then((next) => {
        if (live) setCapability(next);
      });
    return () => {
      live = false;
    };
  }, [mayProbe]);

  return capability;
}
