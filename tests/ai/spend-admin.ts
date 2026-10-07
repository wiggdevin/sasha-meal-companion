import { expect } from "vitest";

/** The circuit breaker's read (`select("created_at")…neq…gte`): no recent failures. */
function noFailures() {
  const chain = { eq: () => chain, neq: () => chain, gte: async () => ({ data: [], error: null }) };
  return chain;
}

/**
 * `ai_spend_reserve` / `ai_spend_settle` in memory (scale S2), with the SQL's rule: refused when
 * settled + live holds + the estimate would pass the user cap (`user_cap`) or the global ceiling
 * (`global_cap`). `spendFor(user)` is the user's already-settled spend.
 */
function reservations(spendFor: (userId: string) => number[], onReserve?: (userId: string) => void) {
  const held = new Map<string, { userId: string; amount: number }>();
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const total = () => sum([...held.values()].map((h) => h.amount));
  return async (fn: string, args: Record<string, unknown>) => {
    if (fn === "ai_spend_reserve") {
      const userId = String(args.p_user_id);
      onReserve?.(userId);
      const amount = Number(args.p_amount_usd);
      const mine = sum(spendFor(userId)) + sum([...held.values()]
        .filter((h) => h.userId === userId).map((h) => h.amount));
      const refuse = (reason: string) => ({ data: [{ reservation_id: null, allowed: false, reason,
        user_committed_usd: mine, global_committed_usd: total() }], error: null });
      if (Number(args.p_user_cap_usd) <= 0 || mine + amount > Number(args.p_user_cap_usd)) {
        return refuse("user_cap");
      }
      if (total() + amount > Number(args.p_global_cap_usd)) return refuse("global_cap");
      const id = crypto.randomUUID();
      held.set(id, { userId, amount });
      return { data: [{ reservation_id: id, allowed: true, reason: null,
        user_committed_usd: mine + amount, global_committed_usd: total() }], error: null };
    }
    if (fn === "ai_spend_settle") {
      const hold = held.get(String(args.p_reservation_id));
      if (!hold) return { data: false, error: null };
      held.delete(String(args.p_reservation_id));
      spendFor(hold.userId).push(Number(args.p_actual_usd));
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  };
}

export function spendAdmin(
  spend: number[],
  inserted: Record<string, unknown>[] = [],
) {
  return {
    rpc: reservations(() => spend),
    from: (table: string) => {
      expect(table).toBe("ai_calls");
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: null };
        },
        select: (columns: string) => {
          if (columns !== "cost_estimate") return noFailures();
          const chain = {
            eq: () => chain,
            gte: async () => ({
              data: spend.map((cost_estimate) => ({ cost_estimate })),
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  };
}

export function spendAdminByUser(
  spendByUser: Record<string, number[]>,
  queriedUsers: string[],
) {
  let selectedUser = "";
  return {
    rpc: reservations((userId) => (spendByUser[userId] ??= []), (userId) => queriedUsers.push(userId)),
    from: (table: string) => {
      expect(table).toBe("ai_calls");
      return {
        insert: async () => ({ error: null }),
        select: (columns: string) => {
          if (columns !== "cost_estimate") return noFailures();
          const chain = {
            eq: (column: string, userId: string) => {
              expect(column).toBe("user_id");
              selectedUser = userId;
              queriedUsers.push(userId);
              return chain;
            },
            gte: async () => ({
              data: (spendByUser[selectedUser] ?? []).map((cost_estimate) => ({ cost_estimate })),
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  };
}

/**
 * Adds the reservation RPCs to any fake admin client (scale S2): `ai_spend_*` calls are answered
 * by the in-memory reservation rule over `spend` (the user's settled spend today); any other rpc
 * goes to the fake's own `rpc`, when it has one.
 */
export function withSpendRpc<T extends object>(admin: T, spend: number[] = []): T & {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
} {
  const own = (admin as { rpc?: (fn: string, args: Record<string, unknown>) => unknown }).rpc;
  const reserve = reservations(() => spend);
  return Object.assign(admin, {
    rpc: async (fn: string, args: Record<string, unknown>) => (fn.startsWith("ai_spend_")
      ? reserve(fn, args)
      : own ? own.call(admin, fn, args) as Promise<{ data: unknown; error: unknown }>
        : { data: null, error: { message: `unexpected rpc ${fn}` } }),
  });
}
