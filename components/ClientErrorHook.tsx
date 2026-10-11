"use client";

import { useEffect } from "react";
import { installClientErrorHandlers } from "@/lib/client-error-reporter";

/** Hooks the window's uncaught errors and rejections once per page load (lib/client-error-reporter.ts). */
export default function ClientErrorHook() {
  useEffect(() => { installClientErrorHandlers(); }, []);
  return null;
}
