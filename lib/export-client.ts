/**
 * CSV export from the phone (Phase 9 slice 1; audit plan r2 finding 6). A plain `<a href>` sent
 * no account header, so a tab still showing A could download B's log once the shared cookie held
 * B. The download is a fetch for the account the card was rendered for instead: the route answers
 * `409 account_mismatch` to a stale tab, and a body that arrives after a switch is never saved.
 */
import { accountFetch, accountText, type AccountHandle } from "@/lib/device/account";

export type ExportKind = "meals" | "progress";

export function exportHref(kind: ExportKind, from: string, to: string): string {
  const params = new URLSearchParams({ kind, format: "csv" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return `/api/export?${params.toString()}`;
}

export type DownloadDeps = {
  fetchImpl?: typeof fetch;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

/** Set by `GET /api/export` on a CSV page (W012, A086): the cursor of the next page, if any. */
const NEXT_CURSOR_HEADER = "x-export-next-cursor";
/** How many trailing `# ` notice lines the page ends with (the truncation notice is the last). */
const NOTICE_LINES_HEADER = "x-export-notice-lines";
/**
 * Pages one download may join. The route counts only the first page against its 10 exports an
 * hour; the continuations have their own budget of 70 an hour (ten downloads of this many pages).
 * A log longer than this many 5,000-entry pages keeps the server's "Export truncated … cursor=" line.
 */
export const MAX_EXPORT_PAGES = 8;

type CsvPage = { lines: string[]; notices: string[]; next: string | null };

/** One CSV page split into its lines (header first) and its trailing notice lines. */
function splitPage(text: string, noticeLines: number): Omit<CsvPage, "next"> {
  const lines = text.split("\r\n");
  if (lines.at(-1) === "") lines.pop();
  const count = Math.min(Math.max(0, noticeLines), Math.max(0, lines.length - 1));
  return { lines: lines.slice(0, lines.length - count), notices: lines.slice(lines.length - count) };
}

/**
 * Join pages into one document: the first page's header, every page's rows in order, then each
 * distinct notice once. A followed page's truncation line (always its last notice) is dropped,
 * since the next page carries on from it; the final page keeps its own.
 */
export function joinCsvPages(pages: readonly CsvPage[]): string {
  const lines: string[] = [];
  const notices = new Set<string>();
  pages.forEach((page, index) => {
    lines.push(...(index === 0 ? page.lines : page.lines.slice(1)));
    const kept = page.next && index < pages.length - 1 ? page.notices.slice(0, -1) : page.notices;
    for (const notice of kept) notices.add(notice);
  });
  return `${[...lines, ...notices].join("\r\n")}\r\n`;
}

async function fetchCsvPage(h: AccountHandle, href: string, deps: DownloadDeps): Promise<CsvPage> {
  const res = await accountFetch(h, href, {}, { fetchImpl: deps.fetchImpl });
  if (!res.ok) throw new Error(`export failed with ${res.status}`);
  const text = await accountText(h, res);
  const page = splitPage(text, Number(res.headers.get(NOTICE_LINES_HEADER) ?? 0));
  return { ...page, next: res.headers.get(NEXT_CURSOR_HEADER) };
}

/**
 * Fetch the CSV as `h` and hand it to the browser as a file named for its kind and dates. A log
 * longer than one page is followed page by page (W012, A086) and saved as one file; nothing is
 * saved when any page fails or the account changes on the way.
 */
export async function downloadExport(
  h: AccountHandle, kind: ExportKind, from: string, to: string, deps: DownloadDeps = {},
): Promise<void> {
  const first = exportHref(kind, from, to);
  const pages = [await fetchCsvPage(h, first, deps)];
  while (pages.at(-1)!.next && pages.length < MAX_EXPORT_PAGES) {
    const params = new URLSearchParams({ cursor: pages.at(-1)!.next! });
    pages.push(await fetchCsvPage(h, `${first}&${params.toString()}`, deps));
  }
  const blob = new Blob([joinCsvPages(pages)], { type: "text/csv;charset=utf-8" });
  const create = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revoke = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  const url = create(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = [kind, from || "all", to || "all"].join("-") + ".csv";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    revoke(url);
  }
}
