"use client";

/**
 * The source glyph on a body reading (Sol audit, T11a). Linear, 16 px, `currentColor` in a neutral
 * ink token — the same Solar-style vocabulary as the tab bar. The four macro gauge colours are
 * reserved for the gauges (DESIGN.md > Colors), so no source is ever drawn in orange, blue, olive or
 * gold. It is decorative: the source name is printed beside it.
 */
const COLOR = "shrink-0 text-graphite";

function frame(children: React.ReactNode) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={COLOR}>
      {children}
    </svg>
  );
}

/** Apple Health and Health Auto Export are both a phone's export: a heart. */
function HeartGlyph() {
  return frame(
    <path d="M12 20.5 4.8 13.3a4.6 4.6 0 1 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 1 1 6.5 6.5Z" />);
}

/** Oura is a ring. */
function RingGlyph() {
  return frame(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /></>);
}

/** Typed in by hand: a pencil. */
function PencilGlyph() {
  return frame(<>
    <path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5Z" />
    <path d="M14.5 6.5 17.5 9.5" />
  </>);
}

/** Unknown or unlabelled: an open ring, never a colour. */
function UnknownGlyph() {
  return frame(<circle cx="12" cy="12" r="8.5" strokeDasharray="2 3" />);
}

export default function SourceGlyph({ kind }: { kind: string }) {
  if (kind === "oura") return <RingGlyph />;
  if (kind === "manual") return <PencilGlyph />;
  if (kind === "apple_health_shortcut" || kind === "health_auto_export") return <HeartGlyph />;
  return <UnknownGlyph />;
}
