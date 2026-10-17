/**
 * `ai_calls.error` for a call the caller stopped (its own abort, or a Jev latency budget it set
 * itself): the provider was not unwell, so lib/ai/circuit.ts never counts it (W068). Recorded
 * under the `timeout` status, which the status check already allows.
 */
export const CALLER_ABORT_ERROR = "caller_abort";
