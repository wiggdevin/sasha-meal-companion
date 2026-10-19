"use client";

import { createContext, useContext, useId, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

/**
 * The one card frame (UI makeover §3, DESIGN.md §Elevation & Depth, the contrast step). Three sizes,
 * one title, at most one supporting line, an aside and a footer. A card on the ground is raised (E1:
 * `.shell` + `.surface`, `--shadow-card`); a card inside it takes the inset step (E0: one shade down,
 * a 12 % hairline, no shadow); a card inside that is the card face again (E0). There is no fourth
 * level: a CardFrame three deep throws in development.
 *
 * `CardToneContext` carries the parent's face, so `level="auto"` always steps away from it and an
 * explicit tone that would repeat its parent's face is stepped too: a same-tone nest cannot happen.
 * The markup keeps the `shell` / `surface` classes, plus one `card-sm|md|lg` and one
 * `card-ivory|recess|olive` class (app/globals.css). The olive tone paints the primary fill
 * (`.card-olive`: `--grad-ink` and the bevel), so its title, meta and aside take `text-on-primary`.
 */
export type CardFrameSize = "sm" | "md" | "lg";
export type CardFrameLevel = "auto" | "raised" | "inset";
export type CardFrameTone = "ivory" | "recess" | "olive";
/** The face a frame resolved to: raised ivory, the inset recess, or the olive call to action. */
export type CardFace = "raised" | "inset" | "olive";

export type CardFrameProps = {
  as?: "section" | "div" | "article" | "li";
  /** sm 12 px padding, md 16 px (default), lg 20 px. */
  size?: CardFrameSize;
  /** auto: raised on the ground, else the opposite of the parent card. */
  level?: CardFrameLevel;
  /** olive = the primary fill with on-primary text (a call to action). */
  tone?: CardFrameTone;
  title?: ReactNode;
  titleAs?: "h2" | "h3";
  /** One line under the title: caption, muted, truncates. */
  meta?: ReactNode;
  /** A count, an Edit button or a chevron, beside the title. */
  aside?: ReactNode;
  footer?: ReactNode;
  /** The whole card is one button (at least 44 px tall, Enter and Space). */
  onClick?: () => void;
  /** Layout only (width, margins, grid placement): never colour, type or border. */
  className?: string;
  children?: ReactNode;
} & Pick<HTMLAttributes<HTMLElement>, "aria-label" | "aria-labelledby" | "id">;

export type CardTone = { depth: number; face: CardFace | null };

/** The enclosing CardFrame: how deep it is (-1 on the ground) and the face it drew. */
export const CardToneContext = createContext<CardTone>({ depth: -1, face: null });

const SIZE: Record<CardFrameSize, { title: string }> = {
  sm: { title: "text-body font-semibold" },
  md: { title: "text-body font-semibold" },
  lg: { title: "text-title font-display" },
};

const TONE_CLASS: Record<CardFace, string> = { raised: "card-ivory", inset: "card-recess", olive: "card-olive" };

/** The face a frame draws at `depth` under a parent face (pure, exported for tests). */
export function resolveCardFace({ level = "auto", tone, parent, depth }: {
  level?: CardFrameLevel; tone?: CardFrameTone; parent: CardFace | null; depth: number;
}): CardFace {
  if (tone === "olive") return "olive";
  const requested: CardFace = tone === "ivory" ? "raised"
    : tone === "recess" ? "inset"
      : level === "raised" ? "raised"
        : level === "inset" ? "inset"
          : depth === 0 || parent === null ? "raised"
            : parent === "raised" ? "inset" : "raised";
  // A same-tone nest steps away from its parent, so a card never blends into the one behind it.
  if (parent === requested) return requested === "raised" ? "inset" : "raised";
  return requested;
}

export default function CardFrame({
  as: Tag = "div", size = "md", level = "auto", tone, title, titleAs: Title = "h2", meta, aside, footer,
  onClick, className = "", children, id, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy,
}: CardFrameProps) {
  const parent = useContext(CardToneContext);
  const titleId = useId();
  const depth = parent.depth + 1;
  if (depth >= 3 && process.env.NODE_ENV !== "production") {
    throw new Error("CardFrame: no fourth level. A card three deep inside cards is not allowed (DESIGN.md §Elevation).");
  }
  const face = resolveCardFace({ level, tone, parent: parent.face, depth });
  const olive = face === "olive";
  const ink = olive ? "text-on-primary" : "text-charcoal";
  const metaInk = olive ? "text-on-primary" : "text-muted";
  // Raised on the ground is E1 (its .shell carries the drop); everything inside a card is E0.
  const shell = depth === 0 && face !== "inset";

  const labelledBy = ariaLabelledBy ?? (title !== undefined && !ariaLabel ? titleId : undefined);
  const button = onClick
    ? {
      role: "button" as const,
      tabIndex: 0,
      onClick,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      },
    }
    : {};
  const pressable = onClick ? "min-h-11 cursor-pointer" : "";
  const a11y = { id, "aria-label": ariaLabel, "aria-labelledby": labelledBy, ...button };

  const faceClass = [
    "surface", `card-${size}`, TONE_CLASS[face], "flex flex-col", depth > 0 ? "card-e0" : "",
    shell ? "" : pressable, shell ? "" : className,
  ].filter(Boolean).join(" ");

  const head = title !== undefined || meta !== undefined || aside !== undefined ? (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        {title !== undefined && (
          <Title id={titleId} className={`m-0 ${SIZE[size].title} ${ink}`}>{title}</Title>
        )}
        {meta !== undefined && <p className={`m-0 truncate text-caption ${metaInk}`}>{meta}</p>}
      </div>
      {aside !== undefined && <div className={`flex shrink-0 items-center ${ink}`}>{aside}</div>}
    </div>
  ) : null;

  const body = (
    <CardToneContext.Provider value={{ depth, face }}>
      {head}
      {children}
      {footer !== undefined && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
    </CardToneContext.Provider>
  );

  if (shell) {
    return (
      <Tag className={`shell block w-full ${pressable} ${className}`.replace(/\s+/g, " ").trim()} {...a11y}>
        <div className={faceClass}>{body}</div>
      </Tag>
    );
  }
  return <Tag className={faceClass} {...a11y}>{body}</Tag>;
}
