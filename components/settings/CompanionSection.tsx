"use client";

import { useRef, useState } from "react";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import MascotPicker from "@/components/today/care/MascotPicker";
import type { MascotKey } from "@/components/today/island/mascots";
import { MASCOT_EVENT, useMascot } from "@/components/today/island/well-pet";
import { syncProfileSettings } from "@/lib/coach/apply-profile";
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import Card from "./Card";
import SettingsSection from "./Section";
import styles from "./CompanionSection.module.css";
import { CAPTION } from "./settings-styles";
import { useSettingsWrite } from "./use-settings-write";

type Choice = { mascot: MascotKey; seq: number; h: AccountHandle | null };

/**
 * Settings › Your companion (owner, 2026-10-07: "Choose a mascot"; CONTRACT MASCOT #8). The picker
 * sits in a small dark well, its home on Today. It shows the companion the phone has (`useMascot`,
 * the well's own reader, so a pull moves it too), or the newest choice still being saved. Choices
 * are sent one after another in tap order as the one `mascot` field on the settings sync, with the
 * shared feedback like Water; each one saved is kept on the phone and tells an open well. When the
 * newest choice fails, the picker shows the companion the account still has; an older failure
 * changes nothing on screen. Each choice belongs to the account that was signed in at the tap: one
 * still waiting its turn after a switch is never sent or kept for the next account (Sol r2).
 * Changing companion keeps every Seed and item.
 */
export default function CompanionSection() {
  const stored = useMascot();
  const [pending, setPending] = useState<MascotKey | null>(null);
  const latest = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const { feedback, write } = useSettingsWrite(({ mascot, seq, h }: Choice) => {
    const run = queue.current.catch(() => {}).then(async () => {
      try {
        if (!h) throw new Error("No account is signed in.");
        assertCurrent(h);
        await syncProfileSettings({ ...loadStore().settings, mascot }, h, ["mascot"]);
        assertCurrent(h);
        const now = loadStore();
        saveStoreFor(h, { ...now, settings: { ...now.settings, mascot } }, { silent: true });
        window.dispatchEvent(new Event(MASCOT_EVENT));
      } finally {
        if (seq === latest.current) setPending(null);
      }
    });
    queue.current = run;
    return run;
  });
  const choose = (mascot: MascotKey) => {
    const seq = ++latest.current;
    setPending(mascot);
    write({ mascot, seq, h: currentAccountOrNull() });
  };
  return <SettingsSection title="Your companion">
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    <Card feedback={feedback.phase}>
      <p className={`m-0 ${CAPTION}`}>Who keeps you company in the glass well. Your Seeds and items stay yours.</p>
      <div className={`matte ${styles.well}`}>
        <MascotPicker value={pending ?? stored} onChange={choose} />
      </div>
    </Card>
  </SettingsSection>;
}
