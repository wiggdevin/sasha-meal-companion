# 08 — PWA

**Outcome:** proved

## Production checks

- `/manifest.webmanifest`: 200 and valid JSON.
- Manifest identity and launch fields: name `Sasha`, `start_url: /`, `scope: /`, `display: standalone`, portrait orientation.
- Manifest icons: 192 and 512 px, each with `any` and `maskable` purpose; both files returned 200 as PNG.
- `/sw.js`: 200, JavaScript, 3,777 bytes.
- Browser evidence: service workers supported; root-scope registration present; worker active and `activated`; page controlled by the worker.

## Offline shell

Using the production sign-in screen in a clean browser task space, the network was switched offline through browser instrumentation and the page was reloaded. Reload completed without an exception, the title remained `Sasha`, the sign-in shell rendered, and the active service worker still controlled the page. Network was restored before the task space was closed.

No production data or session was created.
