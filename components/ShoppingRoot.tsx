"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
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
  /** Lists deleted on screen whose delete waits out its Undo: id → the timer and its revision. */
  const held = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const listFeedback = useActionFeedback();

  const refresh = useCallback(async (account: AccountHandle, chooseId?: string | null) => {
    const serial = ++refreshSerial.current;
    try {
      const seed = { ...initialDraft(), locale: savedLocation(account.userId) };
      const [periods, stock] = await Promise.all([listShoppingPeriods(), listPantry()]);
      if (serial !== refreshSerial.current) return;
      const live = periods.filter((row) => !held.current.has(row.id));
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

  useEffect(() => {
    const pending = held.current;
    // Leaving Shopping sends any delete still waiting on its Undo.
    return () => { for (const { timer, send } of pending.values()) { clearTimeout(timer); send(); } pending.clear(); };
  }, []);
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
    const base = draft ?? initialDraft();
    const saved = await createShoppingPeriod({ ...base, ...dates, title, lockMode: "none" }, crypto.randomUUID());
    assertCurrent(account);
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
  }
  /** Hides the list at once and sends the delete after the Undo toast closes (Undo sends nothing). */
  function deleteList(id: string) {
    const account = accountHandle();
    const row = periods.find((item) => item.id === id);
    if (!row) return;
    const requestId = crypto.randomUUID();
    const send = () => {
      held.current.delete(id);
      void deleteShoppingPeriod(id, row.revision, requestId, account).catch(() => {
        if (!mounted.current || currentAccountOrNull()?.epoch !== account.epoch) return;
        setError(`${listName(row)} was not deleted. It is back in your lists.`);
        void refresh(account).catch(() => undefined);
      });
    };
    held.current.set(id, { timer: setTimeout(send, DELETE_HOLD_MS), send });
    const rest = periods.filter((item) => item.id !== id);
    setPeriods(rest);
    if (snapshot.period?.id === id) {
      selectedId.current = null; hasSelection.current = false;
      void openList(account, currentShoppingPeriod(rest, initialDraft().startDate)?.id ?? cycleOrder(rest)[0]?.id ?? null);
    }
    listFeedback.notify({ tone: "success", message: `${listName(row)} deleted.`, action: { label: "Undo", action: () => {
      const hold = held.current.get(id);
      if (!hold) { setError(`${listName(row)} was already deleted.`); return; }
      clearTimeout(hold.timer);
      held.current.delete(id);
      void openList(account, id);
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
  </>;
}
