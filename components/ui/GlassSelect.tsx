"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties,
  type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { fade, spring } from "@/lib/design/motion";
import styles from "./GlassSelect.module.css";

export type GlassSelectOption = { value: string; label: string; disabled?: boolean };

/** Menu geometry (px): gap to the trigger, viewport margin, tallest menu, one row, inner padding. */
const GAP = 6;
const MARGIN = 8;
const MAX_HEIGHT = 320;
const ROW = 44;
const PAD = 6;

/** The box a `position: fixed` menu is laid out against. A transformed, filtered or contained
 *  ancestor (a sheet mid-spring, a frosted panel) captures fixed descendants, so viewport
 *  coordinates are shifted by that ancestor's padding box and its scroll. */
function fixedOrigin(from: HTMLElement | null) {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.transform !== "none" || s.perspective !== "none" || s.filter !== "none"
      || (s.backdropFilter ?? "none") !== "none" || /paint|layout|strict|content/.test(s.contain ?? "")
      || /transform|perspective|filter/.test(s.willChange ?? "")
      || (s.containerType ?? "normal") !== "normal") {
      const r = el.getBoundingClientRect();
      return { x: r.left + el.clientLeft - el.scrollLeft, y: r.top + el.clientTop - el.scrollTop };
    }
  }
  return { x: 0, y: 0 };
}

function Chevron() {
  return <svg className={styles.chevron} width="16" height="16" viewBox="0 0 16 16" fill="none"
    aria-hidden="true" focusable="false">
    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function Check() {
  return <svg className={styles.check} width="16" height="16" viewBox="0 0 16 16" fill="none"
    aria-hidden="true" focusable="false">
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function Menu({ listId, label, options, value, active, upwards, trigger, listRef, onActive, onChoose, onClose }: {
  listId: string;
  label: string;
  options: GlassSelectOption[];
  value: string;
  active: number;
  upwards: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  onActive: (index: number) => void;
  onChoose: (index: number) => void;
  onClose: () => void;
}) {
  const present = useIsPresent();
  const reduce = useReducedMotion();

  // Placement is written straight to the element before paint, so the menu is never painted (or
  // laid out at the end of <body>) unplaced, and scrolling never re-renders it.
  useLayoutEffect(() => {
    if (!present) return;
    const place = () => {
      const list = listRef.current;
      const anchor = trigger.current;
      if (!list || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      if (r.height > 0 && (r.bottom <= 0 || r.top >= vh)) { onClose(); return; }
      list.style.minWidth = `${Math.min(r.width, vw - MARGIN * 2)}px`;
      list.style.maxWidth = `${vw - MARGIN * 2}px`;
      const natural = Math.min(MAX_HEIGHT, list.scrollHeight);
      const below = vh - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const up = natural > below && above > below;
      const height = Math.min(natural, Math.max(ROW * 2 + PAD * 2, Math.min(MAX_HEIGHT, up ? above : below)));
      list.style.maxHeight = `${height}px`;
      const width = list.offsetWidth;
      const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, vw - MARGIN - width));
      const top = up ? r.top - GAP - height : r.bottom + GAP;
      const origin = fixedOrigin(list.parentElement);
      list.style.left = `${left - origin.x}px`;
      list.style.top = `${top - origin.y}px`;
      list.style.transformOrigin = `${Math.round(r.left + Math.min(r.width, width) / 2 - left)}px ${up ? "100%" : "0%"}`;
      list.style.visibility = "visible";
    };
    place();
    let frame = 0;
    const schedule = (event?: Event) => {
      if (event?.target === listRef.current) return; // the menu scrolling its own rows
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    // Content loading above the trigger moves it without any scroll event.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    observer?.observe(document.body);
    if (trigger.current) observer?.observe(trigger.current);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [present, listRef, trigger, onClose]);

  // Keep the active row in view by scrolling the menu itself; the page never moves.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.children[active] as HTMLElement | undefined;
    if (!list || !row || !present) return;
    const top = row.offsetTop - PAD;
    const bottom = row.offsetTop + row.offsetHeight + PAD;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active, listRef, present]);

  return <motion.div ref={listRef} id={listId} role="listbox" aria-label={label}
    inert={!present} aria-hidden={present ? undefined : true}
    className={`${styles.list} matte-reset`}
    initial={reduce ? false : { opacity: 0, scale: 0.96, y: upwards ? 6 : -6 }}
    animate={{ opacity: 1, scale: 1, y: 0, transition: spring("snappy", reduce) }}
    exit={{ opacity: 0, transition: fade("quick", reduce) }}>
    {options.map((option, index) => {
      const chosen = option.value === value;
      return <button key={`${option.value}-${index}`} type="button"
        id={`${listId}-${index}`} role="option" aria-selected={chosen}
        disabled={option.disabled} tabIndex={-1} onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={() => { if (!option.disabled) onActive(index); }}
        onClick={() => onChoose(index)}
        className={`${styles.option} ${index === active ? styles.active : ""}`}>
        <span className={styles.mark}>{chosen && <Check />}</span>
        <span className={styles.label}>{option.label}</span>
      </button>;
    })}
  </motion.div>;
}

export default function GlassSelect({ value, onChange, options, id, name, disabled = false,
  className = "", style, "aria-label": ariaLabel, "aria-describedby": describedBy }: {
  value: string;
  onChange: (value: string) => void;
  options: GlassSelectOption[];
  id?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label": string;
  "aria-describedby"?: string;
}) {
  const generatedId = useId().replace(/:/g, "");
  const listId = `${id ?? generatedId}-choices`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [upwards, setUpwards] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const enabled = options.map((option, index) => !option.disabled ? index : -1).filter((index) => index >= 0);
  const selected = options.findIndex((option) => option.value === value);
  const label = options[selected]?.label ?? "Choose";
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function openMenu(from: HTMLElement) {
    setActive(selected >= 0 && !options[selected].disabled ? selected : enabled[0] ?? 0);
    setPortalRoot(from.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    // The entrance direction is settled before mount; the menu's own layout effect then places it.
    const r = from.getBoundingClientRect();
    const estimate = Math.min(MAX_HEIGHT, options.length * ROW + PAD * 2);
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    setUpwards(estimate > below && r.top - GAP - MARGIN > below);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || enabled.length === 0) return;
    if (event.key === "Escape") { if (open) event.stopPropagation(); setOpen(false); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else openMenu(event.currentTarget);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { openMenu(event.currentTarget); return; }
      const current = Math.max(0, enabled.indexOf(active));
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      setActive(enabled[next]);
    }
  }

  return <>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={ariaLabel}
      aria-describedby={describedBy} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      disabled={disabled} onKeyDown={onKeyDown}
      onClick={(event) => { if (open) setOpen(false); else openMenu(event.currentTarget); }}
      className={`${styles.trigger} ${className}`} style={style}>
      <span className={styles.value}>{label}</span><Chevron />
    </button>
    {portalRoot && createPortal(<AnimatePresence>
      {open && <Menu key="menu" listId={listId} label={ariaLabel} options={options} value={value}
        active={active} upwards={upwards} trigger={trigger} listRef={list}
        onActive={setActive} onChoose={choose} onClose={close} />}
    </AnimatePresence>, portalRoot)}
  </>;
}
