import type { InputHTMLAttributes } from "react";

/**
 * A typed field: a visible label above a well (tests/design/visible-field-labels), an optional
 * hint under it, and an error line that also marks the input invalid. The label is never hidden.
 */
export default function Field({ id, label, hint, error, className = "", ...rest }: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className">) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`.trim()}>
      <label htmlFor={id} className="text-caption text-muted">{label}</label>
      <input id={id} aria-invalid={error ? "true" : undefined} aria-describedby={describedBy}
        className="well min-h-11 min-w-0 bg-transparent px-3 text-body-md text-charcoal outline-none placeholder:text-muted"
        {...rest} />
      {hint && <span id={`${id}-hint`} className="text-tiny text-muted">{hint}</span>}
      {error && <span id={`${id}-error`} role="alert" className="text-tiny text-alert">{error}</span>}
    </div>
  );
}
