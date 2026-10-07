"use client";

/**
 * Onboarding v2 lane 4: the art lookup for the falling-food discs, backed by the design lane's
 * manifest (coord.md CONTRACT ONB2-ART, 2026-10-07): `public/food-art/manifest.json` ->
 * `{ items: [{ key, file, name, role, group }] }`, `key` = `Starter.id` from
 * `lib/foods/starter.ts`, `file` the webp filename in the same `public/food-art/` directory.
 *
 * Fetched at runtime (not statically imported) so this file compiles and works correctly whether
 * or not the asset PR has landed in this branch's tree yet — a missing manifest (404, or the file
 * not existing) simply leaves every disc on its text-only fallback, exactly today's behavior.
 * One fetch per session: `loadManifest()` is a single-flight module-level promise, so many discs
 * mounting at once never trigger more than one request.
 */
import { useEffect, useState } from "react";

const MANIFEST_URL = "/food-art/manifest.json";

type ManifestItem = { key: string; file: string };
type Manifest = { items?: ManifestItem[] };

let manifestPromise: Promise<void> | null = null;
let artByKey: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function loadManifest(): Promise<void> {
  if (!manifestPromise) {
    // "force-cache" would happily replay a 404 the browser cached from before the asset PR
    // landed (reproduced live: a stale cached 404 persisted across full dev-server restarts).
    // Plain default caching still lets the browser reuse a *successful* fetch across the
    // session; it just won't trust a cached error without revalidating.
    manifestPromise = fetch(MANIFEST_URL)
      .then((response) => (response.ok ? response.json() as Promise<Manifest> : null))
      .then((data) => {
        if (!data?.items) return;
        const map: Record<string, string> = {};
        for (const item of data.items) {
          if (item?.key && item?.file) map[item.key] = `/food-art/${item.file}`;
        }
        artByKey = map;
        notify();
      })
      .catch(() => { /* no manifest yet — every disc stays on its text fallback */ });
  }
  return manifestPromise;
}

/** Synchronous lookup against whatever the manifest fetch has resolved to so far (empty until it
 *  resolves). Pair with `useFoodDiscArtReady()` in a component that renders discs, so the first
 *  real paint re-renders once art is available instead of staying on the fallback forever. */
export function foodDiscArtUrl(starterId: string): string | null {
  return artByKey[starterId] ?? null;
}

/** Call once per screen that renders discs. Triggers the manifest fetch (idempotent) and
 *  re-renders the caller when it resolves, so `foodDiscArtUrl` starts returning real URLs without
 *  requiring a user interaction to force a re-render. */
export function useFoodDiscArtReady(): void {
  const [, forceRender] = useState(0);
  useEffect(() => {
    let mounted = true;
    const onReady = () => { if (mounted) forceRender((n) => n + 1); };
    listeners.add(onReady);
    void loadManifest().then(onReady);
    return () => { mounted = false; listeners.delete(onReady); };
  }, []);
}
