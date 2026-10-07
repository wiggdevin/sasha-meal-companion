"use client";

import { useEffect, useState } from "react";
import CuisineChips, { cuisineCount } from "@/components/CuisineChips";
import TasteChipsField from "@/components/profile/TasteChipsField";
import { cuisinesFrom, type CuisineKey } from "@/lib/profile/cuisines";
import { readProfilePilot } from "@/lib/profile/profile-pilot-client";
import type { Settings } from "@/lib/types";

/**
 * The optional cuisine screen in onboarding (Phase 18 W5, D2): cuisines only — no country (Settings
 * holds that) and no taste chips (W5b). It follows the food-rule review ("Dietary preferences",
 * step 3) and appears only while `GET /api/onboarding/profile-pilot` answers `enabled: true`; any
 * other answer hides it, so no one sees it before W15 assigns a pilot arm.
 *
 * The flow's own step numbers do not move: the screen is a stop between step 3 and step 4, held
 * here. The answer is a draft until "Use this plan", like every onboarding answer; an untouched
 * screen writes nothing, so it never clears cuisines saved on another device.
 */
export const CUISINE_AFTER_STEP = 3;
export const CUISINE_STEP_TITLE = "Cuisines";

function useProfilePilot(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void readProfilePilot().then((on) => { if (live) setEnabled(on); }, () => {});
    return () => { live = false; };
  }, []);
  return enabled;
}

export function useCuisineStep(step: number) {
  const enabled = useProfilePilot();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<CuisineKey[] | null>(null);
  // Left by any other route (a jump back to Body, a retry on Foods): the stop closes behind it.
  const [seenStep, setSeenStep] = useState(step);
  if (seenStep !== step) {
    setSeenStep(step);
    if (step !== CUISINE_AFTER_STEP) setOpen(false);
  }
  const at = enabled && open && step === CUISINE_AFTER_STEP;
  return {
    at,
    chosen,
    setChosen,
    /** Steps shown, and this screen's place among them (1-based). */
    total: (steps: number) => steps + (enabled ? 1 : 0),
    position: step + 1 + (enabled && (at || step > CUISINE_AFTER_STEP) ? 1 : 0),
    /** Next: from step 3 into this screen (true: the press is taken), or on from it (false). */
    forward(): boolean {
      if (at) { setOpen(false); return false; }
      if (!enabled || step !== CUISINE_AFTER_STEP) return false;
      setOpen(true);
      return true;
    },
    /** Back: from this screen to step 3 (true: the press is taken), or from step 4 into it. */
    back(): boolean {
      if (at) { setOpen(false); return true; }
      if (enabled && step === CUISINE_AFTER_STEP + 1) setOpen(true);
      return false;
    },
    /** The settings the plan saves: the chosen cuisines when this screen was answered. */
    withCuisines: (base: Settings): Settings => (chosen === null ? base : { ...base, cuisines: [...chosen] }),
  };
}

export default function CuisineStep({ base, chosen, onChange }: {
  base: Settings;
  chosen: CuisineKey[] | null;
  onChange: (next: CuisineKey[]) => void;
}) {
  const value = chosen ?? cuisinesFrom(base.cuisines);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-caption font-normal text-charcoal">
        Which cuisines do you like? Pick up to 6, or skip this. Food ideas will lean toward them; they never rule a food out.
      </p>
      <CuisineChips label="Cuisines you like" value={value} onChange={onChange} />
      <p className="m-0 text-tiny font-light text-muted" aria-live="polite">{cuisineCount(value.length)}</p>
      {/* Up to 3 chips or one taste text (W5b-2 UI spec); no state, region, race or ethnicity
          question is ever asked here or inside TasteChipsField. The heading and its divider live
          inside TasteChipsField itself, so they render only while the field does (verified finding:
          they used to sit here unconditionally, leaving a bare heading when the flag was off). */}
      <TasteChipsField source="onboarding" heading="Any taste you want to add?" />
    </div>
  );
}
