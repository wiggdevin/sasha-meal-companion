/**
 * Doubles for the S3 job helpers (lib/server/job-sweep.ts, lib/server/job-cursor.ts): a keyset
 * listing page, the `job_cursors` pass store with `claim_job_cursor`, and a stateful `job_runs`,
 * so a route test that fakes the admin client by hand can serve them.
 */
type Result = { data: unknown[] | null; error: unknown };

/** A listing query (`not`/`eq`/`is`/`lt`/`gt`/`order`/`range`) that answers `first` for the first
 *  page and nothing after a key, as a keyset listing shorter than one page does. */
export function keysetListing(first: Result | (() => Result | Promise<Result>)) {
  let after: string | null = null;
  const chain = {
    not: () => chain, eq: () => chain, is: () => chain, lt: () => chain, order: () => chain,
    gt: (_key: string, value: string) => { after = value; return chain; },
    range: async (): Promise<Result> => (after !== null ? { data: [], error: null }
      : typeof first === "function" ? first() : first),
  };
  return chain;
}

/** `job_cursors` that accepts every save (for a route test whose claim is answered elsewhere). */
export function noCursors() {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ job: "j" }], error: null }).then(resolve),
  };
  return chain;
}

type Pass = { after_key: string | null; listed: boolean; retry_keys: string[]; relist: boolean;
  done: boolean;
  pass_started_at: string; lease_owner: string | null; lease_until: number | null };

/**
 * The pass store as migration 20261217120300 defines it: `claim(params)` is `claim_job_cursor`
 * (lease only when none is live, restart resets the pass), `table()` serves the app's
 * compare-and-set save. `now` is the store's clock, in epoch ms.
 */
export function passStore(now: () => number = Date.now) {
  const rows = new Map<string, Pass>();
  const claim = (p: { p_job: string; p_period: string; p_owner: string; p_lease_seconds: number;
    p_restart: boolean }) => {
    const key = `${p.p_job}|${p.p_period}`;
    let row = rows.get(key);
    if (row && row.lease_until !== null && row.lease_until >= now()) return { data: [], error: null };
    if (!row || p.p_restart) {
      row = { after_key: null, listed: false, retry_keys: [], relist: false, done: false,
        pass_started_at: new Date(now()).toISOString(), lease_owner: null, lease_until: null };
      rows.set(key, row);
    }
    row.lease_owner = p.p_owner;
    row.lease_until = now() + p.p_lease_seconds * 1000;
    const { after_key, listed, retry_keys, relist, done, pass_started_at } = row;
    return { data: [{ after_key, listed, retry_keys: [...retry_keys], relist, done,
      pass_started_at }],
      error: null };
  };
  const table = () => {
    let payload: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      update: (fields: Record<string, unknown>) => { payload = fields; return chain; },
      eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
      select: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        const row = rows.get(`${filters.job}|${filters.period}`);
        if (!row || row.lease_owner !== filters.lease_owner) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        Object.assign(row, payload, { lease_until: null });
        return Promise.resolve({ data: [{ job: filters.job }], error: null }).then(resolve);
      },
    };
    return chain;
  };
  return { claim, table, rows };
}

type JobRun = { job: string; user_id: string; run_key: string; status: string;
  started_at: string; finished_at: string | null; detail: unknown };

/** A stateful `job_runs` with the semantics `takeLock`, `claimLock` and `releaseLock` rely on: a
 *  unique key, `update … eq … or(…)` that touches only matching rows, and `select … match`. */
export function jobRunsTable(seed: Partial<JobRun>[] = []) {
  const rows: JobRun[] = seed.map((r) => ({ job: "", user_id: "", run_key: "", status: "running",
    started_at: new Date().toISOString(), finished_at: null, detail: null, ...r }));
  const field = (row: JobRun, name: string) => (row as unknown as Record<string, unknown>)[name];
  function split(expr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of expr) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  }
  function clause(c: string, row: JobRun): boolean {
    if (c.startsWith("and(")) return split(c.slice(4, -1)).every((x) => clause(x, row));
    const [name, cmp, ...rest] = c.split(".");
    const value = rest.join(".").replace(/^"|"$/g, "");
    if (cmp === "eq") return String(field(row, name)) === value;
    if (cmp === "lt") return Date.parse(String(field(row, name))) < Date.parse(value);
    throw new Error(`jobRunsTable: unsupported comparison ${cmp}`);
  }
  const from = () => {
    let mode: "insert" | "update" | "select" = "select";
    let payload: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    let orExpr: string | null = null;
    const matches = (row: JobRun) => Object.entries(filters).every(([k, v]) => field(row, k) === v)
      && (orExpr === null || split(orExpr).some((c) => clause(c, row)));
    const settle = () => {
      if (mode === "insert") {
        const key = payload as Partial<JobRun>;
        if (rows.some((r) => r.job === key.job && r.user_id === key.user_id
          && r.run_key === key.run_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const row = { started_at: new Date().toISOString(), finished_at: null, detail: null,
          ...key } as JobRun;
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      const hit = rows.filter(matches);
      if (mode === "update") hit.forEach((r) => Object.assign(r, payload));
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const chain: Record<string, unknown> = {
      insert: (row: Record<string, unknown>) => { mode = "insert"; payload = row; return chain; },
      update: (row: Record<string, unknown>) => { mode = "update"; payload = row; return chain; },
      select: () => chain,
      eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
      match: (m: Record<string, unknown>) => { Object.assign(filters, m); return chain; },
      or: (expr: string) => { orExpr = expr; return chain; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return chain;
  };
  return { from, rows };
}
