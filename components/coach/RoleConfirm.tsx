"use client";

/**
 * The food-group confirm inside a coach Eats/Avoid card (PR #368). The coach only proposes a role;
 * this asks "Use Tahini as fat?" in place, with the advice's reason as a quiet line. "Use as fat"
 * saves through `lib/foods/role-confirm-client.ts` and confirms in its own button ("Saved"); "Keep as
 * …" writes nothing. After "Saved" every action is locked until the block folds away. A refusal
 * speaks only through a Notice (the button returns to rest): a role that changed meanwhile shows the
 * fresh group; a food not in Eats or Avoids stops offering "Use". Every refusal carries a re-read, so a
 * retry never sends a stale current role. The block grows in and folds away (Fold), its height
 * springs when a Notice joins it (AutoHeight), and when it leaves, focus that was inside it moves to
 * the card's Undo.
 *
 * The answer is remembered per action and account on this device, so a reopened conversation does
 * not ask again; a food whose mirror already holds the proposed role is not asked about at all.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import Button, { type ButtonStatus } from "@/components/ui/Button";
import AutoHeight from "@/components/ui/AutoHeight";
import Fold from "@/components/ui/Fold";
import Notice, { type NoticeTone } from "@/components/ui/Notice";
import { CONFIRM_MS, ERROR_MS } from "@/components/ui/useButtonStatus";
import { confirmHaptic } from "@/lib/haptics";
import {
  AccountChanged, accountKey, currentAccountOrNull,
} from "@/lib/device/account";
import { currentPrefStatus } from "@/lib/foods/prefs-client";
import type { CoachAction } from "@/lib/coach/actions";
import { displayName } from "@/lib/coach/actions/copy";
import {
  confirmFoodRole, roleConfirmOffer, type RoleConfirmOffer, type RoleConfirmResult, type StoredRole,
} from "@/lib/foods/role-confirm-client";

/** The group as a word that reads after "as": "Use Tahini as fat?". */
export const ROLE_WORD: Record<StoredRole, string> = { protein: "protein", carb: "carbs", fat: "fat" };

type Message = { tone: NoticeTone; title: string; body?: string };

type Refusal = Extract<RoleConfirmResult, { fresh: unknown }>;

function decisionKey(actionId: string): string | null {
  const h = currentAccountOrNull();
  return h ? accountKey(h, `role-confirm:${actionId}`) : null;
}

function readDecided(actionId: string): boolean {
  try {
    const key = decisionKey(actionId);
    return key !== null && localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function rememberDecision(actionId: string, decision: "saved" | "kept"): void {
  try {
    const key = decisionKey(actionId);
    if (key) localStorage.setItem(key, decision);
  } catch {
    // A convenience only: without storage the offer may simply be asked again later.
  }
}

function freshLine(fresh: Extract<RoleConfirmResult, { status: "changed" }>["fresh"]): string {
  if (!fresh) return "It is no longer in Favorites or Avoids.";
  const list = fresh.status === "eats" ? "Favorites" : "Avoids";
  return fresh.role ? `It is now ${ROLE_WORD[fresh.role]} in ${list}.` : `It has no group yet in ${list}.`;
}

function refusalMessage(result: Refusal): Message {
  if (result.status === "changed") {
    return { tone: "attention", title: "This food's group changed. Check it again.", body: freshLine(result.fresh) };
  }
  if (result.status === "not_member") return { tone: "attention", title: "This food isn't in Favorites or Avoids." };
  return { tone: "attention", title: "This food is still syncing.", body: "Try again in a moment." };
}

/** Renders nothing unless the action's advice asks for confirmation and names a group. */
export default function RoleConfirm({ action, active, confirm }: {
  action: CoachAction;
  /** Only while the card's list change stands (applied); it folds away on Undo. */
  active: boolean;
  /** Test seam: the client call. */
  confirm?: typeof confirmFoodRole;
}) {
  const offer = roleConfirmOffer(action);
  if (!offer) return null;
  return <RoleConfirmBlock actionId={action.actionId} offer={offer} active={active}
    confirm={confirm ?? confirmFoodRole} />;
}

function RoleConfirmBlock({ actionId, offer, active, confirm }: {
  actionId: string;
  offer: RoleConfirmOffer;
  active: boolean;
  confirm: typeof confirmFoodRole;
}) {
  const [undecided, setUndecided] = useState(() => !readDecided(actionId));
  /** The mirror read has answered, so the question never paints only to fold away. */
  const [checked, setChecked] = useState(() => currentAccountOrNull() === null);
  const [saved, setSaved] = useState(false);
  const [notMember, setNotMember] = useState(false);
  const [currentRole, setCurrentRole] = useState<StoredRole | null>(offer.currentRole);
  const [message, setMessage] = useState<Message | null>(null);
  // The button's own outcome, held here rather than in useButtonStatus: a refusal must return it to
  // rest without ever passing through the error state (only the Notice speaks for a refusal).
  const [status, setStatus] = useState<ButtonStatus>("idle");
  const section = useRef<HTMLElement | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const open = active && undecided && checked;
  const locked = saved || status === "pending";

  // A food whose local mirror already holds the proposed group needs no question.
  useEffect(() => {
    const h = currentAccountOrNull();
    if (!h) return;
    let live = true;
    void currentPrefStatus(offer.foodRefId, h).then((pref) => {
      if (!live) return;
      if (pref?.role === offer.proposedRole) setUndecided(false);
      setChecked(true);
    }, () => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [offer.foodRefId, offer.proposedRole]);

  /** Fold the question away; focus inside it (or nowhere) moves to the card's Undo. */
  function leave() {
    const el = section.current;
    const focused = document.activeElement;
    const homeless = !focused || focused === document.body || (el?.contains(focused) ?? false);
    setUndecided(false);
    if (homeless) {
      // The card's Undo (CoachActionCard's actionUndoLabel); the card's markup is pinned by the
      // action golden, so it is found by its label rather than a new attribute.
      const buttons = el?.closest("[data-action-id]")?.querySelectorAll<HTMLButtonElement>("button") ?? [];
      Array.from(buttons).find((b) => b.textContent === "Undo" && !el?.contains(b))
        ?.focus({ preventScroll: true });
    }
  }

  async function onUse() {
    if (locked || notMember) return;
    if (timer.current) clearTimeout(timer.current);
    setMessage(null);
    setStatus("pending");
    let result: RoleConfirmResult;
    try {
      result = await confirm({ ...offer, currentRole });
    } catch (error) {
      if (error instanceof AccountChanged) { setStatus("idle"); return; }
      setStatus("error");
      timer.current = setTimeout(() => setStatus("idle"), ERROR_MS);
      setMessage({ tone: "error", title: "Could not save the food group.", body: "Try again." });
      return;
    }
    if ("fresh" in result) {
      // A refusal is not a failed tap: the button returns to rest and only the Notice speaks.
      setStatus("idle");
      setCurrentRole(result.fresh?.role ?? null);
      if (result.status === "not_member") {
        setNotMember(true);
        // Use goes away under the finger: hand focus to Keep, which stays, once it has re-rendered.
        requestAnimationFrame(() => keepButton.current?.focus({ preventScroll: true }));
      }
      setMessage(refusalMessage(result));
      return;
    }
    confirmHaptic();
    setStatus("success");
    setSaved(true);
    rememberDecision(actionId, "saved");
    timer.current = setTimeout(leave, CONFIRM_MS);
  }

  function onKeep() {
    if (locked) return;
    rememberDecision(actionId, "kept");
    leave();
  }

  const proposed = ROLE_WORD[offer.proposedRole];
  const name = displayName(offer.name);
  return <AnimatePresence initial={false}>
    {open && <Fold key="role-confirm">
      <AutoHeight>
        <section ref={section} aria-label={`Food group for ${name}`} className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 text-caption font-normal text-on-charcoal">Use {name} as {proposed}?</p>
            {offer.reason && <p className="m-0 text-tiny font-normal text-on-charcoal-muted">{offer.reason}</p>}
          </div>
          {message && <Notice tone={message.tone} title={message.title}
            onDismiss={() => setMessage(null)}>{message.body}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            {!notMember && <Button variant="primary" size="sm" status={saved ? "success" : status}
              confirmLabel="Saved" errorLabel="Try again" aria-disabled={saved || undefined}
              onClick={() => { void onUse(); }}>
              Use as {proposed}
            </Button>}
            <Button ref={keepButton} variant="tertiary" size="sm" onClick={onKeep} disabled={locked}>
              {currentRole ? `Keep as ${ROLE_WORD[currentRole]}` : "Keep as is"}
            </Button>
          </div>
        </section>
      </AutoHeight>
    </Fold>}
  </AnimatePresence>;
}
