"use client";

import { useId, useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import ConfirmSheet from "@/components/ui/ConfirmSheet";
import DateField from "@/components/ui/DateField";
import Notice from "@/components/ui/Notice";
import { compactRange, cycleOrder, listName, newListDates, newListProblem, type NewListSpan } from "@/lib/shopping/saved-lists";
import type { ShoppingPeriod } from "@/lib/shopping/types";

type ListRow = Pick<ShoppingPeriod, "id" | "title" | "startDate" | "endDate" | "updatedAt">;

const SPANS: { value: NewListSpan; label: string }[] = [
  { value: "this_week", label: "This week" },
  { value: "next_week", label: "Next week" },
  { value: "custom", label: "Custom" },
];

/**
 * Every saved list (UI makeover W7 §7.1 item 2): open one, start a new one (optional name, this
 * week / next week / custom dates), rename one, or delete one after a confirm. Deleting keeps the
 * meals already planned on Today: they belong to dates, not lists. The caller holds the delete for
 * its Undo toast.
 */
export default function SavedListsSheet({ periods, currentId, today, onClose, onOpen, onCreate,
  onRename, onDelete }: {
  periods: readonly ListRow[];
  currentId: string | null;
  today: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onCreate: (title: string | null, dates: { startDate: string; endDate: string }) => Promise<void>;
  onRename: (id: string, title: string | null) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [creating, setCreating] = useState(periods.length === 0);
  const [title, setTitle] = useState("");
  const [span, setSpan] = useState<NewListSpan>("this_week");
  const [custom, setCustom] = useState(() => newListDates("this_week", today));
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirming, setConfirming] = useState<ListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dates = newListDates(span, today, custom);
  const datesProblem = newListProblem(dates);
  const datesOk = datesProblem === null;

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't save. Try again."); }
    finally { setBusy(false); }
  }

  if (confirming) {
    return <ConfirmSheet title={`Delete ${listName(confirming)}?`} confirmLabel="Delete list" destructive
      onCancel={() => setConfirming(null)}
      onConfirm={() => { const id = confirming.id; setConfirming(null); onDelete(id); }}>
      Meals you already planned stay on Today.
    </ConfirmSheet>;
  }
  return (
    <Sheet title="Your lists" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <Notice tone="error" title={error} />}
        {creating ? (
          <form className="flex flex-col gap-3" aria-label="New list" onSubmit={(event) => {
            event.preventDefault();
            if (!datesOk || busy) return;
            void run(async () => { await onCreate(title.trim() || null, dates); onClose(); });
          }}>
            <label htmlFor={titleId} className="flex flex-col gap-1 text-sm">Name (optional)
              <input id={titleId} className="well min-h-11 w-full px-3" value={title} maxLength={60}
                placeholder="Weekly shop" autoComplete="off" onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className="pill-in flex gap-1 p-1" role="group" aria-label="Dates">
              {SPANS.map((option) => <Chip key={option.value} selected={span === option.value}
                onClick={() => setSpan(option.value)}>{option.label}</Chip>)}
            </div>
            {span === "custom" ? <div className="flex gap-2">
              <DateField label="From" value={custom.startDate} today={today}
                onChange={(value) => value && setCustom((current) => ({ ...current, startDate: value }))} />
              <DateField label="Through" value={custom.endDate} today={today} min={custom.startDate}
                onChange={(value) => value && setCustom((current) => ({ ...current, endDate: value }))} />
            </div> : <p className="m-0 text-tiny text-muted">{compactRange(dates.startDate, dates.endDate)}</p>}
            {datesProblem && <p className="m-0 text-tiny text-muted">{datesProblem}</p>}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!datesOk || busy}
                status={busy ? "pending" : undefined}>Start list</Button>
              {periods.length > 0 && <Button variant="tertiary" onClick={() => setCreating(false)}>Cancel</Button>}
            </div>
          </form>
        ) : <Button variant="primary" block onClick={() => setCreating(true)}>New list</Button>}
        {periods.length > 0 && <ul className="m-0 flex list-none flex-col p-0" aria-label="Saved lists">
          {cycleOrder(periods).map((row, index, all) => {
            const editing = renaming?.id === row.id;
            const open = row.id === currentId;
            return <li key={row.id}
              className={`flex min-h-14 items-center gap-2 py-1 ${index < all.length - 1 ? "border-b border-hairline" : ""}`}>
              {editing ? <form className="flex flex-1 items-center gap-2" aria-label={`Rename ${listName(row)}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy) return;
                  const next = renaming.title.trim() || null;
                  void run(async () => { await onRename(row.id, next); setRenaming(null); });
                }}>
                <input className="well min-h-11 min-w-0 flex-1 px-3" value={renaming.title} maxLength={60}
                  aria-label="List name" autoFocus placeholder={listName({ ...row, title: null })}
                  onChange={(event) => setRenaming({ id: row.id, title: event.target.value })} />
                <Button type="submit" variant="primary" disabled={busy}>Save</Button>
              </form> : <>
                <button type="button" onClick={() => { onOpen(row.id); onClose(); }}
                  aria-current={open ? "true" : undefined}
                  className="tap flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-charcoal">{listName(row)}</span>
                    <span className="truncate text-tiny text-muted">{compactRange(row.startDate, row.endDate)}</span>
                  </span>
                  {open && <Check size={18} aria-label="Open now" className="shrink-0 text-charcoal" />}
                </button>
                <Button variant="icon" aria-label={`Rename ${listName(row)}`}
                  onClick={() => setRenaming({ id: row.id, title: row.title ?? "" })}>
                  <Pencil size={16} aria-hidden="true" /></Button>
                <Button variant="icon" aria-label={`Delete ${listName(row)}`} onClick={() => setConfirming(row)}>
                  <Trash2 size={16} aria-hidden="true" /></Button>
              </>}
            </li>;
          })}
        </ul>}
      </div>
    </Sheet>
  );
}
