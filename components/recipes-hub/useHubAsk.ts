"use client";
/**
 * The recipe widget's conversation: a chip, a typed ask or a photo becomes one `recipes`-surface
 * coach turn, with the catalog's own matches searched beside it (shown first). Words that report a
 * meal already eaten ("I had two slices of the lasagna") send no turn: they wait as a confirmation,
 * then show what they would log in the capture editor (PanelReview, U23), and only its Log it writes,
 * through the Plan panel's capture path (lib/plan/photo-log.ts, via usePlanPhoto).
 *
 * Audit r4: the widget stays mounted across an account change, so the catalog search is stamped
 * with the account it ran as and its result is dropped once that account is gone. A photo read
 * takes the same ref lock as a turn, and a read that ends on an account change says so.
 *
 * Audit f2 BLOCKER: a catalog match or a coach answer that already landed is one account's own
 * too — `onAccountGone` drops it and the open ask the moment the bound account changes, instead
 * of waiting for the next send/chip/photo to notice.
 *
 * A photo of foods becomes a turn built from what the photo model read. That read's provenance
 * rides with the turn (`madeBy`), so the answer and its cards keep their "AI" label even when the
 * turn itself was written without a model (a Jev fast path or an app-written reply).
 */
import { useEffect, useRef, useState } from "react";
import { readOf } from "@/components/plan/PhotoResult";
import { aiLabelCopy } from "@/components/ui/AiLabel";
import { usePlanPhoto, type PhotoSource, type PhotoWhere } from "@/components/plan/usePlanPhoto";
import { CoachError, postTurn, type CoachClientTurnResponse } from "@/lib/coach-client";
import { AccountChanged, assertCurrent, currentAccountOrNull, isCurrent, onAccountGone,
  type AccountHandle } from "@/lib/device/account";
import { InspireError } from "@/lib/plan/inspire-client";
import type { PhotoRead, PlanSource } from "@/lib/plan/inspire-types";
import { inspireSource, recipeSearchFor } from "@/lib/plan/quick-picks";
import { searchCatalogRecipes } from "@/lib/recipe-catalog-client";
import { recipesJudgedNow, useRecipeReader } from "@/lib/recipes/recipe-freshness";
import type { RecipeCandidate, RecipeSearch } from "@/lib/recipe-catalog/types";
import { chipPrompt, eatenStatement, hubSearchFor, type AskChip } from "@/lib/recipes-hub/hub";
import { readHubDay, type HubDay } from "@/components/recipes-hub/useHubDay";
import type { Provenance } from "@/lib/types";

const PHOTO_PROMPT = "Suggest three recipes or meals I can have today that fit my remaining macros, built"
  + " mostly from the foods in the PLAN SOURCE data (my photo).";

export type HubAsk = { label: string; text: string };

/**
 * Who made the answer the hub shows: the turn's own provenance when it carries a label, else the
 * provenance of the photo read the turn was built from. A turn that is not from a photo has no read,
 * so it keeps its own (which may be no label).
 */
export function answerProvenance(turn: Provenance | undefined, read: Provenance | null): Provenance | undefined {
  if (aiLabelCopy(turn) || !read) return turn;
  return read;
}

function failure(caught: unknown): { message: string; retryable: boolean } {
  if (!(caught instanceof CoachError) || caught.status === 0)
    return { message: "Couldn’t reach the coach. Check your connection and try again.", retryable: true };
  if (caught.status === 404) return { message: "Recipe ideas aren’t available right now.", retryable: false };
  return { message: caught.message || "Something went wrong. Try again.",
    retryable: caught.status === 429 || caught.status >= 500 };
}

export function useHubAsk({ day, recipesOn, onLogged }: {
  day: HubDay; recipesOn: boolean; onLogged?: () => void;
}) {
  const [opening] = useState(currentAccountOrNull);
  const [asked, setAsked] = useState<HubAsk | null>(null);
  const [response, setResponse] = useState<CoachClientTurnResponse | null>(null);
  const [catalog, setCatalog] = useState<RecipeCandidate[] | null>(null);
  // The catalog matches' reader (lib/recipes/recipe-freshness.ts): a new ask aborts the search before
  // it, only the newest lands, and a rule change reads the shown matches again ("Checking…" meanwhile).
  const { reader: catalogReader, stale: catalogStale } = useRecipeReader<RecipeCandidate[]>({
    apply: setCatalog, judged: (recipes) => recipesJudgedNow(recipes) });
  /** No matches, and none to re-read. */
  const dropCatalog = () => { catalogReader.clear(); setCatalog(null); };
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [logged, setLogged] = useState<string | null>(null);
  const threadId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const run = useRef(0);
  const last = useRef<{ ask: HubAsk; search: RecipeSearch | null; planSource?: PlanSource;
    read?: Provenance } | null>(null);
  const [photoRead, setPhotoRead] = useState<PhotoRead | null>(null);
  /** The provenance of the photo read the current turn was built from; null for any other ask. */
  const [readBy, setReadBy] = useState<Provenance | null>(null);
  // A log files under the meal of the tap, not of the last render (audit 2026-10-04).
  const where = (): PhotoWhere => {
    let now = day;
    try { now = readHubDay(); } catch { /* the rendered day stands */ }
    return { slot: now.slot, date: now.date, time: now.time, targetKcal: now.remaining?.kcal };
  };
  const photo = usePlanPhoto({ slot: day.slot, date: day.date, time: day.time, targetKcal: day.remaining?.kcal, where,
    onError: (message) => setError(message ? { message, retryable: false } : null),
    onAccountChanged: () => setError({ message: "Account changed. Close and reopen.", retryable: false }),
    onLogged: () => { setLogged("Logged."); setConfirm(null); onLogged?.(); } });

  // A settled answer or catalog match is `opening`'s own: the moment the bound account changes,
  // drop it instead of leaving it painted for whoever opens the widget next (audit f2 BLOCKER).
  useEffect(() => onAccountGone(() => {
    setAsked(null); setResponse(null); dropCatalog(); setConfirm(null); setLogged(null);
    setPhotoRead(null); setReadBy(null); photo.setShown(null); photo.forget();
    setError({ message: "Account changed. Close and reopen.", retryable: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function account(): AccountHandle | null {
    try {
      if (!opening) throw new AccountChanged();
      assertCurrent(opening);
      return opening;
    } catch { setError({ message: "Account changed. Close and reopen.", retryable: false }); return null; }
  }

  /** Searched as `h` (the account bound now): a result that lands after it is gone is dropped. */
  function findRecipes(search: RecipeSearch | null, mine: number, h: AccountHandle) {
    dropCatalog();
    if (!recipesOn || !search) return;
    void catalogReader.read(async (signal) => {
      const result = await searchCatalogRecipes(search, signal);
      if (mine !== run.current || !isCurrent(h)) throw new AccountChanged();
      return result.recipes;
    });
  }

  async function turn(ask: HubAsk, search: RecipeSearch | null, planSource?: PlanSource,
    read?: Provenance): Promise<boolean> {
    if (busyRef.current) return false;
    const h = account();
    if (!h) return false;
    busyRef.current = true;
    const mine = ++run.current;
    last.current = { ask, search, planSource, read };
    setAsked(ask); setResponse(null); setReadBy(read ?? null); setError(null); setConfirm(null); setLogged(null);
    photo.setShown(null);
    setLoading(true);
    findRecipes(search, mine, h);
    try {
      const answer = await postTurn({ threadId: threadId.current, messageId: crypto.randomUUID(),
        text: ask.text, surface: "recipes", ...(planSource ? { planSource } : {}) }, { account: h });
      assertCurrent(h);
      threadId.current = answer.threadId;
      if (mine === run.current) setResponse(answer);
      return true;
    } catch (caught) {
      if (caught instanceof AccountChanged) { setError({ message: "Account changed. Close and reopen.", retryable: false }); return false; }
      if (mine === run.current) setError(failure(caught));
      return false;
    } finally {
      busyRef.current = false;
      if (mine === run.current) setLoading(false);
    }
  }

  /** Typed words: a log waits for its Log it tap; anything else is a coach turn. */
  function send(text: string): Promise<boolean> {
    const entered = text.trim();
    if (!entered || busyRef.current) return Promise.resolve(false);
    if (eatenStatement(entered)) {
      run.current += 1;
      setAsked({ label: entered, text: entered }); setResponse(null); setReadBy(null); dropCatalog();
      setError(null); setLogged(null); photo.setShown(null); setConfirm(entered);
      return Promise.resolve(true);
    }
    return turn({ label: entered, text: entered }, hubSearchFor({ wish: entered }));
  }

  const chip = (pick: AskChip) => turn({ label: pick, text: chipPrompt(pick) }, hubSearchFor({ chip: pick }));

  /**
   * A camera or upload photo: a plate or menu shows its own log step; foods or a dish ask for ideas.
   * "Not right?" reads the kept photo again another way (`{ as }`), with no second upload.
   */
  async function readSource(source: PhotoSource) {
    if (busyRef.current) return;
    if (!("file" in source) && !photo.photo) return;
    const h = account();
    if (!h) return;
    busyRef.current = true;
    let held = true;
    setReading(true); setError(null); setConfirm(null); setLogged(null);
    try {
      const result = await photo.read(h, source);
      assertCurrent(h);
      if (!result) return;
      setPhotoRead(readOf(result.kind));
      if (result.kind === "plate" || result.kind === "menu") {
        run.current += 1;
        setAsked({ label: "Your photo", text: "" }); setResponse(null); setReadBy(null); dropCatalog();
        photo.setShown(result);
        return;
      }
      if (result.ingredients.length === 0 && !result.title) {
        setError({ message: "I couldn’t spot any food there. Try a closer photo.", retryable: false });
        return;
      }
      setReading(false);
      busyRef.current = false; held = false;
      await turn({ label: "Your photo", text: PHOTO_PROMPT },
        recipeSearchFor({ kind: "inspire", found: result }), inspireSource(result), result.provenance);
    } catch (caught) {
      if (caught instanceof AccountChanged) {
        setError({ message: "Account changed. Close and reopen.", retryable: false });
        return;
      }
      setError({ message: caught instanceof InspireError ? caught.message : "Couldn’t read that. Try again.",
        retryable: false });
    } finally {
      if (held) busyRef.current = false;
      setReading(false);
    }
  }

  const readPhoto = (file: Blob) => readSource({ file });
  const rereadPhoto = (as: PhotoRead) => readSource({ as });

  /** Words that report a meal: matched to foods and shown for review (U23); nothing is logged until
   *  the review's own Log it. */
  function logIt(text: string) {
    const h = account();
    if (h) { setConfirm(null); void photo.reviewText(h, text); }
  }

  /** The review's Log it: the one write this hook makes. */
  async function confirmReview(edits: Parameters<typeof photo.confirm>[1]) {
    const h = account();
    return h ? photo.confirm(h, edits) : null;
  }

  /** The review has held "Logged": report it like any other log. */
  function reviewDone() {
    photo.cancelReview();
    setLogged("Logged."); setConfirm(null); onLogged?.();
  }

  function retry() {
    const previous = last.current;
    if (previous) void turn(previous.ask, previous.search, previous.planSource, previous.read);
  }

  return {
    asked, response, catalog, catalogStale, loading, reading, error, confirm, logged, photo,
    /** Who made the answer: the turn's label, else the photo read it was built from. */
    madeBy: answerProvenance(response?.provenance, readBy),
    busy: loading || reading || photo.logging !== null,
    /** How the kept photo was last read, for the "Not right?" line; null with no photo. */
    photoRead: photo.photo ? photoRead : null,
    send, chip, readPhoto, rereadPhoto, logIt, confirmReview, reviewDone, retry,
    cancelConfirm: () => setConfirm(null),
    account,
  };
}
