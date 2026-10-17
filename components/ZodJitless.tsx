"use client";

import { z } from "zod";

// Zod probes for eval (`Function("")`) the first time it parses an object, to pick its compiled
// fast path. The page CSP (W079, lib/security-headers.ts) gives no 'unsafe-eval', so the probe
// files a violation report (zod catches the refusal and falls back). Zod's plain path is the same
// validation without eval; choosing it up front keeps the reports clean.
z.config({ jitless: true });

export default function ZodJitless() {
  return null;
}
