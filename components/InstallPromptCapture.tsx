"use client";

import { useEffect } from "react";
import { attachAndroidInstallCapture } from "@/lib/install-prompt/android-capture";

/**
 * Renders nothing. Mounted once from the root layout so Android/Chrome/Edge's
 * `beforeinstallprompt` is captured as early as possible — the visible install card lives inline
 * on the Today page instead, so it never overlays a card's own actions (owner feedback,
 * 2026-10-08), but that card would miss the event entirely if nothing was listening before it
 * mounted.
 */
export default function InstallPromptCapture() {
  useEffect(() => {
    attachAndroidInstallCapture();
  }, []);
  return null;
}
