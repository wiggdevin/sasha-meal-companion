"use client";

import { useEffect, useState } from "react";
import { Pill } from "@/components/Sheet";
import CuisineChips, { cuisineCount } from "@/components/CuisineChips";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import GlassSelect from "@/components/ui/GlassSelect";
import TasteChipsField, { tasteDislikeLabel } from "@/components/profile/TasteChipsField";
import { countryFromValue, countryOptions, countryValue } from "@/lib/profile/countries";
import { cuisinesFrom, type CuisineKey } from "@/lib/profile/cuisines";
import { savePlaceSetting, type PlacePatch } from "@/lib/profile/cuisines-client";
import { readTasteChipsEnabled, type TasteChipsAvailability } from "@/lib/profile/taste-enabled-client";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";
import Card from "./Card";
import SettingsSection from "./Section";
import { CAPTION, FIELD_LABEL } from "./settings-styles";
import { useSettingsWrite } from "./use-settings-write";

/**
 * Settings › Cuisines and country (Phase 18 W5): both optional and shown to every account. Up to 6
 * favored cuisines, and a country the user picks (never read from a zone or location). Only the
 * United States will change food ideas, through the U.S. population prior; the copy says so.
 * Each change is shown at once and saved through the shared feedback, like Water.
 *
 * "Your taste" card (Phase 18 W5b-3): the field inside it (`TasteChipsField`) hides itself until
 * `readTasteChipsEnabled()` answers "enabled" — but with the flag off and no stored dislikes, the
 * card around it used to render anyway, leaving a bare legend and caption with nothing under them.
 * This probes the SAME flag itself and hands the answer DOWN to `TasteChipsField` as `availability`
 * (rather than letting it probe separately): two independent reads of the same flag could land two
 * different answers — a transient blip on one, or the flag flipping between them — and show the
 * card with nothing inside it again, the exact bug this exists to prevent (Sol BLOCK, verified).
 * The whole card is shown once the flag is "enabled", OR, flag off or still unknown, whenever the
 * account already has stored dislikes to show as the existing read-only pills (hotfix, live prod
 * bug — verified).
 */
export default function CuisinesSection({ settings }: { settings: Settings }) {
  const [cuisines, setCuisines] = useState<CuisineKey[] | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [tasteChipsAvailable, setTasteChipsAvailable] = useState<TasteChipsAvailability>("unknown");
  // Writes not yet settled (sent or waiting their turn). While none are, a change to the stored
  // settings (a sync pull from another device) replaces what this section last showed, so the next
  // tap builds on the account's current list, not an old one (UI audit r1).
  const [inFlight, setInFlight] = useState(0);
  const stored = JSON.stringify([settings.cuisines ?? null, settings.countryCode ?? null]);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    if (inFlight === 0) { setCuisines(null); setCountry(null); }
  }
  const shownCuisines = cuisines ?? cuisinesFrom(settings.cuisines);
  const shownCountry = country ?? countryValue(settings.countryCode);
  const { feedback, write: send } = useSettingsWrite<PlacePatch>(async (patch) => {
    try { await savePlaceSetting(patch); } finally { setInFlight((n) => n - 1); }
  });
  const write = (patch: PlacePatch) => { setInFlight((n) => n + 1); send(patch); };
  // `Settings.dietPrefs` is typed as the plain wire `DietPrefs` (lib/types.ts); `taste` is carried on
  // the richer `ProfileDietPrefs` every sync writer actually reads and writes (lib/sync/user-settings.ts).
  const dislikes = (settings.dietPrefs as ProfileDietPrefs | null | undefined)?.taste?.dislikes ?? [];
  const showTasteCard = tasteChipsAvailable === "enabled" || dislikes.length > 0;

  useEffect(() => {
    let live = true;
    void readTasteChipsEnabled().then((result) => { if (live) setTasteChipsAvailable(result); }, () => {});
    return () => { live = false; };
  }, []);

  return (
    <SettingsSection title="Cuisines and country">
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      <Card feedback={feedback.phase}>
        <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
          <legend className={`mb-1.5 ${FIELD_LABEL}`}>Cuisines you like</legend>
          <span className={CAPTION}>Optional. Food ideas will lean toward these. They never rule a food out.</span>
          <CuisineChips label="Cuisines you like" value={shownCuisines}
            onChange={(next) => { setCuisines(next); write({ cuisines: next }); }} />
          <span className={CAPTION} aria-live="polite">{cuisineCount(shownCuisines.length)}</span>
        </fieldset>
        <div className="flex min-w-0 flex-col gap-2.5">
          <span className={FIELD_LABEL}>Country</span>
          <GlassSelect aria-label="Country" aria-describedby="settings-country-help" value={shownCountry}
            options={countryOptions()}
            onChange={(value) => {
              if (value === shownCountry) return;
              setCountry(value);
              write({ countryCode: countryFromValue(value) });
            }} />
          <span id="settings-country-help" className={CAPTION}>
            Optional. For now, only the United States will change your food ideas. We never read it from your location.
          </span>
        </div>
      </Card>
      {showTasteCard && (
        <Card>
          <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
            <legend className={`mb-1.5 ${FIELD_LABEL}`}>Your taste</legend>
            <span className={CAPTION}>
              A dislike only lowers how often a food comes up — it never rules a food out.
            </span>
            {dislikes.length > 0 && (
              <div role="group" aria-label="Your current taste dislikes" className="flex flex-wrap gap-2">
                {dislikes.map((key) => (
                  // Read-only (UI-NEEDS: the confirm/undo contract has no path to remove one stored
                  // dislike outside the Undo of the confirm action that added it — see the PR report).
                  <Pill key={key} active disabled onClick={() => {}}>{tasteDislikeLabel(key)}</Pill>
                ))}
              </div>
            )}
            <TasteChipsField source="settings" availability={tasteChipsAvailable}
              onDisabled={() => setTasteChipsAvailable("disabled")} />
          </fieldset>
        </Card>
      )}
    </SettingsSection>
  );
}
