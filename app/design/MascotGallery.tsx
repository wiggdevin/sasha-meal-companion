"use client";

import { useState } from "react";
import MascotPicker from "@/components/today/care/MascotPicker";
import { SproutFigure } from "@/components/today/island/SproutFigure";
import { MASCOTS, MASCOT_KEYS, type MascotKey, type MascotPose } from "@/components/today/island/mascots";
import styles from "@/app/design/ShopGallery.module.css";

const POSES: MascotPose[] = ["content", "joyful", "sleepy", "droopy", "wave", "listening", "thinking", "pointing"];

/** The companion picker in a stand-in for the open well, and every companion's eight poses (2026-10-07). */
export default function MascotGallery() {
  const [mascot, setMascot] = useState<MascotKey>("sprout");
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">Companions</h1>
    <section aria-label="The open well" className={`matte ${styles.well}`}>
      <MascotPicker value={mascot} onChange={setMascot} />
    </section>
    {MASCOT_KEYS.map((key) => <section key={key} aria-label={`${MASCOTS[key].name}'s poses`} className="flex flex-col gap-2">
      <h2 className="m-0 text-caption font-semibold text-muted">{MASCOTS[key].name}</h2>
      <div className="grid grid-cols-4 gap-2">
        {POSES.map((pose) => <SproutFigure key={pose} mascot={key} mood={pose} size={88} breathe={false} label={`${MASCOTS[key].name}, ${pose}`} />)}
      </div>
    </section>)}
  </main>;
}
