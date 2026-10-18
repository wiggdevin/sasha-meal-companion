/**
 * App-initiated sign-out (Phase 9 slice 1, reload boundary). The account's state is made durable
 * first (lib/device/departure.ts); only then is the session removed, and the page reloads. If the
 * session cannot be removed, the departure blocks with Retry and the page does not reload.
 */
import { currentAccountOrNull } from "./account";
import { beginDeparture, departurePhase, isDeparting, type DeparturePhase } from "./departure";
import { pendingTotal, pendingWork } from "./forget";

type AuthPort = {
  signOut: () => Promise<{ error: unknown }>;
  getSession: () => Promise<{ data: { session: unknown } }>;
};

function sessionUser(session: unknown): string | null {
  const id = (session as { user?: { id?: unknown } } | null)?.user?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Sign `userId` — the account the user tapped Sign out for — out of this phone. Nothing happens
 * when this page has already left that account (reload review r1 #9: a sign-out tapped as A must
 * never remove B's session), nor when the session no longer belongs to it.
 */
export function signOutHere(auth: AuthPort, userId: string): Promise<DeparturePhase> {
  if (isDeparting() || currentAccountOrNull()?.userId !== userId) {
    return Promise.resolve(departurePhase());
  }
  return beginDeparture({
    announce: true,
    signOut: async () => {
      const before = sessionUser((await auth.getSession()).data.session);
      if (before !== userId) return; // already signed out, or another account's session now
      // supabase-js removes the local session even when the revoke call fails offline; what
      // matters here is only that no session of this account is left on this phone.
      await auth.signOut();
      if (sessionUser((await auth.getSession()).data.session) === userId) {
        throw new Error("session_not_removed");
      }
    },
  });
}

/** The sign-out notice for the account's unsent work, or null when nothing is waiting. */
export async function signOutNotice(userId: string): Promise<string | null> {
  const total = pendingTotal(await pendingWork(userId));
  if (total === null) return "Some changes may not be synced yet. They stay on this phone.";
  if (total === 0) return null;
  if (total === 1) return "1 change is not synced yet. It stays on this phone and sends when you sign in again.";
  return `${total} changes are not synced yet. They stay on this phone and send when you sign in again.`;
}
