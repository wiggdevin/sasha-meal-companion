/**
 * Phase 13 §3.4: the GitHub half of scripts/model-freshness.ts — find the one open tracking
 * issue, then update it or open it. Split out so the lookup can be tested with a fake fetch.
 *
 * Idempotent across runs: every page of open labelled issues is read (a first page of 100 can
 * miss the tracking issue on a busy repo), and when duplicates already exist the oldest is the one
 * kept up to date. The workflow's `concurrency` group stops two runs racing to open one each.
 */
import { FRESHNESS_ISSUE_LABEL, FRESHNESS_ISSUE_TITLE } from "@/lib/ai/model-freshness";

export type GithubIssue = { number: number; title: string };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PER_PAGE = 100;
const MAX_PAGES = 20;

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "model-freshness-workflow",
  };
}

export async function findOpenIssue(
  repo: string, token: string, fetchImpl: FetchLike = fetch,
): Promise<GithubIssue | null> {
  const matches: GithubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`https://api.github.com/repos/${repo}/issues`);
    url.searchParams.set("labels", FRESHNESS_ISSUE_LABEL);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    const res = await fetchImpl(url.toString(), { headers: githubHeaders(token) });
    if (!res.ok) throw new Error(`GitHub issues list returned ${res.status}`);
    const issues = await res.json() as GithubIssue[];
    matches.push(...issues.filter((issue) => issue.title === FRESHNESS_ISSUE_TITLE));
    if (issues.length < PER_PAGE) break;
  }
  return matches.sort((a, b) => a.number - b.number)[0] ?? null;
}

export async function openOrUpdateIssue(
  repo: string, token: string, body: string, fetchImpl: FetchLike = fetch,
): Promise<string> {
  const existing = await findOpenIssue(repo, token, fetchImpl);
  if (existing) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${existing.number}`, {
      method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub issue update returned ${res.status}`);
    return `updated issue #${existing.number}`;
  }
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST", headers: githubHeaders(token),
    body: JSON.stringify({ title: FRESHNESS_ISSUE_TITLE, body, labels: [FRESHNESS_ISSUE_LABEL] }),
  });
  if (!res.ok) throw new Error(`GitHub issue create returned ${res.status}`);
  const created = await res.json() as GithubIssue;
  return `opened issue #${created.number}`;
}
