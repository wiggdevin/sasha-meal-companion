"use client";

/**
 * Phase 13 slice 4 (§4 "onboarding capture"): pick a profile from the wider catalog — beyond the
 * 12 legacy flags PreferencesStep already offers — with the map's own plain-language do/dont copy,
 * and confirm it explicitly. Every write goes through lib/profile/instances-client.ts; nothing
 * here ever marks a medical item, or a hard rule of an item-level profile, confirmed except the
 * tap on that exact item's own row (§9 R5, map §4 — one at a time, never the blanket "Add").
 *
 * `DietaryProfilePickerView` is pure props-in/callbacks-out (tests/onboarding/dietary-profile-picker.test.tsx);
 * the default export is the container that owns the account, the fetch and the network calls.
 */
import { useEffect, useMemo, useState } from "react";
import { Pill } from "@/components/Sheet";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { loadConstraints, saveConstraints } from "@/lib/constraints-client";
import type { CustomRule } from "@/lib/policy/custom-rules";
import { LITERAL_NAME_MESSAGE, MAX_RULE_LENGTH, isLiteralName, isSavableText } from "@/components/custom-rule-text";
import { currentAccountOrNull, onAccountReady, type AccountHandle } from "@/lib/device/account";
import {
  confirmProfileInstance, fetchProfileInstances, removeProfileInstance,
  type FacetConfirmation,
} from "@/lib/profile/instances-client";
import {
  isMedicalItem, itemLabel, needsOwnConfirmation, type ProfileSummary,
} from "@/lib/policy/profiles/catalog-summary";
import type { ProfileInstance } from "@/lib/policy/profiles/types";

const CAPTION = "text-tiny font-normal text-muted";
const LABEL = "text-caption font-normal";
const MIN_QUERY = 2;
const MAX_RESULTS = 8;

function matches(profile: ProfileSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return false;
  if (profile.label.toLowerCase().includes(needle)) return true;
  return profile.synonyms.some((synonym) => synonym.toLowerCase().includes(needle));
}

/** A confirm tap: item decisions, and optionally one flipped yes/no variant (§4). */
type OnConfirm = (
  profileId: string, confirmations: FacetConfirmation[], options?: Record<string, boolean>,
) => void;

function blanketConfirmations(profile: ProfileSummary): FacetConfirmation[] {
  return profile.items
    .filter((item) => !needsOwnConfirmation(profile, item))
    .map((item) => ({ facet: item.facet, confirmed: true }));
}

type NewCustomRule = { kind: CustomRule["kind"]; text: string };
const MAX_CUSTOM_RULES = 30;
const RULE_KINDS = ["ingredient", "cuisine", "guidance"] as const;
/** A one-food rule the catalog has no profile for ("garlic"), written to the same custom rules
 *  Foods › Avoids edits. Stays on the onboarding step; the typed text is kept until it saves. */
function CustomRuleComposer({ suggestion, noMatch, rules, onAdd }: {
  suggestion: string; noMatch: boolean; rules: readonly CustomRule[];
  onAdd: (rule: NewCustomRule) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [kind, setKind] = useState<CustomRule["kind"]>("ingredient");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? (noMatch ? suggestion.trim().slice(0, MAX_RULE_LENGTH) : "");
  const text = value.trim();
  const full = rules.length >= MAX_CUSTOM_RULES;
  async function add(): Promise<void> {
    if (!isSavableText(text) || busy || full) return;
    if (kind !== "guidance" && !isLiteralName(text)) {
      setMessage(LITERAL_NAME_MESSAGE);
      return;
    }
    setBusy(true);
    setMessage(null);
    const saved = await onAdd({ kind, text });
    setBusy(false);
    if (saved) setDraft(""); else setMessage("That did not save. Try again.");
  }
  return (
    <div className="flex flex-col gap-2 border-t border-graphite/20 pt-3">
      <h3 className={`m-0 ${LABEL} font-medium`}>Add your own food rule</h3>
      <p className={`m-0 ${CAPTION}`}>
        {noMatch ? `No profile matches “${suggestion.trim()}”. ` : ""}
        Exclude one ingredient or cuisine by name. Guidance only does not block foods.
      </p>
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Rule type</legend>
        {RULE_KINDS.map((option) => (
          <label key={option} className="tap flex min-h-11 items-center gap-2 text-caption">
            <input type="radio" name="custom-rule-kind" value={option} checked={kind === option}
              onChange={() => setKind(option)} />
            {option === "guidance" ? "Guidance only" : option}
          </label>
        ))}
      </fieldset>
      <input aria-label="Custom food rule" placeholder="e.g. garlic" maxLength={MAX_RULE_LENGTH}
        value={value} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        className="well min-h-11 px-3 py-2 outline-none text-body" />
      <Button variant="secondary" className="self-start" disabled={busy || full || !isSavableText(text)} onClick={() => void add()}>Add rule</Button>
      {full && <p className={`m-0 ${CAPTION}`}>
        You have {MAX_CUSTOM_RULES} custom rules, the most allowed. Remove one in Foods › Avoids to add another.
      </p>}
      {message && <Notice tone="error" title={message} />}
      {rules.map((rule) => (
        <p key={rule.id} className={`m-0 ${CAPTION}`}>
          {rule.text} · {rule.kind === "guidance" ? "Guidance only" : `${rule.kind} exclusion`}
        </p>
      ))}
    </div>
  );
}

function ProfileRow({
  profile, instance, legacy, busy, onConfirm, onRemove,
}: {
  profile: ProfileSummary;
  instance: ProfileInstance | undefined;
  /** Kept active by a legacy preference flag: only that toggle removes it. */
  legacy: boolean;
  busy: boolean;
  onConfirm: OnConfirm;
  onRemove: (profileId: string) => void;
}) {
  // Map §4 item-level confirmation: every medical item and every hard rule of an item-level
  // profile (halal's pork, alcohol, blood product) is shown on its own row with its own tap.
  const ownItems = profile.items.filter((item) => needsOwnConfirmation(profile, item));
  const hasBlanket = profile.items.some((item) => !needsOwnConfirmation(profile, item));
  const confirmedFacets = new Set((instance?.rules ?? [])
    .filter((rule) => rule.confirmation === "confirmed").map((rule) => rule.facet));
  return (
    <section className="surface flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className={`m-0 ${LABEL} font-medium`}>{profile.label}</h3>
        {instance
          ? <div className="flex items-center gap-3">
              <span className={CAPTION}>Added</span>
              {legacy
                ? <span className={CAPTION}>Set in your preferences</span>
                : <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(profile.id)}>
                    Remove
                  </Button>}
            </div>
          : hasBlanket && <Button size="sm" disabled={busy}
              onClick={() => onConfirm(profile.id, blanketConfirmations(profile))}>
              Add to my profile
            </Button>}
      </div>
      {profile.do.length > 0
        && <p className={`m-0 ${CAPTION}`}>{`Do: ${profile.do.slice(0, 2).join(" ")}`}</p>}
      {profile.dont.length > 0
        && <p className={`m-0 ${CAPTION}`}>{`Don’t: ${profile.dont.slice(0, 2).join(" ")}`}</p>}
      {ownItems.length > 0 && <div className="flex flex-col gap-2 border-t border-graphite/20 pt-2">
        <p className={`m-0 ${CAPTION}`}>
          {ownItems.some(isMedicalItem)
            ? "Your clinician’s advice comes first."
            : "Each rule applies only once you confirm it."}
        </p>
        {ownItems.map((item) => (
          <div key={item.facet} className="flex items-center justify-between gap-3">
            <span className={CAPTION}>{itemLabel(item)}</span>
            {confirmedFacets.has(item.facet)
              ? <span className={CAPTION}>Confirmed</span>
              : <Button variant="ghost" size="sm" disabled={busy} aria-label={`Confirm ${itemLabel(item)}`}
                  onClick={() => onConfirm(profile.id, [{ facet: item.facet, confirmed: true }])}>
                  Confirm
                </Button>}
          </div>
        ))}
      </div>}
      {instance && profile.options.length > 0 && <div className="flex flex-wrap gap-2">
        {profile.options.map((option) => {
          const on = instance.options[option.id] ?? option.default;
          return <Pill key={option.id} active={on} disabled={busy}
            onClick={() => onConfirm(profile.id, [], { [option.id]: !on })}>
            {option.label}
          </Pill>;
        })}
      </div>}
    </section>
  );
}

/** Pure: every catalog and confirmation decision comes in as props, and every write goes out as a
 *  callback. Safe to unit-test with renderToStaticMarkup/@testing-library, no account required. */
export function DietaryProfilePickerView({
  catalog, instances, legacyProfileIds = [], query, busyId, onQueryChange, onConfirm, onRemove,
  customRules = [], onAddCustomRule, catalogReady = true,
}: {
  catalog: readonly ProfileSummary[];
  instances: readonly ProfileInstance[];
  legacyProfileIds?: readonly string[];
  query: string;
  busyId: string | null;
  onQueryChange: (query: string) => void;
  onConfirm: OnConfirm;
  onRemove: (profileId: string) => void;
  /** Rules this account already added by hand (Foods › Avoids' custom rules). */
  customRules?: readonly CustomRule[];
  /** Saves one custom rule; resolves false when it did not save. Absent hides the composer. */
  onAddCustomRule?: (rule: NewCustomRule) => Promise<boolean>;
  /** False until the catalog has loaded: an empty catalog is not a "no match". */
  catalogReady?: boolean;
}) {
  const byId = new Map(instances.map((instance) => [instance.profileId, instance]));
  const results = useMemo(
    () => catalog.filter((profile) => matches(profile, query)).slice(0, MAX_RESULTS),
    [catalog, query],
  );
  return (
    <section id="dietary-profile-picker" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className={`m-0 ${LABEL}`}>More dietary profiles</h2>
        <p className={`m-0 ${CAPTION}`}>
          Search allergies, religious diets, conditions, goals — anything Jev should watch for.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="sr-only">Search dietary profiles</span>
        {/* The rule hand-off hint (DietaryTextHint, Phase 18 W5b) jumps and focuses here by this id. */}
        <input id="dietary-profile-search" value={query} onChange={(event) => onQueryChange(event.target.value)}
          placeholder="e.g. halal, peanut allergy, Crohn's"
          className="well min-h-11 px-3 py-2 outline-none text-body" />
      </label>
      {results.length > 0 && <div className="flex flex-col gap-2">
        {results.map((profile) => (
          <ProfileRow key={profile.id} profile={profile} instance={byId.get(profile.id)}
            legacy={legacyProfileIds.includes(profile.id)} busy={busyId === profile.id} onConfirm={onConfirm} onRemove={onRemove} />
        ))}
      </div>}
      {onAddCustomRule && <CustomRuleComposer suggestion={query}
        noMatch={catalogReady && query.trim().length >= MIN_QUERY && results.length === 0}
        rules={customRules} onAdd={onAddCustomRule} />}
    </section>
  );
}

/** The account-aware container: fetches the catalog and this account's instances once bound, and
 *  writes every confirm/remove through lib/profile/instances-client.ts. `onRulesChanged` runs after
 *  each saved write, so a host that reads the stored holds (onboarding's preview) can read again. */
export default function DietaryProfilePicker({ onRulesChanged }: { onRulesChanged?: () => void } = {}) {
  const [handle, setHandle] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [catalog, setCatalog] = useState<readonly ProfileSummary[]>([]);
  const [instances, setInstances] = useState<readonly ProfileInstance[]>([]);
  const [legacyProfileIds, setLegacyProfileIds] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [customRules, setCustomRules] = useState<readonly CustomRule[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);

  // Onboarding mounts only once the account is bound in practice, but a subscription (rather than
  // a synchronous read) is what lib/device/account.ts's own callers do (AuthGate.tsx,
  // lib/sync/account-sync.ts), so a mount that races the bind still catches up.
  useEffect(() => onAccountReady((h) => setHandle(h)), []);

  useEffect(() => {
    if (handle === null) return;
    let live = true;
    fetchProfileInstances(handle).then((result) => {
      if (!live) return;
      setCatalog(result.catalog);
      setInstances(result.instances);
      setLegacyProfileIds(result.legacyProfileIds ?? []);
      setCatalogReady(true);
    }).catch(() => {});
    // The rules already saved, so the list and the 30-rule cap are true before the first add.
    loadConstraints({ account: handle }).then((loaded) => {
      if (live && loaded) setCustomRules(loaded.profile.custom_rules ?? []);
    }).catch(() => {});
    return () => { live = false; };
  }, [handle]);

  // Reads the live revision each time so a rules change elsewhere is a conflict, not an overwrite.
  async function handleAddCustomRule(rule: NewCustomRule): Promise<boolean> {
    if (handle === null) return false;
    try {
      const loaded = await loadConstraints({ account: handle });
      if (!loaded) return false;
      setCustomRules(loaded.profile.custom_rules ?? []);
      const existing = loaded.profile.custom_rules ?? [];
      const next = [...existing, { id: crypto.randomUUID(), ...rule }];
      const result = await saveConstraints({ baseRev: loaded.rev, customRules: next }, loaded.rev,
        { account: handle });
      if (result.status === "conflict") setCustomRules(result.profile.custom_rules ?? []);
      if (result.status !== "ok") return false;
      setCustomRules(result.profile.custom_rules ?? next);
      onRulesChanged?.();
      return true;
    } catch {
      return false;
    }
  }

  async function handleConfirm(
    profileId: string, confirmations: FacetConfirmation[], options?: Record<string, boolean>,
  ): Promise<void> {
    if (handle === null || (confirmations.length === 0 && !options)) return;
    setBusyId(profileId);
    try {
      const instance = await confirmProfileInstance(handle, profileId, confirmations, options);
      setInstances((current) => [...current.filter((i) => i.profileId !== profileId), instance]);
      onRulesChanged?.();
    } catch {
      // The row keeps its previous state; the person can try again.
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(profileId: string): Promise<void> {
    if (handle === null) return;
    setBusyId(profileId);
    try {
      await removeProfileInstance(handle, profileId);
      setInstances((current) => current.filter((i) => i.profileId !== profileId));
      onRulesChanged?.();
    } catch {
      // Left in place on failure; Remove can be tapped again.
    } finally {
      setBusyId(null);
    }
  }

  if (handle === null) return null;
  return <DietaryProfilePickerView catalog={catalog} instances={instances}
    legacyProfileIds={legacyProfileIds} query={query} customRules={customRules} catalogReady={catalogReady}
    onAddCustomRule={handleAddCustomRule}
    busyId={busyId} onQueryChange={setQuery} onConfirm={(id, c, o) => void handleConfirm(id, c, o)}
    onRemove={(id) => void handleRemove(id)} />;
}
