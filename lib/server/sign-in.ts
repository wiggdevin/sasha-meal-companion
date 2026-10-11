/**
 * W052: email-code, password and code-check sign-in, through the app server so each call passes an
 * IP-keyed limiter first (B103). Before this the browser called Supabase Auth directly, and the only
 * limit was app/sign-in/attempt-limit.ts, which lives in page memory and a reload clears.
 *
 * - Every call is counted under `auth:<action>:<ip>` (lib/server/request-ip.ts), 10 per 10 minutes,
 *   before the body is read: the 11th call in the window answers 429 `rate_limited`. A limiter fault
 *   answers 503 `rate_limit_unavailable` (fail closed, the shared default).
 * - Never keyed by email: an email-keyed server limit would let anyone lock the owner out by
 *   guessing at the owner's address. An IP key only stops the caller who sends the calls.
 * - The three actions count apart, so a run of wrong codes never blocks a password sign-in.
 * - JSON only (415 otherwise): a cross-site form cannot send `application/json` without a CORS
 *   preflight this app never grants, so no other site can sign a browser in here (login CSRF).
 * - No email, password or code reaches a log line or a response.
 *
 * Supabase's own endpoints stay public with the publishable key, so a caller who skips this app
 * meets only the project's own auth limits. Those are reviewed in
 * docs/decisions/2026-10-11-sign-in-limits.md.
 */

import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { jsonError, readJson, safeNextPath } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { applyCookies, createRequestClient } from "@/lib/supabase/server";

export const SIGN_IN_LIMIT = 10;
export const SIGN_IN_WINDOW_SECONDS = 600;
const MAX_BYTES = 4_096;

export type SignInAction = "otp" | "verify" | "password";

/** The limiter key: one window per action per caller IP. */
export function signInLimitKey(action: SignInAction, req: Request): string {
  return `auth:${action}:${requestIp(req)}`;
}

const email = z.string().trim().min(3).max(320).email();
const OtpBody = z.object({ email, create: z.boolean(), next: z.string().max(2_048).optional() }).strict();
const VerifyBody = z.object({ email, code: z.string().regex(/^\d{6,10}$/) }).strict();
const PasswordBody = z.object({ email, password: z.string().min(1).max(1_024) }).strict();

type AuthError = { message: string; status?: number; name?: string } | null;

function requireJson(req: Request): void {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type.trim())) {
    throw new HttpError(415, "unsupported_media_type", "Send JSON.");
  }
}

function noStore(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  return res;
}

function ok(req: Request): Response {
  const res = new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  return noStore(applyCookies(req, res));
}

function limitedByAuth(error: NonNullable<AuthError>): boolean {
  return error.status === 429 || /rate limit|only request this after/i.test(error.message);
}

/**
 * True when Supabase Auth never judged the request: the SDK RESOLVES (not rejects) with an
 * `AuthRetryableFetchError` for a network failure or a gateway 502/503/504 (Sol review, W052). For
 * the code check and the password, any 5xx counts too, so an outage never reads as a wrong
 * password. The email send keeps its 5xx in `otpFailure`, which answers one generic code.
 */
function unavailable(error: AuthError, anyServerError: boolean): boolean {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  return anyServerError && typeof error.status === "number" && error.status >= 500;
}

/** One Supabase Auth call; a throw or an unjudged answer becomes 502 `auth_unavailable`. */
async function call(work: () => Promise<{ error: AuthError }>, anyServerError: boolean): Promise<AuthError> {
  let error: AuthError;
  try {
    error = (await work()).error;
  } catch (cause) {
    throw new HttpError(502, "auth_unavailable", "The sign-in service did not answer.", { cause });
  }
  if (unavailable(error, anyServerError)) {
    throw new HttpError(502, "auth_unavailable", "The sign-in service did not answer.",
      { cause: { name: error?.name, message: error?.message } });
  }
  return error;
}

/**
 * The failure code a send reports, or null when the screen should say "sent".
 *
 * Sign in (no account enumeration, PR #246 review r1, finding 3): with shouldCreateUser false,
 * Supabase answers an address with no account with "Signups not allowed for otp", so that error
 * answers exactly like a real send. Every other sign-in failure, the per-address resend window
 * included, is the one generic `send_failed`, so the answer never tells a known address apart.
 * Create: a known address simply gets a sign-in email, so a rate limit may say to wait.
 */
export function otpFailure(create: boolean, error: AuthError): string | null {
  if (!error) return null;
  if (!create) return error.message === "Signups not allowed for otp" ? null : "send_failed";
  return limitedByAuth(error) ? "auth_rate_limited" : "send_failed";
}

async function guarded(req: Request, action: SignInAction, run: () => Promise<Response>): Promise<Response> {
  try {
    await enforceRateLimit(signInLimitKey(action, req), SIGN_IN_LIMIT, SIGN_IN_WINDOW_SECONDS);
    requireJson(req);
    return noStore(await run());
  } catch (e) {
    return noStore(jsonError(e));
  }
}

export function handleOtp(req: Request): Promise<Response> {
  return guarded(req, "otp", async () => {
    const body = await readJson(req, OtpBody, MAX_BYTES);
    const origin = new URL(req.url).origin;
    const next = safeNextPath(body.next ?? null);
    const error = await call(() => createRequestClient(req).auth.signInWithOtp({
      email: body.email,
      options: {
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // Sign in never creates an account (docs/decisions/2026-09-25-self-serve-signup.md).
        shouldCreateUser: body.create,
      },
    }), false);
    const failure = otpFailure(body.create, error);
    if (failure === "auth_rate_limited") throw new HttpError(429, failure, "Wait a minute, then try again.");
    if (failure) throw new HttpError(400, failure, "That did not send.");
    return ok(req);
  });
}

export function handleVerify(req: Request): Promise<Response> {
  return guarded(req, "verify", async () => {
    const body = await readJson(req, VerifyBody, MAX_BYTES);
    const error = await call(() => createRequestClient(req).auth.verifyOtp({
      email: body.email, token: body.code, type: "email",
    }), true);
    if (error && limitedByAuth(error)) throw new HttpError(429, "auth_rate_limited", "Wait, then try again.");
    if (error) throw new HttpError(400, "invalid_code", "That code did not work.");
    return ok(req);
  });
}

export function handlePassword(req: Request): Promise<Response> {
  return guarded(req, "password", async () => {
    const body = await readJson(req, PasswordBody, MAX_BYTES);
    const error = await call(() => createRequestClient(req).auth.signInWithPassword({
      email: body.email, password: body.password,
    }), true);
    if (error && limitedByAuth(error)) throw new HttpError(429, "auth_rate_limited", "Wait, then try again.");
    if (error) throw new HttpError(401, "invalid_credentials", "That email and password did not match.");
    return ok(req);
  });
}
