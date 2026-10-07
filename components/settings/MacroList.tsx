import { MacroFigure } from "@/components/nutrition/MacroText";
import MacroIcon from "@/components/nutrition/MacroIcon";
import { MACROS, MACRO_SPEC } from "@/components/nutrition/spec";
import type { Macros } from "@/lib/types";
import { EYEBROW } from "./settings-styles";

/** One day type's four macro rows — the same list twice, so: one component. */
export default function MacroList({ eyebrow, macros }: { eyebrow: string; macros: Macros }) {
  return (
    <div className="flex flex-col gap-2">
      <p className={`m-0 ${EYEBROW}`}>{eyebrow}</p>
      <dl className="m-0 flex flex-col">
        {MACROS.map((key, i) => (
          <div
            key={key}
            className={`flex items-center justify-between gap-2 py-2 ${
              i === MACROS.length - 1 ? "" : "border-b border-hairline"}`}
          >
            {/* Icon, amount and its short name: the spelled-out word repeated the abbreviation
                (owner, 2026-10-05), so it is read to screen readers only. */}
            <dt className="flex items-center">
              <MacroIcon macro={key} size={14} />
              <span className="sr-only">{MACRO_SPEC[key].label}</span>
            </dt>
            <dd className="m-0 tabular-nums"><MacroFigure macro={key} value={macros[key]} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
