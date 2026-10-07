/**
 * Dev-only: which code the local server is running, compared with main. On 2026-10-02 the dev
 * server on :3521 ran a checkout 21 commits behind main and nobody could tell from the screen.
 * next.config.ts computes this once at `next dev` start (after the predev fetch) and the app shows
 * DevFreshnessBanner when the checkout is behind. Never runs in a production build.
 */
export type Freshness = { branch: string; behind: number };

type Git = (args: string) => string;

/** null when git or origin/main is unavailable: no banner rather than a wrong one. */
export function readFreshness(git: Git): Freshness | null {
  try {
    const branch = git("rev-parse --abbrev-ref HEAD").trim();
    const behind = Number(git("rev-list --count HEAD..origin/main").trim());
    return Number.isSafeInteger(behind) ? { branch, behind } : null;
  } catch { return null; }
}

export function freshnessLine(value: Freshness | null): string | null {
  if (!value || value.behind === 0) return null;
  const commits = value.behind === 1 ? "1 commit" : `${value.behind} commits`;
  return `Old code: ${value.branch} is ${commits} behind main. Pull, or open the current checkout.`;
}
