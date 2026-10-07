"use client";

import Tag, { type TagTone } from "@/components/ui/Tag";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import SearchField from "@/components/ui/SearchField";
import { useEffect, useMemo, useRef, useState } from "react";
import { createSearchController, toRows, type CatalogRow, type SearchResult } from "@/lib/catalog-client";
import { rowServingLine } from "@/lib/catalog/serving";
import type { Food } from "@/lib/foods";

/**
 * The source as a small tag on the row's second line: USDA in sage green, your own foods in olive,
 * Open Food Facts neutral. The results sit in a soft off-white tray with a hairline (E0: it is always
 * inside a sheet or a card, and a shadow never sits inside a shadow). Text, not the USDA
 * mark: the department's logo may not be used in a way that suggests it endorses the app.
 */
const SOURCE: Record<CatalogRow["sourceTile"], { label: string; tone: TagTone }> = {
  USDA: { label: "USDA", tone: "sage" },
  MINE: { label: "Mine", tone: "olive" },
  OFF: { label: "Open Food Facts", tone: "neutral" },
};

/** Where a search row comes from, the one way every food search says it (CatalogSearch, Add a food). */
export function SourceTag({ tile }: { tile: CatalogRow["sourceTile"] }) {
  const source = SOURCE[tile];
  return <Tag tone={source.tone} className="tracking-wide">{source.label}</Tag>;
}

const ADD = <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"
  strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6h7M6 2.5v7" /></svg>;

function Flags({ row }: { row: CatalogRow }) {
  if (row.prefStatus === null && !row.qualityFlags.includes("energy_mismatch")) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {row.prefStatus && (
        <Tag>{row.prefStatus === "eats" ? "Eats" : "Avoid"}</Tag>
      )}
      {row.qualityFlags.includes("energy_mismatch") && (
        <Tag tone="yellow" title="The source's calories and its macros disagree by more than 10%">Check kcal</Tag>
      )}
    </span>
  );
}

/**
 * The Phase 1 search surface. One list for both tiers: catalog hits in the server's score order, or
 * the bundled database with one "offline results" line above it. Never both at once — a mixed list
 * would let an offline row look like a catalog row.
 */
export default function CatalogSearch({
  mine, autoFocus, onPick, maxResults,
}: {
  mine: Record<string, Food>;
  autoFocus?: boolean;
  onPick: (row: CatalogRow) => void;
  maxResults?: number;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>({ kind: "empty" });
  const [failed, setFailed] = useState(false);
  const controller = useMemo(() => createSearchController(), []);
  const latest = useRef(mine);
  useEffect(() => {
    latest.current = mine;
  });

  useEffect(() => () => controller.cancel(), [controller]);

  function onChange(next: string) {
    setQuery(next);
    setFailed(false);
    controller.search(next, { mine: latest.current }).then(
      (r) => { if (r !== null) setResult(r); },
      () => {
        setFailed(true);
        // Stale rows under an error line read as answers to the new query. M13.
        setResult({ kind: "empty" });
      }
    );
  }

  const rows = toRows(result);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="pl-1.5 text-tiny font-normal text-graphite">Search foods</span>
        <SearchField value={query} onValueChange={onChange} label="Search foods"
          placeholder="e.g. chicken, rice" autoFocus={autoFocus} />
      </label>

      {result.kind === "offline" && (
        <p className="px-1.5 text-tiny text-muted" role="status">
          {result.reason === "no_match"
            ? "Built-in foods — no catalog match for that search."
            : "Offline results — from the foods built into the app."}
          {result.reason === "no_catalog" && " The catalog is not available right now."}
        </p>
      )}

      {failed && (
        <Notice tone="attention" title="Search did not answer. Try again, or type it from the label." />
      )}

      {query.trim() !== "" && rows.length === 0 && !failed && (
        <Notice tone="neutral" title="Nothing matches. Try fewer words, or type it from the label below." />
      )}

      {/* E0: the tray sits inside a sheet or a card, which already carries the shadow. */}
      {rows.length > 0 && <div className="overflow-hidden rounded-2xl bg-field elev-0">
        {(maxResults === undefined ? rows : rows.slice(0, maxResults)).map((row, index) => (
          <button
            key={row.key}
            type="button"
            onClick={() => onPick(row)}
            className={`group flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-[rgb(var(--ink-rgb)/0.03)] active:bg-[rgb(var(--ink-rgb)/0.06)] ${
              index > 0 ? "border-t border-hairline" : ""}`}
          >
            <span className="flex min-w-0 flex-grow flex-col gap-1">
              <span className="truncate text-caption font-normal text-charcoal">{row.description}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-tiny font-normal text-muted">
                <SourceTag tile={row.sourceTile} />
                {/* U8: what one serving weighs and holds, not "per 100 g" (rowServingLine). */}
                <span className="truncate tabular-nums">
                  {row.brand ? `${row.brand} · ` : ""}
                  <KcalText text={rowServingLine(row, mine)
                    ?? (row.offline ? (row.offlineSource === "mine" ? "Your food" : "Built in") : "per 100 g")} />
                </span>
                {row.offPlan.length > 0 && (
                  <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-red-wash px-1.5 text-tiny font-medium leading-none text-red-ink">
                    off-plan: {row.offPlan.join(", ")}
                  </span>
                )}
              </span>
            </span>
            <Flags row={row} />
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full text-graphite transition-colors duration-150 group-hover:bg-sage-wash group-hover:text-sage-ink group-active:bg-sage-wash group-active:text-sage-ink">
              {ADD}
            </span>
          </button>
        ))}
      </div>}
      {maxResults !== undefined && rows.length > maxResults &&
        <p className="m-0 px-1.5 text-tiny text-muted">Refine your search to see more matches.</p>}
    </div>
  );
}
