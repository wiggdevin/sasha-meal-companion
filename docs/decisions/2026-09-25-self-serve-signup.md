# Ruling 2026-09-25 — a new user can create their own account

Devin, 2026-09-25: a new user must be able to create an account and reach onboarding without an
invite. This supersedes Phase 9 §1.4 step 8 ("sign in never creates an account") for a new,
explicit create-account path only (`docs/specs/phase-9-tenancy-blank-slate.md`).

What changed: `/sign-in` has a third mode, "New here? Create an account". It sends the email OTP
with `shouldCreateUser: true`; the existing "sent" screen and code form (`verifyOtp` type `email`)
finish it. A new account has no `user_settings` row, so AuthGate forces onboarding.

What stays: plain sign-in (link, code, password) never creates an account, so a typo cannot mint
one, and its enumeration-safe "sent" handling is unchanged. The app has no password sign-up. The
invite-code system (§1.4–1.6: `account_claims`, the before-user-created hook) stays unbuilt.

Production steps after merge (orchestrator): (1) Supabase Auth `disable_signup` → false; until
then create mode shows the generic failure. (2) The "Confirm signup" email template gets the
`{{ .Token }}` code like the magic-link template, so a new address can use the code form.

Residual: the public Auth REST endpoint still tells a known address from an unknown one, as before;
with sign-up on, its `/signup` endpoint also accepts a password sign-up outside the app.
