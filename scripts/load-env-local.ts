/**
 * `.env.local` for a bare `tsx` script. `next dev` / `next build` read it on their own; a script
 * run through `tsx` does not, so `pnpm timings` used to fail with "SUPABASE_URL /
 * the service-role key not set" unless the shell had sourced the file first.
 *
 * Node's loader, not a dependency: it never overrides a value the shell already carries (a branch
 * run's TEST names, or CI's own secrets, keep winning), and a missing file is not an error — a
 * worktree or CI checkout has none, and the caller's env may already be complete.
 */
import { loadEnvFile } from "node:process";

export function loadEnvLocal(file = ".env.local"): void {
  try {
    loadEnvFile(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
