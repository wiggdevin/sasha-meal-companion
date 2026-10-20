"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import BuildListSlot from "@/components/shopping/BuildListSlot";
import SavedListSwitcher from "@/components/shopping/SavedListSwitcher";
import SavedListsSheet from "@/components/shopping/SavedListsSheet";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import ShoppingView from "@/components/ShoppingView";
import RuleReviewCard from "@/components/RuleReviewCard";
import ShoppingFocusToggle from "@/components/ShoppingFocusToggle";
import { defaultShoppingDraft, draftProblem, type ShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingPreviewData } from "@/components/ShoppingPreview";
import type { ShoppingViewActions, ShoppingPreviewInput } from "@/components/ShoppingView";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import { AccountChanged, AccountNotBound, accountHandle, assertCurrent, currentAccountOrNull, onAccountGone,
  onAccountReady, type AccountHandle } from "@/lib/device/account";
import { loadStore } from "@/lib/store";
import { cookingEffortFromDietPrefs } from "@/lib/sync/user-settings";
import { acceptShopping, addManualShoppingLine, confirmPantryForLine, createShoppingPeriod, deleteShoppingLine,
  getShoppingPeriod, listPantry, listShoppingPeriods, patchShoppingLine, patchShoppingPurchaseWindow,
  previewShopping, removePantryItem, ShoppingRequestFailed, ShoppingStaleRevision,
  type ShoppingSnapshot } from "@/lib/shopping-client";
import type { PantryItem, ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";
import { ruleMarkKey } from "@/lib/rule-mark";
import { currentShoppingPeriod } from "@/lib/shopping/current";
import { deleteShoppingPeriod, renameShoppingPeriod } from "@/lib/shopping/list-client";
import { cycleOrder, listName, stepList } from "@/lib/shopping/saved-lists";
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
    locale: period.locale, lockMode: period.lockMode, title: period.title ?? null };
}
/** How long a deleted list waits for its Undo before the delete is sent. */
/* A second past the Undo toast (ActionFeedback's 5 s), so Undo is never on screen after the send. */
const DELETE_HOLD_MS = 6_000;
/** A pending delete older than this is dropped rather than sent: the list comes back. */
const PENDING_DELETE_MAX_MS = 7 * 86_400_000;
/** A list delete not yet confirmed by the server, kept on the device so a reload, a closed tab or
 *  an account switch never loses it: it is sent again on the next open, and the list stays hidden. */
type PendingDelete = { id: string; revision: number; requestId: string; at: number };
function pendingKey(userId: string): string { return `shopping-pending-deletes:${userId}`; }
function readPendingDeletes(userId: string): PendingDelete[] {
  try {
    const rows: unknown = JSON.parse(window.localStorage.getItem(pendingKey(userId)) ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is PendingDelete => typeof row?.id === "string" && Number.isInteger(row?.revision)
      && typeof row?.requestId === "string" && typeof row?.at === "number"
      && Date.now() - row.at < PENDING_DELETE_MAX_MS).slice(0, 50);
  } catch { return []; }
}
function writePendingDeletes(userId: string, rows: PendingDelete[]): void {
  try {
    if (rows.length) window.localStorage.setItem(pendingKey(userId), JSON.stringify(rows));
    else window.localStorage.removeItem(pendingKey(userId));
  } catch { /* Storage blocked: the delete still waits in memory for its Undo. */ }
}
function rememberPendingDelete(userId: string, entry: PendingDelete): void {
  writePendingDeletes(userId, [...readPendingDeletes(userId).filter((row) => row.id !== entry.id), entry]);
}
function forgetPendingDelete(userId: string, id: string): void {
  writePendingDeletes(userId, readPendingDeletes(userId).filter((row) => row.id !== id));
}
/** Fired by "Have AI build my list" when it saves a list, so the switcher opens it. */
export const SHOPPING_LIST_SAVED_EVENT = "shopping-list-saved";
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

function BlankListFeedback({ enabled, disabled, problem, busy, onSave }: {
  enabled: boolean; disabled: boolean; busy: boolean; onSave: () => Promise<void>;
  /** Why the list cannot start yet, said beside the button rather than leaving it grey. */
  problem?: string | null;
}) {
  const feedback = useActionFeedback();
  return <>
    {enabled && problem && <p className="m-0 text-tiny text-muted">{problem} Fix it in the planner below.</p>}
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
  /** The new-list request in flight or last refused, so a retry of the same list reuses its id. */
  const createRequest = useRef<{ key: string; id: string } | null>(null);
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
  const [listsOpen, setListsOpen] = useState(false);
  /** Lists deleted on screen whose delete waits out its Undo: id → its timer and its send. */
  const held = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>());
  /** Ids whose delete was sent and not yet answered: a flush never sends one twice at once. */
  const sending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const listFeedback = useActionFeedback();

  const refresh = useCallback(async (account: AccountHandle, chooseId?: string | null) => {
    const serial = ++refreshSerial.current;
    try {
      const seed = { ...initialDraft(), locale: savedLocation(account.userId) };
      const [periods, stock] = await Promise.all([listShoppingPeriods(), listPantry()]);
      if (serial !== refreshSerial.current) return;
      const pending = new Set(readPendingDeletes(account.userId).map((row) => row.id));
      const live = periods.filter((row) => !held.current.has(row.id) && !pending.has(row.id));
      const period = chooseId === null ? null : live.find((row) => row.id === (chooseId ?? selectedId.current))
        ?? (chooseId === undefined && !hasSelection.current
          ? currentShoppingPeriod(live, seed.startDate) ?? cycleOrder(live)[0] ?? null : null);
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
      setPeriods(live); setSnapshot(next); setPantry(stock);
      setDraft((current) => changed || !current ? next.period ? draftFromPeriod(next.period) : seed : current);
      setStatus("ready"); setError(null);
    } catch (cause) {
      if (serial === refreshSerial.current) throw cause;
    }
  }, []);
  /** Sends one delete. A final answer forgets it (a 404 means it is already gone); a transient
   *  failure or an account switch keeps it on the device for the next flush. */
  const sendDelete = useCallback((account: AccountHandle, entry: PendingDelete, name: string) => {
    if (sending.current.has(entry.id)) return;
    sending.current.add(entry.id);
    void deleteShoppingPeriod(entry.id, entry.revision, entry.requestId, account)
      .then(() => forgetPendingDelete(account.userId, entry.id))
      .catch((cause) => {
        if (cause instanceof AccountChanged || cause instanceof AccountNotBound) return;
        const status = cause instanceof ShoppingRequestFailed ? cause.status : null;
        const final = cause instanceof ShoppingStaleRevision
          || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429);
        if (!final) return;
        forgetPendingDelete(account.userId, entry.id);
        if (status === 404) return;
        if (!mounted.current || currentAccountOrNull()?.epoch !== account.epoch) return;
        // After the refresh, which clears the error line when it lands.
        void refresh(account).catch(() => undefined).finally(() => {
          if (mounted.current && currentAccountOrNull()?.epoch === account.epoch) {
            setError(`${name} was not deleted. It is back in your lists.`);
          }
        });
      })
      .finally(() => sending.current.delete(entry.id));
  }, [refresh]);
  /** Sends every delete left on the device whose Undo is over (one held on screen waits its turn). */
  const flushDeletes = useCallback((account: AccountHandle) => {
    for (const entry of readPendingDeletes(account.userId)) {
      if (!held.current.has(entry.id)) sendDelete(account, entry, "A list");
    }
  }, [sendDelete]);
  /** Sends the deletes still waiting on their Undo now (leaving Shopping, or the page going away). */
  const sendHeld = useCallback(() => {
    for (const { timer, send } of [...held.current.values()]) { clearTimeout(timer); send(); }
    held.current.clear();
  }, []);
  useEffect(() => {
    const ready = onAccountReady((account) => {
      refreshSerial.current += 1;
      fingerprint.current = null;
      blankSaveSerial.current += 1;
      selectedId.current = null;
      hasSelection.current = false;
      blankRequestId.current = null;
      createRequest.current = null;
      flushDeletes(account);
      setOwner(account); setSnapshot({ period: null, lines: [] }); setPeriods([]); setPantry([]); setViewKey("new");
      setStoreNotes(savedStores(account.userId));
      setDraft(null); setBlankBusy(false); setStatus("loading");
      void refresh(account).catch((cause) => {
        if (!currentAccountOrNull() || currentAccountOrNull()?.epoch !== account.epoch) return;
        setStatus("error"); setError(cause instanceof Error ? cause.message : "Shopping could not load.");
      });
    });
    const gone = onAccountGone(() => {
      // A delete still waiting on its Undo stays on the device and is sent when that account
      // opens Shopping again: sending now would go out under no account.
      for (const { timer } of held.current.values()) clearTimeout(timer);
      held.current.clear();
      refreshSerial.current += 1;
      fingerprint.current = null;
      blankSaveSerial.current += 1;
      selectedId.current = null;
      hasSelection.current = false;
      blankRequestId.current = null;
      createRequest.current = null;
      setOwner(null); setSnapshot({ period: null, lines: [] }); setPeriods([]); setPantry([]); setViewKey("new");
      setDraft(null); setStoreNotes(""); setBlankBusy(false);
      setStatus("loading"); setError(null);
    });
    return () => { ready(); gone(); };
  }, [refresh, flushDeletes]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      const account = currentAccountOrNull();
      if (account) flushDeletes(account);
      if (account) void refresh(account).catch((cause) => {
        if (currentAccountOrNull()?.epoch === account.epoch)
          setError(cause instanceof Error ? cause.message : "Shopping could not refresh.");
      });
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [refresh, flushDeletes]);

  useEffect(() => {
    // Leaving Shopping, or the page going away, sends any delete still waiting on its Undo. Each is
    // also on the device already, so a send the page closes on is retried at the next open.
    window.addEventListener("pagehide", sendHeld);
    return () => { window.removeEventListener("pagehide", sendHeld); sendHeld(); };
  }, [sendHeld]);
  useEffect(() => {
    const onSaved = (event: Event) => {
      const id = (event as CustomEvent<{ periodId?: unknown }>).detail?.periodId;
      const account = currentAccountOrNull();
      if (!account || typeof id !== "string") return;
      void refresh(account, id).catch((cause) => {
        if (currentAccountOrNull()?.epoch === account.epoch)
          setError(cause instanceof Error ? cause.message : "Your new list could not open yet.");
      });
    };
    window.addEventListener(SHOPPING_LIST_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(SHOPPING_LIST_SAVED_EVENT, onSaved);
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
  async function openList(account: AccountHandle, id: string | null) {
    await refresh(account, id).catch((cause) => {
      if (currentAccountOrNull()?.epoch === account.epoch)
        setError(cause instanceof Error ? cause.message : "Could not open this list.");
    });
  }
  async function createList(title: string | null, dates: { startDate: string; endDate: string }) {
    const account = accountHandle();
    const fresh = initialDraft();
    const base = draft ?? fresh;
    // The planner's people and meals carry over only when they could start a list.
    const usable = draftProblem({ ...base, ...dates }) === null;
    const next = { ...base, ...dates, title, lockMode: "none" as const,
      people: usable ? base.people : fresh.people, mealCoverage: usable ? base.mealCoverage : fresh.mealCoverage };
    // A retry of the same list (an answer that was lost) reuses its request id: one list, never two.
    const key = JSON.stringify([title, dates.startDate, dates.endDate]);
    const requestId = createRequest.current?.key === key ? createRequest.current.id : crypto.randomUUID();
    createRequest.current = { key, id: requestId };
    const saved = await createShoppingPeriod(next, requestId);
    assertCurrent(account);
    createRequest.current = null;
    setPeriods((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
    await openList(account, saved.id);
  }
  async function renameList(id: string, title: string | null) {
    const account = accountHandle();
    const row = periods.find((item) => item.id === id);
    if (!row) throw new Error("That list is gone. Refresh your lists.");
    const saved = await renameShoppingPeriod(id, title, row.revision, crypto.randomUUID())
      .catch((cause) => recoverStaleEdit(account, cause));
    assertCurrent(account);
    setPeriods((current) => current.map((item) => item.id === id ? saved : item));
    setSnapshot((current) => current.period?.id === id ? { ...current, period: saved } : current);
    if (selectedId.current === id) setDraft((current) => current ? { ...current, title: saved.title ?? null } : current);
  }
  /** Hides the list at once and sends the delete after the Undo toast closes (Undo sends nothing).
   *  The delete is kept on the device first, so a reload or a closed page inside the hold still sends it. */
  function deleteList(id: string) {
    const account = accountHandle();
    const row = periods.find((item) => item.id === id);
    if (!row) return;
    const entry: PendingDelete = { id, revision: row.revision, requestId: crypto.randomUUID(), at: Date.now() };
    rememberPendingDelete(account.userId, entry);
    const send = () => { held.current.delete(id); sendDelete(account, entry, listName(row)); };
    held.current.set(id, { timer: setTimeout(send, DELETE_HOLD_MS), send });
    const rest = periods.filter((item) => item.id !== id);
    setPeriods(rest);
    const wasOpen = snapshot.period?.id === id;
    if (wasOpen) {
      // `selectedId` keeps the deleted id, so whatever opens next (another list, or none) is a
      // change: the view and its draft start fresh instead of keeping the deleted list's dates.
      hasSelection.current = false;
      void openList(account, currentShoppingPeriod(rest, initialDraft().startDate)?.id ?? cycleOrder(rest)[0]?.id ?? null);
    }
    listFeedback.notify({ tone: "success", message: `${listName(row)} deleted.`, action: { label: "Undo", action: () => {
      const hold = held.current.get(id);
      if (!hold) { setError(`${listName(row)} was already deleted.`); return; }
      clearTimeout(hold.timer);
      held.current.delete(id);
      forgetPendingDelete(account.userId, id);
      if (currentAccountOrNull()?.epoch !== account.epoch) return;
      // Back in the lists; only the list that was open is opened again.
      if (wasOpen) void openList(account, id);
      else void refresh(account).catch(() => setPeriods((current) => cycleOrder([row, ...current.filter((item) => item.id !== id)])));
    } } });
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
      return saved;
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
  return <div className="flex flex-col gap-4">
    <h1 className="m-0 text-xl font-semibold">Shopping</h1>
    {error && <Notice tone="error" title={error} action={{ label: "Retry", onClick: () => {
      void update().catch((cause) => setError(cause instanceof Error ? cause.message : "Shopping could not refresh."));
    } }} />}
    {/* Outside the keyed view: opening the list it just saved must not unmount the build flow. */}
    <BuildListSlot key={owner.epoch} periodId={snapshot.period?.id ?? null} />
    <ShoppingView key={`${owner.epoch}:${viewKey}`} heading={false} buildSlot={null}
      period={snapshot.period} lines={snapshot.lines}
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
      switcher={<SavedListSwitcher period={snapshot.period} count={periods.length}
        itemCount={snapshot.lines.length} checkedCount={snapshot.lines.filter((line) => line.checked).length}
        onOpenLists={() => setListsOpen(true)}
        hasNewer={stepList(periods, snapshot.period?.id ?? null, -1) !== null && snapshot.period !== null}
        hasOlder={stepList(periods, snapshot.period?.id ?? null, 1) !== null}
        onStep={(step) => {
          const next = stepList(periods, snapshot.period?.id ?? null, step);
          if (next) void openList(owner, next.id);
        }} />}
      planNotice={<><RuleReviewCard /><ShoppingFocusToggle /></>}
      emptyList={<div className="flex flex-col items-start gap-2">
        <Notice tone="neutral" title={<>{periods.length === 0 ? "No saved lists yet. " : ""}Add items above,
          tap a Favorite, or plan meals below to fill your list.</>} />
        <BlankListFeedback key={owner.epoch} enabled={!snapshot.period} busy={blankBusy}
          problem={draft ? draftProblem(draft, { needMeals: false }) : null}
          disabled={blankBusy || !draft || draftProblem(draft, { needMeals: false }) !== null}
          onSave={saveBlankList} />
      </div>} />
    {listsOpen && <SavedListsSheet periods={periods} currentId={snapshot.period?.id ?? null}
      today={initialDraft().startDate} onClose={() => setListsOpen(false)}
      onOpen={(id) => void openList(owner, id)} onCreate={createList} onRename={renameList}
      onDelete={deleteList} />}
    <ActionFeedbackToast notice={listFeedback.notice} onDismiss={listFeedback.dismiss} />
  </div>;
}
