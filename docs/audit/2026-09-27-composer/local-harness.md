# Local rendered verification

Managed worktree: `/Users/zero-suminc./.codex/worktrees/sasha-composer/meal-companion`.
Branch: `feat/sasha-tap-composer`, base `aa7946c15c6a5754cca7ebc7e47296329c25a342`.

Temporary route: `app/auth/composer-proof/page.tsx` at `http://127.0.0.1:3106/auth/composer-proof`.
This renders the actual Composer and toolbar with a local `onSend` collector. The visible `[]` below the composer is that collector, outside the product component. It makes no coach request. The server uses a deliberately invalid loopback Supabase URL and a nonsecret placeholder key, so no client data is needed.

Run from this worktree:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-composer-proof-only mise exec -- pnpm dev --hostname 127.0.0.1 --port 3106
```

Ego Browser task space **6**, page **p1**, is dedicated to this work. Port 3105 and the recipe worktree belong to the parent task and were not changed.

`browser-fixture.js` is a synthetic SpeechRecognition adapter for deterministic rendered checks. Inject it in the same browser round as the interactions after loading the page; do not assume a previous round's CDP script survives debugger reconnection/reload. Verify the fixture exists before activating Record. This fixture cannot establish microphone hardware or real provider transcription reliability.

The initial idle and recording screenshots were captured at 390 × 844. A later browser check reached a microphone permission prompt. Ego Browser transferred the space to the user and explicitly required confirmation before resuming. Do not retry, take over, create another task space, or switch browser surfaces to bypass that handoff. Resume this same space only after the user confirms handling the prompt, following the browser's takeover documentation.

The temporary route must be removed before any commit, PR or deployment. Save any useful fixture copy in this evidence folder first. No production route or authorization bypass should ship.

## Completed final run

The user confirmed permission. Space 6 was resumed, microphone access was verified with a live audio track followed by immediate stop, and final rendered flows were captured with the synthetic recognition fixture. The final receipts are the `rendered-*-checks.json` files, eight `final-*-390.png` images, and the independent Gemini/Astra visual reviews.

Space 6 was then finished, its agent page closed, and the owned 3106 dev server stopped. The temporary app route was removed after preserving its exact source in `composer-proof-fixture.txt`. The old URL is no longer a live verification route.

The invalid Supabase URL produces auth retry errors. An earlier real recorder fallback attempt lacked an account binding and failed before upload; this harness does not establish real transcription or authenticated server behavior. The final synthetic flows are separate from the successful real microphone-access probe.
