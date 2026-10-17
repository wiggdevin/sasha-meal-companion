/**
 * Self-serve account deletion against a real database (W057 "Done when"): `deleteAccount`
 * (lib/server/account-delete.ts) with the real `delete_account` function (migration
 * 20261231230000) on the local stack, every migration applied.
 *
 * A fresh account gets one row in every table the tenancy manifest declares
 * (tests/tenancy/table-ops.json, through the same builders the tenancy matrix uses), plus the
 * rows no cascade reaches (`food_facets`), a job-cursor retry key, a rate-limit window and two
 * Storage objects. After the delete:
 *
 * - every public table with a `user_id` column, read from the schema rather than a list here,
 *   holds no row of the account, and neither does any manifest table reached through a parent;
 * - the account's Storage objects, cursor key, rate-limit window and auth user are gone;
 * - a bystander account is byte-for-byte unchanged;
 * - a second delete answers `already_gone`.
 *
 * Needs SUPABASE_TEST_URL and SUPABASE_TEST_DB_URL (the Integration job); skipped without them.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";
import { accountSnapshot, seed } from "../tenancy/seed";
import manifest from "../tenancy/table-ops.json";

vi.mock("server-only", () => ({}));
const { deleteAccount } = await import("@/lib/server/account-delete");

const run = HAS_BRANCH && HAS_DB ? describe : describe.skip;
const seeds = Object.values(manifest as Record<string, { seed: string }>).map((v) => v.seed);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** Every public base table with a `user_id` column, from the catalog. */
function userIdTables(): string[] {
  return runSql(`select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
     where c.relkind = 'r' order by 1`).split("\n").filter(Boolean);
}

function rowsOf(userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of userIdTables()) {
    const n = Number(runSql(`select count(*) from public.${table} where user_id = '${userId}'`));
    if (n > 0) counts[table] = n;
  }
  return counts;
}

run("delete_account on the real schema", () => {
  let admin: SupabaseClient;
  let doomed = "";
  let bystander = "";
  let bystanderBefore: Record<string, unknown> = {};
  const job = `account-delete-test-${randomUUID()}`;
  const objects: string[] = [];

  beforeAll(async () => {
    admin = adminClient();
    const email = `delete-${randomUUID()}@meal-companion.test`;
    const created = await admin.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("no user");
    doomed = created.data.user.id;
    bystander = (await ensureUser("b")).id;

    for (const id of seeds) await seed(id, doomed);
    runSql(`insert into public.food_facets (food_key, input_hash, facet, rubric_version, p, model, user_id)
      values ('delete-test-${randomUUID()}', '\\x00', 'breakfast', 2, 0.5, 'test', '${doomed}')`);
    runSql(`insert into public.job_cursors (job, period, retry_keys)
      values ('${job}', '2040-01-01', array['${doomed}', '${bystander}'])`);
    runSql(`insert into public.rate_limits (key, window_start, count, expires_at)
      values ('account-delete:${doomed}', now(), 1, now() + interval '1 hour')`);
    for (const name of [`${randomUUID()}.jpg`, `${randomUUID()}.jpg`]) {
      const key = `${doomed}/${name}`;
      const up = await admin.storage.from("media").upload(key, new Blob([JPEG], { type: "image/jpeg" }),
        { contentType: "image/jpeg" });
      if (up.error) throw new Error(`upload: ${up.error.message}`);
      objects.push(key);
    }
    bystanderBefore = accountSnapshot(bystander);
  }, 120_000);

  afterAll(() => {
    if (HAS_DB) runSql(`delete from public.job_cursors where job = '${job}'`);
  });

  it("starts with the account's rows in every declared table", () => {
    const snapshot = accountSnapshot(doomed) as Record<string, unknown[]>;
    const empty = Object.entries(snapshot).filter(([, rows]) => rows.length === 0).map(([t]) => t);
    expect(empty).toEqual([]);
    expect(rowsOf(doomed).food_facets).toBeGreaterThan(0);
  });

  it("removes every row, object and pending key of the account and nothing else", async () => {
    await expect(deleteAccount(admin, doomed)).resolves.toEqual({ status: "deleted" });

    expect(rowsOf(doomed)).toEqual({});
    const snapshot = accountSnapshot(doomed) as Record<string, unknown[]>;
    expect(Object.entries(snapshot).filter(([, rows]) => rows.length > 0).map(([t]) => t)).toEqual([]);

    const listed = await admin.storage.from("media").list(doomed);
    expect(listed.error).toBeNull();
    expect(listed.data ?? []).toEqual([]);
    expect(runSql(`select array_to_string(retry_keys, ',') from public.job_cursors where job = '${job}'`))
      .toBe(bystander);
    expect(runSql(`select count(*) from public.rate_limits where key = 'account-delete:${doomed}'`)).toBe("0");
    expect(runSql(`select count(*) from auth.users where id = '${doomed}'`)).toBe("0");

    expect(accountSnapshot(bystander)).toEqual(bystanderBefore);
  }, 60_000);

  it("answers already_gone for an account it already deleted", async () => {
    await expect(deleteAccount(admin, doomed)).resolves.toEqual({ status: "already_gone" });
  });
});
