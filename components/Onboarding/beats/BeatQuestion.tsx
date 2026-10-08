/** Onboarding v2 beats: the question line every question-set beat opens with, and its plain
 *  follow-up line. Cream on the `.matte` shell through the text roles. */
import type { ReactNode } from "react";

export function BeatQuestion({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} className="m-0 font-serif text-heading-sm text-charcoal">{children}</p>;
}

export function BeatNote({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return <p role={live ? "status" : undefined} className="m-0 text-caption text-graphite">{children}</p>;
}
