/**
 * Loads the W1b server-only artifacts (Phase 18 D10) from `lib/foods/universe/artifacts/`, with
 * the NCHS gate on the NHANES-derived table. The population prior loads only when all hold:
 *   - the owner's ruling file exists at NHANES_RULING_PATH;
 *   - its current sha256 equals the approved pin (NHANES_RULING_SHA256), so a refusal or any edit
 *     at the same path shuts the gate;
 *   - the manifest parses under the strict schema and names that path and that hash;
 *   - the table parses under the strict schema.
 * Otherwise the prior is neutral (`P_f = 0`), the reason is logged once, and the rest of the
 * model still works. The substitute graph is not NHANES-derived and loads either way.
 *
 * Nothing in the app reads these yet (the universe stays inert until W2b/W7). A server route that
 * calls them must trace both the artifact files and the ruling file into its bundle
 * (`outputFileTracingIncludes`), or the gate reads the ruling as missing and stays neutral.
 */
import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, parsePriorRows, parseSubstituteGraph } from "@/lib/foods/universe/artifact-schema";
import {
  accountPrior, ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NHANES_RULING_PATH, NHANES_RULING_SHA256, PRIOR_COUNTRY,
  PRIOR_FILE, priorFromRows, type AccountPrior, type NeutralReason, type PopulationPrior, type PriorAccount,
} from "@/lib/foods/universe/prior";
import type { SubstituteGraph } from "@/lib/foods/universe/substitutes";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The current ruling file's sha256, or null when it is missing. */
export function rulingHash(root: string): string | null {
  const path = join(root, NHANES_RULING_PATH);
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** Why the gate is shut under `root`, or null when it is open. */
export function nchsGateReason(root: string): NeutralReason | null {
  const hash = rulingHash(root);
  if (hash === null) return "ruling_missing";
  if (hash !== NHANES_RULING_SHA256) return "ruling_changed";
  const manifest = parseManifest(readJson(join(root, ARTIFACT_DIR, MANIFEST_FILE)));
  if (!manifest) return "manifest_invalid";
  if (manifest.ruling?.path !== NHANES_RULING_PATH || manifest.ruling.sha256 !== hash) return "manifest_unnamed";
  return null;
}

export function nchsGateOpen(root: string): boolean {
  return nchsGateReason(root) === null;
}

const logged = new Set<string>();

function neutral(reason: NeutralReason): PopulationPrior {
  if (!logged.has(reason)) {
    logged.add(reason);
    console.warn(`[population-prior] neutral prior (P_f = 0): ${reason}`);
  }
  return { status: "neutral", reason };
}

export function loadPopulationPrior(root: string = process.cwd()): PopulationPrior {
  const reason = nchsGateReason(root);
  if (reason) return neutral(reason);
  const path = join(root, ARTIFACT_DIR, PRIOR_FILE);
  if (!existsSync(path)) return neutral("artifact_missing");
  const rows = parsePriorRows(readJson(path));
  const prior = rows ? priorFromRows(rows) : null;
  return prior?.status === "loaded" ? prior : neutral("artifact_invalid");
}

/**
 * The prior one account gets on `onDate` (D2): the gated table only when the account chose the
 * U.S. A non-U.S. or unset country reads no file at all and is neutral.
 */
export function loadAccountPrior(account: PriorAccount, onDate: string, root: string = process.cwd()): AccountPrior {
  const loaded: PopulationPrior = account.countryCode === PRIOR_COUNTRY
    ? loadPopulationPrior(root) : { status: "neutral", reason: "country_not_us" };
  return accountPrior(loaded, account, onDate);
}

export function loadSubstituteGraph(root: string = process.cwd()): SubstituteGraph | null {
  return parseSubstituteGraph(readJson(join(root, ARTIFACT_DIR, GRAPH_FILE)));
}
