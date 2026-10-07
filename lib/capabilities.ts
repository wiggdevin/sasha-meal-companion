import "server-only";

import { enabledMethods, type CaptureMethod } from "@/lib/capture/flags";

export type AppCapabilities = {
  coach: boolean;
  scan: boolean;
  captureMethods: CaptureMethod[];
  device?: { enabled: boolean; ouraConfigured: boolean };
};

type CapabilityEnv = Record<string, string | undefined>;

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * The one coach switch. The routes, the weekly-review cron and the UI capability all read it here:
 * the routes once tested `!process.env.COACH_ENABLED`, so "0" hid the coach in the app while its
 * API and the Gemini weekly review kept running (audit 2026-10-01).
 */
export function coachEnabled(env: CapabilityEnv = process.env): boolean {
  return enabled(env.COACH_ENABLED);
}

/** Read once on the server. Missing and unrecognized values deliberately disable the feature. */
export function readAppCapabilities(env: CapabilityEnv): AppCapabilities {
  const healthEnabled = enabled(env.HEALTH_INGEST_ENABLED);
  return {
    coach: coachEnabled(env),
    scan: enabled(env.FEATURE_SCAN ?? env.NEXT_PUBLIC_FEATURE_SCAN),
    captureMethods: enabledMethods(env.CAPTURE_METHODS ?? ""),
    device: { enabled: healthEnabled, ouraConfigured: healthEnabled &&
      Boolean(env.OURA_CLIENT_ID && env.OURA_CLIENT_SECRET && env.OURA_REDIRECT_URI) },
  };
}
