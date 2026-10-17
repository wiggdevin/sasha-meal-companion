/**
 * Every client fetch has a deadline — T0 §2 (docs/plans/2026-09-17-t0-speed-foundations.md).
 *
 * Before this, a capture fetch had no timeout at all: a provider that never answered left the
 * sheet spinning until the user killed the app. Each call now names its budget, and a call that
 * overruns it throws `DeadlineExceeded` — a typed error, not a silent hang, so every surface can
 * map it onto the copy it already has ("Capture is resting, try search", the offline food list,
 * the outbox).
 *
 * The budget is a promise about wall-clock time, so it is enforced by a race rather than by the
 * abort alone: a server (or a stub) that ignores `signal` still loses at the budget. The abort is
 * still sent, so the socket is not left open.
 */

/** The kinds of call spec §2 gives a deadline to. One name per hop the user waits on. */
export type Budget =
  "sign" | "upload" | "propose" | "barcode" | "commit" | "coach" | "search" | "timings"
  | "transcribe" | "prefs" | "undo" | "ideas" | "signIn" | "accountDelete";

/**
 * Spec §2's table, in milliseconds: how long one call of each kind may take before the client
 * gives up on it. These are ceilings, not targets — §6 holds the targets — and T2/T3/T6 may
 * tighten them, never loosen them.
 */
export const DEADLINES: Record<Budget, number> = {
  sign: 5_000,
  upload: 20_000,
  propose: 25_000,
  barcode: 8_000,
  commit: 10_000,
  coach: 40_000,
  search: 6_000,
  prefs: 6_000,
  /**
   * T7 §2: the coach's voice fallback, from the post to the transcript. Short on purpose — the user is
   * holding a phone waiting for words to appear — and the server's own model budget
   * (lib/server/coach-transcribe.ts) sits under it, so the copy the user reads on a slow call is the
   * phone's, once.
   */
  transcribe: 8_000,
  /**
   * Telemetry, not a screen the user is waiting on — but a post with no deadline pins the flush chain
   * and every later flush queues behind it while the buffer grows (Grok pass 3, MEDIUM 5). Short,
   * because nothing is worse for being posted late and nothing is lost by giving up.
   */
  timings: 10_000,
  /**
   * Coach Undo records, reads and server Undos (lib/coach/undo-client.ts). An Undo waits on its
   * action's record post inside a per-action lock, so a post that never answered held that lock
   * for good (review t4r7 #3); past this, the outcome counts as unknown.
   */
  undo: 10_000,
  /**
   * A Plan-sheet chip (POST /api/plan/ideas): code-built cards, ~1 s on the server. The server's
   * own suggestion budget is 8 s, so this sits just above it and the server's honest "ran out of
   * time" line is the one the person reads.
   */
  ideas: 9_000,
  /**
   * W052: a sign-in call through the app's limited routes (lib/sign-in-client.ts). The server makes
   * one Supabase Auth call; past this the screen offers to try again.
   */
  signIn: 10_000,
  /**
   * Self-serve account deletion (lib/account-delete-client.ts): the server removes the account's
   * files, then its rows in one transaction. Rare and deliberate. Longer than the route's own
   * `maxDuration` (60 s), so the phone never gives up on a delete the server is still finishing.
   */
  accountDelete: 65_000,
};

/** The deadline promise's own "nothing to report": settled so the race lets go of it. */
const OVER = Symbol("deadline over");

/** Tests only: deadlines still waiting to settle. An answered call must leave none behind. */
let live = 0;
export function pendingDeadlines(): number {
  return live;
}

export class DeadlineExceeded extends Error {
  constructor(public readonly budget: Budget, public readonly ms: number) {
    super(`No answer within ${ms} ms.`);
    this.name = "DeadlineExceeded";
  }
}

/** True for a deadline, false for a caller's own abort or a transport failure. */
export function isDeadline(e: unknown): e is DeadlineExceeded {
  return e instanceof DeadlineExceeded;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * A promise bounded by one of the same budgets — for a hop that is not a `fetch` this module can
 * own, such as a Supabase read. `late` is the answer when the budget runs out; the work itself is
 * left to finish or not, because there is nothing here that could stop it.
 */
export async function withinBudget<T>(work: Promise<T>, budget: Budget, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  const gaveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => { over = true; resolve(late); }, DEADLINES[budget]);
  });
  // Nobody is waiting for the work once the budget is spent, so it may neither become an
  // unhandled rejection nor disappear in silence: an answer that arrives late is a fact about
  // this phone's connection, and the next pass will have to ask again (Grok pass 26, MEDIUM 4).
  void work.then(
    () => { if (over) console.warn(`${budget}: an answer arrived after the budget; ignored.`); },
    () => undefined,
  );
  try {
    return await Promise.race([work, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithDeadline(
  budget: Budget,
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const ms = DEADLINES[budget];
  const external = init.signal ?? null;
  if (external?.aborted) throw abortError();

  const doFetch = opts.fetchImpl ?? fetch;
  /*
   * A keepalive request belongs to the browser, not to this page — it is meant to survive the tab
   * going away — and WebKit refuses or silently drops one that carries an AbortSignal. On a
   * phone-first PWA that is every iPhone: the timings never land and the warm pings never fire,
   * and both callers swallow the throw (Grok pass 4, HIGH 1). So a keepalive call is sent with no
   * signal at all and is bounded by the race alone: the budget still holds, the socket is simply
   * left to the browser to close, which is what keepalive asked for in the first place.
   */
  const cancellable = init.keepalive !== true;
  const controller = new AbortController();
  /*
   * The signal handed to `fetch` aborts when EITHER the deadline or the caller does, and the link
   * outlives the call on purpose: a caller that aborts its own controller after the response has
   * already landed (a superseded keystroke in lib/catalog-client.ts) must still see the signal it
   * was given come back aborted.
   *
   * `AbortSignal.any` is the primitive for exactly this and cleans up after itself; the fallback
   * for a platform without it links by hand, and unlinks again once the call is over — a caller
   * that keeps one controller for every keystroke would otherwise collect one listener per call,
   * each holding that call's AbortController alive (Grok pass 3).
   */
  const anySignal = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  let signal: AbortSignal | undefined = cancellable ? controller.signal : undefined;
  let unlink: (() => void) | null = null;
  if (external && cancellable) {
    if (typeof anySignal === "function") signal = anySignal([external, controller.signal]);
    else {
      const onAbort = (): void => controller.abort();
      external.addEventListener("abort", onAbort, { once: true });
      unlink = () => external.removeEventListener("abort", onAbort);
    }
  }

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /*
   * The deadline settles either way. Clearing the timer used to be the whole cleanup, which left
   * the promise pending for the life of the page with the race's own reaction still attached to
   * it — one per answered call, on a screen that calls this on every keystroke (Grok pass 16,
   * MEDIUM 3). So the `finally` below hands it this sentinel; by then the race is long decided.
   */
  let over: (answer: typeof OVER) => void = () => {};
  const deadline = new Promise<typeof OVER>((resolve, reject) => {
    over = resolve;
    timer = setTimeout(() => {
      // Reject BEFORE aborting. `abort()` settles the in-flight fetch synchronously, and the
      // race would then report that AbortError instead of the deadline it actually was.
      reject(new DeadlineExceeded(budget, ms));
      if (cancellable) controller.abort();
    }, ms);
  });
  live += 1;
  void deadline.then(() => { live -= 1; }, () => { live -= 1; });

  try {
    // The caller's own signal is dropped too when the request is keepalive: forwarding it is the
    // very pair WebKit refuses, and a request nobody can cancel is better than one nobody sends.
    const { signal: _callers, ...rest } = init;
    const sent = cancellable ? { ...init, signal } : rest;
    const call = doFetch(input, sent);
    // The loser of the race still settles. `Promise.race` does subscribe to both, so its rejection
    // is not unhandled today — this says so locally instead of leaning on that, because an
    // unhandled rejection here would be an error in their console for a call nobody is waiting on.
    // What the deadline costs is the same either way: a keepalive post the timer beats is
    // abandoned and its rows are lost, which for telemetry is the right trade.
    void call.catch(() => {});
    const answer = await Promise.race([call, deadline]);
    // `over` runs in the `finally` below, so the race can only ever see the call or the deadline.
    if (answer === OVER) throw new DeadlineExceeded(budget, ms);
    // The headers are not the answer. A 200 whose BODY never arrives holds the caller open just
    // as surely, and the commit path holds the entry with it — past its own budget, while this
    // call believes it succeeded (Grok pass 25, MEDIUM 2). What is left of the budget covers it,
    // counted from the same start: a caller that reads the body late has less of it, not a fresh
    // one (Grok pass 26, MEDIUM 4).
    if (timer !== null) { clearTimeout(timer); timer = null; }
    return boundBody(answer, budget, () => Math.max(0, ms - (Date.now() - started)),
      () => { if (cancellable) controller.abort(); });
  } catch (e) {
    // The caller's own abort reaches `doFetch` as this controller's abort; it must still read as
    // an AbortError, because a superseded keystroke is not a slow server.
    if (external?.aborted && !isDeadline(e)) throw abortError();
    throw e;
  } finally {
    if (timer !== null) clearTimeout(timer);
    over(OVER);
    // The link exists to carry the caller's abort INTO this call; once the call is over there is
    // nothing left to abort, and the caller's own signal is unaffected either way.
    unlink?.();
  }
}

/** The body-reading methods the app uses. `body` itself is the caller's own to bound. */
const BODY_READS = ["json", "text", "arrayBuffer", "blob", "formData"] as const;

/**
 * The SAME response, with what is left of the budget over its body.
 *
 * The same object, deliberately: a `Response`'s `ok`, `status`, `headers` and `body` are prototype
 * getters that demand the real object as `this`, so a Proxy in front of one throws in Chromium and
 * WebKit the moment a caller reads `res.ok` — every caller's catch, and a search that answered
 * nothing on the phone while the API answered 200 (device regression on 4920024). Node's own
 * Response tolerated it, which is why no test saw it.
 *
 * So the body readers are replaced ON the response, as its own properties, and everything else is
 * untouched. The timer aborts the transport — which is what actually stops a stalled stream — and
 * the read that was waiting on it answers with the deadline rather than an opaque abort.
 */
function boundBody(
  res: Response, budget: Budget, remaining: () => number, abort: () => void,
): Response {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let late: Promise<never> | null = null;
  // Armed by the first read, not by the headers: a caller that never reads the body leaves no
  // timer behind, and one that does gets what is left of the budget AT THAT MOMENT.
  const arm = (): Promise<never> => {
    const ms = remaining();
    late ??= new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new DeadlineExceeded(budget, ms)); abort(); }, ms);
    });
    // The loser of the race still settles; nothing here may become an unhandled rejection.
    void late.catch(() => undefined);
    return late;
  };
  const read = (call: () => Promise<unknown>) => async (): Promise<unknown> => {
    const deadline = arm();
    const reading = call();
    // The abort that ends a stalled body rejects this too, a moment after nobody is waiting.
    void reading.catch(() => undefined);
    try {
      return await Promise.race([reading, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
  for (const name of BODY_READS) {
    const native = res[name] as (() => Promise<unknown>) | undefined;
    if (typeof native !== "function") continue;
    try {
      Object.defineProperty(res, name, {
        value: read(native.bind(res)), configurable: true, writable: true, enumerable: false,
      });
    } catch {
      // A response-like that will not take the property keeps its own reader: an unbounded body
      // is worse than a bounded one, and a call that throws here would be worse than both.
    }
  }
  return res;
}
