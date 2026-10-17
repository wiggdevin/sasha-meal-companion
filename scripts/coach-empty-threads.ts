/**
 * W088 (audit B070): lists coach threads that hold no message. READ-ONLY.
 *
 * Before migration 20270104120000 a coach turn inserted its new thread, then its messages, as
 * separate calls, so a failure in between left an empty thread behind (it still counts against the
 * eight-chat cap). `coach_save_turn` now saves both in one transaction, so no new ones appear; this
 * report finds the old ones for the owner to review and delete by hand. It never writes.
 *
 *   pnpm exec tsx scripts/coach-empty-threads.ts [--older-than-days N] [--production]
 *
 * One line per empty, live thread older than N days (default 1, so a thread a turn is saving right
 * now is never listed): thread id, a truncated SHA-256 of the account id, kind, created_at. Then the
 * total. Branch-first like every CLI (`adminClientForCli`): production only with `--production`.
 */
import { hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadRow = { id: string; user_id: string; kind: string; created_at: string };

export type EmptyThreadPorts = {
  /** Live threads created before the cutoff. */
  threads: (before: string) => Promise<ThreadRow[]>;
  /** True when the thread holds at least one message. */
  hasMessage: (threadId: string) => Promise<boolean>;
};

export type ReportArgs = { olderThanDays: number; production: boolean };

export function parseArgs(argv: readonly string[]): ReportArgs {
  const args: ReportArgs = { olderThanDays: 1, production: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--production") args.production = true;
    else if (argv[i] === "--older-than-days") {
      const days = Number(argv[i + 1]);
      if (!Number.isInteger(days) || days < 1) throw new Error("--older-than-days takes a whole number of days, at least 1");
      args.olderThanDays = days;
      i += 1;
    } else {
      throw new Error(`coach-empty-threads is a read-only report; unknown argument ${argv[i]}`);
    }
  }
  return args;
}

const PARALLEL = 8;

export async function emptyThreads(ports: EmptyThreadPorts, before: string): Promise<ThreadRow[]> {
  const threads = await ports.threads(before);
  const empty: ThreadRow[] = [];
  for (let at = 0; at < threads.length; at += PARALLEL) {
    const batch = threads.slice(at, at + PARALLEL);
    const held = await Promise.all(batch.map((thread) => ports.hasMessage(thread.id)));
    batch.forEach((thread, i) => { if (!held[i]) empty.push(thread); });
  }
  return empty;
}

export function reportLines(rows: readonly ThreadRow[]): string[] {
  const account = (id: string) => hash("sha256", id).slice(0, 12);
  return [...rows.map((row) => `${row.id}\t${account(row.user_id)}\t${row.kind}\t${row.created_at}`),
    `${rows.length} empty thread${rows.length === 1 ? "" : "s"}`];
}

export function databasePorts(db: SupabaseClient): EmptyThreadPorts {
  return {
    threads: async (before) => {
      const { fetchAllRows } = await import("@/lib/server/paged-read");
      return fetchAllRows<ThreadRow>((from, to) => db.from("coach_threads")
        .select("id, user_id, kind, created_at").is("deleted_at", null).lt("created_at", before)
        .order("id").range(from, to));
    },
    hasMessage: async (threadId) => {
      const { count, error } = await db.from("coach_messages")
        .select("id", { count: "exact", head: true }).eq("thread_id", threadId);
      if (error) throw new Error(error.message);
      return (count ?? 0) > 0;
    },
  };
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const { adminClientForCli } = await import("@/lib/server/admin");
  const before = new Date(Date.now() - args.olderThanDays * 86_400_000).toISOString();
  const rows = await emptyThreads(databasePorts(adminClientForCli({ production: args.production })), before);
  for (const line of reportLines(rows)) console.log(line);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
