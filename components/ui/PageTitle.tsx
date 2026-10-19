"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

export type PageTitleBack = {
  /** Where the link goes without script, and the page it names. */
  href: string;
  label: string;
  /** Handles the move in place (a client-side date change); call `preventDefault` to stay put. */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

/**
 * Every page's visible title (UI makeover §2.2, "where am I"): an optional overline eyebrow over a
 * 28 px `h1`, an optional way back above them, and the page's own controls in `trailing`. The one
 * `h1` on the page; a page never hides its title from sight.
 */
export default function PageTitle({ eyebrow, title, trailing, back }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
  back?: PageTitleBack;
}) {
  return <header className="flex min-h-11 items-end justify-between gap-3 px-1">
    <div className="flex min-w-0 flex-col">
      {back && <Link href={back.href} onClick={back.onClick}
        className="tap -ml-1 inline-flex min-h-11 items-center gap-1 self-start px-1 text-caption font-medium text-primary">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        {back.label}
      </Link>}
      {eyebrow && <p className="m-0 text-overline uppercase text-muted">{eyebrow}</p>}
      <h1 className="m-0 font-display text-heading font-normal leading-[34px] tracking-[-0.01em] text-charcoal">{title}</h1>
    </div>
    {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
  </header>;
}
