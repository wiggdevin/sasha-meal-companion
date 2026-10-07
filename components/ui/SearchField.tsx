"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { CloseIcon } from "@/components/ui/CloseButton";
import { SearchIcon } from "@/components/ui/icons";

/**
 * Input tier 1, lookup (DESIGN.md §Text fields, 2026-10-04): a plain search that filters as you type
 * and never talks to the AI. A paper field with the magnifier, a clear button once there is text, and
 * no send. Its siblings: tier 2, the component ask box (`components/plan/PlanComposer`, the AI rim and
 * a send), and tier 3, the dock's charcoal ask bar.
 */
export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** The field's accessible name when there is no visible label. */
  label: string;
  /** `md` 44 px inside a card or tray; `lg` 48 px as a screen's own search. */
  size?: "md" | "lg";
  /** Called after the clear button empties the field (focus stays in it). */
  onClear?: () => void;
  className?: string;
};

const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField({
  value, onValueChange, label, size = "md", onClear, className = "", placeholder, ...rest
}, ref) {
  return (
    <div className={`field field-search ${size === "lg" ? "field-lg" : ""} ${className}`.trim()} data-tier="lookup">
      <span className="field-glyph"><SearchIcon /></span>
      <input ref={ref} type="search" enterKeyHint="search" autoComplete="off" spellCheck={false}
        aria-label={label} placeholder={placeholder ?? label} value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="field-input" {...rest} />
      {value.length > 0 && <button type="button" className="field-clear" aria-label={`Clear ${label.toLowerCase()}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { onValueChange(""); onClear?.(); }}>
        <CloseIcon />
      </button>}
    </div>
  );
});

export default SearchField;
