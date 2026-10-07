import type { HTMLAttributes, ReactNode } from "react";

/** What a tag says, by colour role (DESIGN.md §Colors): a neutral fact, a good fit or a trusted
 *  source (sage), the account's own (olive), something to check (yellow), something wrong (red). */
export type TagTone = "neutral" | "sage" | "olive" | "yellow" | "red";

const TONES: Record<TagTone, string> = {
  neutral: "bg-charcoal/6 text-graphite",
  sage: "bg-sage-wash text-sage-ink",
  olive: "bg-primary text-on-primary",
  yellow: "bg-yellow-wash text-yellow-ink",
  red: "bg-red-wash text-red-ink",
};

const SIZES = {
  /** On a row's second line beside the meta (a source, Eats/Avoid, Check kcal). */
  sm: "h-5 px-1.5 font-medium",
  /** On a card on its own (a recipe's fit). */
  md: "min-h-6 px-2.5 font-semibold",
} as const;

/**
 * A small rounded label on a row or a card: a food's source, its Eats/Avoid status, a fit, a flag.
 * Text only, 12 px, never a control — a tappable chip is `Chip` or a button.
 */
export default function Tag({ tone = "neutral", size = "sm", className = "", children, ...rest }:
  HTMLAttributes<HTMLSpanElement> & { tone?: TagTone; size?: keyof typeof SIZES; children: ReactNode }) {
  return <span {...rest}
    className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full text-tiny leading-none ${SIZES[size]} ${TONES[tone]} ${className}`.trim()}>
    {children}
  </span>;
}
