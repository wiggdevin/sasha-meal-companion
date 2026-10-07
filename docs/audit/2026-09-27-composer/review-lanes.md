# Composer review lane availability — 2026-09-27

These are live availability probes and source inspection, **not acceptance reviews of the change**. No production data or credentials were sent in the probe packets. No product code, services, ports, account selection, or recipe release plan changed.

Inspected base: `aa7946c15c6a5754cca7ebc7e47296329c25a342`. Receipt recorded at `2026-09-27T23:00:27Z`. Selected provider responses are preserved in `review-lane-receipts.json`.

| Requested lane | Availability | Evidence | Acceptance review obtained? |
|---|---|---|---|
| Claude Opus through Max | YES | OAuth status: `claude.ai`, `firstParty`, `max`. Alias `opus` returned `READY`; canonical response model `claude-opus-5-5`; success, no permission denials, about 3.9 s. | NO |
| Jev binary verification | YES | TypeSafe System One returned HTTP 200, requested `jev-latest`, resolved `jev-1.13.0`; synthetic Choice answer `yes`, confidence 1.0; 333 input / 31 output tokens. | NO |
| Gemini 3.8 Flash visual check | YES | Live `agy models` includes `gemini-3.8-flash-low`, `-medium`, `-high`. Direct AGY image probe returned SUCCESS in 5.36 s and correctly identified three round buttons: tray/box, microphone, paper-plane send. | NO; original screenshot availability probe only |
| Kimi K3 through OpenRouter | TEXT PROBE YES; VISUAL REVIEW BLOCKED | Live catalog lists `moonshotai/kimi-k3`, image/video/text input. Text probe returned HTTP 200 / `READY`, cost $0.0003983387. The subsequent original-screenshot request with 200 output tokens returned HTTP 402: could afford only 52 tokens (another provider attempt said 88). | NO |

The Kimi text success does **not** establish enough credit for the required independent visual audit. No credits were purchased, and no different model/vendor was substituted. Recheck available credit before any real Kimi review; do not shrink a substantive review into an uninformative yes/no solely to make the billing request fit.

## Reusable invocation details

Read the `zs-credential-access` skill first. Shell keys were present; only their presence was checked. Keep keys in process memory and out of argv/output. The reviewed local billing roster permits TypeSafe and OpenRouter; Kimi OpenRouter credits are explicitly authorized for this task.

### Opus

`claude auth status` confirmed the existing Max seat; no seat switch or sign-in occurred. Exact successful probe:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_OPUS_MODEL \
  claude -p --model opus --permission-mode plan --tools '' --max-turns 1 --output-format json \
  'Reply only with READY. This is a subscription availability check; do not use tools.'
```

For an actual review, provide the frozen diff, behavior criteria, and test receipts in the prompt (stdin avoids large argv). Preserve the no-tools mode if the packet is complete; otherwise permit only the required read tools. Record `modelUsage` and result, not just the chosen alias. The CLI's `total_cost_usd`/`costBasis:list` is a token-price estimate and does not establish billed API usage; the verified auth route was Max OAuth. The probe inherited substantial local context (210,412 cache-creation input tokens), so keep later packets and context bounded.

### Jev / TypeSafe System One

Existing implementation anchors:

- `lib/ai/lanes.ts`: route and judge pin `jev-latest`.
- `lib/ai/typesafe.ts:14`: `https://api.typesafe.ai/v1/systemone`; request body near line 214 is `{ state, model, questions }`.
- `lib/ai/jev-types.ts:14`: Choice question has named criteria; answer includes chosen key, probabilities, confidence. `noul` produces a probability, not a literal Boolean.
- `scripts/jev-smoke.ts`: existing intent smoke examples; invokes a `react-server` child and loads `.env.local`. This was inspected, not run, because the availability check needed no application database state.
- Production `systemOne` accepts only registered, builder-minted payloads. Do not weaken that boundary or add a production call site for an audit.

An external audit probe can POST a synthetic packet using `TYPESAFE_API_KEY` in an Authorization header. The successful payload was:

```json
{
  "state": { "probe": "ready", "observed": true },
  "model": "jev-latest",
  "questions": {
    "ready": {
      "type": "choice",
      "instructions": "Does the supplied state report observed true?",
      "criteria": { "yes": "observed is true", "no": "observed is false or absent" }
    }
  }
}
```

For actual binary acceptance, replace synthetic state with the exact annotation, observed test/browser evidence, and relevant source excerpt. Ask for `yes` only when that evidence proves the criterion, and `no` when it fails or lacks proof; store confidence separately. Jev judges supplied evidence and cannot itself supply missing browser observations. A synthetic probe is not a product verification.

### Gemini visual lane

Successful direct subscription invocation from this worktree:

```sh
env -u GEMINI_API_KEY -u GOOGLE_API_KEY agy --model gemini-3.8-flash-low \
  --mode plan --sandbox --disable-slash-commands --print-timeout 45s --output-format json \
  -p 'Availability probe only. Inspect the local PNG docs/audit/2026-09-27-composer/original-composer.png using your image viewing tool. Do not read other files or run commands. Return a concise sentence identifying the number of round action buttons below the composer text field and their icon types. If you cannot inspect the pixels, explicitly say IMAGE_UNAVAILABLE. Do not infer from filenames. Do not edit any files.'
```

AGY warned that `--mode plan` has no effect with slash-command expansion disabled. Treat the sandbox and explicit read-only prompt as the controls used; do not claim plan mode enforced this run. Returned conversation ID: `d7d7d120-e7e4-402f-a182-1132dafd7f97`. Response: three buttons, tray/box and mic left, paper-plane send right. This agrees with direct inspection of the saved PNG.

Use direct AGY for image review. The local `zs-gemini-proxy` is unsuitable: its README lines 86–90 and `src/agy-bridge.ts` explicitly reduce images to `[image]` text. Do not route visual evidence through that proxy.

### Kimi visual lane

Verified live catalog: `https://openrouter.ai/api/v1/models`; exact id `moonshotai/kimi-k3`, input modalities `text`, `image`, `video`, context 1,048,576. The local `kimi-k3` wrapper points at **direct Moonshot** and must not be used as if it were the authorized OpenRouter lane.

Use `POST https://openrouter.ai/api/v1/chat/completions` with `OPENROUTER_API_KEY` read into process memory. Vision message shape:

```json
{
  "model": "moonshotai/kimi-k3",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "Exact acceptance criteria and request for binary outcomes." },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,<encoded local screenshot>" } }
  ] }],
  "max_tokens": 200,
  "reasoning": { "effort": "low" }
}
```

The image probe used only `original-composer.png` and a request to count/icon-label visible buttons. It was rejected HTTP 402 before a visual answer. This packet shape is documented for reuse after funding, not recorded as a working current visual lane.

## Talk-to-talk implementation inventory

The checked source has speech-to-text input, but no implemented coach speech-output mode:

- `components/CoachMic.tsx:66–80` wires on-device/live listeners, fallback recorder and transcription. Its original events at lines 117–140 were hold/release and `aria-label="Hold to talk"`.
- `lib/voice/choose-listener.ts:5–9,48–50` selects live dictation first in an installed PWA; on-device recognition first in a browser; recorder fallback follows.
- `app/api/coach/voice/` contains only `ears/route.ts` and `ears/close/route.ts`.
- `lib/voice/` contains `choose-listener`, `ears-client`, `live-io`, `live-listen`, `pcm`; this PCM path captures microphone audio.
- Source search across `components/`, `app/`, `lib/` found no `speechSynthesis`, `runVoiceTurn`, `coach_turn_begin`, voice TTS route, or Talk sheet implementation.
- `docs/specs/phase-14-voice-agent.md:551–562` specifies slice 1 live dictation; lines 564–594 specify the future voice brain/turn route; lines 596–611 specify TTS, playback, Talk sheet and Speak replies; lines 613–620 specify hands-free/barge-in.

Therefore, a composer interaction fix can validate the existing recognition/live/recorder input paths. It cannot truthfully claim talk-to-talk was fixed or tested without implementing the separate, currently absent output flow. Keep that missing scope explicit.

## Updated coordination

The parent reports explicit user approval to replace credit-blocked Kimi with Gemini plus another available reviewer. The composer will use Gemini and primary Astra against the final rendered evidence. No new purchase or further Kimi attempt is required. Kimi's HTTP 402 is retained as historical lane evidence, not a current blocker.

The parent owns the 15 Foods/Avoids/Shopping annotations and combined final audit. This chat owns voice/composer only and preserves the existing voice architecture; no new speech-output subsystem is part of this implementation.
