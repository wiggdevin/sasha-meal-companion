# Lane N — Capture client (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Every step below is a checkbox; do them in order, one commit per task.

**Goal:** Sasha taps `+`, picks Type / Say / Scan a label / Photograph the plate, and gets a draft she
checks and saves. The sheet moves bytes and renders what the server decided: it never computes a
macro, never overrides a policy verdict, and never writes to `log_entries` without her tap. With no
signal it says so in one line and hands her the Phase 2 search, which works offline.

**Architecture:** Three layers, each testable on its own. (1) **Pure** — `lib/media/resize.ts`
(`targetSize` arithmetic; the canvas re-encode around it drops EXIF), `lib/capture/drafts.ts`
(a draft lives in `localStorage` under `smc:draft:<draftId>` with a 64 KB guard, because propose
persists nothing server-side). (2) **Transport** — `lib/capture-client.ts`: `captureText`,
`captureMedia` (sign → `PUT` → propose), `commitDraft` (Phase 2's `buildCommitRequest` +
`commitLogEntry`, with `method` and `draft_id` set from the draft), the status-table → copy map, and
the small pure helpers the components need (`applyEdits`, `canSave`, `policyCopy`, `spendNote`,
`pickAudioMimeType`, `captureActions`, `captureMetaFrom`). (3) **Surface** — `CaptureSheet` (one
sheet, entry mode chosen by an `initial` prop), `CaptureConfirm` (the draft list: grams `Stepper`,
portion picker, swap-to-alternative, policy pill, Save), `VoiceCapture` (press-and-hold
`MediaRecorder`, 30 s hard stop with a countdown ring drawn with the DESIGN.md gauge geometry),
`PhotoCapture` (`capture="environment"` → `resizeImage` → preview), and a `LoggedExtras` edit that
shows a method glyph and a "check this" hint. Every component is gated by a written phone check;
`@testing-library/react` is not installed and is not added.

**Tech Stack:** Next.js 16.3.4 (App Router, client components), React 19, TypeScript 5 strict,
Tailwind 4 (`app/design-tokens.css` tokens and the `app/globals.css` utilities only), `motion` 13,
`idb` 8, `zod` 4, vitest 5 with `environment: "node"` and `include: ["**/*.test.{ts,tsx}"]`,
`fake-indexeddb` 6, pnpm 11.25.0, Node 22.

**Spec paths:**
- `docs/plans/2026-09-11-phase-3-4/00-contracts.md` (frozen; §1 lane row N, §4 policy, §5 capture wire
  types, §6 flags and env, §9 integration, §10 conventions)
- `docs/specs/phase-4-ai-capture.md` (§5 API and the status table, §6 Client changes, §8 Security,
  §10 acceptance criteria 1, 11, 12, §12 open questions 1 and 3)
- `docs/architecture.md` §3.2, §3.3, §3.6, §3.7, §4.1, §4.2, §4.4, §4.6, §5, §6, §7
- `docs/plans/2026-09-10-phase-0/00-contracts.md` §2–§8 (`SyncOp`, entity keys, §8 conventions) and
  `docs/plans/2026-09-11-phase-1-2/00-contracts.md` §2–§5 (`LogCommitRequest`, `CachedRevision`,
  nutrient codes, §8a)
- `AGENTS.md`, `DESIGN.md`, and the mockup working files
  `~/Desktop/Sasha app/07-design/neuform-mockup/LogMeal.dc.html` (sheet chrome, the four capture
  pills, the row and the serving stepper), `Main.dc.html` (gauge geometry), `MealCard.dc.html`
  (olive pill), `Foods.dc.html` (active pill segment)
- Reference only, MIT, nothing ported here: `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`

**The three pre-lane files are not on this checkout.** `lib/capture/types.ts`, `lib/capture/flags.ts`
and `lib/policy/constraints.ts` are being landed on `main` by another session; this lane creates none
of them and codes against the contract signatures in `00-contracts.md` §4–§6, quoted in each task's
**Interfaces** block.

## Global Constraints

Copied from `docs/plans/2026-09-11-phase-3-4/README.md`, "Global Constraints":

> Phase 0 §8 and Phase 1–2 §8a (TDD, conventional commits, no AI attribution, request-local clients,
> `user_id` from `auth.uid()`, rate-limit → identity → body order, files < 400 lines, `null` ≠ `0`)
> plus: no new npm dependencies beyond the pre-lane `zxing-wasm`; provider and model text is data,
> never instruction; no draft reaches `log_entries` without her tap; the only request-path writer of
> `catalog_*` is `lib/server/catalog-writer.ts`; every prompt is temperature 0 with a per-purpose
> `maxOutputTokens`; gates are measured and reported, never lowered.

Lane N additions, all from contracts §1 and §5:

- **Owned files only.** `components/CaptureSheet.tsx`, `components/CaptureConfirm.tsx`,
  `components/VoiceCapture.tsx`, `components/PhotoCapture.tsx`, `components/LoggedExtras.tsx`,
  `lib/media/resize.ts`, `lib/capture-client.ts`, `lib/capture/drafts.ts`,
  `tests/client/capture-*.test.ts`, `docs/screenshots/phase-4/`. Nothing else is edited on this
  branch — not `lib/log-client.ts`, not `lib/log/contract.ts`, not `components/Stepper.tsx`, not
  `components/Sheet.tsx`, not `app/page.tsx`, not `components/QuickActions.tsx` (those last two are
  the integration stage's, contracts §1 and §9; this plan ends with the exact diff for them).
- **Test-file naming.** Contracts §1 gives this lane `tests/client/capture-*.test.ts`, so the resize
  test is `tests/client/capture-resize.test.ts` and the flag test is
  `tests/client/capture-methods.test.ts`. A file outside that glob would be outside the lane.
- **No new dependency, no new design value.** Styling uses `.shell .surface .pill .pill-in .well
  .btn-ink .ts .tap` and the tokens already in `app/design-tokens.css`. Every tap target ≥ 44 px;
  a disabled action renders with the existing `disabled:opacity-40` / `opacity-50` treatment used by
  `LogFoodSheet` and `Stepper`, never a new colour.
- **Nothing is ported from fud-ai in this lane**, so no `NOTICE.md` row is needed (and `NOTICE.md`
  belongs to lanes K and M). Its "review nutrition unlock" rule is not used: grams here re-scale
  nothing on the client, because the server recomputes every snapshot at commit (spec §8).
- **Copy is Sasha's coach's voice:** short, plain, no exclamation marks (DESIGN.md, Do's).

## File structure

| File | Responsibility |
|---|---|
| `lib/media/resize.ts` | **Create.** `targetSize(w, h, longEdge)` (pure, tested) and `resizeImage(file, { longEdge: 1600, quality: 0.8 })` — `createImageBitmap` → canvas → `toBlob("image/jpeg")`, which drops EXIF by re-encoding. |
| `lib/capture/drafts.ts` | **Create.** `saveDraft` / `loadDraft` / `clearDraft` / `latestDraft` in `localStorage` under `smc:draft:<draftId>`, 64 KB guard, injectable store. |
| `lib/capture-client.ts` | **Create.** `captureText`, `captureMedia`, `commitDraft`, the status → copy map, and the pure helpers the four components render from. |
| `components/CaptureSheet.tsx` | **Create.** One sheet; entry mode from the `initial` prop; runs the capture, shows the spend note, falls back to search when offline. Exports `CaptureGlyph` and `useOnline` for the integration diff. |
| `components/CaptureConfirm.tsx` | **Create.** The draft list: label, grams `Stepper`, portion picker, swap-to-alternative, policy pill, "check this" hint, label-food toggle, Save. |
| `components/VoiceCapture.tsx` | **Create.** Press-and-hold `MediaRecorder`, first supported of `audio/mp4`, `audio/aac`, `audio/webm`, 30 s hard stop with a countdown ring, replay, retry. |
| `components/PhotoCapture.tsx` | **Create.** `<input type="file" accept="image/*" capture="environment">` → `resizeImage` → preview → use or retake. |
| `components/LoggedExtras.tsx` | **Modify.** A capture entry shows its method glyph and, when any item is under 0.6 confidence, a "check this" hint. |
| `tests/client/capture-resize.test.ts` | **Create.** `targetSize` arithmetic. |
| `tests/client/capture-drafts.test.ts` | **Create.** Draft round-trip, 64 KB guard, newest-first recovery. |
| `tests/client/capture-client.test.ts` | **Create.** Fake fetch: sign → upload → propose order, the error map, the commit request shape against `logCommitRequestSchema`. |
| `tests/client/capture-methods.test.ts` | **Create.** `enabledMethods()` drives the actions; audio container pick; policy copy; capture meta. |
| `docs/screenshots/phase-4/README.md` | **Create.** The six phone shots the manual gate produces, and where they go. |

## Before Task 1 — start condition

```bash
cd /Users/zero-suminc./projects/clients/Sasha/meal-companion
git switch -c feat/p4-capture-client
ls lib/capture/types.ts lib/capture/flags.ts lib/policy/constraints.ts
```
All three must list. If any is missing, rebase onto the pre-lane PR first — this lane creates none of
them, and a missing file is an import error, not a task.

---

## Task 1 — `lib/media/resize.ts`: the arithmetic, then the canvas

**Files** — Create: `lib/media/resize.ts`. Test path: `tests/client/capture-resize.test.ts`.

**Interfaces**

Consumes: nothing. Browser globals only (`createImageBitmap`, `document`, `HTMLCanvasElement`).

Produces:
```ts
// lib/media/resize.ts
export type ResizeOptions = { longEdge: number; quality: number };
export const DEFAULT_RESIZE: ResizeOptions;                                   // { longEdge: 1600, quality: 0.8 }
export function targetSize(width: number, height: number, longEdge: number): { width: number; height: number };
export function resizeImage(file: Blob, options?: ResizeOptions): Promise<Blob>;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-resize.test.ts
  import { describe, expect, it } from "vitest";
  import { DEFAULT_RESIZE, targetSize } from "@/lib/media/resize";

  describe("targetSize", () => {
    it("fits a landscape phone photo to the long edge", () => {
      expect(targetSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    });

    it("fits a portrait photo to the same long edge", () => {
      expect(targetSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    });

    it("never enlarges an image already inside the budget", () => {
      expect(targetSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
      expect(targetSize(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
    });

    it("keeps at least one pixel on the short edge of a strip", () => {
      expect(targetSize(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
    });

    it("rounds to whole pixels", () => {
      expect(targetSize(3000, 1999, 1600)).toEqual({ width: 1600, height: 1066 });
    });

    it("answers 1 x 1 for a size it cannot read", () => {
      expect(targetSize(Number.NaN, 100, 1600)).toEqual({ width: 1, height: 1 });
    });

    it("ships the architecture 4.2 defaults", () => {
      expect(DEFAULT_RESIZE).toEqual({ longEdge: 1600, quality: 0.8 });
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url @/lib/media/resize (resolved id: …/lib/media/resize)`.
  ```bash
  pnpm test tests/client/capture-resize.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/media/resize.ts
  /**
   * The client half of the media pipeline — architecture §4.2: 1600 px on the long edge, JPEG q 0.8,
   * EXIF dropped. Nothing strips the metadata explicitly: a canvas re-encode carries none forward,
   * which is why the resize is mandatory before any photo leaves the phone.
   *
   * `targetSize` is the whole of the arithmetic and is unit-tested. `resizeImage` is the DOM around
   * it and is covered by the phone gate in Task 12 — vitest runs with `environment: "node"`, so
   * there is no canvas to exercise here and none is faked.
   */

  export type ResizeOptions = { longEdge: number; quality: number };

  export const DEFAULT_RESIZE: ResizeOptions = { longEdge: 1600, quality: 0.8 };

  /** Fit-inside, never enlarge. A dimension we cannot read collapses to 1 px rather than NaN. */
  export function targetSize(
    width: number,
    height: number,
    longEdge: number,
  ): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(longEdge)) {
      return { width: 1, height: 1 };
    }
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const longest = Math.max(w, h);
    if (longest <= longEdge) return { width: w, height: h };
    const scale = longEdge / longest;
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  /** Re-encodes to JPEG at `quality`. Throws when the browser gives us no 2D context or no blob. */
  export async function resizeImage(file: Blob, options: ResizeOptions = DEFAULT_RESIZE): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
      const size = targetSize(bitmap.width, bitmap.height, options.longEdge);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob === null ? reject(new Error("toBlob returned nothing")) : resolve(blob)),
          "image/jpeg",
          options.quality,
        );
      });
    } finally {
      bitmap.close();
    }
  }
  ```
- [ ] Run it. Expected: PASS, 7 tests.
  ```bash
  pnpm test tests/client/capture-resize.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/media/resize.ts tests/client/capture-resize.test.ts
  git commit -m "feat(capture): resize photos to 1600 px and drop EXIF on re-encode"
  ```

---

## Task 2 — `lib/capture/drafts.ts`: a draft lives on the phone

**Files** — Create: `lib/capture/drafts.ts`. Test path: `tests/client/capture-drafts.test.ts`.

**Interfaces**

Consumes (contracts §5, pre-lane `lib/capture/types.ts`):
```ts
export type DraftItem = {
  seq: number; label: string; foodRefId: string | null; catalogFoodRevisionId: number | null;
  grams: number; qty: number; unit: string; portionId: number | null; confidence: number;
  policy: { verdict: "allowed" | "blocked" | "unverified"; reason?: string };
  alternatives: { foodRefId: string; label: string; score: number }[]; autoResolved: boolean;
};
export type ProposeResponse = {
  draftId: string; method: "text" | "voice" | "label" | "photo"; items: DraftItem[];
  labelFood?: { name: string; brand?: string; per100g: Record<string, number | null>;
                ingredientsText?: string; allergenTags: string[] };
  notes: string[]; spend: { usedToday: number; softCap: number };
};
```

Produces:
```ts
// lib/capture/drafts.ts
export const DRAFT_PREFIX: "smc:draft:";
export const DRAFT_MAX_BYTES: 65536;
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type StoredDraft = { draft: ProposeResponse; savedAt: string };
export function saveDraft(draft: ProposeResponse, store?: DraftStore | null, now?: Date): "ok" | "too_large" | "unavailable";
export function loadDraft(draftId: string, store?: DraftStore | null): ProposeResponse | null;
export function clearDraft(draftId: string, store?: DraftStore | null): void;
export function latestDraft(store?: DraftStore | null): ProposeResponse | null;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-drafts.test.ts
  import { describe, expect, it } from "vitest";
  import { clearDraft, DRAFT_PREFIX, latestDraft, loadDraft, saveDraft, type DraftStore } from "@/lib/capture/drafts";
  import type { ProposeResponse } from "@/lib/capture/types";

  function fakeStore(onSet?: () => void): DraftStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { onSet?.(); map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
  }

  function draft(id: string, note = "two eggs"): ProposeResponse {
    return {
      draftId: id, method: "text", notes: [note], spend: { usedToday: 3, softCap: 30 },
      items: [{
        seq: 1, label: "Egg, whole, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
        catalogFoodRevisionId: 910, grams: 100, qty: 2, unit: "each", portionId: 3,
        confidence: 0.82, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
      }],
    };
  }

  describe("drafts in localStorage", () => {
    it("round-trips a draft under smc:draft:<draftId>", () => {
      const store = fakeStore();
      expect(saveDraft(draft("d1"), store)).toBe("ok");
      expect([...store.map.keys()]).toEqual([`${DRAFT_PREFIX}d1`]);
      expect(loadDraft("d1", store)?.items[0].grams).toBe(100);
    });

    it("answers null for an id it has never held", () => {
      expect(loadDraft("nope", fakeStore())).toBeNull();
    });

    it("answers null rather than throwing on a corrupt value", () => {
      const store = fakeStore();
      store.setItem(`${DRAFT_PREFIX}d1`, "{not json");
      expect(loadDraft("d1", store)).toBeNull();
    });

    it("clears the one key it was given", () => {
      const store = fakeStore();
      saveDraft(draft("d1"), store);
      saveDraft(draft("d2"), store);
      clearDraft("d1", store);
      expect(loadDraft("d1", store)).toBeNull();
      expect(loadDraft("d2", store)).not.toBeNull();
    });

    it("refuses a draft over 64 KB and writes nothing", () => {
      const store = fakeStore();
      const big = draft("d1", "x".repeat(70_000));
      expect(saveDraft(big, store)).toBe("too_large");
      expect(store.map.size).toBe(0);
    });

    it("reports unavailable when the store throws, and does not throw itself", () => {
      const store = fakeStore(() => { throw new Error("QuotaExceededError"); });
      expect(saveDraft(draft("d1"), store)).toBe("unavailable");
    });

    it("recovers the newest draft after a duplicate answer", () => {
      const store = fakeStore();
      saveDraft(draft("older"), store, new Date("2026-09-11T10:00:00.000Z"));
      saveDraft(draft("newer"), store, new Date("2026-09-11T10:04:00.000Z"));
      expect(latestDraft(store)?.draftId).toBe("newer");
    });

    it("has no store to use on the server and says so", () => {
      expect(saveDraft(draft("d1"), null)).toBe("unavailable");
      expect(loadDraft("d1", null)).toBeNull();
      expect(latestDraft(null)).toBeNull();
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url @/lib/capture/drafts (resolved id: …/lib/capture/drafts)`.
  ```bash
  pnpm test tests/client/capture-drafts.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/capture/drafts.ts
  /**
   * Where a draft lives — contracts §5 and architecture §4.2. Propose persists nothing on the
   * server, so the phone is the only copy: `localStorage` under `smc:draft:<draftId>`, one key per
   * draft, cleared on commit or dismiss. IndexedDB is Lane L's file this wave, which is the whole
   * reason this is not in the `smc` database.
   *
   * Pure apart from the store it is handed. Every call takes an injectable store so the sheet can be
   * driven in a test and a private-browsing failure is a return value, never a throw.
   */
  import type { ProposeResponse } from "@/lib/capture/types";

  export const DRAFT_PREFIX = "smc:draft:";
  export const DRAFT_MAX_BYTES = 65_536;

  export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  export type StoredDraft = { draft: ProposeResponse; savedAt: string };

  function defaultStore(): DraftStore | null {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null; // private browsing can throw on the property itself
    }
  }

  export function saveDraft(
    draft: ProposeResponse,
    store: DraftStore | null = defaultStore(),
    now: Date = new Date(),
  ): "ok" | "too_large" | "unavailable" {
    if (store === null) return "unavailable";
    const body = JSON.stringify({ draft, savedAt: now.toISOString() } satisfies StoredDraft);
    if (new TextEncoder().encode(body).length > DRAFT_MAX_BYTES) return "too_large";
    try {
      store.setItem(DRAFT_PREFIX + draft.draftId, body);
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  function read(store: DraftStore, key: string): StoredDraft | null {
    const raw = store.getItem(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredDraft;
      return typeof parsed?.draft?.draftId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  export function loadDraft(draftId: string, store: DraftStore | null = defaultStore()): ProposeResponse | null {
    if (store === null) return null;
    return read(store, DRAFT_PREFIX + draftId)?.draft ?? null;
  }

  export function clearDraft(draftId: string, store: DraftStore | null = defaultStore()): void {
    if (store === null) return;
    try {
      store.removeItem(DRAFT_PREFIX + draftId);
    } catch {
      /* nothing to clear is the same outcome as cleared */
    }
  }

  /** The draft a 409 `duplicate_request` is telling us we already hold. */
  export function latestDraft(store: DraftStore | null = defaultStore()): ProposeResponse | null {
    if (store === null) return null;
    let best: StoredDraft | null = null;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key === null || !key.startsWith(DRAFT_PREFIX)) continue;
      const row = read(store, key);
      if (row !== null && (best === null || row.savedAt > best.savedAt)) best = row;
    }
    return best?.draft ?? null;
  }
  ```
- [ ] Run it. Expected: PASS, 8 tests.
  ```bash
  pnpm test tests/client/capture-drafts.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/capture/drafts.ts tests/client/capture-drafts.test.ts
  git commit -m "feat(capture): keep drafts on the phone under smc:draft with a 64 KB guard"
  ```

---

## Task 3 — `lib/capture-client.ts`: `captureText` and the status table

**Files** — Create: `lib/capture-client.ts`. Test path: `tests/client/capture-client.test.ts`.

**Interfaces**

Consumes: `ProposeRequest`, `ProposeResponse` from `@/lib/capture/types` (contracts §5);
`type SlotId` from `@/lib/types` (`"coffee" | "pouches-pre" | "post-refuel" | "meal-1" | "meal-2" |
"meal-3" | "hot-chocolate"`). The spec §5 status table is the source of the mapping: 401
`unauthorized`, 403 `media_not_owned`, 413 `too_large`, 415 `unsupported_media`, 422 `schema_invalid`,
429 `rate_limited` / `spend_cap`, 409 `duplicate_request`, 503 `provider_unavailable`, and 404 when
the method is off (spec §11).

Produces:
```ts
// lib/capture-client.ts
export const PROPOSE_URL: "/api/log/propose";
export const SIGN_URL: "/api/media/sign";
export const LOW_CONFIDENCE: 0.6;
export type CaptureContext = { localDate: string; tz: string; slot: SlotId; fetchFn?: typeof fetch };
export type CaptureOutcome =
  | { kind: "draft"; draft: ProposeResponse }
  | { kind: "empty"; message: string }
  | { kind: "duplicate"; message: string }
  | { kind: "error"; status: number; message: string };
export function mapCaptureError(status: number, error: string): CaptureOutcome;
export function captureText(text: string, ctx: CaptureContext): Promise<CaptureOutcome>;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-client.test.ts
  import { describe, expect, it, vi } from "vitest";
  import { captureText, mapCaptureError, PROPOSE_URL } from "@/lib/capture-client";
  import type { ProposeResponse } from "@/lib/capture/types";

  const CTX = { localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2" as const };

  const DRAFT: ProposeResponse = {
    draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b10", method: "text", notes: [],
    spend: { usedToday: 4, softCap: 30 },
    items: [{
      seq: 1, label: "Egg, whole, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
      catalogFoodRevisionId: 910, grams: 100, qty: 2, unit: "each", portionId: 3,
      confidence: 0.82, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
    }],
  };

  function jsonFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  }

  describe("captureText", () => {
    it("posts the text propose body and returns the draft", async () => {
      const fetchFn = jsonFetch(200, DRAFT);
      const out = await captureText("  two eggs and rice  ", { ...CTX, fetchFn });
      expect(out).toEqual({ kind: "draft", draft: DRAFT });
      const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(PROPOSE_URL);
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        method: "text", localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2",
        text: "two eggs and rice",
      });
    });

    it("refuses an empty box without spending a call", async () => {
      const fetchFn = jsonFetch(200, DRAFT);
      const out = await captureText("   ", { ...CTX, fetchFn });
      expect(out).toMatchObject({ kind: "error", status: 0 });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("maps a lost connection to the search fallback line", async () => {
      const fetchFn = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      await expect(captureText("rice", { ...CTX, fetchFn })).resolves.toMatchObject({
        kind: "error", status: 0, message: "Capture did not answer. Try search.",
      });
    });
  });

  describe("the spec status table", () => {
    it("says the cap is reached at 429 spend_cap", () => {
      expect(mapCaptureError(429, "spend_cap")).toEqual({
        kind: "error", status: 429, message: "Daily capture limit reached",
      });
    });

    it("points at search when the provider is down", () => {
      expect(mapCaptureError(503, "provider_unavailable")).toEqual({
        kind: "error", status: 503, message: "Capture is resting, try search",
      });
    });

    it("opens the sheet with zero items on 422", () => {
      expect(mapCaptureError(422, "schema_invalid").kind).toBe("empty");
    });

    it("sends a 409 back to the draft she already holds", () => {
      expect(mapCaptureError(409, "duplicate_request").kind).toBe("duplicate");
    });

    it("has its own line for every other row of the table", () => {
      for (const [status, error] of [[401, "unauthorized"], [403, "media_not_owned"],
        [413, "too_large"], [415, "unsupported_media"], [429, "rate_limited"],
        [404, "not_found"]] as const) {
        const out = mapCaptureError(status, error);
        expect(out.kind).toBe("error");
        expect(out.message).not.toBe("Capture did not answer. Try search.");
      }
    });

    it("falls back rather than echoing an error name it does not know", () => {
      expect(mapCaptureError(500, "kaboom")).toEqual({
        kind: "error", status: 500, message: "Capture did not answer. Try search.",
      });
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url @/lib/capture-client (resolved id: …/lib/capture-client)`.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/capture-client.ts
  /**
   * The browser half of Phase 4 capture — contracts §5.
   *
   * Three calls and nothing else: text goes straight to propose; media signs, uploads, then
   * proposes; a checked draft commits through the Phase 2 path, because Phase 4 adds no commit type
   * of its own. The server owns every number and every policy verdict — this file moves bytes and
   * turns the spec's status table into a line Sasha can read. Model text is data: an error body is
   * never echoed back to her, only mapped.
   */
  import type { ProposeRequest, ProposeResponse } from "@/lib/capture/types";
  import type { SlotId } from "@/lib/types";

  export const PROPOSE_URL = "/api/log/propose";
  export const SIGN_URL = "/api/media/sign";

  /** Under this, the confirm sheet and Today both say "check this" (spec §6). */
  export const LOW_CONFIDENCE = 0.6;

  export type CaptureContext = {
    localDate: string; tz: string; slot: SlotId; fetchFn?: typeof fetch;
  };

  export type CaptureOutcome =
    | { kind: "draft"; draft: ProposeResponse }
    | { kind: "empty"; message: string }
    | { kind: "duplicate"; message: string }
    | { kind: "error"; status: number; message: string };

  const FALLBACK = "Capture did not answer. Try search.";

  /** One line per row of the spec §5 status table. `spend_cap` and `provider_unavailable` are the
   *  two the contract fixes word for word. */
  const ERROR_COPY: Record<string, string> = {
    unauthorized: "Sign in again, then try once more.",
    media_not_owned: "That upload is not on this account.",
    too_large: "That file is too big. Try a shorter clip or one photo.",
    unsupported_media: "That file type does not work here.",
    schema_invalid: "Nothing came back to check.",
    rate_limited: "Too many tries. Give it a minute.",
    spend_cap: "Daily capture limit reached",
    provider_unavailable: "Capture is resting, try search",
    duplicate_request: "You just sent this. Here it is again.",
    not_found: "That way of logging is off right now.",
    method_disabled: "That way of logging is off right now.",
  };

  export function mapCaptureError(status: number, error: string): CaptureOutcome {
    if (status === 422) return { kind: "empty", message: ERROR_COPY.schema_invalid };
    if (status === 409) return { kind: "duplicate", message: ERROR_COPY.duplicate_request };
    if (status === 503) return { kind: "error", status, message: ERROR_COPY.provider_unavailable };
    return { kind: "error", status, message: ERROR_COPY[error] ?? FALLBACK };
  }

  async function errorFrom(res: Response): Promise<CaptureOutcome> {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return mapCaptureError(res.status, body.error ?? "");
  }

  async function propose(req: ProposeRequest, fetchFn: typeof fetch): Promise<CaptureOutcome> {
    let res: Response;
    try {
      res = await fetchFn(PROPOSE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req),
      });
    } catch {
      return { kind: "error", status: 0, message: FALLBACK };
    }
    if (!res.ok) return errorFrom(res);
    return { kind: "draft", draft: (await res.json()) as ProposeResponse };
  }

  export async function captureText(text: string, ctx: CaptureContext): Promise<CaptureOutcome> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { kind: "error", status: 0, message: "Type what you ate first." };
    }
    return propose(
      { method: "text", localDate: ctx.localDate, tz: ctx.tz, slot: ctx.slot, text: trimmed },
      ctx.fetchFn ?? fetch,
    );
  }
  ```
- [ ] Run it. Expected: PASS, 9 tests.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/capture-client.ts tests/client/capture-client.test.ts
  git commit -m "feat(capture): captureText and the propose status-to-copy map"
  ```

---

## Task 4 — `captureMedia`: sign, upload, propose, in that order

**Files** — Modify: `lib/capture-client.ts` (append after `captureText`, line ~110). Test path:
`tests/client/capture-client.test.ts` (append a describe block).

**Interfaces**

Consumes (contracts §5):
```ts
export type SignRequest  = { kind: "image" | "audio"; contentType: string; bytes: number };
export type SignResponse = { path: string; uploadUrl: string; expiresInSeconds: 60 };
export type CaptureMethod = "text" | "voice" | "label" | "photo";   // lib/capture/flags.ts
```

Produces:
```ts
export type MediaMethod = Exclude<CaptureMethod, "text">;           // "voice" | "label" | "photo"
export function captureMedia(kind: MediaMethod, blob: Blob, ctx: CaptureContext): Promise<CaptureOutcome>;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-client.test.ts — append
  import { captureMedia, SIGN_URL } from "@/lib/capture-client";

  function sequence(steps: { status: number; body?: unknown }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
        status: step.status,
        headers: step.body === undefined ? undefined : { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  const SIGNED = {
    path: "media/9f1c/clip.m4a",
    uploadUrl: "https://example.supabase.co/storage/v1/object/upload/signed/media/9f1c/clip.m4a",
    expiresInSeconds: 60 as const,
  };

  describe("captureMedia", () => {
    it("signs, PUTs the blob, then proposes with the returned path", async () => {
      const { fetchFn, calls } = sequence([
        { status: 200, body: SIGNED }, { status: 200 }, { status: 200, body: { ...DRAFT, method: "voice" } },
      ]);
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
      const out = await captureMedia("voice", blob, { ...CTX, fetchFn });

      expect(out.kind).toBe("draft");
      expect(calls.map((c) => c.url)).toEqual([SIGN_URL, SIGNED.uploadUrl, PROPOSE_URL]);
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        kind: "audio", contentType: "audio/mp4", bytes: 3,
      });
      expect(calls[1].init.method).toBe("PUT");
      expect(calls[1].init.body).toBe(blob);
      expect((calls[1].init.headers as Record<string, string>)["content-type"]).toBe("audio/mp4");
      expect(JSON.parse(String(calls[2].init.body))).toEqual({
        method: "voice", localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2",
        mediaPath: SIGNED.path,
      });
    });

    it("calls a label photo an image", async () => {
      const { fetchFn, calls } = sequence([
        { status: 200, body: SIGNED }, { status: 200 }, { status: 200, body: { ...DRAFT, method: "label" } },
      ]);
      await captureMedia("label", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn });
      expect(JSON.parse(String(calls[0].init.body)).kind).toBe("image");
    });

    it("stops at a refused signature and never uploads", async () => {
      const { fetchFn, calls } = sequence([{ status: 415, body: { error: "unsupported_media", message: "no" } }]);
      const out = await captureMedia("photo", new Blob(["x"], { type: "image/heic" }), { ...CTX, fetchFn });
      expect(out).toMatchObject({ kind: "error", status: 415 });
      expect(calls).toHaveLength(1);
    });

    it("stops at a failed upload and never proposes", async () => {
      const { fetchFn, calls } = sequence([{ status: 200, body: SIGNED }, { status: 403 }]);
      const out = await captureMedia("photo", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn });
      expect(out).toMatchObject({ kind: "error", status: 403, message: "The upload did not finish. Try again." });
      expect(calls).toHaveLength(2);
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module '/lib/capture-client.ts' does not provide an export named 'captureMedia'`.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/capture-client.ts — after captureText
  import type { CaptureMethod } from "@/lib/capture/flags";
  import type { SignRequest, SignResponse } from "@/lib/capture/types";

  export type MediaMethod = Exclude<CaptureMethod, "text">;

  /** Voice is the only audio of the three; both photo paths are images (contracts §5). */
  const MEDIA_KIND: Record<MediaMethod, SignRequest["kind"]> = {
    voice: "audio", label: "image", photo: "image",
  };

  const UPLOAD_FAILED = "The upload did not finish. Try again.";

  /**
   * Sign, upload, propose. The path in the propose body is the server's own string from
   * `/api/media/sign`; nothing here builds a path, because propose re-checks the first segment
   * against `auth.uid()` and a client-made path would be a capability we are not allowed to hold
   * (architecture §4.2).
   */
  export async function captureMedia(
    kind: MediaMethod,
    blob: Blob,
    ctx: CaptureContext,
  ): Promise<CaptureOutcome> {
    const fetchFn = ctx.fetchFn ?? fetch;
    const signRequest: SignRequest = {
      kind: MEDIA_KIND[kind], contentType: blob.type, bytes: blob.size,
    };

    let signed: SignResponse;
    try {
      const res = await fetchFn(SIGN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(signRequest),
      });
      if (!res.ok) return errorFrom(res);
      signed = (await res.json()) as SignResponse;
    } catch {
      return { kind: "error", status: 0, message: FALLBACK };
    }

    try {
      const put = await fetchFn(signed.uploadUrl, {
        method: "PUT", headers: { "content-type": blob.type }, body: blob,
      });
      if (!put.ok) return { kind: "error", status: put.status, message: UPLOAD_FAILED };
    } catch {
      return { kind: "error", status: 0, message: UPLOAD_FAILED };
    }

    return propose(
      { method: kind, localDate: ctx.localDate, tz: ctx.tz, slot: ctx.slot, mediaPath: signed.path },
      fetchFn,
    );
  }
  ```
- [ ] Run it. Expected: PASS, 13 tests.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/capture-client.ts tests/client/capture-client.test.ts
  git commit -m "feat(capture): captureMedia signs, uploads and proposes in one call"
  ```

---

## Task 5 — edits, `canSave`, and `commitDraft` through the Phase 2 path

**Files** — Modify: `lib/capture-client.ts` (append after `captureMedia`, line ~185). Test path:
`tests/client/capture-client.test.ts` (append a describe block).

**Interfaces**

Consumes:
```ts
// lib/log-client.ts (Phase 1–2 contracts §5) — read-only on this branch
export function buildCommitRequest(args: {
  entryId: string; eatenAt: Date; tz: string; slot: SlotId; note?: string; baseRev?: number;
  items: { id: string; foodRefId: string; revision: CachedRevision; grams: number;
           qty: number; unit: string; portionId?: number | null; wasEdited?: boolean }[];
}): LogCommitRequest;                              // sets method: "search"; we override it
export function commitLogEntry(req: LogCommitRequest, opts?: { fetchImpl?: typeof fetch }):
  Promise<LogCommitResponse | LogCommitFailure | { status: "queued" }>;
// lib/log/contract.ts — LogCommitRequest carries draft_id and save_label_as_food already
// lib/db/catalog-cache.ts — type CachedRevision
```

Produces:
```ts
export type DraftEdit = {
  grams?: number; qty?: number; unit?: string; portionId?: number | null;
  foodRefId?: string; catalogFoodRevisionId?: number | null; label?: string; removed?: boolean;
};
export type DraftEdits = Record<number, DraftEdit>;                // keyed by DraftItem.seq
export type EditedItem = DraftItem & { removed: boolean; wasEdited: boolean };
export function applyEdits(items: DraftItem[], edits: DraftEdits): EditedItem[];
export function keptItems(items: EditedItem[]): EditedItem[];
export function canSave(items: EditedItem[]): boolean;
export type CommitContext = {
  entryId?: string; eatenAt?: Date; tz: string; slot: SlotId; note?: string;
  saveLabelAsFood?: boolean; fetchImpl?: typeof fetch;
};
export function commitDraft(draft: ProposeResponse, edits: DraftEdits, ctx: CommitContext):
  Promise<LogCommitResponse | LogCommitFailure | { status: "queued" }>;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-client.test.ts — append
  import { applyEdits, canSave, commitDraft } from "@/lib/capture-client";
  import { logCommitRequestSchema } from "@/lib/log/contract";

  const REF_A = "11111111-1111-4111-8111-111111111111";
  const REF_B = "22222222-2222-4222-8222-222222222222";

  function twoItemDraft(): ProposeResponse {
    return {
      ...DRAFT, method: "photo",
      items: [
        DRAFT.items[0],
        { seq: 2, label: "White rice", foodRefId: null, catalogFoodRevisionId: null,
          grams: 180, qty: 1, unit: "portion", portionId: null, confidence: 0.41,
          policy: { verdict: "unverified" }, autoResolved: false,
          alternatives: [{ foodRefId: REF_B, label: "Rice, white, long-grain, cooked", score: 0.72 }] },
      ],
    };
  }

  describe("draft edits", () => {
    it("marks an item edited only once its grams move", () => {
      const [first] = applyEdits(DRAFT.items, {});
      expect(first.wasEdited).toBe(false);
      const [edited] = applyEdits(DRAFT.items, { 1: { grams: 120 } });
      expect(edited).toMatchObject({ grams: 120, qty: 120, unit: "g", portionId: null, wasEdited: true });
    });

    it("keeps a picked portion's qty and id", () => {
      const [item] = applyEdits(DRAFT.items, { 1: { grams: 50, qty: 1, unit: "portion", portionId: 3 } });
      expect(item).toMatchObject({ grams: 50, qty: 1, unit: "portion", portionId: 3, wasEdited: true });
    });

    it("drops the verdict and the revision when she swaps to an alternative", () => {
      const items = applyEdits(twoItemDraft().items, { 2: { foodRefId: REF_B, label: "Rice, white" } });
      expect(items[1]).toMatchObject({
        foodRefId: REF_B, label: "Rice, white", catalogFoodRevisionId: null, wasEdited: true,
        policy: { verdict: "unverified" },
      });
    });

    it("will not save while an ungrounded item is still in the list", () => {
      expect(canSave(applyEdits(twoItemDraft().items, {}))).toBe(false);
      expect(canSave(applyEdits(twoItemDraft().items, { 2: { removed: true } }))).toBe(true);
    });

    it("will not save a blocked item, and will once it is removed", () => {
      const blocked: ProposeResponse = { ...DRAFT, items: [
        { ...DRAFT.items[0], policy: { verdict: "blocked", reason: "allergen:gluten" } }] };
      expect(canSave(applyEdits(blocked.items, {}))).toBe(false);
      expect(canSave(applyEdits(blocked.items, { 1: { removed: true } }))).toBe(false); // nothing left
    });
  });

  describe("commitDraft", () => {
    it("sends a valid LogCommitRequest carrying the method and the draft id", async () => {
      let sent: unknown = null;
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
          totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const draft = twoItemDraft();
      const out = await commitDraft(draft, { 1: { grams: 120 }, 2: { removed: true } }, {
        eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2", fetchImpl,
      });

      expect(out).toMatchObject({ status: "ok" });
      const parsed = logCommitRequestSchema.safeParse(sent);
      expect(parsed.success).toBe(true);
      expect(sent).toMatchObject({
        method: "photo", draft_id: draft.draftId, tz: "UTC", slot: "meal-2",
        items: [{ seq: 1, food_ref_id: REF_A, grams: 120, qty: 120, unit: "g",
                  food_revision_id: 910, was_edited: true }],
      });
    });

    it("sets save_label_as_food only for the label method", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
          totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const ctx = { eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2" as const,
        saveLabelAsFood: true, fetchImpl };

      await commitDraft({ ...DRAFT, method: "label" }, {}, ctx);
      await commitDraft({ ...DRAFT, method: "photo" }, {}, ctx);
      expect(bodies[0].save_label_as_food).toBe(true);
      expect(bodies[1].save_label_as_food).toBeUndefined();
    });

    it("refuses to commit an empty list without a network call", async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const out = await commitDraft(DRAFT, { 1: { removed: true } }, {
        tz: "UTC", slot: "meal-2", fetchImpl,
      });
      expect(out).toMatchObject({ status: "invalid" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module '/lib/capture-client.ts' does not provide an export named 'applyEdits'`.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/capture-client.ts — after captureMedia
  import type { CachedRevision } from "@/lib/db/catalog-cache";
  import { buildCommitRequest, commitLogEntry } from "@/lib/log-client";
  import type { LogCommitFailure, LogCommitRequest, LogCommitResponse } from "@/lib/log/contract";
  import type { DraftItem } from "@/lib/capture/types";

  export type DraftEdit = {
    grams?: number; qty?: number; unit?: string; portionId?: number | null;
    foodRefId?: string; catalogFoodRevisionId?: number | null; label?: string; removed?: boolean;
  };
  export type DraftEdits = Record<number, DraftEdit>;
  export type EditedItem = DraftItem & { removed: boolean; wasEdited: boolean };

  /**
   * The sheet holds edits by `seq` and never mutates the draft it was given, so a dismissed sheet
   * leaves the stored draft exactly as the server returned it.
   *
   * Typing grams clears the portion, the same rule the Phase 2 portion view follows: grams is the
   * resolved truth and the two can never disagree. A swap drops the verdict to `unverified` —
   * §4.4 runs server-side after the model, an alternative carries no catalog id to re-ask with, and
   * claiming the old food's verdict for a new food would be a lie in the one place it must not be.
   */
  export function applyEdits(items: DraftItem[], edits: DraftEdits): EditedItem[] {
    return items.map((item) => {
      const edit = edits[item.seq] ?? {};
      const grams = edit.grams ?? item.grams;
      const gramsMoved = grams !== item.grams;
      const swapped = edit.foodRefId !== undefined && edit.foodRefId !== item.foodRefId;
      return {
        ...item,
        label: edit.label ?? item.label,
        foodRefId: edit.foodRefId ?? item.foodRefId,
        catalogFoodRevisionId: swapped ? null : (edit.catalogFoodRevisionId ?? item.catalogFoodRevisionId),
        grams,
        qty: edit.qty ?? (gramsMoved ? grams : item.qty),
        unit: edit.unit ?? (gramsMoved ? "g" : item.unit),
        portionId: edit.portionId !== undefined ? edit.portionId : (gramsMoved ? null : item.portionId),
        policy: swapped ? { verdict: "unverified" as const } : item.policy,
        removed: edit.removed === true,
        wasEdited: gramsMoved || swapped,
      };
    });
  }

  export function keptItems(items: EditedItem[]): EditedItem[] {
    return items.filter((item) => !item.removed);
  }

  /** Spec AC9: a blocked item never leaves this sheet. An ungrounded item has no `food_ref_id` to
   *  commit, so it blocks Save the same way until she swaps or removes it. */
  export function canSave(items: EditedItem[]): boolean {
    const kept = keptItems(items);
    return kept.length > 0
      && kept.every((item) => item.policy.verdict !== "blocked" && item.foodRefId !== null);
  }

  /**
   * `buildCommitRequest` reads exactly one field off `revision` — `revision_id` — and the server
   * recomputes every snapshot from it (spec §8, AC10). A draft item carries
   * `catalogFoodRevisionId` and no cached row, so this is the smallest object that satisfies the
   * call without inventing a number that would then be ignored. A null id commits without a pin and
   * the server resolves the active revision.
   */
  function revisionRef(revisionId: number | null): CachedRevision {
    return {
      revision_id: revisionId as unknown as number,
      catalog_food_id: 0, description: "", brand: null, source: "", version_label: "",
      per_100g: {}, portions: [], cached_at: "",
    };
  }

  export type CommitContext = {
    entryId?: string; eatenAt?: Date; tz: string; slot: SlotId; note?: string;
    saveLabelAsFood?: boolean; fetchImpl?: typeof fetch;
  };

  export async function commitDraft(
    draft: ProposeResponse,
    edits: DraftEdits,
    ctx: CommitContext,
  ): Promise<LogCommitResponse | LogCommitFailure | { status: "queued" }> {
    const kept = keptItems(applyEdits(draft.items, edits));
    if (kept.length === 0 || kept.some((item) => item.foodRefId === null)) {
      return { status: "invalid", issues: [{ path: "items", message: "nothing to save" }] };
    }
    const base = buildCommitRequest({
      entryId: ctx.entryId ?? crypto.randomUUID(),
      eatenAt: ctx.eatenAt ?? new Date(),
      tz: ctx.tz,
      slot: ctx.slot,
      note: ctx.note,
      items: kept.map((item) => ({
        id: crypto.randomUUID(),
        foodRefId: item.foodRefId as string,
        revision: revisionRef(item.catalogFoodRevisionId),
        grams: item.grams, qty: item.qty, unit: item.unit,
        portionId: item.portionId, wasEdited: item.wasEdited,
      })),
    });
    const req: LogCommitRequest = { ...base, method: draft.method, draft_id: draft.draftId };
    if (ctx.saveLabelAsFood === true && draft.method === "label") req.save_label_as_food = true;
    return commitLogEntry(req, { fetchImpl: ctx.fetchImpl });
  }
  ```
- [ ] Run it. Expected: PASS, 21 tests.
  ```bash
  pnpm test tests/client/capture-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/capture-client.ts tests/client/capture-client.test.ts
  git commit -m "feat(capture): commit a checked draft through the Phase 2 log path"
  ```

---

## Task 6 — the four render helpers: actions, audio container, policy copy, entry meta

**Files** — Modify: `lib/capture-client.ts` (append, line ~300). Test path:
`tests/client/capture-methods.test.ts`.

**Interfaces**

Consumes (contracts §6, pre-lane `lib/capture/flags.ts`):
```ts
export type CaptureMethod = "text" | "voice" | "label" | "photo";
export function enabledMethods(env?: Record<string, string | undefined>): CaptureMethod[];
export function isMethodEnabled(m: CaptureMethod, env?: Record<string, string | undefined>): boolean;
```
and `type PolicyVerdict = { verdict: "allowed" | "blocked" | "unverified"; reason?: string }` from
`@/lib/policy/constraints` (contracts §4).

Produces:
```ts
export const AUDIO_MIME_TYPES: readonly ["audio/mp4", "audio/aac", "audio/webm"];
export function pickAudioMimeType(isSupported: (type: string) => boolean): string | null;
export const CAPTURE_LABELS: Record<CaptureMethod, string>;
export type CaptureAction = { method: CaptureMethod; label: string };
export function captureActions(env?: Record<string, string | undefined>): CaptureAction[];
export function policyCopy(policy: PolicyVerdict): string | null;
export function spendNote(spend: { usedToday: number; softCap: number }): string;
export type CaptureMeta = { method: CaptureMethod; lowConfidence: boolean };
export function captureMetaFrom(row: Record<string, unknown> | null | undefined): CaptureMeta | null;
```

- [ ] Write the failing test.
  ```ts
  // tests/client/capture-methods.test.ts
  import { describe, expect, it } from "vitest";
  import {
    AUDIO_MIME_TYPES, captureActions, captureMetaFrom, CAPTURE_LABELS, pickAudioMimeType,
    policyCopy, spendNote,
  } from "@/lib/capture-client";

  describe("which actions the sheet offers", () => {
    it("offers nothing when no method is enabled", () => {
      expect(captureActions({})).toEqual([]);
    });

    it("offers exactly the enabled methods, in flag order", () => {
      expect(captureActions({ CAPTURE_METHODS: "text" })).toEqual([
        { method: "text", label: CAPTURE_LABELS.text },
      ]);
      expect(captureActions({ NEXT_PUBLIC_CAPTURE_METHODS: "photo,text" }).map((a) => a.method))
        .toEqual(["photo", "text"]);
    });

    it("has a line of copy for all four methods", () => {
      expect(Object.keys(CAPTURE_LABELS).sort()).toEqual(["label", "photo", "text", "voice"]);
      for (const label of Object.values(CAPTURE_LABELS)) expect(label).not.toMatch(/!/);
    });
  });

  describe("the audio container", () => {
    it("prefers mp4, then aac, then webm", () => {
      expect(AUDIO_MIME_TYPES).toEqual(["audio/mp4", "audio/aac", "audio/webm"]);
      expect(pickAudioMimeType(() => true)).toBe("audio/mp4");
      expect(pickAudioMimeType((t) => t !== "audio/mp4")).toBe("audio/aac");
      expect(pickAudioMimeType((t) => t === "audio/webm")).toBe("audio/webm");
    });

    it("answers null when the browser records none of them", () => {
      expect(pickAudioMimeType(() => false)).toBeNull();
    });
  });

  describe("policy copy", () => {
    it("says nothing for an allowed item", () => {
      expect(policyCopy({ verdict: "allowed" })).toBeNull();
    });

    it("reads an allergen, an avoid-list hit and a banned category", () => {
      expect(policyCopy({ verdict: "blocked", reason: "allergen:gluten" })).toBe("Has gluten");
      expect(policyCopy({ verdict: "blocked", reason: "avoid_list" })).toBe("On your avoid list");
      expect(policyCopy({ verdict: "blocked", reason: "category:simple_sugars" })).toBe("Simple sugars");
      expect(policyCopy({ verdict: "blocked" })).toBe("Blocked");
    });

    it("calls an unverified item not checked", () => {
      expect(policyCopy({ verdict: "unverified" })).toBe("Not checked");
    });
  });

  describe("the spend note and the Today meta", () => {
    it("reads n of 30 today", () => {
      expect(spendNote({ usedToday: 4, softCap: 30 })).toBe("4 of 30 today");
    });

    it("ignores an entry that was not captured", () => {
      expect(captureMetaFrom({ method: "search", items: [] })).toBeNull();
      expect(captureMetaFrom(undefined)).toBeNull();
    });

    it("reads the method and flags a low-confidence item", () => {
      expect(captureMetaFrom({ method: "voice", items: [{ confidence: 0.9 }, { confidence: 0.41 }] }))
        .toEqual({ method: "voice", lowConfidence: true });
      expect(captureMetaFrom({ method: "voice", items: [{ confidence: 0.9 }] }))
        .toEqual({ method: "voice", lowConfidence: false });
    });

    it("treats a missing confidence as nothing to warn about", () => {
      expect(captureMetaFrom({ method: "text", items: [{ confidence: null }, {}] }))
        .toEqual({ method: "text", lowConfidence: false });
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module '/lib/capture-client.ts' does not provide an export named 'captureActions'`.
  ```bash
  pnpm test tests/client/capture-methods.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/capture-client.ts — after commitDraft
  import { enabledMethods } from "@/lib/capture/flags";
  import type { PolicyVerdict } from "@/lib/policy/constraints";

  /** Safari records `audio/mp4`; the spec's open question 1 is which of these Gemini accepts, and
   *  the canary settles it at integration. Order is preference, first supported wins. */
  export const AUDIO_MIME_TYPES = ["audio/mp4", "audio/aac", "audio/webm"] as const;

  export function pickAudioMimeType(isSupported: (type: string) => boolean): string | null {
    return AUDIO_MIME_TYPES.find((type) => isSupported(type)) ?? null;
  }

  export const CAPTURE_LABELS: Record<CaptureMethod, string> = {
    text: "Type a meal",
    voice: "Say a meal",
    label: "Scan a label",
    photo: "Photograph the plate",
  };

  export type CaptureAction = { method: CaptureMethod; label: string };

  /** The rows Today offers. The flag is the only gate: a method not in it has no action and its
   *  propose branch answers 404 (spec §11). */
  export function captureActions(env?: Record<string, string | undefined>): CaptureAction[] {
    return enabledMethods(env).map((method) => ({ method, label: CAPTURE_LABELS[method] }));
  }

  export function policyCopy(policy: PolicyVerdict): string | null {
    if (policy.verdict === "allowed") return null;
    if (policy.verdict === "unverified") return "Not checked";
    const reason = policy.reason ?? "";
    if (reason.startsWith("allergen:")) return `Has ${reason.slice(9)}`;
    if (reason === "avoid_list") return "On your avoid list";
    if (reason.startsWith("category:")) {
      const category = reason.slice(9).replace(/_/g, " ");
      return category.charAt(0).toUpperCase() + category.slice(1);
    }
    return "Blocked";
  }

  export function spendNote(spend: { usedToday: number; softCap: number }): string {
    return `${spend.usedToday} of ${spend.softCap} today`;
  }

  export type CaptureMeta = { method: CaptureMethod; lowConfidence: boolean };

  const CAPTURE_METHOD_SET = new Set<string>(["text", "voice", "label", "photo"]);

  /**
   * What Today needs off a synced `log_entries` row: the method glyph, and whether any item came
   * back under 0.6. The row is `_sync_current`'s shape — the entry with `items[]` inline — and the
   * legacy `LoggedFood` type carries neither field, which is why this reads the row and not the
   * view model. A row with no `confidence` is not a low-confidence row: `null` is not `0`.
   */
  export function captureMetaFrom(row: Record<string, unknown> | null | undefined): CaptureMeta | null {
    const method = typeof row?.method === "string" ? row.method : "";
    if (!CAPTURE_METHOD_SET.has(method)) return null;
    const items = Array.isArray(row?.items) ? (row.items as Record<string, unknown>[]) : [];
    const lowConfidence = items.some(
      (item) => typeof item.confidence === "number" && item.confidence < LOW_CONFIDENCE,
    );
    return { method: method as CaptureMethod, lowConfidence };
  }
  ```
- [ ] Run it. Expected: PASS, 12 tests.
  ```bash
  pnpm test tests/client/capture-methods.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/capture-client.ts tests/client/capture-methods.test.ts
  git commit -m "feat(capture): flag-driven actions, audio container pick and policy copy"
  ```

---

## Task 7 — `components/CaptureConfirm.tsx`: the draft she checks

**Files** — Create: `components/CaptureConfirm.tsx`. Test path: no unit test (no
`@testing-library/react`); its logic is Task 5's `applyEdits` / `canSave` / `policyCopy`, and the
screen is gated by Task 12 step 3 **[manual gate]**.

**Interfaces**

Consumes: `Sheet`, `Pill` from `@/components/Sheet`; `Stepper` from `@/components/Stepper`;
`applyEdits`, `canSave`, `keptItems`, `policyCopy`, `spendNote`, `LOW_CONFIDENCE`, `type DraftEdits`,
`type EditedItem` from `@/lib/capture-client`; `getRevision`, `type CachedPortion` from
`@/lib/db/catalog-cache`; `gramsForPortion` from `@/lib/log/grams`; `type ProposeResponse` from
`@/lib/capture/types`.

Produces:
```ts
export default function CaptureConfirm(props: {
  draft: ProposeResponse;
  saving: boolean;
  message?: string | null;
  onSave: (edits: DraftEdits, saveLabelAsFood: boolean) => void;
  onDismiss: () => void;
}): React.JSX.Element;
```

- [ ] Write the component.
  ```tsx
  // components/CaptureConfirm.tsx
  "use client";

  import { useEffect, useRef, useState } from "react";
  import Sheet, { Pill } from "@/components/Sheet";
  import Stepper from "@/components/Stepper";
  import {
    applyEdits, canSave, keptItems, LOW_CONFIDENCE, policyCopy, spendNote,
    type DraftEdits, type EditedItem,
  } from "@/lib/capture-client";
  import { getRevision, type CachedPortion } from "@/lib/db/catalog-cache";
  import { gramsForPortion } from "@/lib/log/grams";
  import type { ProposeResponse } from "@/lib/capture/types";

  /* Row recipe copied from LogMeal.dc.html (.row, 16 px radius). */
  const ROW: React.CSSProperties = {
    borderRadius: 16,
    background: "linear-gradient(180deg, #ffffff 0%, #fcfcfc 100%)",
    boxShadow:
      "0 2px 3px -1px rgba(0,0,0,0.10), 0 1px 0 0 rgba(25,28,33,0.02), 0 0 0 1px rgba(25,28,33,0.08)",
  };

  const INK_BUTTON: React.CSSProperties = {
    height: 52, fontSize: 15, fontWeight: 400,
    boxShadow:
      "inset 0 1px 1px rgba(255,255,255,0.15), 0 2px 3px -1px rgba(0,0,0,0.1), 0 0 0 1px rgba(25,28,33,0.08)",
  };

  /**
   * A verdict reads as a dot plus graphite text, never as coloured text: amber `#FBC336` at 12 px on
   * white is under 4.5:1, and DESIGN.md's contrast floor outranks the wish for a coloured word.
   */
  function PolicyPill({ item }: { item: EditedItem }) {
    const copy = policyCopy(item.policy);
    if (copy === null) return null;
    const colour = item.policy.verdict === "blocked" ? "#FF3B4E" : "#FBC336";
    return (
      <span className="pill inline-flex shrink-0">
        <span className="pill-in flex h-8 items-center gap-1.5 px-3">
          <span style={{ width: 6, height: 6, borderRadius: 9999, background: colour }} />
          <span className="ts" style={{ fontSize: 11, fontWeight: 400, color: "#4A4A4A" }}>{copy}</span>
        </span>
      </span>
    );
  }

  function Alternatives({
    item, onPick,
  }: { item: EditedItem; onPick: (foodRefId: string, label: string) => void }) {
    if (item.alternatives.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {item.alternatives.slice(0, 3).map((alt) => (
          <Pill key={alt.foodRefId} onClick={() => onPick(alt.foodRefId, alt.label)}>
            {alt.label}
          </Pill>
        ))}
      </div>
    );
  }

  function Portions({
    portions, item, onPick,
  }: {
    portions: CachedPortion[];
    item: EditedItem;
    onPick: (portion: CachedPortion) => void;
  }) {
    if (portions.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {portions.map((portion) => (
          <Pill key={portion.id} active={item.portionId === portion.id} onClick={() => onPick(portion)}>
            {portion.description} · {portion.gramWeight} g
          </Pill>
        ))}
      </div>
    );
  }

  function ItemRow({
    item, portions, firstRef, onGrams, onPortion, onSwap, onRemove,
  }: {
    item: EditedItem;
    portions: CachedPortion[];
    firstRef?: React.RefObject<HTMLDivElement | null>;
    onGrams: (grams: number) => void;
    onPortion: (portion: CachedPortion) => void;
    onSwap: (foodRefId: string, label: string) => void;
    onRemove: () => void;
  }) {
    return (
      <div style={ROW} className="flex flex-col gap-3 px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="ts truncate" style={{ fontSize: 14, fontWeight: 400 }}>{item.label}</span>
            {item.foodRefId === null && (
              <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
                Pick one of these, or remove it
              </span>
            )}
            {item.confidence < LOW_CONFIDENCE && (
              <span style={{ fontSize: 12, fontWeight: 300, color: "#4A4A4A" }}>check this</span>
            )}
          </div>
          <PolicyPill item={item} />
        </div>

        <div ref={firstRef}>
          <Stepper label="Grams" value={item.grams} step={5} unit="g"
            onChange={(next) => onGrams(Math.max(0, next))} />
        </div>

        <Portions portions={portions} item={item} onPick={onPortion} />
        <Alternatives item={item} onPick={onSwap} />

        <button type="button" onClick={onRemove}
          className="tap self-start px-1 text-left"
          style={{ fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
          Remove
        </button>
      </div>
    );
  }

  /**
   * The draft list — spec §6. Everything on screen came from the server: grams, verdict,
   * confidence, alternatives. She nudges grams, picks a portion, swaps a food or removes a line.
   * A blocked line holds Save down until it is gone (AC9); the Phase 2 search path is where she
   * logs one deliberately.
   */
  export default function CaptureConfirm({
    draft, saving, message, onSave, onDismiss,
  }: {
    draft: ProposeResponse;
    saving: boolean;
    message?: string | null;
    onSave: (edits: DraftEdits, saveLabelAsFood: boolean) => void;
    onDismiss: () => void;
  }) {
    const [edits, setEdits] = useState<DraftEdits>({});
    const [saveLabel, setSaveLabel] = useState(draft.method === "label");
    const [portions, setPortions] = useState<Record<number, CachedPortion[]>>({});
    const firstGrams = useRef<HTMLDivElement | null>(null);

    // Portions come from the Phase 2 revision cache when she has touched the food before; a miss
    // simply means no portion pills, and grams still work.
    useEffect(() => {
      let live = true;
      void (async () => {
        const found: Record<number, CachedPortion[]> = {};
        for (const item of draft.items) {
          if (item.catalogFoodRevisionId === null) continue;
          const revision = await getRevision(item.catalogFoodRevisionId).catch(() => undefined);
          if (revision && revision.portions.length > 0) found[item.seq] = revision.portions;
        }
        if (live) setPortions(found);
      })();
      return () => { live = false; };
    }, [draft]);

    // README decision 4: a plate photo opens with the first grams stepper focused, and `was_edited`
    // stays false until she actually moves it. Stepper is not this lane's file, so the focus is
    // taken on its first button through the wrapper.
    useEffect(() => {
      if (draft.method !== "photo") return;
      firstGrams.current?.querySelector("button")?.focus();
    }, [draft.method]);

    const items = applyEdits(draft.items, edits);
    const kept = keptItems(items);
    const ready = canSave(items) && !saving;

    function edit(seq: number, patch: Record<string, unknown>) {
      setEdits((current) => ({ ...current, [seq]: { ...current[seq], ...patch } }));
    }

    return (
      <Sheet
        title="Check this"
        subtitle={spendNote(draft.spend)}
        onClose={onDismiss}
        footer={
          <div className="flex flex-col gap-2">
            <button type="button" disabled={!ready} onClick={() => onSave(edits, saveLabel)}
              className="btn-ink tap w-full disabled:opacity-40" style={INK_BUTTON}>
              {saving ? "Saving" : `Save ${kept.length} item${kept.length === 1 ? "" : "s"}`}
            </button>
            {message && (
              <p role="status" className="px-1.5" style={{ fontSize: 12, fontWeight: 300, color: "#4A4A4A" }}>
                {message}
              </p>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-3 px-1">
          {draft.notes.map((note) => (
            <p key={note} style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>{note}</p>
          ))}

          {items.length === 0 && (
            <p style={{ fontSize: 14, fontWeight: 300, color: "#4A4A4A" }}>
              Nothing came back to check. Search your foods instead.
            </p>
          )}

          {items.filter((item) => !item.removed).map((item, index) => (
            <ItemRow
              key={item.seq}
              item={item}
              portions={portions[item.seq] ?? []}
              firstRef={index === 0 ? firstGrams : undefined}
              onGrams={(grams) => edit(item.seq, { grams })}
              onPortion={(portion) => edit(item.seq, {
                grams: gramsForPortion(portion, 1), qty: 1, unit: "portion", portionId: portion.id,
              })}
              onSwap={(foodRefId, label) => edit(item.seq, { foodRefId, label })}
              onRemove={() => edit(item.seq, { removed: true })}
            />
          ))}

          {draft.method === "label" && draft.labelFood && (
            <div style={ROW} className="flex flex-col gap-2 px-3.5 py-3">
              <span className="ts" style={{ fontSize: 14, fontWeight: 400 }}>{draft.labelFood.name}</span>
              {draft.labelFood.brand && (
                <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>{draft.labelFood.brand}</span>
              )}
              {draft.labelFood.ingredientsText && (
                <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
                  {draft.labelFood.ingredientsText}
                </span>
              )}
              <button type="button" onClick={() => setSaveLabel((on) => !on)} aria-pressed={saveLabel}
                className="tap self-start px-1" style={{ fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
                {saveLabel ? "Saving as my food" : "Save as my food"}
              </button>
            </div>
          )}
        </div>
      </Sheet>
    );
  }
  ```
- [ ] Check the file budget and the types.
  ```bash
  wc -l components/CaptureConfirm.tsx && pnpm exec tsc --noEmit
  ```
  Expected: under 400 lines, no type error.
- [ ] Commit.
  ```bash
  git add components/CaptureConfirm.tsx
  git commit -m "feat(capture): confirm sheet with grams, portions, swaps and policy pills"
  ```

---

## Task 8 — `components/VoiceCapture.tsx`: press and hold, 30 s hard stop

**Files** — Create: `components/VoiceCapture.tsx`. Test path: none (DOM media API); gated by Task 12
step 4 **[manual gate]**. Its one pure decision, the container pick, is tested in Task 6.

**Interfaces**

Consumes: `pickAudioMimeType` from `@/lib/capture-client`; `arc`, `ticks`, `tracer` from
`@/lib/gauge` (`arc(r, pct) → { circumference, dashoffset }`, `ticks(cx, cy, rIn, rOut, n)`,
`tracer(cx, cy, r, pct)`).

Produces:
```ts
export default function VoiceCapture(props: {
  onReady: (clip: Blob) => void;                 // clip.type is the chosen container
  busy?: boolean;
}): React.JSX.Element;
```

- [ ] Write the component.
  ```tsx
  // components/VoiceCapture.tsx
  "use client";

  import { useCallback, useEffect, useRef, useState } from "react";
  import { arc, ticks, tracer } from "@/lib/gauge";
  import { pickAudioMimeType } from "@/lib/capture-client";

  const MAX_SECONDS = 30;
  const TICK_MS = 100;

  /* Mini-gauge geometry from MacroRings (Main.dc.html): 100 px box, 40 px arc radius, 6 px stroke,
     30 ticks between r 44 and r 49, dashed guide at r 30. The arc is charcoal, not a gauge colour —
     DESIGN.md binds orange, blue, olive and gold to the four macros and nothing else. */
  const SIZE = 100;
  const ARC_R = 40;
  const STROKE = 6;

  function CountdownRing({ elapsed }: { elapsed: number }) {
    const centre = SIZE / 2;
    const pct = Math.min(1, elapsed / MAX_SECONDS);
    const { circumference, dashoffset } = arc(ARC_R, pct);
    const dot = tracer(centre, centre, ARC_R, pct);
    return (
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true"
          className="absolute inset-0 overflow-visible">
          {ticks(centre, centre, 44, 49, 30).map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              stroke="rgba(0,0,0,0.10)" strokeWidth={2} strokeLinecap="round" />
          ))}
          <circle cx={centre} cy={centre} r={30} fill="none" stroke="rgba(0,0,0,0.12)"
            strokeWidth={1.5} strokeDasharray="3 6" />
          <circle cx={centre} cy={centre} r={ARC_R} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth={STROKE} />
          <circle cx={centre} cy={centre} r={ARC_R} fill="none" stroke="#2B2B2B" strokeWidth={STROKE}
            strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashoffset}
            transform={`rotate(-90 ${centre} ${centre})`} />
          <circle cx={dot.x} cy={dot.y} r={4} fill="#2B2B2B" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="ts tabular-nums" style={{ fontSize: 22, fontWeight: 300, color: "#2B2B2B" }}>
            {Math.max(0, Math.ceil(MAX_SECONDS - elapsed))}
          </span>
        </div>
      </div>
    );
  }

  /**
   * Press and hold to record — spec §6. Thirty seconds is a hard stop, not a hint: the server
   * refuses a longer clip (415) and the countdown is the only warning she gets. Release, a pointer
   * cancel and the timer all land on the same `stop`, so a finger sliding off the button ends the
   * clip rather than leaving the microphone open.
   */
  export default function VoiceCapture({ onReady, busy = false }: {
    onReady: (clip: Blob) => void;
    busy?: boolean;
  }) {
    const [phase, setPhase] = useState<"idle" | "recording" | "ready" | "unsupported">("idle");
    const [elapsed, setElapsed] = useState(0);
    const [clipUrl, setClipUrl] = useState<string | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const clip = useRef<Blob | null>(null);
    const timer = useRef<number | null>(null);

    const stop = useCallback(() => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      if (recorder.current?.state === "recording") recorder.current.stop();
    }, []);

    useEffect(() => () => {
      stop();
      if (clipUrl !== null) URL.revokeObjectURL(clipUrl);
    }, [stop, clipUrl]);

    async function start() {
      if (busy || phase === "recording") return;
      const mimeType = pickAudioMimeType(
        (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
      );
      if (mimeType === null) { setPhase("unsupported"); return; }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setPhase("unsupported");
        return;
      }

      const chunks: Blob[] = [];
      const media = new MediaRecorder(stream, { mimeType });
      media.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      media.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunks, { type: mimeType });
        clip.current = blob;
        setClipUrl((old) => { if (old !== null) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        setPhase("ready");
      };
      recorder.current = media;
      clip.current = null;
      setElapsed(0);
      setPhase("recording");
      media.start();

      const startedAt = Date.now();
      timer.current = window.setInterval(() => {
        const seconds = (Date.now() - startedAt) / 1000;
        setElapsed(seconds);
        if (seconds >= MAX_SECONDS) stop();
      }, TICK_MS);
    }

    if (phase === "unsupported") {
      return (
        <p style={{ fontSize: 14, fontWeight: 300, color: "#4A4A4A" }}>
          This phone will not record here. Type it instead, or use search.
        </p>
      );
    }

    return (
      <div className="flex flex-col items-center gap-4">
        {phase === "recording" && <CountdownRing elapsed={elapsed} />}

        {phase !== "ready" && (
          <button
            type="button"
            onPointerDown={() => { void start(); }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onPointerLeave={stop}
            disabled={busy}
            aria-label="Hold to record"
            className="tap flex items-center justify-center rounded-full text-white disabled:opacity-40"
            style={{
              width: 88, height: 88, touchAction: "none",
              background: "linear-gradient(180deg, #2A2A2A 0%, #111111 100%)",
              border: "1px solid rgba(0,0,0,0.2)",
              boxShadow: "inset 0 1px 1px rgba(255,255,255,0.15), 0 6px 12px -4px rgba(0,0,0,0.35)",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>
        )}

        <p style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
          {phase === "recording" ? "Listening. Let go when you are done." : "Hold the button and say what you ate."}
        </p>

        {phase === "ready" && clipUrl !== null && (
          <div className="flex w-full flex-col items-center gap-3">
            <audio controls src={clipUrl} className="w-full" />
            <button type="button" disabled={busy}
              onClick={() => { if (clip.current !== null) onReady(clip.current); }}
              className="btn-ink tap w-full disabled:opacity-40"
              style={{ height: 52, fontSize: 15, fontWeight: 400 }}>
              Use this clip
            </button>
            <button type="button" onClick={() => { setPhase("idle"); setElapsed(0); }}
              className="tap px-1" style={{ fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
              Record again
            </button>
          </div>
        )}
      </div>
    );
  }
  ```
- [ ] Type-check.
  ```bash
  pnpm exec tsc --noEmit
  ```
- [ ] Commit.
  ```bash
  git add components/VoiceCapture.tsx
  git commit -m "feat(capture): press-and-hold voice capture with a 30 s countdown ring"
  ```

---

## Task 9 — `components/PhotoCapture.tsx`: camera, resize, preview

**Files** — Create: `components/PhotoCapture.tsx`. Test path: none; gated by Task 12 steps 5 and 6
**[manual gate]**. The arithmetic it depends on is Task 1's.

**Interfaces**

Consumes: `resizeImage` from `@/lib/media/resize`.

Produces:
```ts
export default function PhotoCapture(props: {
  label: string;                                  // "Scan the label" or "Photograph the plate"
  onReady: (photo: Blob) => void;                 // an image/jpeg blob, 1600 px long edge, no EXIF
  busy?: boolean;
}): React.JSX.Element;
```

- [ ] Write the component.
  ```tsx
  // components/PhotoCapture.tsx
  "use client";

  import { useEffect, useRef, useState } from "react";
  import { resizeImage } from "@/lib/media/resize";

  /**
   * The camera half of the label and plate methods — spec §6. `capture="environment"` opens the back
   * camera straight from the file input, so there is no live preview to build and no permission
   * prompt until she taps. Every photo is re-encoded before it leaves the phone: that is the resize
   * and the EXIF strip in one step (architecture §4.2).
   */
  export default function PhotoCapture({ label, onReady, busy = false }: {
    label: string;
    onReady: (photo: Blob) => void;
    busy?: boolean;
  }) {
    const input = useRef<HTMLInputElement | null>(null);
    const [shot, setShot] = useState<Blob | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [working, setWorking] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => () => { if (preview !== null) URL.revokeObjectURL(preview); }, [preview]);

    async function take(file: File) {
      setWorking(true);
      setFailed(false);
      try {
        const resized = await resizeImage(file);
        setShot(resized);
        setPreview((old) => { if (old !== null) URL.revokeObjectURL(old); return URL.createObjectURL(resized); });
      } catch {
        setFailed(true);
      } finally {
        setWorking(false);
      }
    }

    return (
      <div className="flex flex-col items-center gap-3">
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";            // picking the same file twice must still fire
            if (file) void take(file);
          }}
        />

        {preview !== null && (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: URL has no loader
          <img src={preview} alt="" className="w-full rounded-[16px]" style={{ maxHeight: 240, objectFit: "cover" }} />
        )}

        {shot === null ? (
          <button type="button" disabled={busy || working} onClick={() => input.current?.click()}
            className="btn-ink tap w-full disabled:opacity-40"
            style={{ height: 52, fontSize: 15, fontWeight: 400 }}>
            {working ? "Getting it ready" : label}
          </button>
        ) : (
          <div className="flex w-full flex-col items-center gap-2">
            <button type="button" disabled={busy} onClick={() => onReady(shot)}
              className="btn-ink tap w-full disabled:opacity-40"
              style={{ height: 52, fontSize: 15, fontWeight: 400 }}>
              Use this photo
            </button>
            <button type="button" onClick={() => { setShot(null); input.current?.click(); }}
              className="tap px-1" style={{ fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
              Take another
            </button>
          </div>
        )}

        {failed && (
          <p role="status" style={{ fontSize: 12, fontWeight: 300, color: "#4A4A4A" }}>
            That photo would not open. Try again.
          </p>
        )}
      </div>
    );
  }
  ```
- [ ] Type-check and lint the new file.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/PhotoCapture.tsx
  git commit -m "feat(capture): photo capture with a back-camera input and a resized preview"
  ```

---

## Task 10 — `components/CaptureSheet.tsx`: one sheet, four ways in

**Files** — Create: `components/CaptureSheet.tsx`. Test path: none; gated by Task 12 steps 2–7
**[manual gate]**.

**Interfaces**

Consumes: `Sheet` from `@/components/Sheet`; `CaptureConfirm`, `VoiceCapture`, `PhotoCapture`;
`captureText`, `captureMedia`, `commitDraft`, `CAPTURE_LABELS`, `type CaptureOutcome`,
`type DraftEdits` from `@/lib/capture-client`; `saveDraft`, `clearDraft`, `latestDraft` from
`@/lib/capture/drafts`; `type CaptureMethod` from `@/lib/capture/flags`; `type ProposeResponse` from
`@/lib/capture/types`; `type SlotId` from `@/lib/types`.

Produces:
```ts
export function useOnline(): boolean;                                    // for the QuickActions diff
export function CaptureGlyph(props: { method: CaptureMethod; size?: number }): React.JSX.Element;
export default function CaptureSheet(props: {
  initial: CaptureMethod;
  slot: SlotId;
  onOpenSearch: () => void;
  onSaved: () => void;
  onClose: () => void;
}): React.JSX.Element;
```

- [ ] Write the component.
  ```tsx
  // components/CaptureSheet.tsx
  "use client";

  import { useEffect, useState } from "react";
  import CaptureConfirm from "@/components/CaptureConfirm";
  import PhotoCapture from "@/components/PhotoCapture";
  import Sheet from "@/components/Sheet";
  import VoiceCapture from "@/components/VoiceCapture";
  import {
    captureMedia, captureText, CAPTURE_LABELS, commitDraft,
    type CaptureOutcome, type DraftEdits,
  } from "@/lib/capture-client";
  import { clearDraft, latestDraft, saveDraft } from "@/lib/capture/drafts";
  import type { CaptureMethod } from "@/lib/capture/flags";
  import type { ProposeResponse } from "@/lib/capture/types";
  import type { SlotId } from "@/lib/types";

  /* Method glyphs: 1.5 px linear SVG, copied from LogMeal.dc.html's four capture pills.
     DESIGN.md Iconography — never emoji. */
  const GLYPH_PATHS: Record<CaptureMethod, React.ReactNode> = {
    text: (<><path d="M4 7h16" /><path d="M4 12h10" /><path d="M4 17h7" /></>),
    voice: (<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>),
    label: (<><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M8 9v6" /><path d="M12 9v6" /><path d="M16 9v6" /></>),
    photo: (<><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="12.5" r="3.5" /></>),
  };

  export function CaptureGlyph({ method, size = 18 }: { method: CaptureMethod; size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {GLYPH_PATHS[method]}
      </svg>
    );
  }

  /** Capture is the one online-only surface in the app (spec §6), so everything that offers it needs
   *  the same answer to one question. Read in an effect, never during render. */
  export function useOnline(): boolean {
    const [online, setOnline] = useState(true);
    useEffect(() => {
      const read = () => setOnline(navigator.onLine);
      read();
      window.addEventListener("online", read);
      window.addEventListener("offline", read);
      return () => {
        window.removeEventListener("online", read);
        window.removeEventListener("offline", read);
      };
    }, []);
    return online;
  }

  const SUBTITLE: Record<CaptureMethod, string> = {
    text: "Say what was on the plate, in your words.",
    voice: "Hold the button and say what you ate.",
    label: "Photograph the nutrition panel.",
    photo: "One photo of the whole plate.",
  };

  /**
   * The one capture sheet — architecture §4.2. The mode never changes once it is open: she chose it
   * on Today, and swapping mid-flow would throw away a clip she just recorded. Offline it does not
   * pretend: one line and a way into the Phase 2 search, which logs with no signal.
   */
  export default function CaptureSheet({ initial, slot, onOpenSearch, onSaved, onClose }: {
    initial: CaptureMethod;
    slot: SlotId;
    onOpenSearch: () => void;
    onSaved: () => void;
    onClose: () => void;
  }) {
    const online = useOnline();
    const [text, setText] = useState("");
    const [draft, setDraft] = useState<ProposeResponse | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);

    // Capture is always "now", whatever day the Today screen is showing: the commit's eaten_at is
    // this instant, and local_date must agree with it in this zone (lib/log/contract.ts).
    const [when] = useState(() => ({
      localDate: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date()),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));

    function settle(outcome: CaptureOutcome) {
      if (outcome.kind === "draft") {
        saveDraft(outcome.draft);
        setDraft(outcome.draft);
        setMessage(null);
        return;
      }
      if (outcome.kind === "duplicate") {
        const held = latestDraft();
        if (held !== null) { setDraft(held); setMessage(outcome.message); return; }
      }
      if (outcome.kind === "empty") {
        setDraft({ draftId: crypto.randomUUID(), method: initial, items: [], notes: [],
          spend: { usedToday: 0, softCap: 0 } });
      }
      setMessage(outcome.message);
    }

    async function run(work: Promise<CaptureOutcome>) {
      setBusy(true);
      try { settle(await work); } finally { setBusy(false); }
    }

    async function save(edits: DraftEdits, saveLabelAsFood: boolean) {
      if (draft === null) return;
      setSaving(true);
      const result = await commitDraft(draft, edits, { tz: when.tz, slot, saveLabelAsFood });
      setSaving(false);
      if (result.status === "ok" || result.status === "queued") {
        clearDraft(draft.draftId);
        onSaved();
        return;
      }
      setMessage(
        result.status === "stale_revision"
          ? "That food was updated. Log it from search."
          : "That did not save. Try again.",
      );
    }

    if (draft !== null) {
      return (
        <CaptureConfirm draft={draft} saving={saving} message={message} onSave={save}
          onDismiss={() => { clearDraft(draft.draftId); onClose(); }} />
      );
    }

    return (
      <Sheet title={CAPTURE_LABELS[initial]} subtitle={SUBTITLE[initial]} onClose={onClose}>
        <div className="flex flex-col gap-4 px-1">
          {!online ? (
            <div className="flex flex-col gap-3">
              <p style={{ fontSize: 14, fontWeight: 300, color: "#4A4A4A" }}>
                Capture needs a connection. Search still works.
              </p>
              <button type="button" onClick={onOpenSearch} className="btn-ink tap w-full"
                style={{ height: 52, fontSize: 15, fontWeight: 400 }}>
                Search your foods
              </button>
            </div>
          ) : initial === "text" ? (
            <>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={3}
                aria-label="What you ate"
                placeholder="two eggs, half an avocado, a bowl of white rice"
                className="well tap w-full px-4 py-3 outline-none"
                style={{ fontSize: 16, fontWeight: 300, color: "#2B2B2B", minHeight: 96 }}
              />
              <button type="button" disabled={busy || text.trim().length === 0}
                onClick={() => { void run(captureText(text, { ...when, slot })); }}
                className="btn-ink tap w-full disabled:opacity-40"
                style={{ height: 52, fontSize: 15, fontWeight: 400 }}>
                {busy ? "Reading it" : "Check it"}
              </button>
            </>
          ) : initial === "voice" ? (
            <VoiceCapture busy={busy} onReady={(clip) => { void run(captureMedia("voice", clip, { ...when, slot })); }} />
          ) : (
            <PhotoCapture
              busy={busy}
              label={initial === "label" ? "Scan the label" : "Photograph the plate"}
              onReady={(photo) => { void run(captureMedia(initial, photo, { ...when, slot })); }}
            />
          )}

          {message !== null && (
            <p role="status" style={{ fontSize: 12, fontWeight: 300, color: "#4A4A4A" }}>{message}</p>
          )}
        </div>
      </Sheet>
    );
  }
  ```
- [ ] Check the budget and the types.
  ```bash
  wc -l components/CaptureSheet.tsx && pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/CaptureSheet.tsx
  git commit -m "feat(capture): one capture sheet for text, voice, label and photo"
  ```

---

## Task 11 — `components/LoggedExtras.tsx`: the method glyph and the "check this" hint

**Files** — Modify: `components/LoggedExtras.tsx` (imports at line 1–4; `EntryText` at line 61;
`ExtraRow` at line 134; `LoggedExtras` at line 169). Test path: `tests/client/capture-methods.test.ts`
covers `captureMetaFrom`; the row itself is gated by Task 12 step 8 **[manual gate]**.

**Interfaces**

Consumes: `getRow` from `@/lib/sync/idb` (`getRow(entity: Entity, key: string):
Promise<Record<string, unknown> | undefined>`); `captureMetaFrom`, `type CaptureMeta` from
`@/lib/capture-client`; `CaptureGlyph` from `@/components/CaptureSheet`.

Produces: the same default export with one added, optional-by-default behaviour — no prop change, so
`app/page.tsx` is untouched.
```ts
export default function LoggedExtras(props: {
  extras: LoggedFood[]; waterCups: number; pendingIds?: Set<string>;
  onOpen: (id: string) => void; onDetails?: (id: string) => void;
}): React.JSX.Element | null;
```

- [ ] Add the imports and the state (top of the file, after line 4).
  ```tsx
  import { useEffect, useState } from "react";
  import { CaptureGlyph } from "@/components/CaptureSheet";
  import { captureMetaFrom, type CaptureMeta } from "@/lib/capture-client";
  import { getRow } from "@/lib/sync/idb";
  ```
- [ ] Read the meta inside `LoggedExtras`, before the early return is impossible — hooks run first,
      so put the effect above the `if (extras.length === 0 …)` line and keep that guard where it is.
  ```tsx
    const ids = extras.map((e) => e.id).join(",");
    const [meta, setMeta] = useState<Record<string, CaptureMeta>>({});

    /* `method` and per-item `confidence` live on the synced log_entries row (architecture §3.3), not
       on the legacy LoggedFood view model, and lib/types.ts is not this lane's file. So the row is
       read straight from the Phase 0 IndexedDB store by entry id; an id that predates sync, or a
       browser with no store, simply has no meta and the row renders exactly as it does today. */
    useEffect(() => {
      let live = true;
      void (async () => {
        const found: Record<string, CaptureMeta> = {};
        for (const id of ids === "" ? [] : ids.split(",")) {
          const row = await getRow("log_entries", id).catch(() => undefined);
          const entry = captureMetaFrom(row);
          if (entry !== null) found[id] = entry;
        }
        if (live) setMeta(found);
      })();
      return () => { live = false; };
    }, [ids]);
  ```
- [ ] Pass it down: `<ExtraRow … meta={meta[e.id]} />`, add `meta?: CaptureMeta` to `ExtraRow`'s props
      and hand it to `EntryText`.
- [ ] Render the glyph and the hint in `EntryText` — the glyph replaces the meal icon for a captured
      entry, and the hint sits under the macro line.
  ```tsx
        <span className="ts flex items-center gap-1.5 truncate text-[15px] font-normal text-charcoal">
          {pending && (
            <span aria-label="Not synced yet" title="Not synced yet"
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
          )}
          {meta ? (
            <span role="img" aria-label={`Logged by ${meta.method}`} className="shrink-0 text-graphite">
              <CaptureGlyph method={meta.method} size={16} />
            </span>
          ) : e.items ? <MealIcon /> : null}
          {e.name}
        </span>
  ```
  ```tsx
        {meta?.lowConfidence && (
          <span className="text-tiny font-light text-graphite">check this</span>
        )}
  ```
- [ ] Type-check, lint, and re-run the two tests that touch this path.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint && pnpm test tests/client/capture-methods.test.ts
  ```
  Expected: no type error, no lint error, 12 tests PASS.
- [ ] Commit.
  ```bash
  git add components/LoggedExtras.tsx
  git commit -m "feat(capture): show the method glyph and a check-this hint on Today"
  ```

---

## Task 12 — the phone gate and its screenshots

**Files** — Create: `docs/screenshots/phase-4/README.md`. Test path: the gate itself.

**Interfaces** — Consumes nothing. Produces a written gate that Devin runs on the phone against a
Vercel preview with `CAPTURE_METHODS` and `NEXT_PUBLIC_CAPTURE_METHODS` set to the same list
(contracts §6, §9 step 4).

- [ ] Write the file.
  ```md
  # Phase 4 capture — phone screenshots

  Six shots, taken on Devin's phone against the preview deploy, one method per deploy
  (`00-contracts.md` §9 step 4). Drop the PNGs in this folder with these names; they are the evidence
  for spec §10 AC1, AC11 and AC12 and for the README's ASSUMED decision 4.

  | File | What it must show |
  |---|---|
  | `01-actions.png` | The `+` menu with exactly the enabled capture actions above the water row, every row ≥ 44 px. |
  | `02-text-draft.png` | A three-item draft from typed text, with the spend note "n of 30 today" under the title. |
  | `03-voice-recording.png` | The countdown ring mid-clip, with the seconds remaining in the centre. |
  | `04-label-confirm.png` | A label draft with the label-food card and "Save as my food" visible. |
  | `05-photo-focus.png` | A plate draft opening with the first grams stepper focused and Save enabled. |
  | `06-offline.png` | Airplane mode: the four actions disabled and the sheet's "Capture needs a connection" line with the search button. |

  A blocked item (AC9) has no screenshot of its own: it appears in `04-label-confirm.png` as a red
  dot pill with Save greyed out, taken with an apple-containing pouch.
  ```
- [ ] Run the gate **[manual gate]** on the preview, in one sitting (spec §9, "Manual gate"):
      1. Type a three-item meal, check the items, Save. The entry appears under "Also today" with the
         type glyph.
      2. Hold the mic button, say the same meal, release, replay, Use this clip, Save.
      3. Photograph a pouch label, confirm the ingredients line, leave "Save as my food" on, Save.
      4. Photograph a plate; confirm the first grams stepper has focus and that saving without
         touching it stores `was_edited = false`.
      5. Airplane mode: confirm the four actions are disabled with "needs a connection" and that the
         sheet's search button still logs a food.
      6. An apple-containing pouch: confirm the red pill and that Save stays disabled until the item
         is removed.
- [ ] Record the result in the PR body: one line per step, pass or fail, plus the six file names.
- [ ] Commit.
  ```bash
  git add docs/screenshots/phase-4/README.md
  git commit -m "docs(capture): phase 4 phone gate and its screenshot set"
  ```

---

## Task 13 — lane regression and the flag-off check

**Files** — none. Test path: the four test files.

**Interfaces** — Consumes `enabledMethods` (contracts §6). Produces the evidence the exit gate asks
for.

- [ ] Run this lane's tests once, together.
  ```bash
  pnpm test tests/client/capture-resize.test.ts tests/client/capture-drafts.test.ts tests/client/capture-client.test.ts tests/client/capture-methods.test.ts
  ```
  Expected: 4 files, 48 tests, all PASS.
- [ ] Confirm the flag-off default: with neither `CAPTURE_METHODS` nor
      `NEXT_PUBLIC_CAPTURE_METHODS` set, `captureActions()` is `[]`, so Today offers no capture row
      and nothing in this lane can be reached.
  ```bash
  pnpm exec tsx -e "import('./lib/capture-client.ts').then((m) => console.log(m.captureActions({})))"
  ```
  Expected output: `[]`.
- [ ] Lint and type-check the whole tree once.
  ```bash
  pnpm lint && pnpm exec tsc --noEmit
  ```
- [ ] Check the file budget on every file this lane wrote.
  ```bash
  wc -l lib/capture-client.ts lib/capture/drafts.ts lib/media/resize.ts components/Capture*.tsx components/VoiceCapture.tsx components/PhotoCapture.tsx components/LoggedExtras.tsx
  ```
  Expected: every file under 400 lines.
- [ ] Commit nothing if the tree is clean; otherwise commit the fix with a `fix(capture): …` subject.

---

## Lane exit gate

All of these, evidenced in the PR body, before the branch is offered for landing:

1. `pnpm test tests/client/capture-*.test.ts` green — 4 files, 48 tests.
2. `pnpm lint` and `pnpm exec tsc --noEmit` green.
3. Every file this lane wrote is under 400 lines and every function under 50.
4. **No file outside contracts §1's Lane N row is modified.** Check it:
   `git diff --name-only main...HEAD` lists only `lib/media/resize.ts`, `lib/capture/drafts.ts`,
   `lib/capture-client.ts`, `components/CaptureSheet.tsx`, `components/CaptureConfirm.tsx`,
   `components/VoiceCapture.tsx`, `components/PhotoCapture.tsx`, `components/LoggedExtras.tsx`,
   `tests/client/capture-*.test.ts`, `docs/screenshots/phase-4/README.md`.
5. No new dependency: `git diff main...HEAD -- package.json pnpm-lock.yaml` is empty.
6. No new design value: every colour, radius and shadow in the four components is quoted from
   `DESIGN.md`, `app/globals.css` or a mockup file, with the source named in a comment.
7. The phone gate of Task 12 is run and its six steps recorded. Steps 2–4 and 6 need Lane M's routes
   on a preview, so this gate runs at integration (contracts §9 step 4) and the PR says so;
   steps 1 and 5 run on the branch preview with the actions rendered and no method enabled.
8. Spec AC11 and AC12 are demonstrated: offline disables the four actions and the sheet offers
   search; every tap target in the sheet is ≥ 44 px.

## Hand-off to integration

Two diffs, applied on `feat/p3-4-integration` after K, L, M and N land (contracts §9 step 1). Neither
file is touched on this branch.

**1. `components/QuickActions.tsx`** — the four capture rows, gated by `enabledMethods()` and
`navigator.onLine`, above the existing water / gut / weight rows. Fifteen added lines:

```tsx
import { captureActions } from "@/lib/capture-client";
import { CaptureGlyph, useOnline } from "@/components/CaptureSheet";
import type { CaptureMethod } from "@/lib/capture/flags";
```
```tsx
export default function QuickActions({
  onLogFood,
  onLogMeal,
  onCapture,
```
```tsx
  onCapture: (method: CaptureMethod) => void;
```
```tsx
  const online = useOnline();
  const captures = captureActions();
```
```tsx
                {captures.map((a) => (
                  <button key={a.method} type="button" disabled={!online}
                    onClick={() => { onCapture(a.method); close(); }}
                    className={`${rowClass} disabled:opacity-40`}>
                    <CaptureGlyph method={a.method} />
                    {online ? a.label : `${a.label} — needs a connection`}
                  </button>
                ))}
```
(the block goes immediately above the `Log water — 1 cup` button, inside the `!weightOpen` fragment.)

**2. `app/page.tsx`** — the sheet mount and the initial-mode state. Eleven added lines:

```tsx
import CaptureSheet from "@/components/CaptureSheet";
import type { CaptureMethod } from "@/lib/capture/flags";
```
```tsx
  const [captureMode, setCaptureMode] = useState<CaptureMethod | null>(null);
```
```tsx
          {captureMode && (
            <CaptureSheet
              key={`capture-${captureMode}`}
              initial={captureMode}
              slot={currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1"}
              onOpenSearch={() => { setCaptureMode(null); setLogOpen("food"); }}
              onSaved={() => { setCaptureMode(null); refresh(); }}
              onClose={() => setCaptureMode(null)}
            />
          )}
```
(inside the existing `<AnimatePresence>` that already holds `LogFoodSheet` and `NoteSheet`), and one
changed line on the existing `QuickActions` element:

```tsx
        <QuickActions onLogFood={() => setLogOpen("food")} onLogMeal={() => setLogOpen("meal")} onCapture={setCaptureMode} onLogWater={logWater} onGutCheckin={logGut} onLogWeight={logWeight} />
```

`components/LogFoodSheet.tsx` needs no diff from this lane: its `CaptureRow` is already drawn at 50 %
opacity with `aria-disabled`, and wiring it is optional polish for a later PR — the `+` menu is the
route contracts §9 names. If integration does wire it, the same three lines apply: `onCapture` prop,
`captureActions()` for the enabled set, and the existing pill markup with `disabled={!online}`.

## Open questions

1. **`log_items.confidence` never reaches the server.** `LogItemInput` (`lib/log/contract.ts`, frozen
   and shared) has no `confidence` field, and `commitDraft` therefore cannot carry the model's
   per-item confidence into `log_items`. The column exists (`apply_sync_op` writes `i.confidence`)
   and Today's "check this" hint reads it, so today that hint can only ever fire if Lane M writes
   confidence server-side from the draft it holds — which it cannot, because drafts are not
   persisted. Either the contract gains `confidence?: number` on `LogItemInput` (a `docs: phase-3-4
   contract change` commit, then a one-line change here), or the hint is documentation of an
   intention rather than a feature. **This lane ships the hint reading the column and showing
   nothing when it is null**, which is correct either way. Devin or the contract owner decides.
2. **A swapped item's verdict.** Swapping to an alternative drops the policy to `unverified` (amber),
   because §4.4 runs server-side and an alternative carries a `foodRefId` but no catalog id to re-ask
   `/api/foods/[id]` with. If Lane M's `FoodDetail.policy` were reachable by `food_ref_id`, the sheet
   could re-check on swap. Worth one route parameter later; not worth widening a frozen contract now.
3. **Duplicate recovery is best-effort.** A 409 `duplicate_request` returns `aiCallId`, not
   `draftId`, so the sheet re-opens the newest draft in `localStorage`. On a phone that cleared site
   data between the two calls there is nothing to re-open and she sees the 409 line with no items.
   Acceptable; naming `draftId` in the 409 body would make it exact.
4. **Photo grams (README decision 4, ASSUMED).** Implemented as: the stepper opens focused,
   `was_edited` stays false until she moves it. If Devin rules the other way, it is one `useEffect`
   in `CaptureConfirm`.
5. **iOS audio container (spec §12 open question 1).** `pickAudioMimeType` prefers `audio/mp4`; the
   canary at integration decides whether Gemini accepts it. If it fails, the fallback named in the
   spec is a client re-mux to 16 kHz mono WAV — a new task in this lane's file set, not a change to
   any other lane's.
