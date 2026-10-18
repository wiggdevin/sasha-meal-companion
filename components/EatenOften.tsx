"use client";

/**
 * Phase 18 W3 UI: the read-only "Eaten often" section on the Foods tab's first tab
 * (components/EatsView.tsx), beneath the user's own foods list. Draws `GET /api/foods/taste`
 * (lib/foods/taste-client.ts) — derived, IMPLICIT eaten history (spec §D5/§D6/§W3). The one write
 * is the user's own tap on "Add", a Favor (lib/foods/favor-client.ts, `POST /api/foods/favor`), offered only
 * where the server reports the row `favorable` and not yet `favored`; nothing is written otherwise.
 *
 * Re-reads on SYNCED_EVENT and whenever an account becomes ready (which covers "the Foods tab
 * mounts" — this section only exists while that tab is on screen), and after a Favor answer that
 * moved the list. No polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import CappedList from "@/components/MyFoods.list";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import Surface from "@/components/ui/Surface";
import Tag from "@/components/ui/Tag";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import { FAVOR_COPY, favorTasteKey, type FavorOutcome } from "@/lib/foods/favor-client";
import { noteRulesRevision } from "@/lib/foods/rules-epoch";
import { loadTaste, type TasteRead, type TasteRow } from "@/lib/foods/taste-client";
import { SYNCED_EVENT, syncOnce } from "@/lib/sync/client";

/** "3 Oct" for a local yyyy-mm-dd date — the same day-first short date Foods already shows for a
 *  dated range (components/ShoppingView.tsx `dateRange`'s own `day` formatter). */
function shortDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
}

function daysCopy(days180: number): string {
  return `Eaten on ${days180} ${days180 === 1 ? "day" : "days"}`;
}

type Note = { key: string; text: string; tone: "ok" | "error" };

function Row({ item, last, pending, note, onFavor }: {
  item: TasteRow; last: boolean; pending: boolean; note: Note | null; onFavor: (item: TasteRow) => void;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-3 px-2.5 py-3 ${last ? "" : "border-b border-hairline"}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium">{item.name}</span>
          {item.provenance.estimated && <Tag tone="neutral">Estimated</Tag>}
        </span>
        <span className="truncate text-tiny font-normal text-muted">
          {daysCopy(item.days180)} · Last: {shortDate(item.lastOn)}
        </span>
        {/* Spoken once by the section's own status line; shown here, beside the food it is about. */}
        {note && <span aria-hidden="true" className={`text-tiny ${note.tone === "error" ? "text-alert" : "text-muted"}`}>
          {note.text}</span>}
      </span>
      {/* Offered only when the server says the write would succeed now (D6), and never twice. */}
      {item.favorable && !item.favored && (
        <Button variant="tertiary" size="sm" className="shrink-0" onClick={() => onFavor(item)}
          status={pending ? "pending" : undefined} aria-label={`Add ${item.name} to Favorites`}>
          Add
        </Button>
      )}
    </div>
  );
}

/** The words for an outcome that needs them; a re-read alone answers the rest. */
function noteFor(key: string, outcome: FavorOutcome): Note | null {
  switch (outcome.status) {
    case "favored": return { key, text: FAVOR_COPY.favored, tone: "ok" };
    case "changed": return { key, text: FAVOR_COPY.changed, tone: "error" };
    case "blocked": return { key, text: FAVOR_COPY.blocked, tone: "error" };
    case "busy": return { key, text: FAVOR_COPY.busy, tone: "error" };
    case "failed": return { key, text: FAVOR_COPY.failed, tone: "error" };
    case "gone":
    case "rule_review": return null;
  }
}

export default function EatenOften() {
  const [read, setRead] = useState<TasteRead | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<Note | null>(null);
  const latest = useRef(0);

  const reload = useCallback((account: AccountHandle) => {
    const mine = ++latest.current;
    void loadTaste({ account }).then((result) => {
      // Never write a result for an account that moved on while the read was in flight, nor one
      // an overlapping newer read (a sync during the mount read) has already superseded.
      if (mine === latest.current && currentAccountOrNull()?.epoch === account.epoch) setRead(result);
    });
  }, []);

  useEffect(() => {
    const offReady = onAccountReady(reload);
    const offGone = onAccountGone(() => { setRead(null); setNote(null); setPending(new Set()); });
    const onSynced = () => {
      const account = currentAccountOrNull();
      if (account) reload(account);
    };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => {
      offReady(); offGone();
      window.removeEventListener(SYNCED_EVENT, onSynced);
    };
  }, [reload]);

  async function favor(item: TasteRow) {
    const account = currentAccountOrNull();
    if (!account || pending.has(item.key)) return;
    setNote(null);
    setPending((keys) => new Set(keys).add(item.key));
    let outcome: FavorOutcome | null = null;
    try {
      outcome = await favorTasteKey(item.key, { account });
    } catch {
      // The account changed mid-flight: its list and its answer belong to someone else now.
    } finally {
      setPending((keys) => { const next = new Set(keys); next.delete(item.key); return next; });
    }
    if (!outcome || currentAccountOrNull()?.epoch !== account.epoch) return;
    setNote(noteFor(item.key, outcome));
    if (outcome.status === "favored") {
      if (outcome.rulesRevision !== null) noteRulesRevision(outcome.rulesRevision, account.userId);
      // The server wrote the Favored mark; a pull brings it to this phone (Your usual foods, the
      // meal suggestions), and the pass's SYNCED_EVENT re-reads this list once more.
      void syncOnce(account).catch(() => undefined);
    }
    // Favored, gone, changed or rule review: the list itself has moved, so read it again.
    if (outcome.status !== "blocked" && outcome.status !== "busy" && outcome.status !== "failed") reload(account);
  }

  if (!read || read.status === "unavailable") return null;
  if (read.status === "ok" && read.items.length === 0) return null;

  return (
    <section aria-label="Eaten often" className="flex flex-col gap-2">
      {read.status === "rule_review" ? (
        <Notice tone="error" title={read.message} className="px-1.5" />
      ) : (
        <Surface className="flex flex-col">
          <div className="flex flex-col gap-1 px-4 pt-4 pb-2">
            <h2 className="section-title m-0 text-title font-semibold! tracking-heading-sm!">Eaten often</h2>
            <p className="m-0 text-caption text-muted">From food logged in the last 6 months.</p>
          </div>
          <CappedList items={read.items} keyOf={(item) => item.key} divided label="eaten often foods"
            inset="px-4" render={(item, { last }) => <Row item={item} last={last} pending={pending.has(item.key)}
              note={note?.key === item.key ? note : null} onFavor={(row) => void favor(row)} />} />
        </Surface>
      )}
      <p role="status" className="sr-only">{note?.text ?? ""}</p>
    </section>
  );
}
