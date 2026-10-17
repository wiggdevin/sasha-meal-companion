"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import GlassSelect from "@/components/ui/GlassSelect";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import ShoppingView from "@/components/ShoppingView";
import RuleReviewCard from "@/components/RuleReviewCard";
import ShoppingFocusToggle from "@/components/ShoppingFocusToggle";
import { defaultShoppingDraft, realCalendarDate, type ShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingPreviewData } from "@/components/ShoppingPreview";
import type { ShoppingViewActions, ShoppingPreviewInput } from "@/components/ShoppingView";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import { accountHandle, assertCurrent, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { loadStore } from "@/lib/store";
import { cookingEffortFromDietPrefs } from "@/lib/sync/user-settings";
import { acceptShopping, addManualShoppingLine, confirmPantryForLine, createShoppingPeriod, deleteShoppingLine,
  getShoppingPeriod, listPantry, listShoppingPeriods, patchShoppingLine, patchShoppingPurchaseWindow,
  previewShopping, removePantryItem, ShoppingStaleRevision, type ShoppingSnapshot } from "@/lib/shopping-client";
import type { PantryItem, ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";
import { ruleMarkKey } from "@/lib/rule-mark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";

function dateInZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function initialDraft(): ShoppingDraft {
  const settings = loadStore().settings;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const draft = defaultShoppingDraft(dateInZone(timezone), timezone);
  const effort = cookingEffortFromDietPrefs(settings.dietPrefs);
  return { ...draft, effort: effort === "none" || effort === "minimal" ? effort : "standard" };
}
function draftFromPeriod(period: ShoppingPeriod): ShoppingDraft {
  return { startDate: period.startDate, endDate: period.endDate,
    timezone: period.timezone, people: period.people, mealCoverage: period.mealCoverage,
    mode: period.mode, effort: period.effort, maxActiveMinutes: period.maxActiveMinutes,
    variety: period.variety, budgetAmount: period.budgetAmount, currency: period.currency,
    locale: period.locale, lockMode: period.lockMode };
}
function locationKey(userId: string): string { return `shopping-location:${userId}`; }
function storesKey(userId: string): string { return `shopping-stores:${userId}`; }
function savedLocation(userId: string): string | null {
  try { return window.localStorage.getItem(locationKey(userId)); } catch { return null; }
}
function rememberLocation(userId: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(locationKey(userId), value);
    else window.localStorage.removeItem(locationKey(userId));
  } catch { /* Storage is optional; an accepted period still retains its location. */ }
}
function savedStores(userId: string): string {
  try { return window.localStorage.getItem(storesKey(userId)) ?? ""; } catch { return ""; }
}
function rememberStores(userId: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(storesKey(userId), value);
    else window.localStorage.removeItem(storesKey(userId));
  } catch { /* Store notes remain optional. */ }
}
function snapshotFingerprint(next: ShoppingSnapshot, stock: PantryItem[]): string {
  // Marks are judged on every read, not stored, so a rule change moves them with no new revision:
  // they are part of the fingerprint, or an open preview would keep showing the old marks.
  const versions = (rows: { id: string; revision: number; ruleMark?: RuleMarkValue | null }[]) =>
    rows.map((row) => `${row.id}:${row.revision}:${ruleMarkKey(row.ruleMark)}`).sort();
  return JSON.stringify([next.period?.id, next.period?.revision, next.period?.planRevision,
    versions(next.lines), versions(next.purchaseWindows ?? []), versions(stock)]);
}

function BlankListFeedback({ enabled, disabled, busy, onSave }: {
  enabled: boolean; disabled: boolean; busy: boolean; onSave: () => Promise<void>;
}) {
  const feedback = useActionFeedback();
  return <>
    {enabled && <Button disabled={disabled || feedback.controlProps.disabled}
      className={feedback.controlProps.className} data-feedback-state={feedback.controlProps["data-feedback-state"]}
      aria-busy={feedback.controlProps["aria-busy"]}
      // The button gives way to the new list when this lands, so the confirmation is the notice.
      onClick={() => { void feedback.run(onSave, { kind: "commit", confirm: "notice", successMessage: "Shopping list started.",
        failureMessage: (cause) => cause instanceof Error ? cause.message : "Could not save this list." }); }}>
      {busy ? "Starting list…" : "Start an empty list"}</Button>}
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </>;
}

export default function ShoppingRoot() {
  const [owner, setOwner] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [snapshot, setSnapshot] = useState<ShoppingSnapshot>({ period: null, lines: [] });
  const [periods, setPeriods] = useState<ShoppingPeriod[]>([]);
  const selectedId = useRef<string | null>(null);
  const hasSelection = useRef(false);
  const blankRequestId = useRef<string | null>(null);
  const refreshSerial = useRef(0);
  const fingerprint = useRef<string | null>(null);
  const blankSaveSerial = useRef(0);
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [draft, setDraft] = useState<ShoppingDraft | null>(null);
  const [storeNotes, setStoreNotes] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [blankBusy, setBlankBusy] = useState(false);
  const [invalidateRevision, setInvalidateRevision] = useState(0);
  /** The list the view was opened on. A list this view just started keeps its key, so the toast
   *  that says so survives (only switching lists remounts the view). */
  const [viewKey, setViewKey] = useState("new");

  const refresh = useCallback(async (account: AccountHandle, chooseId?: string | null) => {
    const serial = ++refreshSerial.current;
    try {
      const seed = { ...initialDraft(), locale: savedLocation(account.userId) };
      const [periods, stock] = await Promise.all([listShoppingPeriods(), listPantry()]);
      if (serial !== refreshSerial.current) return;
      const period = chooseId === null ? null : periods.find((row) => row.id === (chooseId ?? selectedId.current))
        ?? (chooseId === undefined && !hasSelection.current
          ? periods.find((row) => row.startDate <= seed.startDate && row.endDate >= seed.startDate)
            ?? periods[0] : null);
      if (chooseId && !period) throw new Error("That saved list is no longer available. Refresh and choose another.");
      const next = period ? await getShoppingPeriod(period.id) : { period: null, lines: [] };
      if (serial !== refreshSerial.current) return;
      assertCurrent(account);
      const changed = selectedId.current !== (next.period?.id ?? null);
      if (changed) setViewKey(next.period?.id ?? "new");
      const nextFingerprint = snapshotFingerprint(next, stock);
      if (fingerprint.current !== nextFingerprint) setInvalidateRevision((value) => value + 1);
      fingerprint.current = nextFingerprint;
      selectedId.current = next.period?.id ?? null;
      hasSelection.current = true;
      setPeriods(periods); setSnapshot(next); setPantry(stock);
      setDraft((current) => changed || !current ? next.period ? draftFromPeriod(next.period) : seed : current);
      setStatus("ready"); setError(null);
    } catch (cause) {
      if (serial === refreshSerial.current) throw cause;
    }
  }, []);
  useEffect(() => {
    const ready = onAccountReady((account) => {
      refreshSerial.current += 1;
      fingerprint.current = null;
      blankSaveSerial.current += 1;
      selectedId.current = null;
      hasSelection.current = false;
      blankRequestId.current = null;
      setOwner(account); setSnapshot({ period: null, lines: [] }); setPeriods([]); setPantry([]); setViewKey("new");
      setStoreNotes(savedStores(account.userId));
      setDraft(null); setBlankBusy(false); setStatus("loading");
      void refresh(account).catch((cause) => {
        if (!currentAccountOrNull() || currentAccountOrNull()?.epoch !== account.epoch) return;
        setStatus("error"); setError(cause instanceof Error ? cause.message : "Shopping could not load.");
      });
    });
    const gone = onAccountGone(() => {
      refreshSerial.current += 1;
      fingerprint.current = null;
      blankSaveSerial.current += 1;
      selectedId.current = null;
      hasSelection.current = false;
      blankRequestId.current = null;
      setOwner(null); setSnapshot({ period: null, lines: [] }); setPeriods([]); setPantry([]); setViewKey("new");
      setDraft(null); setStoreNotes(""); setBlankBusy(false);
      setStatus("loading"); setError(null);
    });
    return () => { ready(); gone(); };
  }, [refresh]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      const account = currentAccountOrNull();
      if (account) void refresh(account).catch((cause) => {
        if (currentAccountOrNull()?.epoch === account.epoch)
          setError(cause instanceof Error ? cause.message : "Shopping could not refresh.");
      });
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [refresh]);

  async function update() { await refresh(accountHandle()); }
  async function recoverStaleEdit(account: AccountHandle, cause: unknown): Promise<never> {
    if (!(cause instanceof ShoppingStaleRevision)) throw cause;
    assertCurrent(account);
    try { await refresh(account); }
    catch {
      assertCurrent(account);
      throw new Error("Shopping changed elsewhere. Reload this list and retry the edit.");
    }
    assertCurrent(account);
    throw new Error("Shopping changed elsewhere. The latest list loaded; retry the edit.");
  }
  /** This week's list, saved now: the first quick add needs a list to land on. */
  async function startList(account: AccountHandle): Promise<ShoppingPeriod> {
    const saved = await createShoppingPeriod(draft ?? initialDraft(), crypto.randomUUID());
    assertCurrent(account);
    selectedId.current = saved.id; hasSelection.current = true;
    setPeriods((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
    setSnapshot({ period: saved, lines: [] });
    return saved;
  }
  async function saveBlankList() {
    if (!draft || snapshot.period || blankBusy) return;
    const account = accountHandle();
    const saveSerial = ++blankSaveSerial.current;
    const requestId = blankRequestId.current ?? crypto.randomUUID();
    blankRequestId.current = requestId;
    setError(null);
    setBlankBusy(true);
    try {
      const saved = await createShoppingPeriod(draft, requestId);
      assertCurrent(account);
      blankRequestId.current = null;
      selectedId.current = saved.id; hasSelection.current = true;
      setPeriods((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
      setSnapshot({ period: saved, lines: [] });
      try { await refresh(account, saved.id); }
      catch {
        assertCurrent(account);
        setError("List saved. Its latest contents could not reload yet. Use Retry to refresh.");
      }
    } finally { if (saveSerial === blankSaveSerial.current) setBlankBusy(false); }
  }
  const actions: ShoppingViewActions = {
    preview: async (input: ShoppingPreviewInput): Promise<ShoppingPreviewData> => {
      const account = accountHandle();
      const proof = await previewShopping(input, snapshot.period);
      assertCurrent(account);
      const requestId = crypto.randomUUID();
      return { period: proof.period, lines: proof.lines, choices: proof.choices,
        issues: proof.informationalIssues, blockingIssues: proof.blockingIssues,
        unmetPins: proof.unmetPins, windows: proof.windows, replenishment: proof.replenishment,
        unfilledSlots: proof.unfilledSlots, proposedAdditions: proof.proposedAdditions,
        compromise: proof.compromise, price: proof.price,
        accept: async () => {
          assertCurrent(account);
          const accepted = await acceptShopping(proof.previewId, requestId);
          assertCurrent(account);
          selectedId.current = accepted.period?.id ?? null; hasSelection.current = true;
          setSnapshot(accepted);
          window.dispatchEvent(new Event("recipe-plan-accepted"));
          try { await refresh(account, accepted.period?.id ?? null); }
          catch { assertCurrent(account); setError("Plan accepted. The latest shopping list could not refresh yet."); }
        } };
    },
    patchLine: async (line: ShoppingLine, patch: ShoppingLinePatch) => {
      const account = accountHandle();
      const saved = await patchShoppingLine(line, patch).catch((cause) => recoverStaleEdit(account, cause));
      assertCurrent(account);
      setSnapshot((current) => current.period?.id === line.periodId
        ? { ...current, lines: current.lines.map((row) => row.id === saved.id ? saved : row) } : current);
      try { await update(); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Item saved. The latest shopping list could not refresh yet."); }
    },
    patchWindow: async (window, patch) => {
      const account = accountHandle();
      const saved = await patchShoppingPurchaseWindow(window, patch).catch((cause) => recoverStaleEdit(account, cause));
      assertCurrent(account);
      setSnapshot((current) => current.period?.id === window.periodId
        ? { ...current, purchaseWindows: (current.purchaseWindows ?? [])
          .map((row) => row.id === saved.id ? saved : row) } : current);
      try { await update(); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Week item saved. The latest shopping list could not refresh yet."); }
    },
    confirmPantry: async (line: ShoppingLine, grams: number) => {
      const account = accountHandle();
      const saved = await confirmPantryForLine(line, grams).catch((cause) => recoverStaleEdit(account, cause));
      assertCurrent(account);
      setPantry((current) => [...current.filter((row) => row.id !== saved.id), saved]);
      try { await update(); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Stock saved. The latest shopping list could not refresh yet."); }
    },
    addItems: async (names: string[]) => {
      const account = accountHandle();
      const period = snapshot.period ?? await startList(account);
      const results = await Promise.allSettled(names.map((name) =>
        addManualShoppingLine(period.id, name, crypto.randomUUID())));
      assertCurrent(account);
      const saved = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      setSnapshot((current) => current.period?.id === period.id ? { ...current, lines: [
        ...current.lines.filter((row) => !saved.some((line) => line.id === row.id)), ...saved] } : current);
      try { await refresh(account, period.id); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Items added. The latest shopping list could not refresh yet."); }
      const failed = results.length - saved.length;
      if (failed) throw new Error(failed === results.length ? "Those items did not save. Try again."
        : `${failed} of ${results.length} items did not save. Try again.`);
    },
    removeLine: async (line: ShoppingLine) => {
      const account = accountHandle();
      await deleteShoppingLine(line).catch((cause) => recoverStaleEdit(account, cause));
      assertCurrent(account);
      setSnapshot((current) => ({ ...current, lines: current.lines.filter((row) => row.id !== line.id) }));
      try { await update(); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Item removed. The latest shopping list could not refresh yet."); }
    },
    removePantry: async (item: PantryItem) => {
      const account = accountHandle();
      await removePantryItem(item).catch((cause) => recoverStaleEdit(account, cause));
      assertCurrent(account);
      setPantry((current) => current.filter((row) => row.id !== item.id));
      try { await update(); }
      catch { if (currentAccountOrNull()?.epoch === account.epoch)
        setError("Removed. The latest shopping list could not refresh yet."); }
    },
    refresh: update,
  };
  if (!owner || status === "loading") return <p role="status">Loading shopping…</p>;
  if (status === "error") return <Notice tone="error" title={error ?? undefined} action={{ label: "Retry", onClick: () => {
    setStatus("loading"); void refresh(accountHandle()).catch((cause) => {
      setStatus("error"); setError(cause instanceof Error ? cause.message : "Shopping could not load.");
    });
  } }} />;
  return <>
    {error && <Notice tone="error" title={error} action={{ label: "Retry", onClick: () => {
      void update().catch((cause) => setError(cause instanceof Error ? cause.message : "Shopping could not refresh."));
    } }} />}
    <ShoppingView key={`${owner.epoch}:${viewKey}`} period={snapshot.period} lines={snapshot.lines}
      pantry={pantry} purchaseWindows={snapshot.purchaseWindows ?? []}
      initialDraft={draft ?? initialDraft()} actions={actions}
      storeNotes={storeNotes} onStoreNotesChange={(value) => {
        setStoreNotes(value); rememberStores(owner.userId, value);
      }}
      onDraftChange={(next) => { setDraft(next); blankRequestId.current = null;
        if (next.locale !== draft?.locale) rememberLocation(owner.userId, next.locale); }}
      invalidateRevision={invalidateRevision}
      onPantryPhoto={(items) => setPantry((current) =>
        [...current.filter((row) => !items.some((item) => item.id === row.id)), ...items])}
      favorites={Object.values(loadStore().foods).filter((food) => food.status === "eats")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((food) => food.name)}
      switcher={periods.length > 0 ? <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1"><GlassSelect aria-label="Open shopping list"
          value={snapshot.period?.id ?? "new"}
          onChange={(id) => { void refresh(owner, id === "new" ? null : id).catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Could not open this list.")); }}
          options={[{ value: "new", label: "New list" }, ...periods.map((row) => ({
            value: row.id, label: `${row.startDate} – ${row.endDate}` }))]} /></div>
        <Button onClick={() => { void refresh(owner, null).catch((cause) =>
          setError(cause instanceof Error ? cause.message : "Could not start a new list.")); }}>New list</Button>
      </div> : null}
      planNotice={<><RuleReviewCard /><ShoppingFocusToggle /></>}
      emptyList={<div className="flex flex-col items-start gap-2">
        <Notice tone="neutral" title={<>{periods.length === 0 ? "No saved lists yet. " : ""}Add items above,
          tap a Favorite, or plan meals below to fill your list.</>} />
        <BlankListFeedback key={owner.epoch} enabled={!snapshot.period} busy={blankBusy}
          disabled={blankBusy || !draft || !realCalendarDate(draft.startDate) ||
            !realCalendarDate(draft.endDate) || draft.endDate < draft.startDate || draft.people < 1}
          onSave={saveBlankList} />
      </div>} />
  </>;
}
