/** Known-bad class combinations for tests/design/contrast-scan.test.ts. Never rendered. */
const PANEL_TEXT = "text-caption text-on-olive";

export function Offenders({ on }: { on: boolean }) {
  return <div>
    <p className={`olive-panel m-0 p-4 ${PANEL_TEXT}`}>Cream on a 7 % tint</p>
    <span className="text-on-olive-muted">Cream on ivory</span>
    <span className={on ? "well text-on-primary" : "well text-charcoal"}>Cream on a well</span>
    <span className="text-tiny text-gauge-carbs">Sage as text</span>
    <span className="text-tiny macro-protein">A gauge class as text</span>
    <span className="h-1.5 w-1.5 rounded-full bg-current macro-protein" />
  </div>;
}
