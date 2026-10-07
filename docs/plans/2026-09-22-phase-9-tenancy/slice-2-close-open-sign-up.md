# Slice 2 — Close open sign-up in the UI

> **IMPLEMENTED — see PR #246 (branch `fix/p9-close-open-signup`).** The PR code and its reviews in
> `docs/audit/code/` are the source of truth; the text below is the original plan and is
> superseded (audit plan r12).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Sign in path never creates an account (`shouldCreateUser: false`), and the dev sign-in route stays refused outside development.

**Architecture:** One option flip in the magic-link call and two tests. The hosted Auth `/signup` endpoint is closed by Devin in the dashboard, not by code (spec 1.5a).

**Tech Stack:** Next.js page, Vitest + `@testing-library/react` (jsdom pragma).

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md`, 1.4 step 8, 1.5a, Slices item 2.

**Branch:** `fix/p9-close-open-sign-up`. One PR, unmerged. No migration.

## Global Constraints

See `README.md`. **This PR must not deploy to production before Devin turns off "Allow new users
to sign up" in the production dashboard and checks it (Open for Devin 2).** Say so at the top of
the PR body.

## Current code (verified at `1d5790d`)

- `app/sign-in/page.tsx:70-77` — `signInWithOtp({ email, options: { emailRedirectTo, shouldCreateUser: true } })` with an owner-ruling comment dated 2026-09-22 (PR #237).
- `tests/sign-in/self-signup.test.tsx:14-26` — asserts `args.options.shouldCreateUser` is `true`.
- `app/api/dev/sign-in/route.ts:22-24` — `if (!devSignInAllowed()) return notFound();`
- `lib/server/dev-sign-in.ts` — `devSignInAllowed()` is false for `NODE_ENV=production`, any
  `VERCEL` environment, or an unset `DEV_SIGN_IN_EMAIL`.

---

### Task 1: Sign in never creates an account

**Files:**
- Modify: `app/sign-in/page.tsx:73-76` (comment and option)
- Modify (rename and invert): `tests/sign-in/self-signup.test.tsx` → `tests/sign-in/no-self-signup.test.tsx`

- [ ] **Step 1: Write the failing test** (rename the file with `git mv`, then change the test)

```tsx
describe("sign-in does not create accounts (Phase 9 §1.4 step 8)", () => {
  beforeEach(() => { cleanup(); signInWithOtp.mockClear(); });

  it("sends the code or link only to an existing account", async () => {
    render(<SignInPage />);
    const email = screen.getByRole("textbox");
    fireEvent.change(email, { target: { value: " tester@example.com " } });
    fireEvent.submit(email.closest("form")!);
    await waitFor(() => expect(signInWithOtp).toHaveBeenCalledTimes(1));
    const [args] = signInWithOtp.mock.calls[0] as unknown as [{ email: string; options: { shouldCreateUser: boolean } }];
    expect(args.email).toBe("tester@example.com");
    expect(args.options.shouldCreateUser).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail** — `pnpm exec vitest run tests/sign-in/no-self-signup.test.tsx` — Expected: FAIL (`expected true to be false`).
- [ ] **Step 3: Implement** — in `app/sign-in/page.tsx` set `shouldCreateUser: false` and replace the comment with: "Sign in never creates an account (Phase 9 §1.4 step 8). New accounts come only through an invite (§1.4) or the gated helpers (§1.6)."
- [ ] **Step 4: Run it and see it pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git add app/sign-in/page.tsx tests/sign-in && git commit -m "fix: sign-in no longer creates accounts"`

Note for the implementer (as built in PR #246, through review r1/r2/r3; audit plan r6 finding 3):
a new address gets Supabase's "Signups not allowed for otp" error. The page treats that one error
as a send and shows the neutral sent screen, "If this email has an account, we sent a sign-in
link. Check your inbox." (`fix/p9-close-open-signup:app/sign-in/page.tsx:78-87,156-163`); any
other error keeps the generic failure — the sent screen's own copy was rewritten for this too
(review r3, finding 2): the old "Check your email. Tap the link…" claimed a link was sent, which
is false for the no-account case. Test: when `signInWithOtp` resolves `{ error: { message:
"Signups not allowed for otp" } }`, the page shows the same neutral sent screen as a real send, and
no error text. (Residual disclosure — review r2 finding 3 — is covered once, under Human steps for
Devin, below.)

---

### Task 2: The dev sign-in route is refused outside development

**Files:**
- Create: `tests/sign-in/dev-route.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const generateLink = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ auth: { admin: { generateLink } } }) }));

async function call(env: Record<string, string | undefined>): Promise<Response> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  const { GET } = await import("@/app/api/dev/sign-in/route");
  return GET(new Request("https://x.test/api/dev/sign-in"));
}

afterEach(() => { vi.unstubAllEnvs(); generateLink.mockReset(); });

describe("GET /api/dev/sign-in", () => {
  it("is 404 in production", async () => {
    const res = await call({ NODE_ENV: "production", DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 on any Vercel environment", async () => {
    const res = await call({ NODE_ENV: "development", VERCEL: "1", DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 without DEV_SIGN_IN_EMAIL", async () => {
    const res = await call({ NODE_ENV: "development", VERCEL: undefined, DEV_SIGN_IN_EMAIL: undefined });
    expect(res.status).toBe(404);
  });
});
```

(Read `lib/server/dev-sign-in.ts` first and match the exact env names it checks; if it reads
`VERCEL_ENV` rather than `VERCEL`, stub that.)

- [ ] **Step 2: Run it** — `pnpm exec vitest run tests/sign-in/dev-route.test.ts` — Expected: PASS at once (the guard exists). Prove the test can fail: temporarily make `devSignInAllowed` return `true`, run, see FAIL, restore.
- [ ] **Step 3: Gates and PR**

```bash
pnpm exec tsc --noEmit && pnpm lint
pnpm exec vitest run tests/sign-in
git add tests/sign-in/dev-route.test.ts
git commit -m "test: dev sign-in route refused outside development"
git push -u origin fix/p9-close-open-sign-up
gh pr create --base main --title "fix: close open sign-up in the UI (Phase 9 slice 2)" --body-file /tmp/p9-slice2-pr.md
```

Leave the PR unmerged. Save the independent review to `docs/audit/code/`.

## Preview test steps

1. On the Vercel preview, open `/sign-in` and enter an address that has **no** account (for
   example `devin+p9-new@<his domain>`). Expected (revised through review r2/r3 — the old "generic
   error" expectation contradicted the code and would fail a correct build): the neutral screen "If
   this email has an account, we sent a sign-in link."; no email arrives; no new row in the preview
   branch's Authentication → Users.
2. Enter T's (test account) address. Expected: the code or link arrives and signs T in, as
   before — the same acknowledgement screen as step 1.
3. Open `<preview>/api/dev/sign-in`. Expected: 404.

## Rollback

Revert the merge commit. No data to undo.

## Human steps for Devin

1. **Before this deploys to production:** Supabase dashboard → Authentication → Sign In / Providers
   → turn off "Allow new users to sign up". **Check it against the Auth API directly, not through
   the app's `/sign-in` UI** (PR #246 review r1, finding 1: the UI always sends `shouldCreateUser:
   false` once this slice ships, so it answers "Signups not allowed for otp" for a new address
   whether or not the hosted setting is off — it cannot prove the setting, only that the app's own
   flip works). From a terminal, run a direct password `signUp` and a direct OTP `signInWithOtp`
   with `shouldCreateUser: true`, both for a brand-new address, against the target project's Auth
   API. Both must answer "Signups not allowed" and create no user. These become
   `scripts/invite-probe.ts` probes 1 and 2 in slice 5; until then, run them by hand (`curl` or the
   Supabase JS client against the project's Auth URL and anon key).
2. **Production gate — prove existing users can still sign in (review r2 finding 1; order fixed
   in review r3 finding 1).** With sign-up closed, Supabase can route an *unconfirmed* existing
   account through the signup path, where it would now be refused. In this order:
   a. **Read-only SQL precondition, before deploy:** run `select count(*) from auth.users where
      email_confirmed_at is null` against production. It must return `0`. **Tonight's result:
      0 of 2** (`auth.users` has 2 rows, both `email_confirmed_at` set, both with a password —
      read-only query, 2026-09-22). If it is ever non-zero before a future deploy, confirm those
      accounts (or otherwise give them a working sign-in path) before shipping this PR — do not
      deploy with an unconfirmed account still open.
   b. **Pre-deploy check, on the PR's Vercel Preview build, before merging to production
      (review r3, finding 1):** Sasha signs in on the Preview with her real account, once with
      the OTP/magic-link path and once with her password. Both must succeed there — the Preview
      already runs this PR's code (`shouldCreateUser: false`), so it is the last chance to catch
      a break before production sees it.
   c. Merge the PR (production deploys on merge).
   d. **Post-deploy check, on production, after the merge:** Sasha signs in once with the
      OTP/magic-link path and once with her password. Both must succeed. Do the same for the
      test account if practical.

**Residual disclosure (review r2, finding 3):** this PR closes account enumeration in the app's
own `/sign-in` UI only. A direct, unauthenticated request to the public Supabase Auth REST
endpoint still answers differently for a known vs. an unknown address (Supabase's OTP handler is
explicit about it). Closing that is out of scope for this slice; listed here for Devin, not
claimed as solved.
