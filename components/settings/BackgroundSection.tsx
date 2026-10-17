"use client";

import { useEffect, useState } from "react";
import { currentAccountOrNull, onAccountGone, onAccountReady } from "@/lib/device/account";
import { currentGround, GROUND_EVENT, saveGround } from "@/lib/design/ground-pref";
import { GROUNDS, type GroundId } from "@/lib/design/grounds";
import Card from "./Card";
import SettingsSection from "./Section";
import { CAPTION } from "./settings-styles";

/**
 * Settings › Background: four grounds for the page behind the cards. The choice is kept on this
 * phone for this account and painted at once; cards, the meal card and the dock do not change.
 */
export default function BackgroundSection() {
  const [value, setValue] = useState<GroundId>(currentGround);
  useEffect(() => {
    const sync = () => setValue(currentGround());
    sync();
    window.addEventListener(GROUND_EVENT, sync);
    const ready = onAccountReady(sync);
    const gone = onAccountGone(sync);
    return () => { window.removeEventListener(GROUND_EVENT, sync); ready(); gone(); };
  }, []);
  const choose = (id: GroundId) => {
    const h = currentAccountOrNull();
    if (!h) return;
    saveGround(h, id);
  };
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = GROUNDS[(i + step + GROUNDS.length) % GROUNDS.length];
    choose(next.id);
    document.getElementById(`ground-${next.id}`)?.focus();
  };
  return <SettingsSection title="Background">
    <Card>
      <p className={`m-0 ${CAPTION}`}>The colour behind your cards. It stays on this phone.</p>
      <div role="radiogroup" aria-label="Background" className="grid grid-cols-4 gap-3">
        {GROUNDS.map((g, i) => {
          const on = g.id === value;
          return <button key={g.id} id={`ground-${g.id}`} type="button" role="radio" aria-checked={on}
            tabIndex={on ? 0 : -1} onClick={() => choose(g.id)} onKeyDown={(e) => onKey(e, i)}
            className="flex min-h-11 flex-col items-center gap-2 rounded-2xl bg-transparent p-0 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <span aria-hidden="true"
              className={`ground-swatch-${g.id} block h-14 w-full rounded-2xl ${on ? "ring-2 ring-primary" : "ring-1 ring-charcoal/30"}`} />
            <span className={`text-body-sm ${on ? "font-semibold text-charcoal" : "text-muted"}`}>{g.label}</span>
          </button>;
        })}
      </div>
    </Card>
  </SettingsSection>;
}
