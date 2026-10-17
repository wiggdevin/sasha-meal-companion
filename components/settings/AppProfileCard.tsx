"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import Button from "@/components/ui/Button";
import { isProfileComplete } from "@/lib/profile/energy";
import { browserClient } from "@/lib/supabase/client";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { kgToLb } from "@/lib/health/units";
import { formatHeight } from "@/lib/units/height";
import type { Goal, Macros, Settings } from "@/lib/types";
import styles from "./AppProfileCard.module.css";

const GOAL_LABEL: Record<Goal, string> = {
  lose_fat: "Fat loss",
  recomp: "Recomposition",
  maintain: "Maintenance",
  gain_muscle: "Muscle gain",
};

/** The body details Edit profile sets (activity and goal live under Goals & targets), in the account's own units; "—" when unset. */
export function profileDetails(settings: Settings, year = new Date().getFullYear()): { label: string; value: string }[] {
  const weight = settings.weightKg == null ? "—" : settings.weightUnit === "kg"
    ? `${Math.round(settings.weightKg * 10) / 10} kg` : `${Math.round(kgToLb(settings.weightKg) * 10) / 10} lb`;
  return [
    { label: "Height", value: formatHeight(settings.heightCm ?? null, settings.heightUnit ?? "ft_in") },
    { label: "Weight", value: weight },
    { label: "Age", value: settings.birthYear ? String(year - settings.birthYear) : "—" },
    { label: "Sex", value: settings.sex === "female" ? "Female" : settings.sex === "male" ? "Male"
      : settings.sex === "unspecified" ? "Prefer not to say" : "—" },
    { label: "Body fat", value: settings.bodyFatPct == null ? "—" : `${settings.bodyFatPct}%` },
  ];
}

function formatKcal(target: Macros | null): string {
  return target ? target.kcal.toLocaleString("en-US") : "—";
}

function identityInitial(email: string | null): string {
  const candidate = email?.trim().charAt(0);
  return candidate ? candidate.toUpperCase() : "S";
}

/** One column of the stat row: the name on top, the figure under it with its unit set small, so
 *  three columns read level and nothing wraps (2026-10-01: "TRAINING KCAL" broke onto two lines). */
function ProfileStat({ label, value, unit, ink }: { label: string; value: string; unit?: string; ink?: string }) {
  return (
    <div className={`${styles.stat} flex min-w-0 flex-col items-center gap-2 px-2 py-4 text-center`}>
      <p className="m-0 whitespace-nowrap text-caption font-medium text-muted">{label}</p>
      <p className="m-0 flex items-baseline gap-1 whitespace-nowrap leading-none tabular-nums">
        <span className={`text-subheading font-medium tracking-tight ${ink ?? "text-charcoal"}`}>{value}</span>
        {unit && <span className="text-caption font-medium text-muted">{unit}</span>}
      </p>
    </div>
  );
}

export default function AppProfileCard({
  settings,
  setup,
  training,
  rest,
}: {
  settings: Settings;
  setup: boolean;
  training: Macros | null;
  rest: Macros | null;
}) {
  const reducedMotion = useReducedMotion();
  const [email, setEmail] = useState<string | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const ready = isProfileComplete(settings);
  const targetsReady = training !== null && rest !== null;

  useEffect(() => {
    let live = true;
    void browserClient().auth.getSession().then(
      ({ data }) => {
        if (!live) return;
        setEmail(data.session?.user.email ?? null);
        setIdentityLoaded(true);
      },
      () => {
        if (live) setIdentityLoaded(true);
      },
    );
    return () => { live = false; };
  }, []);

  function finishEditor(): void {
    setEditorOpen(false);
    globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
  }

  const protein = training?.protein ?? rest?.protein ?? null;
  const actionLabel = setup || !ready ? "Finish profile" : "Edit profile";
  const progress = ready ? "100%" : "58%";
  const statusLabel = !ready ? "Setup needed" : targetsReady ? "Plan ready" : "Targets unavailable";

  return (
    <>
      <motion.div className="shell"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
        <div className="surface flex flex-col gap-4 p-5">
          <div className="flex items-start gap-4">
            <div aria-label={ready ? "Profile ready" : "Profile setup needed"}
              className={`${styles.avatarRing} grid size-16 shrink-0 place-items-center rounded-full p-[3px]`}
              style={{ "--profile-progress": progress } as React.CSSProperties}>
              <span className={`${styles.avatarCore} grid size-full place-items-center rounded-full text-heading font-light text-charcoal`}>
                {identityInitial(email)}
              </span>
            </div>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 min-w-0 text-subheading font-medium leading-tight tracking-tight text-charcoal [text-wrap:balance]">
                  Your profile
                </h3>
                <span className={`${styles.tag} shrink-0 rounded-full px-2.5 py-1 text-caption font-medium text-graphite`}>
                  {statusLabel}
                </span>
              </div>
              {/* The address takes the full width under the title, so the tag never cuts it short. */}
              <p className="m-0 mt-1 truncate text-caption text-muted">
                {!identityLoaded ? "Checking account…" : email ?? "Account details unavailable"}
              </p>
              <p className="m-0 mt-3 text-caption leading-relaxed text-graphite [text-wrap:pretty]">
                {ready && targetsReady
                  ? "Your targets stay connected to the profile and food rules that shape your day."
                  : ready
                    ? "Your body profile is complete. Targets appear when the server revision is available."
                  : "Finish your details so every meal can be sized to you."}
              </p>
            </div>
          </div>

          <div className={`${styles.statGrid} grid grid-cols-3`}>
            <ProfileStat label="Training day" value={formatKcal(training)} unit={training ? "kcal" : undefined}
              ink={training ? "kcal" : undefined} />
            <ProfileStat label="Rest day" value={formatKcal(rest)} unit={rest ? "kcal" : undefined}
              ink={rest ? "kcal" : undefined} />
            <ProfileStat label="Protein" value={protein === null ? "—" : String(protein)}
              unit={protein === null ? undefined : "g"} ink={protein === null ? undefined : "macro-ink-protein"} />
          </div>

          {/* The body details the targets come from (owner, 2026-10-05: the separate "Body profile &
              units" section repeated what Edit profile edits, so it left and the card shows them). */}
          <dl className="m-0 grid grid-cols-3 gap-x-3 gap-y-3">
            {profileDetails(settings).map((detail) => (
              <div key={detail.label} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-tiny font-medium text-muted">{detail.label}</dt>
                <dd className="m-0 truncate text-caption font-medium tabular-nums text-charcoal">{detail.value}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-wrap gap-2">
            <span className={`${styles.tag} rounded-full px-3 py-1.5 text-caption text-graphite`}>
              {settings.goal ? GOAL_LABEL[settings.goal] : "Goal not set"}
            </span>
            <span className={`${styles.tag} rounded-full px-3 py-1.5 text-caption text-graphite`}>
              {settings.mealsPerDay ? `${settings.mealsPerDay} meals` : "Flexible meals"}
            </span>
          </div>

          <Button variant="primary" className="w-full font-medium" onClick={() => setEditorOpen(true)}>
            {actionLabel}
          </Button>
        </div>
      </motion.div>

      {editorOpen && <OnboardingFlow initial={0} returnTo="/settings" onFinished={finishEditor}
        offerDevice={setup} />}
    </>
  );
}
