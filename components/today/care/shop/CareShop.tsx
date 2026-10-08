"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import Button from "@/components/ui/Button";
import DressedSprout from "@/components/today/care/shop/DressedSprout";
import CareScenePlayer from "@/components/today/care/CareScenePlayer";
import { LEDGER_COPY, SHOP_ITEMS, canWear, itemById, words, type CareScene, type ShopItem, type Slot } from "@/components/today/care/shop/catalog";
import { equip, pendingSeeds, purchase, seeds, type EquipOutcome, type PurchaseOutcome, type ShopState } from "@/components/today/care/shop/shop-state";
import { play, readMuted, unlockAudio } from "@/components/today/care/sound";
import styles from "@/components/today/care/shop/Shop.module.css";
import { named, sceneArt, type ScenePose } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";

/** A seed: the Seeds glyph, in the currentColor of its place. */
function Seed() {
  return <svg className={styles.seed} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <path d="M8 1.5c3 2.2 4.6 5 4.6 7.6A4.6 4.6 0 0 1 8 13.7a4.6 4.6 0 0 1-4.6-4.6C3.4 6.5 5 3.7 8 1.5Z" />
    <path d="M8 13.7v1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

const day = (localDate: string) => new Date(`${localDate}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const newActionId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
  : `a-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Sprout's shop and wardrobe in the open well (owner, 2026-10-07: "a shop with items … massage,
 * pants, hat, gloves, sunglasses … bought with points"; GPT-6 Astra §2 and §5). One stage, no chrome:
 * the Seeds balance (tap for recent Seeds), Sprout wearing what it has on, and one row of items. A tap
 * on an item tries it on (a bouncy settle onto Sprout); buying stays its own button, with the price
 * and the balance after it in words. A bought item goes on at once; an owned one can be worn or taken
 * off. Every change is said in a polite live region. Presentation on the server's contract shape
 * (shop-state.ts): the gallery passes samples; the real routes wait on UI-NEEDS SPROUT-CARE.
 */
/** Where a purchase or a change of clothes is decided: the server on Today, the pure rules in the gallery. */
export type ShopRules = {
  purchase: (state: ShopState, itemId: string, actionId: string) => Promise<PurchaseOutcome | "failed">;
  equip: (state: ShopState, slot: Slot, itemId: string | null) => Promise<EquipOutcome | "failed" | "conflict">;
};

/** A care scene's tile shows its first frame, drawn for the chosen companion. */
const SCENE_TILE: Record<CareScene, ScenePose> = { massage: "massage-1" };

export default function CareShop({ state, onChange, today, rules, items, onRefresh, onClose }: {
  state: ShopState;
  onChange: (next: ShopState) => void;
  /** The account's local date, YYYY-MM-DD, for a purchase's ledger row under the local rules. */
  today: string;
  /** The server's rules (Today); without them the shop plays on the pure rules (the gallery). */
  rules?: ShopRules;
  /** What is on offer, at the server's prices; the whole catalog when absent. */
  items?: readonly ShopItem[];
  /** Read Seeds and the shop again: after a confirmed change, or when another device changed it. */
  onRefresh?: () => void;
  /** Put the shop away (Today, where it opens over the well); a Close button in its top row. */
  onClose?: () => void;
}) {
  const offered = items ?? SHOP_ITEMS;
  const local: ShopRules = {
    purchase: async (from, itemId, actionId) => purchase(from, itemId, actionId, today),
    equip: async (from, slot, itemId) => equip(from, slot, itemId),
  };
  const decide = rules ?? local;
  // One request at a time; a purchase that never got an answer keeps its action id, so the next tap
  // retries the same purchase (the server answers the first receipt, never a second charge).
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ itemId: string; actionId: string } | null>(null);
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  // Sprout fills the stage, whatever room the well gives it.
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(196);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize(Math.round(Math.max(120, Math.min(360, width * 0.82, height))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [chosen, setChosen] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  // Each line keeps the companion it was said for (stamped when its tap began), and is shown only while
  // that companion is still chosen: a change of companion with the shop open, or a purchase that settles
  // after one, never leaves a line about the other companion.
  const [said, setSaidFor] = useState<{ text: string; mascot: string }>({ text: "", mascot });
  // Lines are written with Sprout's name and said with the chosen companion's.
  const setSaid = (text: string) => setSaidFor({ text: named(text, mascot), mascot });
  // A change of companion clears the line, so switching back never brings an old one back.
  const [saidFor, setSaidCompanion] = useState(mascot);
  if (saidFor !== mascot) { setSaidCompanion(mascot); setSaidFor({ text: "", mascot }); }
  const [bought, setBought] = useState(0);
  const ledgerId = useId();
  // Taking an item off deselects it, so its Take-off button disappears with nothing in its place;
  // focus goes back to that item's tile rather than falling through to the page.
  const tileRefs = useRef<Partial<Record<string, HTMLButtonElement>>>({});
  const item = chosen ? offered.find((entry) => entry.id === chosen) ?? itemById(chosen) ?? null : null;
  const owned = item ? state.owned.includes(item.id) : false;
  // A care scene (a massage) is done for Sprout: it plays, it is never worn or tried on.
  const care = item?.scene ?? null;
  // Each companion wears an item at its own fit; one with no fit (a hat on Pod) cannot wear it, and an
  // item it cannot wear is never shown as on, though it stays equipped for the companions that can.
  const fits = item ? canWear(item, mascot) : false;
  const worn = item && fits ? state.equipped[item.slot] === item.id : false;
  const [playing, setPlaying] = useState<CareScene | null>(null);
  // What the companion has on: what it can wear of the equipped things, and the chosen item tried on.
  const wearing: Partial<Record<Slot, string>> = Object.fromEntries(Object.entries(state.equipped)
    .filter(([, id]) => { const on = id ? itemById(id) : undefined; return on ? canWear(on, mascot) : false; }));
  if (item && fits) wearing[item.slot] = item.id;
  const pending = pendingSeeds(state);

  const choose = (next: ShopItem) => {
    if (chosen === next.id) { setChosen(null); setSaid(""); return; }
    setChosen(next.id);
    // Say so whenever the preview actually changes what Sprout has on — an owned item not yet worn
    // previews exactly like an unbought one. Selecting an already-worn item changes nothing to say.
    if (next.scene) setSaid("");
    else if (!canWear(next, mascot)) setSaid(`Sprout cannot wear ${words(next).the}.`);
    else if (state.equipped[next.slot] !== next.id) setSaid(`Sprout tries on ${words(next).the}.`);
  };
  const buy = async (target: ShopItem) => {
    if (busy) return;
    // The shared Sound off (set in the award player) and reduced motion both keep the chime quiet.
    const sound = !reduce && !readMuted();
    if (sound) unlockAudio();
    const actionId = retry.current?.itemId === target.id ? retry.current.actionId : newActionId();
    retry.current = { itemId: target.id, actionId };
    setBusy(true);
    const outcome = await decide.purchase(state, target.id, actionId);
    if (outcome === "failed") { setBusy(false); setSaid("That did not go through. Try again."); return; }
    retry.current = null;
    if (!outcome.ok) {
      setBusy(false);
      setSaid(outcome.code === "insufficient" ? `${seeds(outcome.short)} more needed.` : "That one is already yours.");
      onRefresh?.();
      return;
    }
    const w = words(target);
    if (target.scene) {
      // Bought, and played at once; the scene says itself.
      setBusy(false);
      onChange(outcome.state);
      setSaid(`${w.the[0].toUpperCase()}${w.the.slice(1)} ${w.is} yours. ${seeds(outcome.receipt.balance)}.`);
      setPlaying(target.scene);
      onRefresh?.();
      return;
    }
    const dressed = await decide.equip(outcome.state, target.slot, target.id);
    setBusy(false);
    onChange(typeof dressed === "object" && dressed.ok ? dressed.state : outcome.state);
    setBought((n) => n + 1);
    if (sound) play("chime");
    setSaid(typeof dressed === "object" && dressed.ok
      ? `${w.the[0].toUpperCase()}${w.the.slice(1)} ${w.is} yours, and Sprout has ${w.it} on. ${seeds(outcome.receipt.balance)}.`
      : `${w.the[0].toUpperCase()}${w.the.slice(1)} ${w.is} yours. ${seeds(outcome.receipt.balance)}.`);
    onRefresh?.();
  };
  const wear = async (target: ShopItem, on: boolean) => {
    if (busy) return;
    setBusy(true);
    const result = await decide.equip(state, target.slot, on ? target.id : null);
    setBusy(false);
    if (result === "failed") { setSaid("That did not go through. Try again."); return; }
    if (result === "conflict") { setSaid("Your companion changed on another device. Try again."); onRefresh?.(); return; }
    if (!result.ok) return;
    onChange(result.state);
    if (!on) { setChosen(null); tileRefs.current[target.id]?.focus(); }
    setSaid(on ? `Sprout puts on ${words(target).the}.` : `Sprout takes off ${words(target).the}.`);
  };

  const shortBy = item && !owned ? Math.max(0, item.price - state.balance) : 0;
  return <section className={styles.shop} aria-label={named("Sprout's shop", mascot)}>
    <div className={styles.top}>
      <button type="button" className={`tap ${styles.balance}`} aria-expanded={ledgerOpen} aria-controls={ledgerId}
        aria-label={`${seeds(state.balance)}. ${ledgerOpen ? "Hide" : "Show"} recent Seeds`} onClick={() => setLedgerOpen((o) => !o)}>
        <Seed />
        <span className={styles.balanceNum}>{state.balance.toLocaleString("en-US")}</span>
        <span className={styles.balanceWord}>{state.balance === 1 ? "Seed" : "Seeds"}</span>
      </button>
      {pending > 0 && <span className={styles.pending}>+{pending} settling tonight</span>}
      {onClose && <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
    </div>

    <AnimatePresence>
      {ledgerOpen && <motion.div key="ledger" id={ledgerId} className={styles.ledger} role="region" aria-label="Recent Seeds"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }} transition={reduce ? INSTANT : SPRINGS.gentle}>
        <ul className={styles.ledgerList}>
          {state.ledger.slice(0, 6).map((row) => <li key={row.id} className={styles.ledgerRow}>
            <span className={styles.ledgerDelta} data-spent={row.delta < 0 || row.status === "reversed" || undefined}>
              {row.delta > 0 ? `+${row.delta}` : row.delta}</span>
            <span className={styles.ledgerWhat}>
              {row.kind === "purchase" && row.itemId ? `${LEDGER_COPY.purchase}: ${itemById(row.itemId)?.name ?? "an item"}` : LEDGER_COPY[row.kind]}
            </span>
            <span className={styles.ledgerWhen}>
              {row.status === "pending" ? "tonight" : row.status === "reversed" ? `reversed, ${day(row.localDate)}` : day(row.localDate)}</span>
          </li>)}
        </ul>
      </motion.div>}
    </AnimatePresence>

    <div ref={stage} className={styles.stage}>
    <motion.div key={bought} className={styles.stageBody} initial={bought && !reduce ? { scale: 0.96, y: 6 } : false}
      animate={{ scale: 1, y: 0 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
      <DressedSprout wearing={wearing} size={size} mascot={mascot}
        label={named(`Sprout${Object.keys(wearing).length ? `, wearing ${Object.values(wearing).map((id) => itemById(id!)?.name.toLowerCase()).join(", ")}` : ""}`, mascot)} />
    </motion.div>
    </div>

    <ul className={styles.tiles} aria-label="Items">
      {offered.map((entry) => {
        const mine = state.owned.includes(entry.id);
        const on = canWear(entry, mascot) && state.equipped[entry.slot] === entry.id;
        return <li key={entry.id}>
          <button type="button" ref={(el) => { tileRefs.current[entry.id] = el ?? undefined; }}
            className={`tap ${styles.tile}`} aria-pressed={chosen === entry.id}
            aria-label={named(`${entry.name}, ${mine ? (on ? "yours, on Sprout" : "yours") : seeds(entry.price)}`, mascot)} onClick={() => choose(entry)}>
            <span className={styles.tileArt}><Image src={entry.scene ? sceneArt(mascot, SCENE_TILE[entry.scene]) : entry.art} alt="" fill sizes="48px" draggable={false} /></span>
            {mine ? <span className={styles.tileMark}>{on ? "On" : "Yours"}</span>
              : <span className={styles.tilePrice}><Seed />{entry.price}</span>}
          </button>
        </li>;
      })}
    </ul>

    <div className={styles.action}>
      <div className={styles.actionText}>
        <span className={styles.actionName}>{item ? item.name : "Try something on"}</span>
        <span className={styles.actionNote}>
          {named(!item ? "Tap an item: Sprout tries it on."
            : !care && !fits ? `Sprout cannot wear ${words(item).the}.`
            : owned && care ? "Yours. It plays any time."
            : owned ? (worn ? `Sprout has ${words(item).it} on.` : `Yours. Sprout can wear ${words(item).it}.`)
            : shortBy > 0 ? `${seeds(shortBy)} more to go.` : `Balance after: ${seeds(state.balance - item.price)}.`, mascot)}
        </span>
      </div>
      {item && <div className={styles.actionButtons}>
        {/* One shared key: Buy, Wear and Take off are the same action slot, so a purchase or a wear
            toggle updates this button in place and keeps keyboard focus on it, never dropping focus
            to the page when the slot swaps to a different label. */}
        {!owned && (care || fits) && <Button key="action" variant="primary" size="sm" disabled={shortBy > 0 || busy}
          status={busy ? "pending" : undefined} onClick={() => void buy(item)}
          aria-label={`Buy ${words(item).the} for ${seeds(item.price)}`}>Buy · {item.price}</Button>}
        {owned && care && <Button key="action" variant="primary" size="sm" onClick={() => setPlaying(care)}>Play</Button>}
        {owned && !care && fits && !worn && <Button key="action" variant="primary" size="sm" disabled={busy}
          status={busy ? "pending" : undefined} onClick={() => void wear(item, true)}>Wear</Button>}
        {owned && worn && <Button key="action" variant="secondary" size="sm" disabled={busy}
          status={busy ? "pending" : undefined} onClick={() => void wear(item, false)}>Take off</Button>}
      </div>}
    </div>
    <p className="sr-only" aria-live="polite">{said.mascot === mascot ? said.text : ""}</p>
    <AnimatePresence>
      {playing && <CareScenePlayer key={playing} scene={playing} onClose={() => setPlaying(null)} />}
    </AnimatePresence>
  </section>;
}
