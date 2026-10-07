/**
 * CSV export from the phone (Phase 9 slice 1; audit plan r2 finding 6). A plain `<a href>` sent
 * no account header, so a tab still showing A could download B's log once the shared cookie held
 * B. The download is a fetch for the account the card was rendered for instead: the route answers
 * `409 account_mismatch` to a stale tab, and a body that arrives after a switch is never saved.
 */
import { accountBlob, accountFetch, type AccountHandle } from "@/lib/device/account";

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

/** Fetch the CSV as `h` and hand it to the browser as a file named for its kind and dates. */
export async function downloadExport(
  h: AccountHandle, kind: ExportKind, from: string, to: string, deps: DownloadDeps = {},
): Promise<void> {
  const res = await accountFetch(h, exportHref(kind, from, to), {}, { fetchImpl: deps.fetchImpl });
  if (!res.ok) throw new Error(`export failed with ${res.status}`);
  const blob = await accountBlob(h, res);
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
