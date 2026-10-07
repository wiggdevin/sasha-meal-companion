/**
 * `job_runs` belongs to Lane P's `20260926000000_phase5_oura_oauth.sql`. When Q's branch is pushed
 * before P has landed, the table is absent; Q's own migration creates it with `if not exists`, and
 * this fixture is the belt for a branch that was pushed from an older checkout. It needs psql and
 * SUPABASE_TEST_DB_URL and is a no-op without them, so CI stays green.
 */
import { execFileSync } from "node:child_process";

const DDL = `create table if not exists job_runs (job text not null, run_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));`;

export function ensureJobRuns(): void {
  const url = process.env.SUPABASE_TEST_DB_URL;
  if (!url) return;
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", DDL], { stdio: "pipe" });
}
