"use client";

import { useRef, useState } from "react";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import MascotPicker from "@/components/today/care/MascotPicker";
import { MASCOTS, type MascotKey } from "@/components/today/island/mascots";
import { MASCOT_EVENT, useMascot } from "@/components/today/island/well-pet";
import { syncProfileSettings } from "@/lib/coach/apply-profile";
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { enqueueCompanionWrite, setCompanionShown, useHiddenCompanions } from "@/lib/today/companion-visibility";
import { loadStore, saveStoreFor } from "@/lib/store";
import Card from "./Card";
import SettingsSection from "./Section";
import styles from "./CompanionSection.module.css";
import { CAPTION } from "./settings-styles";
import { SETTINGS_WRITE_FAILED, useSettingsWrite } from "./use-settings-write";

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
 * Changing companion keeps every Seed and item. A companion the account hid carries a "Hidden" tag,
 * and one switch row shows or hides the chosen one on Today (UI makeover W3, `companionsHidden`,
 * synced per account); choices and Show/Hide share one write queue on this phone.
 */
export default function CompanionSection() {
  const stored = useMascot();
  const [pending, setPending] = useState<MascotKey | null>(null);
  const latest = useRef(0);
  const hidden = useHiddenCompanions();
  const { feedback, write } = useSettingsWrite((choice: Choice) => {
    const { mascot, seq, h } = choice;
    return enqueueCompanionWrite(async () => {
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
  });
  const choose = (mascot: MascotKey) => {
    const seq = ++latest.current;
    setPending(mascot);
    write({ mascot, seq, h: currentAccountOrNull() });
  };
  const selected = pending ?? stored;
  const name = MASCOTS[selected].name;
  const shown = !hidden.includes(selected);
  // Show/Hide changes the phone at the tap (so a second tap reads the new state) and waits its turn
  // on the companion write queue behind any choice still being saved.
  const toggleShown = () => void feedback.run(() => setCompanionShown(selected, !shown),
    { kind: "commit", failureMessage: SETTINGS_WRITE_FAILED });
  return <SettingsSection title="Your companion">
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    <Card feedback={feedback.phase}>
      <p className={`m-0 ${CAPTION}`}>Who keeps you company on Today. Your Seeds and items stay yours.</p>
      <div className={`matte ${styles.well}`}>
        <MascotPicker value={selected} onChange={choose} hidden={hidden} />
      </div>
      <div className={styles.showRow}>
        <span className="text-body text-charcoal">{`Show ${name} on Today`}</span>
        <Button variant="secondary" size="sm" role="switch" aria-checked={shown} aria-label={`Show ${name} on Today`}
          className="shrink-0" onClick={toggleShown}>
          {shown ? "On" : "Off"}
        </Button>
      </div>
    </Card>
  </SettingsSection>;
}
