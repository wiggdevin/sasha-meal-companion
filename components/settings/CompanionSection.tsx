"use client";

import { useState } from "react";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import MascotPicker from "@/components/today/care/MascotPicker";
import { mascotOf, type MascotKey } from "@/components/today/island/mascots";
import { MASCOT_EVENT } from "@/components/today/island/well-pet";
import { syncProfileSettings } from "@/lib/coach/apply-profile";
import { loadStore, saveStore } from "@/lib/store";
import type { Settings } from "@/lib/types";
import Card from "./Card";
import SettingsSection from "./Section";
import styles from "./CompanionSection.module.css";
import { CAPTION } from "./settings-styles";
import { useSettingsWrite } from "./use-settings-write";

/**
 * Settings › Your companion (owner, 2026-10-07: "Choose a mascot"; CONTRACT MASCOT #8). The picker
 * sits in a small dark well, its home on Today. A choice shows at once, is kept on the phone, and is
 * sent as the one `mascot` field on the settings sync, with the shared feedback like Water. Changing
 * companion keeps every Seed and item.
 */
export default function CompanionSection({ settings }: { settings: Settings }) {
  const [chosen, setChosen] = useState<MascotKey>(() => mascotOf(settings.mascot).key);
  const { feedback, write } = useSettingsWrite(async ({ mascot, previous }: { mascot: MascotKey; previous: MascotKey }) => {
    try {
      await syncProfileSettings({ ...loadStore().settings, mascot }, undefined, ["mascot"]);
    } catch (error) {
      // Not saved: the picker goes back to the companion the account still has.
      setChosen(previous);
      throw error;
    }
    saveStore({ ...loadStore(), settings: { ...loadStore().settings, mascot } }, { silent: true });
    window.dispatchEvent(new Event(MASCOT_EVENT));
  });
  return <SettingsSection title="Your companion">
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    <Card feedback={feedback.phase}>
      <p className={`m-0 ${CAPTION}`}>Who keeps you company in the glass well. Your Seeds and items stay yours.</p>
      <div className={`matte ${styles.well}`}>
        <MascotPicker value={chosen} onChange={(next) => { write({ mascot: next, previous: chosen }); setChosen(next); }} />
      </div>
    </Card>
  </SettingsSection>;
}
