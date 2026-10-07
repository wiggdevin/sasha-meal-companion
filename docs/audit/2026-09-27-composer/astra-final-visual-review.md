# Primary Astra final visual review

Inspected all eight final 390 px screenshots directly with the image viewer: idle, editing, recording, reduced-motion, finishing, send, review and permission-error. These images show the actual rendered Composer and toolbar in the temporary local harness. Image identities: `final-visual-source-hashes.json`.

| Visual check | Outcome | Evidence |
|---|---|---|
| One main control across idle, recording, finishing, Send and Review | YES | Rightmost control stays in one position; microphone, stop square, ellipsis, send and eye icons distinguish states |
| Editing retains a reachable Send action and Record | YES | Editing image shows Send beside the main microphone, without overlap |
| Stop is visibly red and distinct | YES | Recording and reduced-motion images show a red round control with white stop square |
| Text and controls fit the 390 px viewport | YES | All states fit; no composer content clips horizontally |
| Draft and error copy remain legible | YES | Draft reads on the glass panel; the permission line fits beneath it |
| Review and Send are visually distinct | YES | Eye icon for Review, paper-plane icon for Send; accessible labels verified in browser snapshots |

No concrete visual defect found in these states. The eye icon's first-use discoverability has not been tested with users.

The local title, JSON collector beneath the composer, and Next.js development badge are fixture scaffolding, not production composer UI. Ignore those as product defects.

Animation is not established by a still: `rendered-manual-checks.json` separately records the animation advancing while recording (140.2 → 179.9 ms, running), and computed animation name `none` under emulated reduced motion. Layout checks at 320, 430 and 1024 px show no horizontal overflow and a 44 × 44 px main control.

Microphone access was separately verified using a live audio track, then immediately stopped. The transcripts and denied-permission scenario used a synthetic SpeechRecognition transport. Real provider recognition quality, iOS/Android hardware, real IME, and production behavior remain unverified. This review does not approve the parent's 15 Foods annotations or authorize landing.
