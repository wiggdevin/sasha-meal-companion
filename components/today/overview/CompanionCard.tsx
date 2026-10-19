"use client";

import { useEffect, useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import CardFrame from "@/components/ui/CardFrame";
import { DisclosureChevron, DisclosurePanel } from "@/components/ui/Disclosure";
import CareLayer from "@/components/today/care/CareLayer";
import { useCare } from "@/components/today/care/useCare";
import SproutStage, { SproutFigure, type Glance } from "@/components/today/island/Sprout";
import { MASCOTS, type MascotKey } from "@/components/today/island/mascots";
import { wellPet } from "@/components/today/island/well-pet";
import PondScene from "@/components/today/scene/PondScene";
import type { OverviewData } from "@/components/today/overview/types";
import type { PetMood, PetState } from "@/lib/today/pet-mood";
import styles from "@/components/today/overview/CompanionCard.module.css";

/** The mood in one word, for the row's name ("Sprout: content. Open"). */
const MOOD_WORD: Record<PetMood, string> = { content: "content", joyful: "joyful", sleepy: "sleepy" };

/** The design gallery's fixed state: its own clock and open/closed, no Seeds read and no Hide. */
export type CompanionPreview = { hour: number; open?: boolean; pond?: boolean };

/** The phone's hour, read once mounted and again every few minutes; a preview holds its own. */
function useHour(fixed: number | undefined): number | null {
  const [hour, setHour] = useState<number | null>(fixed ?? null);
  useEffect(() => {
    if (fixed !== undefined) return;
    const tick = () => { const now = new Date(); setHour(now.getHours() + now.getMinutes() / 60); };
    tick();
    const timer = setInterval(tick, 5 * 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return hour;
}

/** The companion cheers for a moment when the viewed day's log grows on today (neutral copy). */
function useCheer(kcal: number, when: OverviewData["when"]): { cheer: boolean; bounce: number } {
  const [cheer, setCheer] = useState(false);
  const [bounce, setBounce] = useState(0);
  const last = useRef({ kcal, when });
  // The timer outlives a later change (a drop inside the 2.6 s would otherwise leave the cheer on).
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const before = last.current;
    last.current = { kcal, when };
    if (when !== "today" || before.when !== "today" || kcal <= before.kcal) return;
    setCheer(true);
    setBounce((count) => count + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCheer(false), 2600);
  }, [kcal, when]);
  return { cheer, bounce };
}

/**
 * The companion in the Overview face (UI makeover §5): one 64 px row that opens in place. Collapsed,
 * the companion in its current mood, its name, one observational line (OD19: never sad on a
 * shortfall, never tells anyone to eat), a Seeds tag when the care read succeeded, and a chevron.
 * Open, a dark stage with the companion, its line and "Care today", the Seeds chip and its messages
 * (today only), then Visit the pond and a Hide link. Nothing here is a bubble, swipe, hold or hidden
 * grabber. The open state is never stored; frame loops rest while the face is hidden.
 */
export default function CompanionCard({ data, mascot, active, onHide, preview }: {
  data: Pick<OverviewData, "targets" | "consumed" | "partial" | "water" | "when">;
  mascot: MascotKey;
  /** True while the Overview face is on show. */
  active: boolean;
  /** Hides this companion for the account (the slot owns the write and its Undo). */
  onHide?: () => void;
  preview?: CompanionPreview;
}) {
  const id = useId();
  const [open, setOpen] = useState(preview?.open ?? false);
  const [pond, setPond] = useState(preview?.pond ?? false);
  const [glance, setGlance] = useState<Glance>(null);
  const hour = useHour(preview?.hour);
  const { cheer, bounce } = useCheer(data.consumed.kcal, data.when);
  const name = MASCOTS[mascot].name;
  const today = data.when === "today";
  // Seeds and messages are read while the row is on show on today; a failed read shows nothing.
  const careOn = active && today && !preview;
  const care = useCare(careOn);
  const targets = data.targets;
  const pet: PetState = targets
    ? wellPet({ targets, consumed: data.consumed, partial: data.partial,
      water: data.water ? { cups: data.water.cups, goal: data.water.goal } : undefined }, hour, data.when, cheer, mascot)
    : { mood: "content", vitality: null, line: `${name} is here with you.` };
  // Folding the row (or leaving the face) puts the pond away: it opens on the stage again.
  const shownPond = pond && open && targets !== null;
  const toggle = () => { setOpen((was) => !was); setPond(false); };

  return <CardFrame size="sm" as="section" aria-label={name}>
    <button type="button" className={`tap ${styles.row}`} aria-expanded={open}
      aria-controls={`${id}-panel`} aria-label={`${name}: ${MOOD_WORD[pet.mood]}. ${open ? "Close" : "Open"}`}
      onClick={toggle}>
      <span className={styles.figure} data-mood={pet.mood}>
        <SproutFigure mascot={mascot} mood={pet.mood} size={40} breathe={false} shadow={false} />
      </span>
      <span className={styles.words}>
        <span className={`text-body font-semibold text-charcoal ${styles.name}`}>{name}</span>
        <span className={`text-caption text-muted ${styles.line}`}>{pet.line}</span>
      </span>
      {care.shop && <span className={`text-caption ${styles.seeds}`} data-testid="companion-seeds">
        {`Seeds ${care.shop.state.balance.toLocaleString("en-US")}`}
      </span>}
      <DisclosureChevron open={open} />
    </button>
    <DisclosurePanel id={`${id}-panel`} open={open} keepMounted={false}>
      <div className={styles.open}>
        <div className={`matte ${styles.stage}`} data-pond={shownPond || undefined}
          onPointerDown={(event) => setGlance({ x: event.clientX, key: event.timeStamp })}>
          {shownPond && targets
            ? <PondScene data={{ targets, consumed: data.consumed, partial: data.partial, water: data.water }} pet={pet}
              paused={!active} cheer={bounce} />
            : <SproutStage state={pet} glance={glance} bounce={bounce} when={data.when} mascot={mascot} />}
          {/* Seeds, the shop and messages: today only, and never for a hidden companion (the slot
              unmounts this card). The shop is modal over the page while it is open. */}
          {!preview && <CareLayer active={careOn && open && !shownPond} care={care} modalAt="screen" />}
        </div>
        <div className={styles.actions}>
          {targets && <Button variant="secondary" size="sm" onClick={() => setPond((was) => !was)}>
            {shownPond ? "Back" : "Visit the pond"}
          </Button>}
          {onHide && <button type="button" className={`tap text-caption text-muted ${styles.hide}`}
            onClick={onHide}>{`Hide ${name}`}</button>}
        </div>
      </div>
    </DisclosurePanel>
  </CardFrame>;
}
