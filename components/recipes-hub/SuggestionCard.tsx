"use client";

import { getImageProps } from "next/image";
import { forwardRef, useId, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import CloseButton from "@/components/ui/CloseButton";
import { MacroLine } from "@/components/nutrition/MacroText";
import { MACROS, type MacroKey, type MacroValues } from "@/components/nutrition/spec";
import { INSTANT, MORPH } from "@/lib/design/motion";
import { illustrativeMealImage, mealArtAspect } from "@/lib/today/meal-art";
import { BALANCED_PLATE_IMAGE } from "@/lib/today/meal-art-rules";
import photo from "@/components/ui/MealPhoto.module.css";
import { CARD_SUMMARY, MEAL_TITLE } from "@/lib/design/meal-type";

/** A food's everyday name: the part before a catalog qualifier ("Canned albacore, drained" → "Canned
 *  albacore"). */
const shortName = (name: string) => name.split(",")[0].trim();
const amount = (qty: number) => String(Math.round(qty * 100) / 100);

/** A one-line description from a recipe's ingredients: "Chicken breast, carrots and quinoa". */
export function ingredientLine(items: readonly { name: string }[], max = 3): string {
  const names = [...new Set(items.map((item) => shortName(item.name)).filter(Boolean))];
  if (names.length === 0) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** A one-line description of a meal built from its foods, by portion, which its name does not say:
 *  "120 g Canned albacore · 1 Banana · 10 g Olive oil". */
export function portionLine(items: readonly { name: string; qty: number; unit: string }[]): string {
  return items.filter((item) => item.name.trim()).map((item) => {
    const unit = item.unit && item.unit !== "whole" ? ` ${item.unit}` : "";
    return `${amount(item.qty)}${unit} ${shortName(item.name)}`;
  }).join(" · ");
}

/** A card's photo only when it shows this kind of dish: the generic balanced plate stands in for any
 *  meal on a meal card, but in a row of choices it would picture several different meals as the same
 *  plate, so a card falls back to the app's own olive art instead (Kimi P1, 2026-10-04). */
export function specificPhoto(src: string | null): string | null {
  return src === BALANCED_PLATE_IMAGE ? null : src;
}

export function suggestionPhoto(name: string, items: readonly { name: string }[]): string | null {
  return specificPhoto(illustrativeMealImage(name, items));
}

export type SuggestionCardData = {
  name: string;
  image: string | null;
  description?: string;
  values: MacroValues;
  only?: readonly MacroKey[];
  tag?: ReactNode;
  /** The tag while the card is open, when the detail already says part of it (default: `tag`). */
  openTag?: ReactNode;
};

/** The card's photo: a clip that changes shape with the card while the photo inside covers it at its
 *  own aspect, so it only ever scales evenly (the meal card's MealPhoto technique). Without a photo
 *  the clip shows the app's own olive art. */
function CardPhoto({ src, open, transition }: { src: string | null; open: boolean; transition: Transition }) {
  const image = src ? getImageProps({ src, alt: "", width: 736, height: Math.round(736 / mealArtAspect(src)),
    sizes: "(max-width: 640px) 90vw, 400px" }).props : null;
  return <motion.span layout aria-hidden="true" data-suggestion-photo={src ? "photo" : "art"}
    className={`relative w-full ${open ? "h-44" : "h-24"} ${photo.clip}`} style={{ borderRadius: 16 }}
    transition={transition}>
    {image && <motion.img layout src={image.src} srcSet={image.srcSet} sizes={image.sizes} alt=""
      decoding="async" loading="lazy" className={photo.cover} style={{ ["--a" as string]: mealArtAspect(src!) }}
      transition={transition} />}
  </motion.span>;
}

/**
 * One suggestion in a carousel (2026-10-03 the Foods recipe hub; 2026-10-04 the meal card's Swap and a
 * menu's picks; owner: "designed as the recipe card that's on the foods page"). An ivory card with a
 * hairline: a rounded photo, the name, a one-line description, the figures in the nutrition display
 * system and a tag (a fit, a source). Without a photo the photo's place shows the app's own olive art,
 * so every card keeps one geometry.
 *
 * Closed, the whole card is one button (`onOpen`). Open (components/recipes-hub/SuggestionCarousel.tsx,
 * owner: "it should grow smoothly and take up the space provided"), the same card is a container
 * transform: it grows on the gentle spring with its parts gliding to their places at their own size
 * (text never stretches), the photo becomes a hero, a close × sits over its top-right corner, and `detail`
 * fades in once the card has room; closing fades the detail out first, then the card shrinks back.
 *
 * `nested` drops the card's own shadow and takes the inset step (inside another card, E0: one shade
 * down with the card hairline, DESIGN.md §Elevation), so it never blends into the card behind it.
 */
const FIGURE_LINE = "min-w-0 max-w-full";

const SuggestionCard = forwardRef<HTMLDivElement, SuggestionCardData & {
  open?: boolean; detail?: ReactNode; showDetail?: boolean;
  onOpen?: () => void; onClose?: () => void; onDetailGone?: () => void;
  nested?: boolean; reduce?: boolean; buttonRef?: (node: HTMLButtonElement | null) => void;
  /** Extra props for the closed card's button (aria-controls, aria-pressed in a picker). */
  buttonProps?: Record<string, unknown>;
}>(function SuggestionCard({ name, image, description, values, only, tag, openTag, open = false, detail,
  showDetail = open, onOpen, onClose, onDetailGone, nested = false, reduce = false, buttonRef, buttonProps }, ref) {
  const id = useId();
  const shownTag = open && openTag !== undefined ? openTag : tag;
  const keys = only ?? MACROS;
  const morph = reduce ? INSTANT : MORPH.frame;
  const glide = { layout: "position" as const, transition: morph };
  return <motion.div ref={ref} layout transition={morph} data-recipe-card="" data-open={open || undefined}
    role={open ? "group" : undefined} aria-label={open ? name : undefined} tabIndex={open ? -1 : undefined}
    onKeyDown={open ? (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose?.(); } } : undefined}
    style={{ borderRadius: 24 }}
    className={`${nested ? "border-[color:var(--hairline-card)] [background:var(--grad-card-inset)]" : "shell border-hairline bg-surface"} relative flex w-full flex-col gap-2 border p-2 pb-3 text-left outline-none ${
      open ? "" : "tap"}`.trim()}>
    {!open && onOpen && <button ref={buttonRef} type="button" aria-expanded={false}
      aria-labelledby={`${id}-name ${id}-about ${id}-figures`} onClick={onOpen} {...buttonProps}
      // The tag (a fit, a source, a rule mark with its reason) is the card's description.
      aria-describedby={[tag ? `${id}-tag` : null, buttonProps?.["aria-describedby"]]
        .filter((part): part is string => typeof part === "string" && part !== "").join(" ") || undefined}
      className="absolute inset-0 z-10 rounded-[inherit]" />}
    <CardPhoto src={image} open={open} transition={morph} />
    {/* The × sits over the photo, top right (owner, 2026-10-05), on every suggestion card. */}
    {open && onClose && <CloseButton onPhoto onClick={onClose} label={`Close ${name}`}
      className="absolute top-4 right-4 z-20" />}
    <span className="flex min-w-0 flex-1 flex-col gap-1 px-2">
      <motion.span {...glide} className="flex min-w-0 items-start justify-between gap-2">
        <span id={`${id}-name`} className={`min-w-0 ${open ? MEAL_TITLE.standard : `line-clamp-2 ${MEAL_TITLE.compact}`}`}>{name}</span>
      </motion.span>
      {description && <motion.span {...glide} id={`${id}-about`}
        className={`${CARD_SUMMARY} ${open ? "" : "truncate"}`}>{description}</motion.span>}
      {/* Up to two figures share a line; four take two lines, calories over the three macros by
          letter, so a narrow card never wraps a separator onto a line of its own. */}
      {/* The figures wrap inside the 11.5rem card rather than run past its edge (min-w-0 down the
          chain; MacroLine wraps between figures, never inside one). */}
      <motion.span {...glide} id={`${id}-figures`} className="flex min-w-0 max-w-full flex-col gap-0.5 tabular-nums">
        {keys.length <= 2 ? <MacroLine values={values} only={keys} className={FIGURE_LINE} /> : <>
          <MacroLine values={values} only={keys.filter((key) => key === "kcal")} className={FIGURE_LINE} />
          <MacroLine values={values} only={keys.filter((key) => key !== "kcal")} label="letter" className={FIGURE_LINE} />
        </>}
      </motion.span>
      {shownTag && <motion.span {...glide} id={`${id}-tag`} className="mt-auto pt-0.5">{shownTag}</motion.span>}
    </span>
    <AnimatePresence initial={false} onExitComplete={onDetailGone}>
      {open && showDetail && detail && <motion.div key="detail" layout="position" className="min-w-0 px-2 pt-1"
        initial={{ opacity: 0 }} animate={{ opacity: 1, transition: reduce ? INSTANT : MORPH.contentIn }}
        exit={{ opacity: 0, transition: reduce ? INSTANT : MORPH.contentOut }}>
        {detail}
      </motion.div>}
    </AnimatePresence>
  </motion.div>;
});

export default SuggestionCard;
