"use client";

/**
 * The server-side half of Avoids: the allergens, the categories and the conditions the coach,
 * food search, the scanner and every recipe save obey (lib/policy/constraints.ts).
 *
 * D1 §6.2. This card used to render a fixed rule list from lib/reference.ts and let the server
 * only switch each row on or off — so a brand-new account opened Foods > Avoids and read five
 * "off the plan" rules and three locked allergens that were somebody else's. It now renders the
 * account's OWN `constraint_profiles` row and nothing else: an empty row reads "No food rules
 * yet", and every rule on screen is one this account added. lib/reference.ts supplies the
 * on-screen name and the help line for a key, never the fact that a key applies. A profile that
 * has not loaded is a third state and says so, because "no rules" must never be a guess.
 *
 * There is no floor. The server accepts the removal of any allergen (D1 §6.1), so no control here
 * renders locked.
 *
 * Everything still saves with a baseRev compare-and-swap; a conflict reloads the current profile
 * and asks for the change again, because the server's copy wins. `constraint_profiles` is not
 * outbox-synced, so offline every control is disabled rather than queued.
 *
 * `children` remains available to older callers and always renders first, in every state: the
 * user's own avoid list leads Avoids (FluidVoice A05), before any rule control or card.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { Pill } from "@/components/Sheet";
import type { ConstraintsPut } from "@/lib/coach/types";
import { loadConstraints, saveConstraints, type Profile } from "@/lib/constraints-client";
import {
  ALLERGEN_KEYS, CATEGORY_KEYS, ruleHelp, ruleLabel,
} from "@/lib/reference";
import { ASSISTANT_NAME } from "@/lib/brand";
import type { CustomRule } from "@/lib/policy/custom-rules";
import { LITERAL_NAME_MESSAGE, isLiteralName } from "@/components/custom-rule-text";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { SendGlyph } from "@/components/coach/round-button";

const CARD_TITLE = "m-0 text-title";
const CAPTION = "m-0 text-tiny font-normal text-muted";
const ROW_TITLE = "text-body font-medium";
const EYEBROW = "text-overline uppercase text-muted";
/** "Add a rule" and its siblings are `Button` secondaries (2026-10-04 button system). */
const ADD_RULE = "self-start";
const REMOVE_RULE =
  "tap flex min-h-11 min-w-11 shrink-0 items-center justify-center text-caption font-light text-graphite underline disabled:opacity-40";

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

/** One rule the account added: its name, what the key covers, and the control to take it off. */
function Rule({ item, why, last, control }: {
  item: string; why: string; last: boolean; control: ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-3 py-2 ${last ? "" : "border-b border-hairline"}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={ROW_TITLE}>{item}</span>
        {why && <span className={CAPTION}>{why}</span>}
      </span>
      {control}
    </div>
  );
}

function without(list: readonly string[], value: string): string[] {
  return list.filter((entry) => entry !== value);
}

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? without(list, value) : [...list, value];
}

export function isRuleListEmpty(profile: Profile | null): boolean {
  if (profile === null) return true;
  return profile.avoid_allergens.length === 0
    && profile.banned_categories.length === 0
    && (profile.custom_rules?.length ?? 0) === 0
    && profile.conditions.length === 0;
}

export default function AvoidRules({ initial, children }: {
  /** A profile to render with no fetch. Also what makes this component testable without a DOM. */
  initial?: Profile;
  children?: ReactNode;
}) {
  const [profile, setProfile] = useState<Profile | null>(initial ?? null);
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [picking, setPicking] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const feedback = useActionFeedback();
  // Conditions owns its own feedback key and lifecycle (FluidVoice A11): a rule save can never
  // light the Conditions control, and a Conditions save never lights a rule control.
  const conditionsFeedback = useActionFeedback();
  const [ruleText, setRuleText] = useState("");
  const [ruleKind, setRuleKind] = useState<CustomRule["kind"]>("guidance");
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [conditionsDraft, setConditionsDraft] = useState<string | null>(null);
  const ruleErrorId = useId();

  useEffect(() => {
    // A load that came back empty while offline is retried once the connection returns, so the
    // card never sits on "Checking your rules…" with every control disabled.
    let waitingForOnline = false;
    let live = true;
    const sync = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && waitingForOnline) {
        waitingForOnline = false;
        setAttempt((value) => value + 1);
      }
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    if (initial === undefined) {
      void loadConstraints().then((loaded) => {
        if (!live) return;
        if (!loaded) {
          // Offline the caption below already explains itself. Online, a failed load would
          // otherwise read as "nothing is avoided", which is the one wrong thing to say here —
          // so the card body says it failed and offers Retry, never "Checking your rules…".
          if (navigator.onLine) setLoadFailed(true);
          else waitingForOnline = true;
          return;
        }
        setLoadFailed(false);
        setProfile(loaded.profile);
        setRev(loaded.rev);
      });
    }
    return () => {
      live = false;
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [initial, attempt]);

  async function save(patch: ConstraintsPut,
    channel: ReturnType<typeof useActionFeedback> = feedback): Promise<boolean> {
    setStatus(null);
    const outcome = await channel.run(async () => {
      const result = await saveConstraints(patch, rev);
      if (result.status === "conflict") {
        setProfile(result.profile);
        setRev(result.rev);
        throw new Error("Your rules changed elsewhere. Check them and try again.");
      }
      if (result.status === "error") throw new Error(result.message);
      setProfile(result.profile);
      setRev(result.rev);
      return true;
    }, { kind: "commit", successMessage: "Saved.",
      failureMessage: (error) => error instanceof Error ? error.message : "That did not save. Try again." });
    return outcome.ok;
  }

  // Nothing is editable without both a profile to diff against and a connection to send on:
  // constraint_profiles is not outbox-synced, so an offline tap would be a lie.
  // One write at a time across both channels: every save is a compare-and-swap on the same rev.
  const ready = profile !== null && online && feedback.phase !== "pending"
    && conditionsFeedback.phase !== "pending";
  const allergens = profile?.avoid_allergens ?? [];
  const categories = profile?.banned_categories ?? [];
  const conditions = (profile?.conditions ?? []).join(", ");
  const customRules = profile?.custom_rules ?? [];
  // A profile that has not arrived is NOT an empty one. Saying "no food rules yet" before the
  // read lands — or after it failed — is the one wrong thing this card can say (F-018).
  const loaded = profile !== null;
  const empty = loaded && isRuleListEmpty(profile);

  // The picker renders right under whichever "Add a rule" control opened it, at the top of the
  // screen — never below the rule cards.
  const picker = picking ? (
    <Card>
      <h2 className={CARD_TITLE}>Add a rule</h2>
      <span className={EYEBROW}>Allergens</span>
      <div className="flex flex-wrap gap-2">
        {ALLERGEN_KEYS.map((key) => (
          <Pill
            key={key}
            active={allergens.includes(key)}
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              void save({ baseRev: rev, avoidAllergens: toggle(allergens, key) });
            }}
          >
            {ruleLabel(key)}
          </Pill>
        ))}
      </div>
      <span className={EYEBROW}>Off the plan</span>
      <div className="flex flex-wrap gap-2">
        {CATEGORY_KEYS.map((key) => (
          <Pill
            key={key}
            active={categories.includes(key)}
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              void save({ baseRev: rev, bannedCategories: toggle(categories, key) });
            }}
          >
            {ruleLabel(key)}
          </Pill>
        ))}
      </div>
      <button type="button" onClick={() => setPicking(false)}
        className="tap min-h-11 self-start px-1 text-caption font-normal text-graphite underline">
        Done
      </button>
    </Card>
  ) : null;

  return (
    <>
      {children}
      {!loaded ? (
        <>
          <Card>
            <h2 className={CARD_TITLE}>Food rules</h2>
            {loadFailed ? (
              <Notice tone="error" title="Could not load your rules." />
            ) : online ? (
              <p className={CAPTION}>Checking your rules…</p>
            ) : (
              <Notice tone="attention" title="Your rules load when you are back online." />
            )}
            {loadFailed ? (
              <Button variant="secondary" className={ADD_RULE}
                onClick={() => { setLoadFailed(false); setAttempt((value) => value + 1); }}>
                Retry
              </Button>
            ) : (
              <Button variant="secondary" disabled onClick={() => setPicking(true)} className={ADD_RULE}>
                Add a rule
              </Button>
            )}
          </Card>
        </>
      ) : empty ? (
        <>
          <Card>
            <h2 className={CARD_TITLE}>Food rules</h2>
            <Notice tone="neutral" title="No food rules yet">
              Add one and {ASSISTANT_NAME}, search and the scanner all block it.
            </Notice>
            <Button variant="secondary" disabled={!ready} onClick={() => setPicking(true)}
              className={ADD_RULE}>
              Add a rule
            </Button>
          </Card>
          {picker}
        </>
      ) : (
        <>
          {/* The control sits ABOVE the rule cards: adding a rule is the most-used action on a
              new account (2026-09-22), and it must not scroll off the bottom of the list. */}
          <Button variant="secondary" disabled={!ready} onClick={() => setPicking(true)}
            className={ADD_RULE}>
            Add a rule
          </Button>
          {picker}

          {allergens.length > 0 && (
            <Card>
              <h2 className={CARD_TITLE}>Allergens</h2>
              <p className={CAPTION}>
                The plan is built without these. Search, the scanner and {ASSISTANT_NAME} block them.
              </p>
              <div className="flex flex-col">
                {allergens.map((key, i) => (
                  <Rule
                    key={key}
                    item={ruleLabel(key)}
                    why={ruleHelp(key)}
                    last={i === allergens.length - 1}
                    control={
                      <button type="button" disabled={!ready}
                        aria-label={`Remove ${ruleLabel(key)}`}
                        onClick={() => {
                          if (!ready) return;
                          void save({ baseRev: rev, avoidAllergens: without(allergens, key) });
                        }}
                        className={REMOVE_RULE}>
                        Remove
                      </button>
                    }
                  />
                ))}
              </div>
            </Card>
          )}

          {categories.length > 0 && (
            <Card>
              <h2 className={CARD_TITLE}>Off the plan</h2>
              <p className={CAPTION}>{ASSISTANT_NAME} and search block these too.</p>
              <div className="flex flex-col">
                {categories.map((key, i) => (
                  <Rule
                    key={key}
                    item={ruleLabel(key)}
                    why={ruleHelp(key)}
                    last={i === categories.length - 1}
                    control={
                      <button type="button" disabled={!ready}
                        aria-label={`Remove ${ruleLabel(key)}`}
                        onClick={() => {
                          if (!ready) return;
                          void save({ baseRev: rev, bannedCategories: without(categories, key) });
                        }}
                        className={REMOVE_RULE}>
                        Remove
                      </button>
                    }
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card>
        <h2 className={CARD_TITLE}>Custom rules</h2>
        <p className={CAPTION}>
          Exclude an ingredient or cuisine by name. Save other preferences as guidance;
          guidance does not block foods.
        </p>
        {customRules.map((rule) => <div key={rule.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-caption">
            {rule.text} · {rule.kind === "guidance" ? "Guidance only" : `${rule.kind} exclusion`}
          </span>
          <button type="button" disabled={!ready} aria-label={`Edit ${rule.text}`}
            className={REMOVE_RULE} onClick={() => {
              setEditingRule(rule.id); setRuleText(rule.text); setRuleKind(rule.kind);
            }}>Edit</button>
          <button type="button" disabled={!ready} aria-label={`Remove ${rule.text}`}
            className={REMOVE_RULE} onClick={() => void save({ baseRev: rev,
              customRules: customRules.filter((item) => item.id !== rule.id) })}>Remove</button>
        </div>)}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Rule type">
          {(["ingredient", "cuisine", "guidance"] as const).map((kind) =>
            <Button key={kind} size="sm" role="radio" aria-checked={ruleKind === kind}
              variant={ruleKind === kind ? "primary" : "tertiary"} disabled={!ready}
              onClick={() => setRuleKind(kind)}>{kind === "guidance" ? "Guidance only" : kind}</Button>)}
        </div>
        <input aria-label="Custom food rule" placeholder="e.g. garlic" className="well min-h-11 px-3 text-caption"
          aria-describedby={status ? ruleErrorId : undefined} aria-invalid={status ? true : undefined}
          disabled={!ready} value={ruleText} maxLength={80}
          onChange={(event) => { setRuleText(event.target.value); setStatus(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
        {status && <div id={ruleErrorId}><Notice tone="error" title={status} /></div>}
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!ready || ruleText.trim().length < 2}
            className={ADD_RULE} onClick={async () => {
              const text = ruleText.trim();
              if (!ready || text.length < 2) return;
              if (ruleKind !== "guidance" && !isLiteralName(text)) {
                setStatus(LITERAL_NAME_MESSAGE);
                return;
              }
              const next = [...customRules.filter((item) => item.id !== editingRule),
                { id: editingRule ?? crypto.randomUUID(), kind: ruleKind, text }];
              if (await save({ baseRev: rev, customRules: next })) {
                setEditingRule(null); setRuleText("");
              }
            }}>{editingRule ? "Save rule" : "Add rule"}</Button>
          {editingRule && <button type="button" className={REMOVE_RULE} onClick={() => {
            setEditingRule(null); setRuleText("");
          }}>Cancel</button>}
        </div>
      </Card>

      <Card>
        <h2 className={CARD_TITLE}>Conditions</h2>
        <p className={CAPTION}>What {ASSISTANT_NAME} knows about your health.</p>
        <input
          // Uncontrolled so it can be typed in freely; remounted when the saved value changes,
          // because the profile arrives after this input has already mounted empty.
          key={conditions}
          value={conditionsDraft ?? conditions}
          disabled={!ready}
          aria-label="Conditions, separated by commas"
          className="well min-h-[44px] px-3 text-caption font-normal text-charcoal outline-none disabled:opacity-40"
          onChange={(event) => setConditionsDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") {
            event.preventDefault();
            if (ready) void save({ baseRev: rev, conditions: (conditionsDraft ?? conditions)
              .split(",").map((s) => s.trim()).filter(Boolean) }, conditionsFeedback).then((ok) => {
                if (ok) setConditionsDraft(null);
              });
          } }}
        />
        <Button variant="secondary" disabled={!ready || conditionsDraft === null || conditionsFeedback.controlProps.disabled}
          aria-label="Save conditions" className={`${ADD_RULE} ${conditionsFeedback.controlProps.className}`}
          data-feedback-state={conditionsFeedback.controlProps["data-feedback-state"]} confirmLabel="Saved"
          aria-busy={conditionsFeedback.controlProps["aria-busy"]} leading={<SendGlyph />}
          onClick={async () => {
            if (!ready) return;
            if (await save({ baseRev: rev, conditions: (conditionsDraft ?? conditions)
              .split(",").map((s) => s.trim()).filter(Boolean) }, conditionsFeedback)) setConditionsDraft(null);
          }}>Save conditions</Button>
      </Card>

      {!online && <Notice tone="attention" title="Needs a connection to change." className="px-1.5" />}
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      <ActionFeedbackToast notice={conditionsFeedback.notice} onDismiss={conditionsFeedback.dismiss} />
    </>
  );
}
