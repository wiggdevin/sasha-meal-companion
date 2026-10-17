# planDay phone benchmark and snapshot v3 telemetry (W107)

Status: **planDay measured 2026-10-17 in a cloud container** (4 vCPU Linux, headless Chromium 141).
The snapshot build p95 needs a real database and an open account, so it is a Mac step (below).
Open food world is off for every account (`OPEN_WORLD_ENABLED` unset), so none of this reaches a
person today; these numbers gate opening it.

## What is measured

- **`planDay`** (`lib/meals/day.ts`), the open food-world search the phone runs for one whole day.
  The pool is an open account's admitted pool built the way the phone builds it: a v3 body from the
  D4 admission over the whole bundled universe (`tests/helpers/open-snapshot.ts`), through JSON and
  the strict parse, into `openWorldInputs`, plus N Favored foods taken in order from the bundled USDA
  list. Days are 4 meals (2,000 kcal) and 6 meals (2,400 kcal), the W8 acceptance days. Each case
  runs 5 untimed warm-up days, then 60 timed dates. Target: **p95 ≤ 20 ms** on a phone-class CPU (D11).
- **Snapshot v3 build** (`lib/server/meal-snapshot-v3.ts`). Every open-account body logs one line,
  `metric: "snapshot_v3_build"`, with `buildMs` (from after the world read to the finished body),
  `bytes`, `over`, `sections` (UTF-8 JSON bytes of `foods`, `admittedUniverseIds`, `admittedRefIds`,
  `excluded`, `eligible`) and `counts` (`foods`, `favored`, `universe`, `excluded`). Target: build
  **p95 ≤ 500 ms**, body ≤ 250 KB. A body over 250 KB also logs `snapshot_v3_overage` with the same
  sizes. Neither line carries a food name, an id or the account (`snapshotV3Size` in
  `lib/meals/snapshot-v3.ts` reads lengths and counts only; `tests/meals/snapshot-v3-size.test.ts`).
  No `lib/timing.ts` step is added. A request that ends in `409 rules_changed` or `503`, or whose
  world closed mid-build, logs no build line, so the `buildMs` p95 covers completed bodies only;
  count those failures from their own status codes.

## Commands

```sh
pnpm exec tsx scripts/bench/plan-day.ts                        # Chromium, 4x CPU throttle (default)
pnpm exec tsx scripts/bench/plan-day.ts --throttle 1           # same browser, no throttle
pnpm exec tsx scripts/bench/plan-day.ts --mode node            # this host's Node, no browser
pnpm exec tsx scripts/bench/plan-day.ts --favored 0,20,100,300 --slots 4,6 --dates 60 --json out.json
```

The browser mode bundles `scripts/bench/plan-day-workload.ts` with the esbuild tsx already ships,
starts headless Chromium (`--chrome <path>`, else `CHROME_PATH`, else `/opt/pw-browsers/chromium`
or the usual macOS Chrome path), sets `Emulation.setCPUThrottlingRate` over the DevTools protocol
and runs the bundle in a blank page. No network, no database, no account data.

## Results, 2026-10-17

4x CPU throttle (the phone-class figure):

| Favored | Slots | Pool | Body KB | Prepare ms | p50 ms | p95 ms | max ms | max sizePlate | p95 ≤ 20 ms |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 4 | 311 | 49.8 | 21.6 | 116.8 | 295.2 | 473.0 | 1180 | no |
| 0 | 6 | 311 | 49.8 | 11.7 | 133.1 | 185.1 | 234.6 | 1776 | no |
| 20 | 4 | 331 | 56.2 | 18.4 | 106.3 | 177.3 | 190.1 | 1032 | no |
| 20 | 6 | 331 | 56.2 | 12.1 | 139.2 | 249.2 | 312.5 | 1488 | no |
| 100 | 4 | 411 | 81.7 | 20.6 | 126.3 | 166.0 | 202.7 | 1288 | no |
| 100 | 6 | 411 | 81.7 | 15.8 | 164.3 | 283.6 | 341.9 | 1848 | no |
| 300 | 4 | 611 | 145.7 | 37.9 | 151.3 | 206.4 | 375.5 | 1282 | no |
| 300 | 6 | 611 | 145.7 | 10.9 | 188.4 | 269.8 | 343.4 | 1766 | no |

No throttle, same browser and host:

| Favored | Slots | Pool | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|
| 0 | 4 | 311 | 24.1 | 34.7 | 68.4 |
| 0 | 6 | 311 | 29.4 | 45.5 | 51.4 |
| 20 | 4 | 331 | 18.0 | 23.8 | 61.0 |
| 20 | 6 | 331 | 27.9 | 45.0 | 50.9 |
| 100 | 4 | 411 | 26.3 | 31.3 | 39.2 |
| 100 | 6 | 411 | 33.4 | 56.3 | 65.0 |
| 300 | 4 | 611 | 36.4 | 47.6 | 88.2 |
| 300 | 6 | 611 | 44.1 | 51.2 | 63.4 |

"Prepare" is the one-off phone cost before any day (parse the body, `openWorldInputs`). Body KB is
the test builder's body, which has no history or facet scores, so a real body is somewhat larger.

## Findings

1. **planDay misses the 20 ms target by 8–15x on a 4x-throttled CPU** (p95 166–295 ms) and is
   already over it unthrottled on this host (p95 24–56 ms). Every day stays inside the W8 search
   bound (at most 1,848 `sizePlate` calls against 20,000), so the cost is per-plate work, not a
   runaway search. This blocks opening the food world on phones until the search is faster or runs
   off the main thread. Ranking is not changed here (W107 guard); the fix is its own item, with the
   golden tests.
2. **Favored size barely moves the time.** 0 to 300 Favored foods adds about 20–40 % at p50, because
   the search keeps at most 24 anchors per occasion (`OPEN_ANCHOR_LIMIT`). Slot count matters more
   than Favored count.
3. **Body size grows about 0.32 KB per Favored food** (49.8 KB with none, 145.7 KB with 300), so the
   250 KB ceiling is reached near 600 Favored foods.

## Decision: Favored soft cap

**No Favored soft cap.** The data does not support one: Favored count is not what makes `planDay`
slow, and the body stays under 250 KB until roughly 600 Favored foods, far past a normal list. A cap
would also break "Favored never limits meals" (spec §1). Revisit only if `snapshot_v3_build` lines
show `counts.favored` above 500 or `over: true` for a real account.

## Mac session steps (owner)

- **Real phone.** Write the bundle (`pnpm exec tsx scripts/bench/plan-day.ts --bundle plan-day.js`),
  load it in the phone's browser (Safari Web Inspector on an iPhone), call
  `__planDayBench({ favored: [20], slots: [4, 6], dates: 60 })` from the console, and record p50/p95
  of each case's `times` here beside the 4x row.
- **Snapshot build p95.** On the isolated test stack (`scripts/test-stack.sh`, as in
  `load-soak-report.md`), start the app with `OPEN_WORLD_ENABLED=1`, open one test account's food
  world (`POST /api/foods/world`), call `GET /api/foods/eligible?v=3` 50 times, and read the
  `snapshot_v3_build` lines from the server log: p95 of `buildMs` against 500 ms. Once accounts are
  open in production, the same lines are in Vercel runtime logs (search `snapshot_v3_build`).
- The spec text for `docs/specs/phase-18-open-world-foods.md` §W8 is owned by another batch (B6);
  it should cite this file.
