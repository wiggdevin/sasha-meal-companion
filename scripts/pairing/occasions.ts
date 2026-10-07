/**
 * Reads the NHANES Day 1 individual-food files into in-memory eating occasions for the W1c
 * co-consumption feature (Phase 18 D8 part 5, D10). Offline build only; runs only while the NCHS
 * gate is open (scripts/pairing/build.ts).
 *
 * An occasion is one respondent's foods that share a recall time and an eating-occasion name. The
 * respondent sequence number joins the files here and goes no further: an occasion carries an array
 * position for its respondent, never the survey id. Occasions are never written to disk; only the
 * aggregate pair rates computed from them leave the build (H1, H2). Race and ethnicity are not read
 * (H5).
 *
 * The population is the W1b root's: adults 18 and over with a complete, reliable Day 1 recall and
 * a positive day weight. The eating-occasion name maps to a meal template; drinks, extended
 * consumption, infant feeding and unknown names are left out.
 */
import { join } from "node:path";
import { ADULT_AGE } from "@/lib/foods/universe/prior";
import type { TemplateKey } from "@/lib/meals/templates";
import { RELEASES } from "@/scripts/priors/nhanes";
import { numbers, readXpt } from "@/scripts/priors/xpt";

/**
 * NHANES eating-occasion codes onto meal templates (English and Spanish names as the survey records
 * them): breakfast 1 Breakfast, 5 Brunch, 10 Desayuno; main 2 Lunch, 3 Dinner, 4 Supper,
 * 11 Almuerzo, 12 Comida, 14 Cena; snack 6 Snack, 13 Merienda, 15 Entre comida, 16 Botana,
 * 17 Bocadillo, 18 Tentempie. Out: 7 Drink, 19 Bebida, 8 Infant feeding, 9 Extended consumption,
 * 91 Other, 99 Don't know.
 */
export const OCCASION_TEMPLATES: Readonly<Record<number, TemplateKey>> = {
  1: "breakfast", 5: "breakfast", 10: "breakfast",
  2: "main", 3: "main", 4: "main", 11: "main", 12: "main", 14: "main",
  6: "snack", 13: "snack", 15: "snack", 16: "snack", 17: "snack", 18: "snack",
};

export const OCCASION_RULE = "Day 1 recall, one respondent's foods sharing a recall time and an eating-occasion name; "
  + "breakfast = Breakfast, Brunch, Desayuno; main = Lunch, Dinner, Supper, Almuerzo, Comida, Cena; "
  + "snack = Snack, Merienda, Entre comida, Botana, Bocadillo, Tentempie; drinks and the rest left out";

export type Occasion = {
  /** Array position of the respondent in this build (never the survey id). */
  respondent: number;
  release: number;
  cluster: number;
  stratum: number;
  /** Day 1 dietary weight divided by the number of releases pooled. */
  weight: number;
  template: TemplateKey;
  /** Grams per food code in this occasion. */
  foods: Map<string, number>;
};

export type OccasionFrame = { occasions: Occasion[]; respondents: number; clusters: number; strata: number };

export function loadOccasions(workspace: string, releases = RELEASES): OccasionFrame {
  const clusters = new Map<string, number>();
  const strata = new Map<string, number>();
  const byKey = new Map<string, Occasion>();
  const occasions: Occasion[] = [];
  let respondents = 0;
  releases.forEach((release, releaseIndex) => {
    const demo = readXpt(join(workspace, release.demo), ["SEQN", "RIDAGEYR", "SDMVPSU", "SDMVSTRA"]);
    const tot = readXpt(join(workspace, release.tot[1]), ["SEQN", "DR1DRSTZ", release.weight[1]]);
    const iff = readXpt(join(workspace, release.iff[1]), ["SEQN", "DR1IFDCD", "DR1IGRMS", "DR1_020", "DR1_030Z"]);
    const weightOf = new Map<number, number>();
    const totId = numbers(tot, "SEQN"), status = numbers(tot, "DR1DRSTZ"), weight = numbers(tot, release.weight[1]);
    for (let i = 0; i < tot.rows; i += 1) if (status[i] === 1 && weight[i] > 0) weightOf.set(totId[i], weight[i]);
    const id = numbers(demo, "SEQN"), age = numbers(demo, "RIDAGEYR"), psu = numbers(demo, "SDMVPSU"), stratum = numbers(demo, "SDMVSTRA");
    const person = new Map<number, { index: number; cluster: number; stratum: number; weight: number }>();
    for (let i = 0; i < demo.rows; i += 1) {
      const dayWeight = weightOf.get(id[i]);
      if (dayWeight === undefined || !(age[i] >= ADULT_AGE)) continue;
      const clusterKey = `${release.label}:${stratum[i]}:${psu[i]}`, stratumKey = `${release.label}:${stratum[i]}`;
      if (!clusters.has(clusterKey)) clusters.set(clusterKey, clusters.size);
      if (!strata.has(stratumKey)) strata.set(stratumKey, strata.size);
      person.set(id[i], { index: respondents, cluster: clusters.get(clusterKey)!, stratum: strata.get(stratumKey)!,
        weight: dayWeight / releases.length });
      respondents += 1;
    }
    const foodId = numbers(iff, "SEQN"), code = numbers(iff, "DR1IFDCD"), grams = numbers(iff, "DR1IGRMS");
    const time = numbers(iff, "DR1_020"), name = numbers(iff, "DR1_030Z");
    for (let i = 0; i < iff.rows; i += 1) {
      const who = person.get(foodId[i]);
      const template = OCCASION_TEMPLATES[name[i]];
      if (!who || !template || !(grams[i] > 0) || !Number.isFinite(code[i]) || !Number.isFinite(time[i])) continue;
      const key = `${who.index}|${time[i]}|${name[i]}`;
      let occasion = byKey.get(key);
      if (!occasion) {
        occasion = { respondent: who.index, release: releaseIndex, cluster: who.cluster, stratum: who.stratum,
          weight: who.weight, template, foods: new Map() };
        byKey.set(key, occasion);
        occasions.push(occasion);
      }
      const food = String(code[i]);
      occasion.foods.set(food, (occasion.foods.get(food) ?? 0) + grams[i]);
    }
  });
  return { occasions, respondents, clusters: clusters.size, strata: strata.size };
}
