/**
 * Measures the OFF per-IP read limit — Phase 3 spec open question 1, architecture §10, deferred
 * to this phase. Thirty sequential reads of known GTINs through the real fetcher, printing the
 * status and the rate-limit headers so the outbound budget in contracts §2 can stop being a
 * guess. Record the answer in docs/specs/phase-3-fast-capture.md "Open questions".
 *
 * [needs network] [never in CI] — run by hand at the integration stage:
 *   pnpm exec tsx scripts/off-rate-probe.ts
 */
import { fetchOffProduct, isProviderFailure, OFF_FIELDS, OFF_USER_AGENT } from "@/lib/catalog/off";

const GTINS = [
  "04006381333931", "00602652171000", "00038000138416", "00016000275263", "00021000658930",
  "00028400090063", "00044000032029", "00070847811169", "00013000001328", "00012000001086",
];

async function main(): Promise<void> {
  console.log(`user-agent: ${OFF_USER_AGENT}`);
  console.log(`fields: ${OFF_FIELDS.join(",")}`);
  const started = Date.now();
  for (let i = 0; i < 30; i += 1) {
    const gtin = GTINS[i % GTINS.length];
    const at = Date.now();
    const result = await fetchOffProduct(gtin);
    const outcome = isProviderFailure(result) ? `FAIL ${String(result.status)}` : "ok";
    console.log(
      `${String(i + 1).padStart(2, "0")}  ${gtin}  ${outcome}  ${Date.now() - at} ms  ` +
      `t+${Math.round((Date.now() - started) / 1000)} s`
    );
  }
  console.log("Record the first refusal (if any) and its headers in the Phase 3 spec, open question 1.");
}

void main();
