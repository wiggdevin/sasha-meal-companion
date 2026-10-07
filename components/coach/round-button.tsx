/**
 * The converse chat box's round white icon button (vikod3/converse `chat-input.tsx`): a 40 px
 * white circle with a black 16–18 px glyph, inside a 44 px tap target the caller provides.
 */
export const ROUND = "flex h-10 w-10 items-center justify-center rounded-full text-on-primary";
const ROUND_STYLE: React.CSSProperties = { background: "var(--grad-ink)" };

export function Round({ children }: { children: React.ReactNode }) {
  return <span data-coach-round className={ROUND} style={ROUND_STYLE}>{children}</span>;
}

export function SendGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></svg>;
}
