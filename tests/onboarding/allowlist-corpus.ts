/**
 * Onboarding v2 allowlist gate corpora (tests/onboarding/allowlist-gate.test.ts).
 * MEDICINE_AND_CONDITION: brand and generic medicines and conditions, said the ways an opener
 * would say them. NORMAL_OPENERS: ordinary goal, body and routine statements.
 */

/** Every medicine sentence the final Sol reviews named (r1 aspirin, r2 amoxicillin). */
export const SOL_REVIEW_MEDICINE: readonly string[] = [
  "I take aspirin daily and want to lose weight.",
  "I take amoxicillin and want to lose weight.",
];

export const MEDICINE_AND_CONDITION: readonly string[] = [
  "I'm on metformin and want to lose 20 pounds",
  "lisinopril every morning, 5'9, 190 lb, want to drop weight",
  "I started sertraline last year and gained 25 pounds",
  "on levothyroxine, female, 34, want to lose fat",
  "I use Ozempic now and want to keep losing",
  "insulin twice a day, want to build muscle",
  "my doctor put me on a statin, want to lose weight",
  "doc put me on something for my heart, want to get fit",
  "I'm 52, 5 foot 4, 160, Mounjaro since spring",
  "zoloft made me gain weight, want to lose 15 lb",
  "lose 30 pounds, wegovy weekly",
  "prednisone bloated me, trying to drop 10",
  "I have hypothyroidism and want to lose weight",
  "type 2, want to lose 40 pounds",
  "PCOS makes it hard to lose weight",
  "high blood pressure, 6 ft, 240, want to lose",
  "I'm prediabetic and want to cut fat",
  "metoprolol 25 at night, want to train more",
  "on atorvastatin and amlodipine, I want to lose weight",
  "I'm on gabapentin for nerve pain, want to tone up",
  "I take adderall so I skip breakfast",
  "jardiance plus metformin, want to lose weight",
  "I'm on keppra, 28, want to build muscle",
  "lexapro 10 mg, lost 12 lb, want to keep going",
  "I use an albuterol inhaler when I run",
  "on spironolactone for acne, want to lose fat",
  "taking vitamin d and iron, 5'3, 130",
  "I'm on HRT, menopause weight gain, 55",
  "Synthroid each morning, want to recomp",
  "my endo says I should lose 20 lb",
  "eliquis and losartan, 70, want to walk more",
  "I'm on Tirzepatide shots, 44, want to keep muscle",
  "I take Lasix for swelling and want to lose weight",
  "on Humira for crohns, want to gain weight",
  "I'm recovering from heart surgery, want to walk daily",
];

/** Final Sol review r3 (BLOCK: "I have a fit every week") and the sweep after it: sentences made
 *  only of onboarding-shaped words that still name a health event, an injury, self-harm, a
 *  pregnancy or an eating rule. */
export const DUAL_MEANING: readonly string[] = [
  "I have a fit every week",
  "I had a fit last month",
  "I cut myself every week",
  "I fast every week",
  "I fast 3 days a week",
  "I have a stone",
  "I have a mass",
  "my cycle is every 28 days",
  "my back is out",
  "I have drop foot",
  "my feet are bad",
  "my body is done",
  "I went into labor 2 weeks ago",
  "I'm 20 weeks",
  "I'm about 5 months along",
  "3 months postpartum, want to lose weight",
  "I'm run down all the time",
  "I want to eat under 800 a day",
  "I skip meals to lose weight",
  "I'm heavy every month",
];

export const NORMAL_OPENERS: readonly string[] = [
  "lose 20 pounds, I'm 34, 5 foot 6, 170",
  "I want to lose weight",
  "I'm 28, male, 6 ft, 190 lb, want to build muscle",
  "female, 41, 5'4\", 165 lbs, lose fat",
  "I want to get stronger and lift 4 days a week",
  "maintain my weight, I walk every day",
  "34 year old woman, 160 cm, 70 kg, want to tone up",
  "I lift Monday Wednesday Friday and want to gain muscle",
  "desk job, mostly sitting, want to lose about 15 lbs",
  "I want to drop 10 pounds slowly",
  "Born 1990, 5'10, 180, I run 3 times a week",
  "I'd like to recomp, gym 5 days a week",
  "I eat 3 meals a day, first meal around 8am",
  "I don't cook much, quick meals please",
  "Gaining weight is the goal, I'm 6 ft 1",
  "I'm a guy, 25, 175 lbs, want to bulk",
  "want to lose fat and build muscle, I'm 30",
  "I work out in the mornings before work",
  "I'm pretty active, on my feet all day at work",
  "I want to get fit and lose a little weight",
];
