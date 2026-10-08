"use client";

import { useEffect, useRef, useState } from "react";
import CuisineChips, { cuisineCount } from "@/components/CuisineChips";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import GlassSelect from "@/components/ui/GlassSelect";
import TasteChipsField, { tasteDislikeLabel } from "@/components/profile/TasteChipsField";
import {
  newTasteDislikeActionId, removeTasteDislike, undoRemoveTasteDislike,
  type TasteDislikeWriteOutcome,
} from "@/lib/profile/taste-dislike-remove-client";
import { countryFromValue, countryOptions, countryValue } from "@/lib/profile/countries";
import { cuisinesFrom, type CuisineKey } from "@/lib/profile/cuisines";
import { savePlaceSetting, type PlacePatch } from "@/lib/profile/cuisines-client";
import { readTasteChipsEnabled, type TasteChipsAvailability } from "@/lib/profile/taste-enabled-client";
import type { TasteDislike } from "@/lib/profile/taste";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";
import Card from "./Card";
import SettingsSection from "./Section";
import { CAPTION, FIELD_LABEL } from "./settings-styles";
import { useSettingsWrite } from "./use-settings-write";

/** A stable, shared reference for "no stored dislikes" (see the `dislikes` derivation below). */
const EMPTY_DISLIKES: readonly TasteDislike[] = [];

function dislikeRemoveFailureMessage(error: unknown): string {
  const outcome = error as TasteDislikeWriteOutcome<unknown> | null | undefined;
  if (outcome && outcome.ok === false) {
    if (outcome.reason === "offline") return "This waits for a connection.";
    if (outcome.reason === "retry") return outcome.message || "No connection. Try again.";
    if (outcome.reason === "refused") return outcome.message || "That did not save. Try again.";
  }
  return "That did not save. Try again.";
}

/**
 * One dislike pill with its own remove control (Followups #1). The toast and Undo state live in
 * the SECTION, not here (Sol BLOCK, verified): a successful remove settles the server's row and
 * fires `SYNCED_EVENT`, which drops this key from `settings.dietPrefs.taste.dislikes` on the very
 * next render — unmounting this pill. A feedback instance owned by the pill would take its Undo
 * toast down with it before the user could ever tap it. This component is purely presentational;
 * `pending` and `onRemove` are owned by `CuisinesSection`.
 */
function DislikePill({ dislikeKey, pending, onRemove }: {
  dislikeKey: TasteDislike; pending: boolean; onRemove: (key: TasteDislike) => void;
}) {
  const label = tasteDislikeLabel(dislikeKey);
  return (
    <div className="pill inline-flex items-center overflow-hidden">
      <span className="flex h-11 items-center rounded-l-full px-4 text-tiny font-normal text-on-primary"
        style={{ background: "var(--grad-ink)" }}>
        {label}
      </span>
      <button type="button" aria-label={`Remove ${label} from your taste dislikes`}
        disabled={pending} onClick={() => onRemove(dislikeKey)}
        className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-r-full text-on-primary disabled:opacity-40"
        style={{ background: "var(--grad-ink)" }}>
        ×
      </button>
    </div>
  );
}

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
  // `EMPTY_DISLIKES` is a stable, shared reference (not a fresh `[]` every render) so the "no stored
  // dislikes" case has one consistent identity too, for the reference-equality fallback below.
  const dislikes = (settings.dietPrefs as ProfileDietPrefs | null | undefined)?.taste?.dislikes ?? EMPTY_DISLIKES;
  const showTasteCard = tasteChipsAvailable === "enabled" || dislikes.length > 0;

  // Followups #1/#2 (Sol round 2 BLOCK, verified): the dislike-remove toast and Undo live here, at
  // the section, so a success (which drops the key from `dislikes` above and unmounts the pill
  // that started it) never takes the toast down with it. One remove OR undo at a time for the
  // WHOLE section — never two at once, for the same key or different ones. `tasteFeedback.run`
  // joins a second caller onto the FIRST one's already-running promise rather than rejecting or
  // queueing it (no `queue: true` passed here), so two concurrent taps would otherwise both resolve
  // from the first request's result: the second pill would hide and its "Undo" would carry the
  // FIRST pill's action id. Rather than patching that join (`queue: true` would still run the
  // second request, just serialized — still two actionIds inside one shared toast's branching
  // logic), `dislikeBusy` is a plain ref, checked and set BEFORE anything async or any `setState`:
  // while it holds, every pill is disabled and the Undo toast's action is ignored, so a second tap
  // can never start a second `run()` call in the first place. `dislikeActionIds` keeps one action
  // id per key until a DEFINITE outcome (removed / already_gone / existing); a failed or lost
  // response keeps it so a retry tap reuses the same id instead of minting a new one the server
  // has never seen.
  const tasteFeedback = useActionFeedback();
  const dislikeBusy = useRef(false);
  const [dislikeBusyKey, setDislikeBusyKey] = useState<TasteDislike | null>(null);
  const dislikeActionIds = useRef<Map<TasteDislike, string>>(new Map()).current;
  // Hidden at once on a successful remove, rather than waiting for the next settings pull to drop
  // the key from `dislikes` above — a remount of this SECTION (e.g. leaving and returning to
  // Settings) still reads `dislikes` fresh, so nothing here needs to survive that; only the toast
  // and Undo (held by `tasteFeedback`, not this) must survive the key's own pill unmounting.
  // Reconciled against every fresh `settings` the parent hands down (Sol round 2 WARN, verified):
  // a key this device just hid locally can be reintroduced by another device's write landing in
  // between (or this device's own Undo settling through a DIFFERENT path than `undoDislike`
  // below) — if the FRESH row still carries the key, that is the server's own current answer and
  // wins over a stale local hide, so any key the newest `dislikes` still contains is dropped from
  // `hiddenDislikes` the moment that row arrives, not kept hidden forever. Keyed on the settings
  // ROW's own identity (`updatedAt`, "stamped by the store on every settings save" — lib/types.ts),
  // not on whether the dislikes LIST changed (Sol round 3 WARN, verified): two consecutive rows can
  // carry the exact same dislikes content (a reintroduction that lands between two renders with no
  // intermediate "key is gone" render in between), and a content-only comparison would never catch
  // that. `updatedAt` is absent only on a `Settings` this component never actually receives in
  // practice (every real settings object is stamped on save); the dislikes array reference itself
  // is the fallback so this still works under a bare manufactured object in a test.
  const [hiddenDislikes, setHiddenDislikes] = useState<ReadonlySet<TasteDislike>>(new Set());
  const settingsIdentity: string | readonly TasteDislike[] = settings.updatedAt ?? dislikes;
  const [seenSettingsIdentity, setSeenSettingsIdentity] = useState(settingsIdentity);
  if (seenSettingsIdentity !== settingsIdentity) {
    setSeenSettingsIdentity(settingsIdentity);
    setHiddenDislikes((prev) => {
      if (prev.size === 0) return prev;
      let next: Set<TasteDislike> | null = null;
      for (const key of dislikes) {
        if (prev.has(key)) { (next ??= new Set(prev)).delete(key); }
      }
      return next ?? prev;
    });
  }
  const visibleDislikes = dislikes.filter((key) => !hiddenDislikes.has(key));

  function removeDislike(key: TasteDislike) {
    if (dislikeBusy.current) return;
    dislikeBusy.current = true;
    setDislikeBusyKey(key);
    const actionId = dislikeActionIds.get(key) ?? newTasteDislikeActionId();
    dislikeActionIds.set(key, actionId);
    const sent = removeTasteDislike(key, { actionId }).then((outcome) => {
      if (outcome.ok) return outcome.result;
      throw outcome;
    });
    sent.catch(() => {});
    void tasteFeedback.run(() => sent, {
      kind: "commit",
      confirm: "notice",
      failureMessage: dislikeRemoveFailureMessage,
    }).then((result) => {
      dislikeBusy.current = false;
      setDislikeBusyKey(null);
      if (!result.ok) return; // keep the stored action id: the next tap on this key is a retry
      dislikeActionIds.delete(key); // a definite outcome; a future tap (new pill, same key) is fresh
      const resultActionId = result.value.actionId;
      setHiddenDislikes((prev) => new Set(prev).add(key));
      // Sol round 2/3 WARN, intentional: one shared toast for the whole section means removing a
      // SECOND key, after the first remove has already completed and its Undo toast is showing,
      // replaces that toast with this one — the first key's Undo is no longer reachable from the
      // toast (though it is still a stored pending action; nothing writes until tapped). This is
      // the ordinary "the newest toast replaces the old one" rule every other ActionFeedback
      // surface in this app already follows (ActionFeedback.ts `show()`), not a bug to fix here.
      tasteFeedback.notify({
        tone: "success", message: "Removed.",
        // Captures THIS request's own action id and key, never whatever the ref/state hold by the
        // time Undo is tapped — this closure is the only thing that can answer "undo of what".
        action: { label: "Undo", action: () => undoDislike(resultActionId, key) },
      });
    });
  }

  function undoDislike(actionId: string, key: TasteDislike) {
    if (dislikeBusy.current) return; // the same single-flight guard: never race a remove in progress
    dislikeBusy.current = true;
    setDislikeBusyKey(key);
    const sent = undoRemoveTasteDislike(actionId).then((outcome) => {
      if (outcome.ok) return outcome.result;
      throw outcome;
    });
    sent.catch(() => {});
    void tasteFeedback.run(() => sent, {
      kind: "commit",
      confirm: "notice",
      failureMessage: dislikeRemoveFailureMessage,
    }).then((result) => {
      dislikeBusy.current = false;
      setDislikeBusyKey(null);
      if (!result.ok) return;
      // `restored` is the server's own word for whether the key is actually back; `capped` means
      // it would have been but the account hit the 50-dislike limit from something else since.
      // Neither is reliable on an `already_undone` repeat (it answers the FIRST undo's values),
      // but this component only ever sends one undo per action id, so that path is not reached.
      if (result.value.restored) {
        setHiddenDislikes((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        tasteFeedback.notify({ tone: "success", message: "Back." });
      } else if (result.value.capped) {
        tasteFeedback.notify({ tone: "changed", message: "Couldn't bring that back — the limit is reached." });
      }
    });
  }

  useEffect(() => {
    let live = true;
    void readTasteChipsEnabled().then((result) => { if (live) setTasteChipsAvailable(result); }, () => {});
    return () => { live = false; };
  }, []);

  return (
    <SettingsSection title="Cuisines and country">
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      {/* Outside the "Your taste" card's own conditional on purpose (Followups #1): that card can
          hide itself the moment the last dislike is removed (flag off, nothing left to show), but
          the toast it just raised — and its Undo — must still be reachable. */}
      <ActionFeedbackToast notice={tasteFeedback.notice} onDismiss={tasteFeedback.dismiss} />
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
            {visibleDislikes.length > 0 && (
              <div role="group" aria-label="Your current taste dislikes" className="flex flex-wrap gap-2">
                {/* Every pill disables while ANY remove or undo is pending, not only its own (the
                    `dislikeBusy` ref above is the real guard; this is just the visible state). */}
                {visibleDislikes.map((key) => <DislikePill key={key} dislikeKey={key}
                  pending={dislikeBusyKey !== null} onRemove={removeDislike} />)}
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
