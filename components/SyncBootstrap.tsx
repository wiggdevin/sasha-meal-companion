"use client";

import { useEffect } from "react";
import { mountAccountSync } from "@/lib/sync/account-sync";

/**
 * Starts sync for the account this phone is bound to, once that account is ready (legacy adoption
 * finished), and stops it the moment the account is gone. The triggers — open, return to the tab,
 * signal back, 1.5 s after a local write — live in lib/sync/account-sync.ts, where they can be
 * tested; an effect body cannot be.
 */
export default function SyncBootstrap() {
  useEffect(() => mountAccountSync(), []);
  return null;
}
