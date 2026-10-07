/**
 * Reads one NHANES release's recall day into in-memory respondent frames (offline build only,
 * Phase 18 W1b). The respondent sequence number joins the demographics, totals and individual-food
 * files here and goes no further: a frame carries an array position, never the survey id. Frames
 * are never written to disk; only the aggregates computed from them leave the build (H1, H2).
 *
 * A respondent counts when the day's recall is complete and reliable (status 1), the day weight is
 * positive, and the age is 2 or over (the WWEIA reporting population; infants are out).
 * The race and Hispanic-origin field is read for the offline fairness audit only (H5) and never
 * enters a cohort key or an artifact.
 */
import { join } from "node:path";
import { raw } from "@/scripts/priors/sources";
import { numbers, readXpt } from "@/scripts/priors/xpt";

export type Day = 1 | 2;
export type Sex = "male" | "female";

export type Respondent = {
  release: number;
  /** Index into the run's cluster list ("<release>:<stratum>:<psu>"). */
  cluster: number;
  stratum: string;
  sex: Sex;
  age: number;
  /** Offline fairness audit only (H5). Never in a cohort, a table or a manifest. */
  auditGroup: number;
  /** The day's dietary weight divided by the number of releases pooled. */
  weight: number;
  /** Grams per food code eaten that day. */
  foods: Map<string, number>;
};

export type ReleaseFiles = { label: string; demo: string; tot: Record<Day, string>; iff: Record<Day, string>;
  weight: Record<Day, string> };

export const RELEASES: readonly ReleaseFiles[] = [
  { label: "2017-2020", demo: raw("P_DEMO"), tot: { 1: raw("P_DR1TOT"), 2: raw("P_DR2TOT") },
    iff: { 1: raw("P_DR1IFF"), 2: raw("P_DR2IFF") }, weight: { 1: "WTDRD1PP", 2: "WTDR2DPP" } },
  { label: "2021-2023", demo: raw("DEMO_L"), tot: { 1: raw("DR1TOT_L"), 2: raw("DR2TOT_L") },
    iff: { 1: raw("DR1IFF_L"), 2: raw("DR2IFF_L") }, weight: { 1: "WTDRD1", 2: "WTDR2D" } },
];

export const MIN_AGE = 2;

/** Respondents of every release for one day, with the shared cluster index. */
export function loadDay(workspace: string, day: Day, releases = RELEASES): { respondents: Respondent[]; clusters: string[] } {
  const clusters: string[] = [];
  const clusterIndex = new Map<string, number>();
  const respondents: Respondent[] = [];
  releases.forEach((release, releaseIndex) => {
    const demo = readXpt(join(workspace, release.demo), ["SEQN", "RIAGENDR", "RIDAGEYR", "RIDRETH3", "SDMVPSU", "SDMVSTRA"]);
    const tot = readXpt(join(workspace, release.tot[day]), ["SEQN", `DR${day}DRSTZ`, release.weight[day]]);
    const iff = readXpt(join(workspace, release.iff[day]), ["SEQN", `DR${day}IFDCD`, `DR${day}IGRMS`]);
    const id = numbers(demo, "SEQN"), sex = numbers(demo, "RIAGENDR"), age = numbers(demo, "RIDAGEYR");
    const group = numbers(demo, "RIDRETH3"), psu = numbers(demo, "SDMVPSU"), stratum = numbers(demo, "SDMVSTRA");
    const byId = new Map<number, Respondent>();
    const totId = numbers(tot, "SEQN"), status = numbers(tot, `DR${day}DRSTZ`), weight = numbers(tot, release.weight[day]);
    const totById = new Map<number, number>();
    for (let i = 0; i < tot.rows; i += 1) if (status[i] === 1 && weight[i] > 0) totById.set(totId[i], weight[i]);
    for (let i = 0; i < demo.rows; i += 1) {
      const dayWeight = totById.get(id[i]);
      if (dayWeight === undefined || !(age[i] >= MIN_AGE) || (sex[i] !== 1 && sex[i] !== 2)) continue;
      const clusterKey = `${release.label}:${stratum[i]}:${psu[i]}`;
      if (!clusterIndex.has(clusterKey)) { clusterIndex.set(clusterKey, clusters.length); clusters.push(clusterKey); }
      const respondent: Respondent = {
        release: releaseIndex, cluster: clusterIndex.get(clusterKey)!, stratum: `${release.label}:${stratum[i]}`,
        sex: sex[i] === 1 ? "male" : "female", age: age[i], auditGroup: group[i],
        weight: dayWeight / releases.length, foods: new Map(),
      };
      byId.set(id[i], respondent);
      respondents.push(respondent);
    }
    const foodId = numbers(iff, "SEQN"), code = numbers(iff, `DR${day}IFDCD`), grams = numbers(iff, `DR${day}IGRMS`);
    for (let i = 0; i < iff.rows; i += 1) {
      const respondent = byId.get(foodId[i]);
      if (!respondent || !(grams[i] > 0) || !Number.isFinite(code[i])) continue;
      const key = String(code[i]);
      respondent.foods.set(key, (respondent.foods.get(key) ?? 0) + grams[i]);
    }
  });
  return { respondents, clusters };
}
