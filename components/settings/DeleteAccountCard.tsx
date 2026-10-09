"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import ConfirmSheet from "@/components/ui/ConfirmSheet";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import { useButtonStatus } from "@/components/ui/useButtonStatus";
import { SignInCodeForm } from "@/components/SignInCodeForm";
import { verifyOtpCode } from "@/app/sign-in/otp";
import {
  readAccountDeletionEnabled, requestAccountDeletion, type AccountDeleteOutcome,
} from "@/lib/account-delete-client";
import { currentAccountOrNull, isCurrent, type AccountHandle } from "@/lib/device/account";
import { eraseDeletedAccountHere } from "@/lib/device/erase";
import { downloadExport } from "@/lib/export-client";
import { browserClient } from "@/lib/supabase/client";
import { CAPTION } from "./settings-styles";

/** What the deletion removes, in the words the row shows. */
export const DELETED_ITEMS = [
  "Every meal, water and weight log, and your notes",
  "Your foods, food rules, recipes, plans and shopping lists",
  "Coach chats, photos and voice recordings",
  "Your profile, targets, health connections and settings",
];

export const CONFIRM_WORD = "DELETE";

type Stage = "idle" | "explain" | "confirm" | "deleting" | "reauth" | "leaving";

const FAILURE: Partial<Record<AccountDeleteOutcome, string>> = {
  failed: "Your account was not deleted. Check your connection and try again.",
  rate_limited: "Too many tries. Wait a few minutes, then try again.",
  not_enabled: "Account deletion is not available right now.",
  signed_out: "Your session ended. Sign in again, then delete your account.",
};

/**
 * Settings → Data & account → Delete account (reconciliation audit 2026-10-08). Never one tap:
 * the row opens an explanation of what is deleted with "Download my data first"; the delete button
 * stays off until the user types DELETE; a final sheet asks once more. A session older than 10
 * minutes is confirmed with a sign-in code first (the server answers `reauth_required`). On
 * success this phone signs out, erases the account's data here and lands on the sign-in page.
 *
 * Hidden unless the server says the feature is on (`GET /api/account/delete/enabled`; any error
 * reads as off).
 */
export default function DeleteAccountCard() {
  const [account] = useState(currentAccountOrNull);
  const enabled = useDeletionEnabled(account);
  const flow = useDeleteFlow(account);
  if (!enabled || account === null) return null;
  return (
    <section aria-label="Delete account" className="flex flex-col gap-3 p-4">
      {flow.stage === "idle" ? <IdleRow onOpen={flow.open} /> : <Explain flow={flow} />}
      {flow.stage === "confirm" ? (
        <ConfirmSheet title="Delete your account?" destructive confirmLabel="Delete forever"
          onConfirm={flow.confirm} onCancel={flow.back}>
          Your account and everything in it are deleted for good. This cannot be undone.
        </ConfirmSheet>
      ) : null}
    </section>
  );
}

function useDeletionEnabled(account: AccountHandle | null): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (account === null) return;
    let live = true;
    void readAccountDeletionEnabled(account).then((on) => { if (live) setEnabled(on); }, () => {});
    return () => { live = false; };
  }, [account]);
  return enabled;
}

type Flow = ReturnType<typeof useDeleteFlow>;

function useDeleteFlow(account: AccountHandle | null) {
  const [stage, setStage] = useState<Stage>("idle");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  const remove = async (): Promise<void> => {
    if (account === null || !isCurrent(account)) { setError(FAILURE.failed as string); setStage("explain"); return; }
    setStage("deleting");
    setError(null);
    const outcome = await requestAccountDeletion(account);
    if (outcome === "deleted") {
      setStage("leaving");
      void eraseDeletedAccountHere(browserClient().auth, account.userId);
      return;
    }
    if (outcome === "reauth_required") { await startReauth(setEmail, setError); setStage("reauth"); return; }
    setError(FAILURE[outcome] ?? (FAILURE.failed as string));
    setStage("explain");
  };

  return {
    stage, typed, error, email, account,
    open: () => { setStage("explain"); setError(null); },
    cancel: () => { setStage("idle"); setTyped(""); setError(null); },
    ask: () => { if (typed.trim() === CONFIRM_WORD) setStage("confirm"); },
    back: () => setStage("explain"),
    confirm: () => { void remove(); },
    setTyped,
    verify: async (code: string): Promise<string | null> => {
      const failed = await verifyOtpCode(browserClient().auth, email, code);
      if (failed) return failed;
      void remove();
      return null;
    },
  };
}

/** Sends this account's own email a sign-in code; the code form under it confirms. */
async function startReauth(setEmail: (e: string) => void, setError: (e: string | null) => void): Promise<void> {
  const auth = browserClient().auth;
  const address = (await auth.getSession()).data.session?.user?.email ?? "";
  setEmail(address);
  if (!address) { setError("Sign in again, then delete your account."); return; }
  const { error } = await auth.signInWithOtp({ email: address, options: { shouldCreateUser: false } });
  if (error) setError("That code did not send. Try again in a minute.");
}

function IdleRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className={`m-0 min-w-0 ${CAPTION}`}>Delete your account and everything in it.</p>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={onOpen}>Delete account</Button>
    </div>
  );
}

function Explain({ flow }: { flow: Flow }) {
  const busy = flow.stage === "deleting" || flow.stage === "leaving";
  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-heading-sm text-charcoal">Delete account</h3>
      <p className="m-0 text-caption font-normal text-graphite">
        This deletes your account for good. It cannot be undone. We delete:
      </p>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-caption font-normal text-graphite">
        {DELETED_ITEMS.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <DownloadFirst account={flow.account} />
      {flow.stage === "reauth" ? <Reauth flow={flow} /> : <TypeToConfirm flow={flow} busy={busy} />}
      {flow.error ? <Notice tone="error" title={flow.error} /> : null}
      {flow.stage === "leaving" ? <p role="status" className="m-0 text-caption text-graphite">Account deleted. Signing out…</p> : null}
    </div>
  );
}

function DownloadFirst({ account }: { account: AccountHandle | null }) {
  const status = useButtonStatus();
  const [failed, setFailed] = useState(false);
  const download = (): void => {
    if (account === null || !isCurrent(account)) { setFailed(true); return; }
    setFailed(false);
    void status.run(async () => {
      await downloadExport(account, "meals", "", "");
      await downloadExport(account, "progress", "", "");
    }).then((outcome) => { if (!outcome.ok) setFailed(true); });
  };
  return (
    <div className="flex flex-col gap-2">
      <Button variant="tertiary" block status={status.status} confirmLabel="Downloaded" onClick={download}>
        Download my data first
      </Button>
      {failed ? <Notice tone="error" title="Could not download. Try again." /> : null}
    </div>
  );
}

function TypeToConfirm({ flow, busy }: { flow: Flow; busy: boolean }) {
  const ready = flow.typed.trim() === CONFIRM_WORD;
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); flow.ask(); }}>
      <Field id="delete-account-confirm" label={`Type ${CONFIRM_WORD} to confirm`} value={flow.typed}
        autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy}
        onChange={(e) => flow.setTyped(e.target.value)} />
      <Button type="submit" variant="danger" block disabled={!ready || busy}
        status={flow.stage === "deleting" ? "pending" : "idle"}>
        Delete account
      </Button>
      <Button type="button" variant="tertiary" block disabled={busy} onClick={flow.cancel}>Cancel</Button>
    </form>
  );
}

function Reauth({ flow }: { flow: Flow }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="m-0 text-caption font-normal text-graphite">
        To keep your account safe, confirm it is you. We sent a sign-in code
        {flow.email ? ` to ${flow.email}` : ""}. Enter it to delete your account.
      </p>
      <SignInCodeForm onVerify={flow.verify} startOpen />
      <Button type="button" variant="tertiary" block onClick={flow.cancel}>Cancel</Button>
    </div>
  );
}
