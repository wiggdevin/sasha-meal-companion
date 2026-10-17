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
  return <SettingsSection title="Background">
    <Card>
      <p className={`m-0 ${CAPTION}`}>The colour behind your cards. It stays on this phone.</p>
      <div role="radiogroup" aria-label="Background" className="grid grid-cols-4 gap-3">
        {GROUNDS.map((g) => {
          const on = g.id === value;
          return <button key={g.id} type="button" role="radio" aria-checked={on}
            onClick={() => choose(g.id)}
            className="flex min-h-11 flex-col items-center gap-2 bg-transparent p-0 text-center">
            <span aria-hidden="true"
              className={`ground-swatch-${g.id} block h-14 w-full rounded-2xl ${on ? "ring-2 ring-primary" : "ring-1 ring-charcoal/10"}`} />
            <span className={`text-body-sm ${on ? "font-semibold text-charcoal" : "text-muted"}`}>{g.label}</span>
          </button>;
        })}
      </div>
    </Card>
  </SettingsSection>;
}
