"use client";

import { useEffect, useRef } from "react";

/**
 * The ground behind every screen (DESIGN.md §Techniques): the motion-portfolio reference's own
 * clip, dark chrome ribbons on black, fixed and silent, under a 30 % black veil. The glass cards
 * frost over it.
 *
 * The clip is attached after mount, and only when the user has not asked for reduced motion and
 * the phone is not in data-saver mode; until then, and on those phones for good, the poster (a frame
 * of the same clip) is the ground. The markup carries no `src`, so the server and the first client
 * render are identical. The filename is versioned: the service worker keeps it after one fetch.
 */
const CLIP = "/ground-v1.mp4";

type NetworkInfo = { saveData?: boolean };

function wantsStill(): boolean {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return true;
  const connection = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  return connection?.saveData === true;
}

export default function GroundVideo() {
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
    <div className="ground-layer" aria-hidden="true">
      <video ref={ref} poster="/ground-v1.jpg" muted loop playsInline preload="auto" disablePictureInPicture />
    </div>
  );
}
