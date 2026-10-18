import type { ReactNode } from "react";

/**
 * One row of a list (a food, a source, a setting): title and meta on the left, a trailing slot on
 * the right. With `onClick` it is a full-width button; without, a plain row. Title and meta wrap,
 * so a coach food line is never cut on a phone; `truncate` keeps them to one line each, for rows
 * whose labels are known to be short.
 */
export default function ListRow({ title, meta, trailing, onClick, truncate = false, className = "" }: {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  truncate?: boolean;
  className?: string;
}) {
  const fit = truncate ? "truncate" : "break-words";
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={`${fit} text-[16px] font-medium text-charcoal`}>{title}</span>
        {meta && <span className={`${fit} text-tiny text-muted`}>{meta}</span>}
      </span>
      {trailing && <span className="shrink-0 text-tiny text-muted">{trailing}</span>}
    </>
  );
  const classes = `list-row flex min-h-12 w-full items-center gap-3 px-3 py-2 ${className}`.trim();
  return onClick
    ? <button type="button" onClick={onClick} className={`tap ${classes}`}>{body}</button>
    : <div className={classes}>{body}</div>;
}
