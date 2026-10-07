/**
 * Migration 20261217120300 on the real migrated schema (SUPABASE_TEST_DB_URL): `claim_job_cursor`
 * takes a pass's lease only when none is live, returns the saved state, refuses a second claimant,
 * lets a lapsed lease be taken over, and resets the pass on restart. Client roles cannot touch it.
 */
import "../tenancy/local-only";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const JOB = `test-${randomUUID()}`;
const claim = (owner: string, seconds = 360, restart = false) => runSql(`select
  coalesce(after_key, '-') || '|' || listed || '|' || (array_length(retry_keys, 1) is not null)
  || '|' || done from public.claim_job_cursor('${JOB}', 'p', '${owner}', ${seconds}, ${restart})`);

describe.skipIf(!HAS_DB)("claim_job_cursor (S3 pass lease)", () => {
  afterAll(() => { runSql(`delete from public.job_cursors where job = '${JOB}'`); });

  it("leases once, refuses a live lease, hands over a lapsed one, and restarts on request", () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    expect(claim(a)).toBe("-|false|false|false");          // a fresh pass
    expect(claim(b)).toBe("");                              // a's lease is live: no row
    // a saves (compare-and-set on its owner) and releases.
    runSql(`update public.job_cursors set after_key = 'k9', listed = true,
      retry_keys = '{k3}', lease_owner = null, lease_until = null
      where job = '${JOB}' and period = 'p' and lease_owner = '${a}'`);
    expect(claim(b, 1)).toBe("k9|true|true|false");        // the saved state comes back
    runSql(`update public.job_cursors set lease_until = now() - interval '1 second'
      where job = '${JOB}'`);
    expect(claim(c)).toBe("k9|true|true|false");            // b's lease lapsed: c takes over
    expect(runSql(`select lease_owner from public.job_cursors where job = '${JOB}'`)).toBe(c);
    runSql(`update public.job_cursors set lease_owner = null, lease_until = null
      where job = '${JOB}'`);
    expect(claim(a, 360, true)).toBe("-|false|false|false"); // restart: a fresh pass
  });

  it("is server-only: no client role can read the table or run the claim", () => {
    expect(runSql(`select has_table_privilege('authenticated', 'public.job_cursors', 'select')
      || '|' || has_table_privilege('anon', 'public.job_cursors', 'select')
      || '|' || has_function_privilege('authenticated',
        'public.claim_job_cursor(text, text, uuid, integer, boolean)', 'execute')
      || '|' || has_function_privilege('service_role',
        'public.claim_job_cursor(text, text, uuid, integer, boolean)', 'execute')`))
      .toBe("false|false|false|true");
  });
});
