"use client";

import { useEffect } from "react";
import { onAccountGone, onAccountReady } from "@/lib/device/account";
import { applyGround, readGround } from "@/lib/design/ground-pref";
import { DEFAULT_GROUND } from "@/lib/design/grounds";

/** Paints the signed-in account's chosen background onto <html data-ground>; Oat when none. */
export default function GroundTheme() {
  useEffect(() => {
    const ready = onAccountReady((h) => applyGround(readGround(h)));
    const gone = onAccountGone(() => applyGround(DEFAULT_GROUND));
    return () => { ready(); gone(); };
  }, []);
  return null;
}
