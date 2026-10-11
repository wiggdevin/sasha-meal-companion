# 2026-10-11 — server-side sign-in limits and the Supabase Auth limit review (W052, B103)

## What the app does now

The sign-in screen no longer calls Supabase Auth from the browser. Three app routes do it on the
server (`lib/server/sign-in.ts`):

| Route | Supabase call | Limiter key |
|---|---|---|
| `POST /api/auth/otp` | `signInWithOtp` (link and code; `create` sets `shouldCreateUser`) | `auth:otp:<ip>` |
| `POST /api/auth/verify` | `verifyOtp` type `email` | `auth:verify:<ip>` |
| `POST /api/auth/password` | `signInWithPassword` | `auth:password:<ip>` |

- 10 calls per 10 minutes per action per IP (`requestIp`: `x-real-ip` only). The 11th answers
  429 `rate_limited` with `Retry-After`. The count runs before the body is read, so malformed calls
  count too.
- A limiter fault answers 503 `rate_limit_unavailable` (fail closed). Sign-in waits; it never
  goes through uncounted.
- No key holds an email. An email-keyed server limit would let anyone lock the owner out by
  sending wrong guesses for the owner's address. An IP key stops only the caller who sends the
  calls, so the owner's own IP is never locked by someone else (one shared NAT aside).
- The actions count apart: a run of wrong codes never blocks a password sign-in.
- JSON only (415 otherwise), so no cross-site form can sign a browser in (login CSRF).
- The answer sets the session cookies (`applyCookies`), so the installed PWA keeps the session in
  its own cookie store, as the typed-code path needs.
- Account enumeration stays closed in the app: `otpFailure` answers a sign-in for an unknown
  address exactly like a sent one, and every other sign-in failure is one generic `send_failed`.
- The email-keyed page-memory floor (`app/sign-in/attempt-limit.ts`) stays in front.

## Supabase Auth limits, as read on 2026-10-11

Read-only from the Management API (`GET /v1/projects/<ref>/config/auth`) for the production
project. Nothing was changed.

| Setting | Value | Meaning |
|---|---|---|
| `rate_limit_email_sent` | 150 | emails per hour, project-wide (custom SMTP is set) |
| `rate_limit_otp` | 30 | OTP and magic-link sends per hour, project-wide |
| `smtp_max_frequency` | 60 | seconds before the same address can get another email |
| `rate_limit_verify` | 30 | `/verify` calls per 5 minutes per IP |
| `rate_limit_token_refresh` | 150 | `/token` calls (password sign-in and refresh) per 5 minutes per IP |
| `rate_limit_anonymous_users` | 30 | anonymous sign-ins per hour per IP (anonymous sign-in is off) |
| `security_sb_forwarded_for_enabled` | false | Supabase rate-limits by the caller's own IP |
| `security_captcha_enabled` | false | no CAPTCHA on sign-up, sign-in or recovery |
| `disable_signup` | false | self-serve create is on (ruling 2026-09-25) |
| `mailer_autoconfirm` | false | a new account must confirm its email |
| `mailer_otp_exp` / `mailer_otp_length` | 1800 / 8 | codes last 30 minutes, 8 digits |
| `password_min_length` | 6 | |

## New consequence: Supabase sees the server's IP

Because the calls now come from the app's functions, Supabase's per-IP limits for `/verify`
(30 per 5 minutes) and `/token` (150 per 5 minutes) are shared by everyone who signs in through the
app at once. At today's account count this is far from the limit. If many people sign in at the
same time, Supabase can answer 429; the screen then says to wait (`auth_rate_limited`).

The fix Supabase documents is IP forwarding: turn on `security_sb_forwarded_for_enabled` and call
Auth with a secret key (`sb_secret_…`) and an `Sb-Forwarded-For: <client ip>` header. It does not
work with the publishable key or the legacy `service_role` key. This needs an owner step and a
small code change (follow-up).

## The `/signup` abuse path

Supabase's own endpoints stay public with the publishable key, so a caller who skips this app does
not meet the app's limiter:

- `/auth/v1/otp` and `/auth/v1/signup` can send emails. Every email counts against the
  project-wide 150 per hour, so a flood can use up the budget and delay real sign-in emails for up
  to an hour. One address gets at most one email per 60 seconds.
- `/auth/v1/signup` accepts a password sign-up outside the app (the app has none). With
  `mailer_autoconfirm` false the account stays unconfirmed until its email is confirmed, so
  sign-ups for addresses the caller does not own never become usable accounts. They do add rows to
  `auth.users`.
- `/auth/v1/token` and `/auth/v1/verify` stay limited per caller IP by Supabase (table above).

Recommended, in order (owner decisions, not done here):

1. Turn on CAPTCHA (Cloudflare Turnstile) in Authentication > Attack Protection. Supabase then
   refuses every sign-up, sign-in and OTP call without a valid token, including direct calls. The
   app must then send `captchaToken` through the three routes (a follow-up code change; until it
   ships, turning CAPTCHA on breaks sign-in).
2. Or a before-user-created Auth hook that refuses accounts not created through `/api/auth/otp`.
3. Raise `password_min_length` to at least 8.
