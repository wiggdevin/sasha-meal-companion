"use client";

/**
 * A ± stepper for a single numeric target. PRD §7.5 "Controls" — this is the
 * whole interaction the reviewer needs: "go up two hundred on training days" is
 * four taps of `+` on a `step={50}` Stepper, nothing else.
 *
 * Shape copied from the serving stepper in LogMeal.dc.html: a `.pill` shell
 * around a `.pill-in` interior, 44 × 44 px buttons in #4a4c42 at 18 px/300,
 * the value centred at 13 px/400. The user uses this on a phone, one-handed.
 */
type StepperProps = {
  label: string;
  value: number;
  step: number;
  unit?: string;
  onChange: (next: number) => void;
  disabled?: boolean;
  helperText?: string;
};

const STEP_BUTTON = "rounded-full text-graphite text-subheading font-normal";
const STEP_BUTTON_STYLE: React.CSSProperties = { width: 44, height: 44 };

export default function Stepper({
  label,
  value,
  step,
  unit,
  onChange,
  disabled = false,
  helperText,
}: StepperProps) {
  const display = unit ? `${value.toLocaleString("en-US")} ${unit}` : value.toLocaleString("en-US");

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-body font-medium text-charcoal">
          {label}
        </span>
        <div className="pill inline-flex shrink-0">
          <div className="pill-in flex items-center">
            <button
              type="button"
              aria-label={`Decrease ${label}`}
              disabled={disabled}
              onClick={() => onChange(value - step)}
              className={`flex items-center justify-center disabled:opacity-40 ${STEP_BUTTON}`}
              style={STEP_BUTTON_STYLE}
            >
              −
            </button>
            <span
              className="text-center tabular-nums text-caption font-normal text-charcoal"
              style={{ minWidth: 76 }}
            >
              {display}
            </span>
            <button
              type="button"
              aria-label={`Increase ${label}`}
              disabled={disabled}
              onClick={() => onChange(value + step)}
              className={`flex items-center justify-center disabled:opacity-40 ${STEP_BUTTON}`}
              style={STEP_BUTTON_STYLE}
            >
              +
            </button>
          </div>
        </div>
      </div>
      {helperText && (
        <p className="mt-1 text-tiny font-normal text-muted">
          {helperText}
        </p>
      )}
    </div>
  );
}
