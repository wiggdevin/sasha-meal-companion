"use client";

import { currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { useCallback, useEffect, useState } from "react";
import { BODY_PROFILE_CHANGED_EVENT } from "@/lib/body-profile-client";
import { browserClient } from "@/lib/supabase/client";
import { lastError, lastSyncAt, SYNCED_EVENT, syncOnce } from "@/lib/sync/client";
import { pendingCount, retryParked } from "@/lib/sync/outbox";
import { HELD_LINE, legacyHeldCount } from "@/lib/device/legacy-adoption";
import AutoHeight from "@/components/ui/AutoHeight";
import Button, { type ButtonStatus } from "@/components/ui/Button";
import { useButtonStatus } from "@/components/ui/useButtonStatus";

export type SyncStatusState = {
  email: string | null;
  pending: number;
  lastSync: string | null;
  error: string | null;
  syncing: boolean;
  loaded: boolean;
  /** Changes the old build left on this phone that no account can prove it owns (spec §0.6):
   *  counted, never sent, never shown in detail. */
  held?: number;
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}

/** The caption under the email/"Signed out" line: what to do, or what is still queued. */
export function statusLine(state: SyncStatusState): string {
  if (!state.loaded) return "Checking sync status…";
  if (state.email === null) {
    const pending = state.pending > 0
      ? ` ${state.pending} change${state.pending === 1 ? "" : "s"} waiting to send.`
      : "";
    return `This phone only. Sign in to see the same list on every device.${pending}`;
  }
  if (state.error !== null) {
    return `Last try failed (${state.error}). Your data is safe on this phone.`;
  }
  const suffix =
    state.pending > 0
      ? ` ${state.pending} change${state.pending === 1 ? "" : "s"} waiting to send.`
      : " Everything is sent.";
  return `Last synced ${ago(state.lastSync)}.${suffix}`;
}

/**
 * Who is signed in, the caption, and the manual sync button: a row of the one Data & account card
 * (U17, 2026-10-04), so it draws no card of its own. The email takes the full width (it used to
 * break mid-word beside the button); Sync now sits at the end of the status line and confirms in
 * itself ("Synced").
 */
export function SyncCard({ state, onSync, syncStatus }: {
  state: SyncStatusState; onSync: () => void; syncStatus?: ButtonStatus;
}) {
  const signedOut = state.email === null;
  return (
    <section aria-label="Sync" className="flex flex-col gap-1 p-4">
      <p className="m-0 text-caption text-muted">Account email</p>
      <p className="m-0 text-body-sm font-semibold text-graphite [overflow-wrap:anywhere]">
        {!state.loaded ? "Checking…" : signedOut ? "Signed out" : state.email}
      </p>
      <div className="flex items-center justify-between gap-3">
        {/* While a sync runs the caption says so; the button keeps one label and shows its dots,
            so it never changes width under the finger. */}
        <AutoHeight className="min-w-0 flex-1">
          <p className="m-0 text-caption text-muted" aria-live="polite">
            {state.syncing ? state.error === null ? "Syncing…" : "Retrying…" : statusLine(state)}
          </p>
          {(state.held ?? 0) > 0 && (
            <p className="m-0 mt-1 text-caption text-muted">{HELD_LINE(state.held ?? 0)}</p>
          )}
        </AutoHeight>
        {state.loaded && !signedOut && (
          <Button variant="secondary" size="sm" onClick={onSync} status={syncStatus}
            confirmLabel="Synced" errorLabel="Try again" className="shrink-0">
            Sync now
          </Button>
        )}
      </div>
    </section>
  );
}

/** Register the signals that make the locally persisted status stale. */
export function listenForSyncStatusRefresh(target: EventTarget, refresh: () => void): () => void {
  const signals = [SYNCED_EVENT, BODY_PROFILE_CHANGED_EVENT];
  for (const signal of signals) target.addEventListener(signal, refresh);
  return () => {
    for (const signal of signals) target.removeEventListener(signal, refresh);
  };
}

type SyncIdentityClient = {
  auth: {
    getSession: () => Promise<{ data: {
      session: { user: { email?: string | null } } | null;
    } }>;
  };
};

/** Read the local queue and the identity shown on this device as one status snapshot. */
export async function loadSyncStatus(
  client: SyncIdentityClient = browserClient(),
  h: AccountHandle | null = currentAccountOrNull(),
): Promise<Pick<SyncStatusState, "email" | "pending" | "lastSync" | "error" | "held">> {
  const { data } = await client.auth.getSession();
  // Phase 9 §0.2: the queue of the bound account only; with none bound there is nothing to count.
  const [pending, lastSync, error] = h === null ? [0, null, null] : await Promise.all([
    pendingCount(h), lastSyncAt(h), lastError(h),
  ]);
  // An unreadable legacy database is not a reason to fail the card; it is kept, and counted later.
  const held = await legacyHeldCount().catch(() => 0);
  return { email: data.session?.user.email ?? null, pending, lastSync, error, held };
}

/** Settings row: who is signed in, what is still queued, when this phone last agreed with the server. */
export default function SyncStatus() {
  const [state, setState] = useState<SyncStatusState>({
    email: null, pending: 0, lastSync: null, error: null, syncing: false, loaded: false,
  });

  const refresh = useCallback(async () => {
    try {
      const snapshot = await loadSyncStatus();
      setState((s) => ({
        ...s, ...snapshot, loaded: true,
      }));
    } catch {
      // Keep the row visible and fall back to the honest signed-out state.
      setState((s) => ({ ...s, email: null, loaded: true }));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const onStale = () => void refresh();
    const stop = listenForSyncStatusRefresh(window, onStale);
    const t = window.setInterval(onStale, 30_000);
    return () => {
      stop();
      window.clearInterval(t);
    };
  }, [refresh]);

  const button = useButtonStatus();
  const handleSync = async () => {
    setState((s) => ({ ...s, syncing: true }));
    // The user's one deliberate action is also the release for anything this device parked.
    const h = currentAccountOrNull();
    await button.run(async () => {
      if (h === null) return;
      await retryParked(h).catch(() => undefined);
      // A pass that ran but could not send everything is not "Synced": the button says Try again.
      const { push } = await syncOnce(h);
      if (push.failed) throw new Error("some changes could not be sent");
    });
    setState((s) => ({ ...s, syncing: false }));
    await refresh();
  };

  return <SyncCard state={state} onSync={() => void handleSync()} syncStatus={button.status} />;
}
