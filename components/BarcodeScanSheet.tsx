"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsPresent } from "motion/react";
import Sheet from "@/components/Sheet";
import type { BarcodeResponse, ScanReply } from "@/lib/barcode/client";
import { resolveScan } from "@/lib/barcode/resolve-scan";
import { currentAccountOrNull } from "@/lib/device/account";
import { acceptReading, isPersistentScanFailure, pruneHistory, type Reading } from "@/lib/barcode/quorum";
import { beginRun, mark, type TimingRun } from "@/lib/timing";

/** One frame to the worker every 150 ms. Faster burns battery; slower feels like a stall. */
const FRAME_INTERVAL_MS = 150;
const FRAME_WIDTH = 640;

type Phase = "starting" | "scanning" | "resolving" | "refused" | "denied" | "unreadable" | "offline"
  | "scannerError";

/** After a refused match the camera waits this long before it reads again, so the same pack in
 *  view is not sent straight back into the refusal. */
const REFUSED_PAUSE_MS = 2000;

const MESSAGES: Record<Phase, string> = {
  starting: "Starting the camera…",
  scanning: "Point the camera at the barcode.",
  resolving: "Looking it up…",
  refused: "That did not go through. Scan again in a moment.",
  denied: "The camera is blocked. Allow it in Settings, or search for the food instead.",
  unreadable: "That is not a barcode we can read. Try the other side of the pack.",
  offline: "No connection, and this one is not on the phone yet. It will retry when you are back.",
  scannerError: "The scanner isn't reading right now. Search for the food instead.",
};

export default function BarcodeScanSheet({
  onResolved, onClose, hint, refusedCopy,
}: {
  /** The run the scan was measured under travels with the answer, so the commit closes THAT one.
   *  Answering false (now or later) means the page could not take the match: the sheet says so
   *  and scans again instead of holding "Looking it up…" (UI audit 2026-10-18 §6). */
  onResolved: (response: BarcodeResponse, run?: TimingRun) => void | boolean | Promise<boolean>;
  onClose: () => void;
  hint?: { brand?: string; name?: string };
  /** The line shown when `onResolved` answers false. */
  refusedCopy?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const historyRef = useRef<Reading[]>([]);
  const busyRef = useRef(false);
  /** Frames before this time are ignored (after a refused match). */
  const pausedUntilRef = useRef(0);
  const scanErrorsRef = useRef(0);
  /** This scan's own timing run: two scans in a session are two taps, never one row set. */
  const runRef = useRef<TimingRun | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  // A lookup that settles after the sheet has left (closed, unmounted, or exiting while another
  // scan opens) belongs to nothing on screen: its answer is dropped, never handed to the page.
  const present = useIsPresent();
  const here = useRef(true);
  useEffect(() => { here.current = present; }, [present]);
  useEffect(() => () => { here.current = false; }, []);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  /** Takes the camera back if a hidden page let it go while a lookup ran (set by the camera effect). */
  const resumeRef = useRef<() => void>(() => {});

  const resolve = useCallback(
    async (gtin: string) => {
      busyRef.current = true;
      setPhase("resolving");
      // The account that scanned (Phase 9 §0.2): the lookup, the cache and the retry queue are its.
      const h = currentAccountOrNull();
      if (h === null) { busyRef.current = false; return; }
      const run = runRef.current ?? undefined;
      const outcome = await resolveScan(h, gtin, hint, run);
      if (!here.current) return;
      if (outcome.kind === "resolved") {
        const taken = await onResolved(outcome.response, run);
        if (taken !== false || !here.current) return;
        busyRef.current = false;
        historyRef.current = [];
        pausedUntilRef.current = Date.now() + REFUSED_PAUSE_MS;
        setPhase("refused");
        resumeRef.current();
        return;
      }
      busyRef.current = false;
      if (outcome.kind === "unreadable") setPhase("unreadable");
      else if (outcome.kind === "offline") setPhase("offline");
      // Scanning goes on after an answer that is not a match, as before, even if the page was hidden
      // (and the camera let go) while the lookup ran.
      resumeRef.current();
    },
    [hint, onResolved]
  );

  /* One reading is never enough: a curved pouch reads a wrong digit often enough that a single
     frame cannot be trusted. acceptReading holds the line (spec "Engines and logic"). */
  const onReply = useCallback(
    (reply: ScanReply) => {
      if (busyRef.current || Date.now() < pausedUntilRef.current) return;
      if (reply.error) {
        scanErrorsRef.current += 1;
        if (isPersistentScanFailure(scanErrorsRef.current)) setPhase("scannerError");
        return;
      }
      scanErrorsRef.current = 0;
      const at = Date.now();
      for (const result of reply.results) {
        const next: Reading = { text: result.text, format: result.format, at };
        const accepted = acceptReading(historyRef.current, next);
        historyRef.current = pruneHistory([...historyRef.current, next], at);
        if (accepted) {
          void resolve(accepted);
          return;
        }
      }
    },
    [resolve]
  );

  /* The camera lifecycle must mount once. onReply changes identity whenever the caller's
     hint/onResolved props do (the app/page.tsx hand-off passes both inline), and depending on
     it here would tear down and re-request the camera on every parent re-render. */
  const onReplyRef = useRef(onReply);
  useEffect(() => {
    onReplyRef.current = onReply;
  }, [onReply]);

  useEffect(() => {
    let raf = 0;
    let lastFrame = 0;
    let frameId = 0;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const worker = new Worker(new URL("../lib/barcode/worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e: MessageEvent<ScanReply>) => onReplyRef.current(e.data));

    /* Camera permission is asked at the scan tap, never at app load, and is never required to
       log (spec "Security"). A hidden page lets the camera go and takes it back when shown. */
    // One camera request at a time, so a quick hide and show can never leave two streams live.
    let requesting = false;
    /** `announce` false keeps the sheet's current line (an unreadable or offline answer) on resume. */
    const start = (announce = true): void => {
      if (requesting || streamRef.current) return;
      requesting = true;
      void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } })
      .then((stream) => {
        requesting = false;
        // Closed, or hidden while the camera was being asked for: let it go (a show starts it again).
        if (cancelled || document.visibilityState === "hidden") { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorchAvailable(Boolean(capabilities?.torch));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => setPhase("denied"));
        }
        if (announce) setPhase("scanning");
        // The camera is live: `decode` is running from here until a reading is accepted (T0 §1).
        // Its own run, so a second scan started before this one has settled is its own tap.
        runRef.current = beginRun("barcode");
        mark("barcode", "decode", runRef.current);
        const tick = (t: number): void => {
          raf = requestAnimationFrame(tick);
          const video = videoRef.current;
          if (!video || video.readyState < 2 || t - lastFrame < FRAME_INTERVAL_MS) return;
          lastFrame = t;
          const scale = FRAME_WIDTH / video.videoWidth;
          canvas.width = FRAME_WIDTH;
          canvas.height = Math.round(video.videoHeight * scale);
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          frameId += 1;
          worker.postMessage({ id: frameId, data: ctx.getImageData(0, 0, canvas.width, canvas.height) });
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(() => { requesting = false; if (!cancelled) setPhase("denied"); }); };
    const stop = (): void => {
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setTorchOn(false);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stop();
      else if (!streamRef.current && !requesting && !busyRef.current) { setPhase("starting"); start(); }
    };
    resumeRef.current = () => { if (!cancelled && document.visibilityState !== "hidden") start(false); };
    start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      worker.terminate();
    };
  }, []);

  function toggleTorch(): void {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    void track
      .applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints)
      .then(() => setTorchOn(next))
      .catch(() => setTorchAvailable(false));
  }

  return (
    <Sheet title="Scan" subtitle={phase === "refused" && refusedCopy ? refusedCopy : MESSAGES[phase]}
      onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div
          className="relative w-full overflow-hidden rounded-3xl"
          style={{ aspectRatio: "4 / 3", background: "var(--color-well-dark)" }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full object-cover"
            aria-label="Camera preview"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 rounded-2xl border-2 border-white/70"
            style={{
              width: "72%", height: 96, transform: "translate(-50%, -50%)",
            }}
          />
        </div>
        {torchAvailable && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className="pill tap self-start"
          >
            <span className="pill-in flex h-11 items-center px-4 text-tiny font-normal text-graphite">
              {torchOn ? "Light off" : "Light on"}
            </span>
          </button>
        )}
      </div>
    </Sheet>
  );
}
