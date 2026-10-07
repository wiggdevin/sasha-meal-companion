import type { ButtonHTMLAttributes } from "react";

/**
 * A choice in a small set (a unit, a weekday): a pill that is the white primary fill when chosen
 * and plain text when not. Group chips inside a `pill-in` row.
 */
export default function Chip({ selected = false, className = "", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button type="button" aria-pressed={selected}
      className={`tap min-h-11 flex-1 rounded-full px-3 text-caption font-normal ${selected ? "chip-on" : "chip-off"} ${className}`.trim()}
      {...rest}>
      {children}
    </button>
  );
}
