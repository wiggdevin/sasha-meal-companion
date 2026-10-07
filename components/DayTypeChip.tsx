import { dayTypeChipName, dayTypeLabel } from "@/lib/plan-day";
import type { DayType } from "@/lib/types";

/* Icon tiles: gold gradient for a training day, ink for a rest day (DESIGN.md
   Buttons > Icon tile). Glyphs are linear inline SVG — never emoji. */
const BOLT = <path d="M13 2 4 14h7l-1 8 9-12h-7z" />;
const MOON = <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />;
/** Linear lock — DESIGN.md glyphs never use emoji or a filled style. */
const LOCK = (
  <>
    <path d="M6 11h12v10H6z" />
    <path d="M7 11V8a5 5 0 0 1 10 0v3" />
  </>
);

const TILE_GOLD = "var(--grad-gold)";
const TILE_INK = "var(--grad-ink)";

const TILE: Record<DayType, { tile: string; glyph: React.ReactNode }> = {
  "training-10": { tile: TILE_GOLD, glyph: BOLT },
  rest: { tile: TILE_INK, glyph: MOON },
  "training-7-fasted": { tile: TILE_GOLD, glyph: BOLT },
};

/**
 * The Today header's day-type control: a compact glass icon beside the avatar. Closed, it is just
 * the day's icon tile (plus a lock dot once pinned); open, it widens into a pill that names the day
 * type, and the menu drops down under it in place. `.tap` keeps the 44 px floor.
 */
export default function DayTypeChip({
  dayType,
  override,
  open,
  onOpen,
  menuId,
}: {
  dayType: DayType;
  override: DayType | undefined;
  /** Drives `aria-expanded` and the widened pill — the menu is open. */
  open: boolean;
  onOpen: () => void;
  menuId?: string;
}) {
  const tile = TILE[dayType];
  const locked = override !== undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={dayTypeChipName(dayType, locked)}
      title={dayTypeLabel(dayType, override)}
      className="tap relative inline-flex min-w-0 items-center justify-center"
      style={{ width: "auto", appearance: "none", textAlign: "left" }}
    >
      <span className="pill inline-flex min-w-0">
        <span className={`pill-in flex h-10 min-w-10 items-center justify-center gap-2 transition-[padding] duration-200 ${open ? "pl-2.5 pr-3.5" : "px-2.5"}`}>
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[12px] text-on-primary"
            style={{ background: tile.tile, boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4)" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {tile.glyph}
            </svg>
          </span>
          {open && (
            <span className="min-w-0 truncate text-tiny font-normal text-graphite">
              {dayTypeLabel(dayType, override)}
            </span>
          )}
          {locked && (
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center text-graphite ${open ? "" : "absolute -right-0.5 -top-0.5 rounded-full bg-paper"}`}>
              <svg width={open ? 12 : 10} height={open ? 12 : 10} viewBox="0 0 24 24" fill="none" aria-hidden="true"
                stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                {LOCK}
              </svg>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
