"use client";

import { APP_NAME } from "@/lib/brand";
import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/settings/Card";
import SettingsSection from "@/components/settings/Section";
import { CAPTION } from "@/components/settings/settings-styles";
import TourLayer, { type TourOpening } from "@/components/tour/TourLayer";

/** Settings › How the app works: the first-run overview, any time. Opening it here changes nothing stored. */
export default function HowSashaWorksCard() {
  const [opening, setOpening] = useState<TourOpening | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);
  return <SettingsSection title={`How ${APP_NAME} works`}>
    <Card>
      <p className={`m-0 ${CAPTION}`}>A short tour of your meal cards, what each tap does, and the swipe shortcuts.</p>
      <Button ref={button} variant="secondary" className="self-start" aria-haspopup="dialog"
        onClick={() => setOpening({
          origin: button.current?.getBoundingClientRect() ?? null, returnFocusTo: button.current, seq: ++seq.current,
        })}>
        Show me how it works
      </Button>
    </Card>
    <TourLayer opening={opening} onClose={() => setOpening(null)} />
  </SettingsSection>;
}
