"use client";

import { z } from "zod";

// Zod probes for eval (`Function("")`) the first time it parses an object, to pick its compiled
// fast path. The page CSP (W079, lib/security-headers.ts) gives no 'unsafe-eval', so the probe is a
// violation report today and a blocked call once the policy is enforced. Zod's plain path is the
// same validation without eval; set it before anything in the browser parses.
z.config({ jitless: true });

export default function ZodJitless() {
  return null;
}
