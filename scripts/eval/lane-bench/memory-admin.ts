/**
 * An in-memory stand-in for the admin client the lane bench hands to generateStructured: no circuit
 * history, no spend, rows kept locally. It answers the spend RPCs lib/ai/spend.ts calls
 * (`ai_spend_reserve_split`, `ai_spend_settle`, `ai_spend_sweep`) so the reservation fails closed
 * only for a real reason, never because the double lacks `rpc`. Nothing here reaches a database.
 */
export function memoryAdmin(rows: Record<string, unknown>[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain, in: () => chain,
    order: () => chain, limit: () => chain,
    insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  const rpc = async (name: string) => ({
    error: null,
    data: name === "ai_spend_reserve_split"
      ? [{ reservation_id: "bench-reservation", allowed: true }] : null,
  });
  return { from: () => chain, rpc } as never;
}
