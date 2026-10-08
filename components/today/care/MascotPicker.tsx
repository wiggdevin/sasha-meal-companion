"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import { SproutFigure } from "@/components/today/island/SproutFigure";
import { MASCOTS, MASCOT_KEYS, type MascotKey } from "@/components/today/island/mascots";
import styles from "@/components/today/care/Mascot.module.css";

/** How long a newly chosen companion waves before it settles, ms. */
const HELLO_MS = 1600;

/**
 * Choose your companion (owner, 2026-10-07: "Choose a mascot"). The chosen one stands large on top
 * with its name and one line, and waves hello when it is picked; below, all four in a row. Changing
 * companion keeps every Seed and item (the server's `user_settings.mascot` is only which one draws).
 * The choice is said in a polite live region; reduced motion swaps without the hop or the wave.
 */
export default function MascotPicker({ value, onChange }: {
  value: MascotKey;
  onChange: (next: MascotKey) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [hello, setHello] = useState(0);
  const [said, setSaid] = useState("");
  const waving = hello > 0 && !reduce;
  useEffect(() => {
    if (!hello) return;
    const timer = setTimeout(() => setHello(0), HELLO_MS);
    return () => clearTimeout(timer);
  }, [hello]);
  const chosen = MASCOTS[value];

  const choose = (key: MascotKey) => {
    if (key === value) return;
    onChange(key);
    setHello((n) => n + 1);
    setSaid(`${MASCOTS[key].name} is your companion now.`);
  };

  return <div className={styles.picker} role="group" aria-label="Choose your companion">
    <motion.div key={value} className={styles.feature} initial={reduce ? false : { y: 10, scale: 0.94 }}
      animate={{ y: 0, scale: 1 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
      <SproutFigure mascot={value} mood={waving ? "wave" : "content"} size={176} label={chosen.name} />
      <p className={styles.name}>{chosen.name}</p>
      <p className={styles.line}>{chosen.line}</p>
    </motion.div>
    <ul className={styles.row} aria-label="Companions">
      {MASCOT_KEYS.map((key) => <li key={key}>
        <button type="button" className={`tap ${styles.tile}`} aria-pressed={key === value} onClick={() => choose(key)}>
          <SproutFigure mascot={key} mood="content" size={64} breathe={false} shadow={false}
            className={styles.tileArt} />
          <span className={styles.tileName}>{MASCOTS[key].name}</span>
        </button>
      </li>)}
    </ul>
    <p className="sr-only" aria-live="polite">{said}</p>
  </div>;
}
