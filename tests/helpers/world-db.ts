/**
 * Phase 18 W2b database-test helpers for the migrated local stack (SUPABASE_TEST_DB_URL): accounts,
 * a user session, the two admission-input versions and a throwaway catalog revision.
 */
import { spawn } from "node:child_process";
import { pgEnvFromUrl, runSql } from "./supabase";

/** Every account a test created; `dropAccounts` deletes them (the delete cascades). */
const users: string[] = [];

export function dropAccounts(): void {
  if (users.length) runSql(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(",")})`);
  users.length = 0;
}

export function account(): string {
  const id = crypto.randomUUID();
  users.push(id);
  runSql(`insert into auth.users (id, email) values ('${id}', 'w2b-${id}@example.test');
    insert into public.user_settings (user_id, first_opened_at, diet_prefs)
      values ('${id}', now(), '{"flags": [], "water": {"unit": "oz"}}'::jsonb);
    insert into public.constraint_profiles (user_id, avoid_allergens, banned_categories)
      values ('${id}', '{}', '{}');`);
  return id;
}

/** SQL run as the signed-in user (the authenticated role with this JWT subject). */
export function asUser(user: string, sql: string): string {
  return runSql(`begin; set local role authenticated;
    set local request.jwt.claim.sub = '${user}';
    set local request.jwt.claims = '{"sub": "${user}", "role": "authenticated"}';
    ${sql}; commit;`);
}

export const rules = (user: string) =>
  Number(runSql(`select coalesce((select rules_rev from public.account_rules_clock where user_id = '${user}'), 0)`));
export const evidence = () => Number(runSql(`select evidence_rev from public.evidence_clock where id = 1`));
export const world = (user: string) => runSql(`select food_world from public.user_settings where user_id = '${user}'`);
export const marker = (user: string) =>
  runSql(`select condition_review_required from public.constraint_profiles where user_id = '${user}'`);

/** The change in the account's rules clock across `write`. */
export function moves(user: string, write: () => unknown): number {
  const before = rules(user);
  write();
  return rules(user) - before;
}

/** The change in the evidence clock across one SQL statement. */
export function step(sql: string): number {
  const before = evidence();
  runSql(sql);
  return evidence() - before;
}

/** A throwaway catalog revision (and its food and version), with a way to drop it again. */
export function catalogRevision(): { id: string; drop: () => void } {
  const tag = crypto.randomUUID();
  const id = runSql(`with v as (insert into public.catalog_versions (source, version_label)
      values ('fdc_sr_legacy', 'w2b-${tag}') returning id),
    f as (insert into public.catalog_foods (source, source_id) values ('fdc_sr_legacy', 'w2b-${tag}') returning id)
    insert into public.catalog_food_revisions (description, catalog_food_id, catalog_version_id, quality_class, content_hash)
      select 'W2b bread', f.id, v.id, 'survey', 'w2b-${tag}' from f, v returning id`).split("\n")[0];
  return { id, drop: () => runSql(`delete from public.catalog_food_revisions where id = ${id};
    delete from public.catalog_foods where source_id = 'w2b-${tag}';
    delete from public.catalog_versions where version_label = 'w2b-${tag}';`) };
}

/** One psql connection, run in the background; resolves with its exit status and stderr. */
export function background(sql: string): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("psql", ["-v", "ON_ERROR_STOP=1", "-At", "-c", sql], {
      env: { ...process.env, ...pgEnvFromUrl(process.env.SUPABASE_TEST_DB_URL ?? "") } });
    let err = "";
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("close", (code) => resolve({ code, err }));
  });
}


/** An account food with a user ref (the shape an Eats or Avoid mark points at). */
export function userFood(owner: string, name: string): { foodId: string; refId: string } {
  const foodId = crypto.randomUUID();
  const refId = crypto.randomUUID();
  runSql(`insert into public.user_foods (id, user_id, name, kind, per_100g)
      values ('${foodId}', '${owner}', '${name}', 'custom', '{"protein": 10, "carbohydrate": 10, "fat_total": 1}');
    insert into public.food_refs (id, kind, user_food_id) values ('${refId}', 'user', '${foodId}');`);
  return { foodId, refId };
}
