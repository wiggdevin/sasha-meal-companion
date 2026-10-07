import { Clock3, CookingPot, UsersRound, type LucideIcon } from "lucide-react";
import { displayMinutes } from "@/lib/recipes/preview-display";

type Facet = { key: "cuisine" | "time" | "servings"; Icon: LucideIcon; text: string; spoken: string };

export function recipeFacets({ cuisine, minutes, servings }: {
  cuisine: string | null; minutes: number | null; servings: number;
}): Facet[] {
  const facets: Facet[] = [];
  if (cuisine) facets.push({ key: "cuisine", Icon: CookingPot, text: cuisine, spoken: `${cuisine} cuisine` });
  facets.push(minutes === null
    ? { key: "time", Icon: Clock3, text: "Time not recorded", spoken: "Time not recorded" }
    : { key: "time", Icon: Clock3, text: displayMinutes(minutes), spoken: `Ready in ${displayMinutes(minutes)}` });
  // "Serves 3", never a bare figure: beside a people glyph a lone 3 read as a head count (Kimi review).
  facets.push({ key: "servings", Icon: UsersRound, text: `Serves ${servings}`, spoken: `Serves ${servings}` });
  return facets;
}

/**
 * A recipe's cuisine, time and servings (owner, 2026-10-04: smaller, and colour-coded). `pill`: small
 * tinted pills, each in its facet's hue (globals.css `.facet`); `line`: the same three as one quiet
 * line with coloured glyphs, the default on cards: three tinted pills beside four macro hues were too many
 * hues for one card (Kimi review 2026-10-04).
 */
export default function RecipeFacets({ cuisine, minutes, servings, variant = "pill", className = "" }: {
  cuisine: string | null; minutes: number | null; servings: number; variant?: "pill" | "line"; className?: string;
}) {
  const facets = recipeFacets({ cuisine, minutes, servings });
  return <ul aria-label="At a glance" className={`m-0 flex list-none flex-wrap items-center p-0 ${
    variant === "pill" ? "gap-1.5" : "gap-x-3 gap-y-1"} ${className}`.trim()}>
    {facets.map(({ key, Icon, text, spoken }) => <li key={key} data-facet={key}
      className={variant === "pill"
        ? "facet inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-tiny font-medium text-graphite"
        : "inline-flex items-center gap-1 whitespace-nowrap text-tiny text-graphite"}>
      <span className="sr-only">{spoken}</span>
      <Icon size={13} strokeWidth={1.6} aria-hidden="true" className="facet-glyph shrink-0" />
      <span aria-hidden="true">{text}</span>
    </li>)}
  </ul>;
}
