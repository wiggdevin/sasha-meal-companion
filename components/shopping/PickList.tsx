"use client";

import { useEffect, useMemo, useState } from "react";
import CappedList from "@/components/MyFoods.list";
import { useFoodFavorites } from "@/components/MyFoods.favorites";
import PickRow from "@/components/shopping/PickRow";
import Button from "@/components/ui/Button";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Notice from "@/components/ui/Notice";
import { currentAccountOrNull, isCurrent, onAccountGone, onAccountReady } from "@/lib/device/account";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { currentEligibleView } from "@/lib/foods/rule-marks";
import { loadTaste } from "@/lib/foods/taste-client";
import { groupByAisle } from "@/lib/foods/aisle";
import { byAisle, pickSources, type PickItem, type PickStarRow, type PickTasteRow } from "@/lib/shopping/pick-sources";
import { FAVORITES_CHANGED_EVENT } from "@/lib/favorites";
import { listFavorites } from "@/lib/favorites-client";
import { planQuickAdd } from "@/lib/shopping/quick-add";
import type { ShoppingLine } from "@/lib/shopping/types";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";

/**
 * "Pick from your foods" (UI makeover W7 §7.1 item 4), replacing the old Favorites pills: a box
 * for anything else, then Favorites (Favored foods, starred first) and Often eaten, each grouped
 * by aisle in lists of six. "+" adds a manual line; ✓ takes off only a manual unchecked line.
 * Avoid foods are never offered; a food off the rules shows its mark and cannot be added.
 */
export default function PickList({ lines, onAdd, onRemove }: {
  lines: readonly ShoppingLine[];
  onAdd: (names: string[]) => Promise<void>;
  onRemove: (line: ShoppingLine) => Promise<void>;
}) {
  const stars = useFoodFavorites();
  const [foods, setFoods] = useState(() => loadStore().foods);
  const [verified, setVerified] = useState<ReadonlySet<string> | undefined>(undefined);
  const [taste, setTaste] = useState<PickTasteRow[]>([]);
  const [starRows, setStarRows] = useState<PickStarRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const feedback = useActionFeedback();

  useEffect(() => {
    let live = true;
    const read = () => {
      const account = currentAccountOrNull();
      if (!account) return;
      const store = loadStore();
      setFoods(store.foods);
      void loadEligibleLocalFoodIds(account, store.foods)
        .then((set) => { if (live && isCurrent(account)) setVerified(set); })
        .catch(() => { if (live && isCurrent(account)) setVerified(undefined); });
      void loadTaste({ account }).then((answer) => {
        if (live && isCurrent(account)) setTaste(answer.status === "ok" ? [...answer.items] : []);
      });
      void listFavorites().then((rows) => {
        if (live && isCurrent(account)) setStarRows(rows.filter((row) => row.kind === "food").map((row) => ({ name: row.name })));
      }).catch(() => { if (live && isCurrent(account)) setStarRows([]); });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(FAVORITES_CHANGED_EVENT, read);
    const ready = onAccountReady(read);
    const gone = onAccountGone(() => { setFoods({}); setVerified(undefined); setTaste([]); setStarRows([]); });
    return () => {
      live = false;
      window.removeEventListener(SYNCED_EVENT, read); window.removeEventListener(FAVORITES_CHANGED_EVENT, read);
      ready(); gone();
    };
  }, []);

  const view = useMemo(() => currentEligibleView(foods, loadStore().settings, verified), [foods, verified]);
  const { favorites, often } = pickSources({ foods, starred: stars.isStarred, starredRows: starRows, taste, view, lines });
  const plan = planQuickAdd(text, lines);

  async function toggle(item: PickItem) {
    if (busy) return;
    setBusy(item.key); setError(null);
    try {
      if (item.onList && item.removable) await onRemove(item.removable);
      else if (!item.onList) await onAdd([item.name]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${item.name} didn't save. Try again.`);
    } finally { setBusy(null); }
  }
  async function addTyped() {
    if (busy || plan.items.length === 0) return;
    const typed = text;
    const names = plan.items;
    const added = names.length === 1 ? `${names[0]} added` : `${names.length} items added`;
    const left = plan.rest ? plan.rest.split(", ").length : 0;
    setBusy("typed"); setError(null);
    // The field clears as the items land, so the count is said in the notice.
    const outcome = await feedback.run(() => onAdd(names), { kind: "commit", confirm: "notice",
      successMessage: left ? `${added}; ${left} more left in the box.` : `${added}.`,
      failureMessage: (cause) => cause instanceof Error ? cause.message : "Those items didn't save." });
    setBusy(null);
    // Only what was sent: an item typed while the add was in flight stays in the field.
    if (outcome.ok) setText((current) => current === typed ? plan.rest : current);
  }

  const section = (title: string, items: PickItem[], empty: string) => {
    const groups = groupByAisle(byAisle(items), (row) => row.aisle);
    return <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      {items.length === 0 ? <p className="m-0 text-tiny text-muted">{empty}</p>
        : groups.map((group) => <div key={group.aisle} className="flex flex-col">
          <h4 className="m-0 pb-1 text-tiny font-medium uppercase tracking-wide text-muted">{group.label}</h4>
          <CappedList items={group.items} keyOf={(row) => row.key} label={`${group.label} ${title}`}
            render={(row, { last }) => <PickRow item={row} last={last} busy={busy !== null}
              onToggle={(next) => void toggle(next)} />} />
        </div>)}
    </section>;
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Pick from your foods">
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void addTyped(); }}>
        <label className="flex flex-1 flex-col gap-1 text-sm">Add something else
          <input className="well min-h-11 w-full px-3" value={text} enterKeyHint="done" autoComplete="off"
            placeholder="2 avocados, oat milk" onChange={(event) => setText(event.target.value)} /></label>
        <Button type="submit" disabled={busy !== null || plan.items.length === 0}>Add</Button>
      </form>
      {plan.items.length === 0 && plan.duplicates > 0 && <p className="m-0 text-tiny text-muted">Already on your list.</p>}
      {error && <Notice tone="error" title={error} />}
      {stars.error && <Notice tone="error" title={stars.error} />}
      {section("Favorites", favorites, "Star or favorite foods on the Foods tab to see them here.")}
      {section("Often eaten", often, "Foods you log often show up here.")}
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    </section>
  );
}
