/**
 * The country picker's choices (Phase 18 W5, Settings only — D2 asks no country in onboarding):
 * "Prefer not to say" (stored as null), the United States (the one country with the population
 * prior, W5), then every other ISO 3166-1 alpha-2 code by its English name.
 * The names come from `Intl.DisplayNames`, so no country name is kept here. The value is only ever
 * what the user picks: never read from a time zone, a locale or a location.
 *
 * Pure. No I/O.
 */
import { parseCountryCode } from "@/lib/profile/cuisines";

/** ISO 3166-1 alpha-2, every officially assigned code (249). */
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT "
  + "BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH "
  + "ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT "
  + "HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS "
  + "LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI "
  + "NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG "
  + "SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG "
  + "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** The picker's value for "no country": the empty string, stored as null. */
export const NO_COUNTRY = "";
export const NO_COUNTRY_LABEL = "Prefer not to say";
const PRIOR_COUNTRY = "US";

export type CountryOption = { value: string; label: string };

let names: Intl.DisplayNames | null = null;

/** A code's English name, or the code itself where the runtime has no name for it. */
export function countryName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

let options: CountryOption[] | null = null;

export function countryOptions(): CountryOption[] {
  options ??= [
    { value: NO_COUNTRY, label: NO_COUNTRY_LABEL },
    { value: PRIOR_COUNTRY, label: countryName(PRIOR_COUNTRY) },
    ...COUNTRY_CODES.filter((code) => code !== PRIOR_COUNTRY)
      .map((code) => ({ value: code, label: countryName(code) }))
      .sort((a, b) => a.label.localeCompare(b.label, "en")),
  ];
  return options;
}

/** The picker's value for a stored country: a listed code, else "no country". */
export function countryValue(stored: unknown): string {
  const code = parseCountryCode(stored);
  return code !== null && COUNTRY_CODES.includes(code) ? code : NO_COUNTRY;
}

/** What a picked value stores: a listed code, or null for "Prefer not to say" and anything else. */
export function countryFromValue(value: string): string | null {
  return COUNTRY_CODES.includes(value) ? value : null;
}
