"use client";
/**
 * The recipe widget: what the Foods page's New recipe button opens, in place under the Recipes
 * header (owner ask 2026-10-03: "nothing should slide up from the bottom"). It no longer morphs out
 * of the button (U15, owner 2026-10-04: "When I press it, the cards should show up. When I exit,
 * they should go away. There shouldn't be this weird swooping thing into this rectangular new
 * recipe button"): RecipesSection grows it open on the frame spring and folds it away (`Fold`), and
 * the button stays where it is. Top to bottom, all within a thumb's
 * reach: quick chips, a swipeable catalog, and an ask box with a camera and an upload button. Asks
 * go to the coach on the `recipes` surface; "Build my own" opens the manual recipe editor here, as
 * an attached panel (components/Sheet.tsx AttachedSheetHost), never a bottom sheet.
 */
import { useEffect, useRef, useState } from "react";
import RecipeSheet from "@/components/RecipeSheet";
import { AttachedSheetHost } from "@/components/Sheet";
import PlanComposer from "@/components/plan/PlanComposer";
import HubAnswer, { hubApplyPrefix } from "@/components/recipes-hub/HubAnswer";
import RecipeCarousel from "@/components/recipes-hub/RecipeCarousel";
import { useHubAsk } from "@/components/recipes-hub/useHubAsk";
import { useHubDay } from "@/components/recipes-hub/useHubDay";
import Button from "@/components/ui/Button";
import { CloseIcon } from "@/components/ui/CloseButton";
import PhotoPrivacyNotice from "@/components/ui/PhotoPrivacyNotice";
import { clearFlightOutcomesUnder, useFlying } from "@/components/single-flight";
import { currentAccountOrNull } from "@/lib/device/account";
import type { RecipeAccess } from "@/lib/recipe-access-client";
import { exampleAt, HUB_CHIPS, remainingLine, type HubChip } from "@/lib/recipes-hub/hub";

const EXAMPLE_MS = 3500;

export type HubAccess = Pick<RecipeAccess, "enabled" | "loading"> & Partial<Pick<RecipeAccess, "unavailable" | "retry">>;

function AccessLine({ access }: { access: HubAccess }) {
  if (access.loading) return <p role="status" className="m-0 text-caption text-graphite">Checking recipe access…</p>;
  if (access.unavailable) return <div className="flex flex-wrap items-center gap-2">
    <p role="status" className="m-0 text-caption text-graphite">Recipe access could not be checked.</p>
    {access.retry && <button type="button" onClick={access.retry} className="tap min-h-11 text-caption underline">Retry</button>}
  </div>;
  return <p role="status" className="m-0 text-caption text-graphite">
    The recipe catalog isn’t on for this account yet. Ask below: ideas still fit your day.</p>;
}

export default function RecipeHub({ id, access, onClose, onSaved, embedded = false }: {
  /** For the New recipe button's `aria-controls`. */
  id?: string;
  access: HubAccess; onClose: () => void; onSaved: () => void;
  /**
   * The Recipes card's own body (owner, 2026-10-05: "the expansion portion should just
   * automatically go to the new recipe page … that shouldn't be a child card"): no card of its own,
   * no title or close (the card's header names it and folds it), and no access line (the section
   * shows that notice).
   */
  embedded?: boolean;
}) {
  const day = useHubDay();
  const ask = useHubAsk({ day, recipesOn: access.enabled });
  const [building, setBuilding] = useState(false);
  const [active, setActive] = useState<HubChip | null>(null);
  const [draft, setDraft] = useState("");
  const [tick, setTick] = useState(0);
  const [opening] = useState(currentAccountOrNull);
  const epoch = opening?.epoch;
  // Whether THIS hub (not HubAnswer, which unmounts more often — "Build my own" toggles it) is
  // still open. applyAs reads this right before it would record an outcome, so a write that
  // settles after the hub itself is gone cannot put a stale "Done." back after the clear below
  // (audit g1 MINOR).
  const hubAlive = useRef(true);
  // The hub closing for good forgets any apply outcome HubAnswer kept, so a later, unrelated
  // "New recipe" open never hydrates a stale "Done." it never caused (audit f2 MAJOR).
  useEffect(() => () => {
    hubAlive.current = false;
    clearFlightOutcomesUnder(hubApplyPrefix(opening?.userId));
  }, [opening?.userId]);
  // A composed meal on the wire keeps the hub open: closing it mid-save hid the result (audit r4).
  const saving = useFlying(hubApplyPrefix(opening?.userId));

  useEffect(() => {
    if (draft) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), EXAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [draft]);

  function pick(chip: HubChip) {
    if (chip === "Build my own") { setActive(chip); setBuilding(true); return; }
    if (ask.busy) return;
    setBuilding(false);
    void ask.chip(chip).then((ok) => { if (ok) setActive(chip); });
  }

  function submit() {
    const entered = draft.trim();
    if (!entered || ask.busy) return;
    setBuilding(false);
    void ask.send(entered).then((ok) => {
      if (!ok) return;
      setActive(null);
      setDraft((current) => current.trim() === entered ? "" : current);
    });
  }

  const body = <>
      {embedded ? <p className="m-0 text-tiny text-muted">{remainingLine(day.remaining)}</p>
      : <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 text-body-md font-medium text-charcoal">New recipe</h3>
          <p className="m-0 text-tiny text-muted">{remainingLine(day.remaining)}</p>
        </div>
        <Button variant="ghost" shape="circle" onClick={onClose} aria-label="Close" disabled={saving}
          className="-mr-2 -mt-1 text-muted">
          <CloseIcon />
        </Button>
      </div>}
      {/* A chip row owns only the x axis; a vertical drag over it still scrolls the page. */}
      <div role="group" aria-label="Quick actions"
        className="-m-1.5 flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain p-1.5">
        {HUB_CHIPS.map((chip) => <Button key={chip} aria-pressed={active === chip}
          variant={active === chip ? "primary" : "secondary"}
          disabled={ask.busy && chip !== "Build my own"} onClick={() => pick(chip)}>{chip}</Button>)}
      </div>
      {building ? <AttachedSheetHost>
        <RecipeSheet onClose={() => { setBuilding(false); setActive(null); }}
          onSaved={() => { setBuilding(false); onSaved(); }} />
      </AttachedSheetHost> : <>
        {access.enabled ? <RecipeCarousel remaining={day.remaining} date={day.date} />
          : embedded ? null : <AccessLine access={access} />}
        <PlanComposer draft={draft} onDraft={setDraft} onSubmit={submit} busy={ask.busy} upload
          onPhoto={(file) => { setBuilding(false); void ask.readPhoto(file); }}
          label="Ask about recipes" placeholder={exampleAt(tick)}
          hint="Ask for an idea, a portion, or tell me what you had. Snap a fridge, a dish or your plate."
          photoNotice={<PhotoPrivacyNotice />} />
        <HubAnswer ask={ask} day={day} sourceEpoch={epoch} hubAlive={hubAlive} />
      </>}
  </>;
  if (embedded) {
    return <section id={id} data-card-group="true" aria-label="New recipe" className="flex min-w-0 flex-col gap-3">
      {body}</section>;
  }
  return <section id={id} data-card-group="true" aria-label="New recipe"
    className="shell min-w-0 w-full scroll-mt-3">
    <div className="surface flex min-w-0 flex-col gap-3 p-4">{body}</div>
  </section>;
}
