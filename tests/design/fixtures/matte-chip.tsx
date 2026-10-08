/** Light chips a `.matte` shell in another file renders (contrast-scan rule 6). Never rendered. */
const CHIP_FILL = "bg-[var(--color-fog)] shadow-[0_0_0_1px_rgb(var(--ink-rgb)/0.06)]";

export function MatteChip() {
  return <div>
    <button type="button" className={`${CHIP_FILL} rounded-full text-charcoal`}>Cream on fog</button>
    <span className="well text-charcoal">Cream on a well</span>
    <span className="matte-reset"><span className="well text-charcoal">Reset: fine</span></span>
  </div>;
}
