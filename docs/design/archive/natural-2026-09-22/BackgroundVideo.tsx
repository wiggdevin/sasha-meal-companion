"use client";

import { useEffect, useRef } from "react";

/**
 * The ground behind every screen (DESIGN.md §Colors, 2026-09-18): a fixed, silent, looping clip
 * of a night garden in true colour, with the cards frosted over it.
 *
 * The clip is attached to the element after mount, and only when the user has not asked for reduced
 * motion and the phone is not in data-saver mode; until then, and on those phones for good, the
 * blurred poster (the same frame) is the ground. The markup carries no `src`, so the server and
 * the first client render are identical and the video never enters a hydration diff.
 * `aria-hidden`: it carries no meaning.
 */
const CLIP = "/bg/garden.mp4";

type NetworkInfo = { saveData?: boolean };

function wantsStill(): boolean {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return true;
  const connection = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  return connection?.saveData === true;
}

export default function BackgroundVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || wantsStill()) return;
    video.src = CLIP;
    void video.play().catch(() => {});
    // Pause when the tab is hidden: a looping decode in the background costs battery for nothing.
    const onVisibility = () => {
      if (document.hidden) video.pause();
      else void video.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeAttribute("src");
    };
  }, []);

  return (
    <div className="bg-video" aria-hidden="true">
      <video
        ref={ref}
        poster="/bg/garden.jpg"
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
      />
    </div>
  );
}
