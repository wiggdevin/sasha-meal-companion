"use client";
/**
 * What the Plan panel shows after a photo: one clear next step. A plate offers to log itself to
 * this meal with a portion adjuster; a menu shows the three dishes that fit best as image cards, each
 * with an ordering tip, opening into a larger card that logs it. Every log is checked first. Under any photo result, one line re-reads the same photo
 * another way without uploading it again: PhotoResult draws it when given `onSwitch` (the recipe
 * widget); the Plan panel draws its own, which also sits under an ingredients read.
 */
import { useState } from "react";
import SuggestionCarousel from "@/components/recipes-hub/SuggestionCarousel";
import { suggestionPhoto } from "@/components/recipes-hub/SuggestionCard";
import Tag from "@/components/ui/Tag";
import type { InspireResult, PhotoRead } from "@/lib/plan/inspire-types";
import { PORTIONS, scaleMacros, type MenuPick, type PlateEstimate } from "@/lib/plan/photo-result";
import { MacroLine } from "@/components/nutrition/MacroText";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
import AiLabel from "@/components/ui/AiLabel";
import type { Provenance } from "@/lib/types";
import { CARD_SECTION, MEAL_TITLE } from "@/lib/design/meal-type";

/** Which read each kind already is, so the switch line can mark it. */
export function readOf(kind: InspireResult["kind"]): PhotoRead {
  return kind === "plate" ? "plate" : kind === "menu" ? "menu" : "ingredients";
}

const SWITCHES: { read: PhotoRead; label: string }[] = [
  { read: "plate", label: "Log it" }, { read: "menu", label: "Pick from menu" },
  { read: "ingredients", label: "Cook from it" },
];

export function SwitchLine({ current, busy, onSwitch }: {
  current: PhotoRead; busy: boolean; onSwitch: (read: PhotoRead) => void;
}) {
  return <p className="m-0 flex flex-wrap items-center gap-x-1 text-tiny text-muted" aria-label="Not right?">
    <span>Not right?</span>
    {SWITCHES.map(({ read, label }, index) => <span key={read} className="flex items-center gap-1">
      {index > 0 && <span aria-hidden="true">·</span>}
      <Button variant="ghost" size="sm" disabled={busy || read === current} aria-current={read === current || undefined}
        aria-label={`${label} instead`} onClick={() => onSwitch(read)}
        className="px-1 underline decoration-hairline underline-offset-4 disabled:no-underline">
        {label}
      </Button>
    </span>)}
  </p>;
}

function PlateResult({ plate, label, busy, logging, onLog, provenance }: {
  plate: PlateEstimate; label: string; busy: boolean; logging: boolean; onLog: (factor: number) => void;
  provenance?: Provenance;
}) {
  const [factor, setFactor] = useState(1);
  const shown = scaleMacros(plate, factor);
  return <section aria-label={`Log this as ${label}?`}
    className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h3 className={`m-0 min-w-0 ${CARD_SECTION}`}>Log this as {label}?</h3>
        <AiLabel provenance={provenance} className="mt-0.5" />
      </div>
      {plate.title && <p className={`m-0 ${MEAL_TITLE.standard}`}>{plate.title}</p>}
      <p className="m-0 text-caption text-graphite">About <MacroLine values={shown} /></p>
      <p className="m-0 text-tiny text-muted">
        {plate.items.map((item) => `${item.name} ${Math.round(item.grams * factor)} g`).join(" · ")}
      </p>
    </div>
    <div role="group" aria-label="Portion" className="flex gap-2">
      {PORTIONS.map((portion) => <Button key={portion.label} size="sm" disabled={busy} className="flex-1"
        variant={factor === portion.factor ? "primary" : "secondary"}
        aria-pressed={factor === portion.factor} onClick={() => setFactor(portion.factor)}>
        {portion.label}
      </Button>)}
    </div>
    {/* The capture's own foods are shown to check before anything is logged (AI audit B3). */}
    <Button variant="primary" block disabled={busy} status={logging ? "pending" : undefined}
      onClick={() => onLog(factor)}>Check and log</Button>
  </section>;
}

/** What a pick shows once its card has grown: what to ask first, and "Log it", which shows the
 *  capture's foods to check before anything is logged (AI audit B3). */
function PickDetail({ pick, busy, logging, onLog }: {
  pick: MenuPick; busy: boolean; logging: boolean; onLog: () => void;
}) {
  return <div className="flex min-w-0 flex-col gap-3 pb-1">
    {pick.check && <Notice tone="attention" title={pick.check} />}
    <Button variant="primary" block disabled={busy} status={logging ? "pending" : undefined}
      aria-label={`Log ${pick.name}`} onClick={onLog}>Log it</Button>
  </div>;
}

/**
 * A menu's best picks as image cards (2026-10-04, owner: "like the little visible cards that you can
 * horizontally scroll that we have, and that can be expanded into larger meal cards"): the shared
 * carousel of the Foods recipe hub and Swap. A tap grows a pick in place into its larger card.
 */
function MenuResult({ picks, targetKcal, busy, logging, onPick, provenance }: {
  picks: MenuPick[]; targetKcal: number | undefined; busy: boolean; logging: string | null;
  onPick: (pick: MenuPick) => void; provenance?: Provenance;
}) {
  // The slot's budget is said as room left, never as a figure of the meal (U2).
  const heading = targetKcal ? `Best picks for the ${Math.round(targetKcal)} kcal left` : "Best picks from this menu";
  return <section aria-label={heading} className="flex min-w-0 flex-col gap-2">
    {/* One label for the whole read, beside its heading, never one per pick. */}
    <div className="flex min-w-0 items-start justify-between gap-2">
      <h3 className="m-0 min-w-0 text-body-md font-medium"><KcalText text={heading} /></h3>
      <AiLabel provenance={provenance} className="mt-0.5" />
    </div>
    {picks.length === 0 && <Notice tone="neutral" title="Nothing I could read here fits your food rules.">
      Try a clearer photo of the menu.
    </Notice>}
    {picks.length > 0 && <SuggestionCarousel label="Menu picks" nested items={picks.map((pick) => ({
      id: pick.name, name: pick.name, image: suggestionPhoto(pick.name, []),
      description: pick.tip ? `Tip: ${pick.tip}` : undefined, values: pick,
      tag: pick.check ? <Tag size="md" tone="yellow">Ask first</Tag> : undefined,
      detail: <PickDetail pick={pick} busy={busy} logging={logging === pick.name} onLog={() => onPick(pick)} />,
    }))} />}
  </section>;
}

export default function PhotoResult({ result, label, targetKcal, busy, logging, onLogPlate, onPick, onSwitch }: {
  result: InspireResult; label: string; targetKcal: number | undefined; busy: boolean;
  /** "plate" while a plate logs, a dish name while that pick logs. */
  logging: string | null;
  onLogPlate: (factor: number) => void; onPick: (pick: MenuPick) => void;
  /** Re-read the same photo another way ("Not right?"), drawn under the result. */
  onSwitch?: (read: PhotoRead) => void;
}) {
  const shown = result.kind === "plate" && result.plate
    ? <PlateResult plate={result.plate} label={label} busy={busy} logging={logging === "plate"} onLog={onLogPlate}
      provenance={result.provenance} />
    : result.kind === "menu"
      ? <MenuResult picks={result.menu ?? []} targetKcal={targetKcal} busy={busy} logging={logging} onPick={onPick}
        provenance={result.provenance} />
      : null;
  if (!shown || !onSwitch) return shown;
  return <div className="flex min-w-0 flex-col gap-2">
    {shown}
    <SwitchLine current={readOf(result.kind)} busy={busy} onSwitch={onSwitch} />
  </div>;
}
