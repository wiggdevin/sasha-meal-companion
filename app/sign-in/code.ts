/**
 * The typed one-time-code fallback (Phase 0 Lane B open question 4): on iOS
 * the magic link opens in Safari rather than the installed PWA, so the
 * session cookie can land in the wrong cookie store. `signInWithOtp` also
 * sends a 6-digit code alongside the link when the Supabase "Magic Link"
 * email template includes `{{ .Token }}` — typing it in verifies the OTP
 * directly in the PWA's own browser context.
 */

/** Strips whitespace a phone keyboard or paste can add around the digits. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/**
 * How many digits a code may have. Supabase's mailer_otp_length is 8 on this
 * project; older codes were 6. Both the validator below and the input's
 * `maxLength`/`pattern` in components/SignInCodeForm.tsx read these, because
 * when they drifted apart the field capped typing at 6 and refused every real
 * 8-digit code before it could be submitted.
 */
export const CODE_MIN_DIGITS = 6;
export const CODE_MAX_DIGITS = 8;

/** The `pattern` attribute for a code input, from the same bounds. */
export const CODE_PATTERN = `[0-9]{${CODE_MIN_DIGITS},${CODE_MAX_DIGITS}}`;

/** True only for a clean code of an allowed length, once normalised. */
export function isValidCode(code: string): boolean {
  return new RegExp(`^${CODE_PATTERN}$`).test(code);
}

/**
 * What the code field should hold after someone types or pastes `raw`.
 *
 * Supabase's email puts the code on its own line and phones add spaces around
 * a paste, so the separators are stripped here rather than fought with an HTML
 * `pattern` (which validates before any JS runs) or cut off by `maxLength`
 * (which would truncate "1234 5678" to seven digits and submit the wrong code).
 */
export function toCodeInput(raw: string): string {
  return normalizeCode(raw).slice(0, CODE_MAX_DIGITS);
}
