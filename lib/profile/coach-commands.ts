/**
 * The coach's command grammar (Phase 18 W5b, Sol r3 BLOCK 1): the WHOLE-MESSAGE forms the intent
 * pre-pass may send to Jev although the taste safety check did not clear the text. A message
 * qualifies only when all of it — trimmed, one sentence with at most one closing mark, no second
 * clause — is exactly one form below with allowed arguments: a food name made of known food words
 * (lib/profile/taste-words.ts FOOD_WORDS), a number, a unit. Anything else that the check did not
 * clear makes no intent Jev call: the deterministic parser or the main coach path answers it.
 *
 * Forms: log water, log weight, add to / remove from a list, avoid or unavoid a food, move meals,
 * suggest options, "a <food> that fits my macros", "what should I eat", set a target, state an
 * age, show a chart, log a food.
 *
 * Pure. No I/O.
 */
import { FOOD_WORDS } from "@/lib/profile/taste-words";

const words = (list: string) => new Set(list.split(" "));

const NUMBER_WORDS = words("a an one two three four five six seven eight nine ten half some few couple");
const isNumber = (token: string) => /^\d+(\.\d+)?$/.test(token) || NUMBER_WORDS.has(token);
const VOLUME = words("ml milliliter milliliters millilitre millilitres l liter liters litre litres oz ounce ounces cup cups glass glasses bottle bottles can cans");
const MASS = words("kg kgs kilo kilos lb lbs pound pounds");
const TIME = words("min mins minute minutes hour hours hr hrs h");
const SLOTS = words("meal meals breakfast lunch dinner snack snacks everything all my the today tonight remaining rest of day");
const LISTS = "(eats|avoid|favou?rites?|favored|favorite)";
const CALENDAR = words("next this every each weekday weekdays weekend week weeks month months day days morning "
  + "monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays thursdays fridays "
  + "as to my the on until starting from");

const isFood = (token: string) => FOOD_WORDS.has(token) || FOOD_WORDS.has(token.replace(/e?s$/, ""))
  || FOOD_WORDS.has(token.replace(/ies$/, "y"));

/** A food name: one to six food words, joined only by "and" / "with", starting and ending on food. */
function foodName(phrase: string): boolean {
  const tokens = phrase.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.length <= 6 && isFood(tokens[0]) && isFood(tokens[tokens.length - 1])
    && tokens.every((t) => isFood(t) || t === "and" || t === "with");
}

/** A food entry: food words, numbers, units, and the slot it was eaten in. */
function foodEntry(phrase: string): boolean {
  const tokens = phrase.split(" ").filter(Boolean);
  const allowed = (t: string) => isFood(t) || isNumber(t) || t === "meal"
    || VOLUME.has(t) || MASS.has(t) || words("g grams gram slice slices piece pieces bowl bowls and with of for breakfast lunch dinner snack "
      + "grilled roasted baked fried steamed boiled scrambled poached raw cooked toasted smoked plain").has(t);
  return tokens.length > 0 && tokens.length <= 12 && tokens.every(allowed) && tokens.some(isFood);
}

const only = (rest: string, ok: (token: string) => boolean) => {
  const tokens = rest.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every(ok);
};

type Form = (message: string) => boolean;

const FORMS: readonly Form[] = [
  // Water: "16 oz water", "drank 500 ml", "I drank 2 cups of water", "2 cups then 500 ml", "drank some water".
  (m) => {
    const rest = m.replace(/^(?:i )?(?:drank|had|log|logged) /, "");
    const tokens = rest.split(" ").filter(Boolean);
    return only(rest, (t) => isNumber(t) || VOLUME.has(t) || ["of", "water", "then", "and"].includes(t))
      && (tokens.includes("water") || tokens.some((t) => VOLUME.has(t)));
  },
  // Weight: "I weigh 128 lb", "58 kg today", "weighed in".
  (m) => /^(?:i )?weighed in(?: today)?$/.test(m)
    || /^(?:i weigh|i weighed|weighed|my weight is|log my weight(?: as)?) (\d+(?:\.\d+)?) ?(?:kg|kgs|kilos?|lbs?|pounds?)?(?: today| this morning)?$/.test(m)
    || /^\d+(?:\.\d+)? ?(?:kg|kgs|kilos?|lbs?|pounds?)(?: today| this morning)?$/.test(m),
  // Lists: "add cheese to my avoid list", "remove salmon from my eats".
  (m) => {
    const found = new RegExp(`^(?:please )?(?:add|put|remove|take|drop) (.+?) (?:to|on|onto|from|off) (?:my|the) ${LISTS}(?: list)?$`).exec(m);
    return found !== null && foodName(found[1]);
  },
  (m) => m === "drop it" || ((/^(?:please )?(?:avoid|unavoid) (.+)$/.exec(m)?.[1]) !== undefined
    && foodName(/^(?:please )?(?:avoid|unavoid) (.+)$/.exec(m)![1])),
  // Schedule: "move my meals 30 minutes later", "push everything back an hour", "move lunch by 20 min".
  (m) => {
    const found = /^(?:can you |please )?(?:move|shift|push|bump|delay|pull) (.+)$/.exec(m);
    return found !== null && only(found[1], (t) => SLOTS.has(t) || TIME.has(t) || isNumber(t) || /^meal-\d$/.test(t)
      || words("by later earlier back forward to until").has(t));
  },
  // Suggestions: "make me 5 suggestions from my eats list", "suggest a snack that fits my remaining macros".
  (m) => {
    const found = /^(?:make me|give me|suggest|show me|find)(?: (.+))?$/.exec(m);
    return found !== null && only(found[1] ?? "", (t) => isNumber(t) || SLOTS.has(t) || /^meal-\d$/.test(t)
      || isFood(t)
      || words("option options idea ideas suggestion suggestions more for from eats list favorites favourites that fits fit macros recipe recipes").has(t));
  },
  (m) => {
    const found = /^(?:a|an|some) (.+?) that fits? my(?: remaining)? macros$/.exec(m);
    return found !== null && foodName(found[1]);
  },
  (m) => /^what should i (?:eat|have)(?: for (?:breakfast|lunch|dinner|a snack|snack|today|tonight|meal \d))?$/.test(m),
  // Targets, age, charts.
  (m) => /^set (?:my )?(?:kcal|calories|calorie target|protein)(?: target)? to \d+(?: ?(?:kcal|g|grams))?$/.test(m),
  (m) => /^i(?:'m| am) \d{2}(?: years old)?$/.test(m),
  (m) => /^show (?:me )?(?:my )?(?:weight|macros|calories|kcal)(?: trend| chart| this week| today)?$/.test(m),
  // Plan a meal: "set my breakfast to oatmeal with blueberries every weekday for the next two weeks",
  // "change next tuesday's lunch to grilled chicken and rice".
  (m) => {
    const found = /^(?:set|change|plan|make|put) (.+)$/.exec(m);
    return found !== null && /\b(breakfast|lunch|dinner|snack|meal)\b/.test(found[1]) && foodEntry(found[1].split(" ")
      .filter((t) => !CALENDAR.has(t.replace(/'s$/, ""))).join(" "));
  },
  (m) => /^how am i doing(?: this week| today)?$/.test(m)
    || /^how many (?:calories|kcal|grams of protein) (?:do i have left|have i had|are left)(?: today)?$/.test(m),
  // Log a food: "log 2 eggs and toast", "I had a banana".
  (m) => {
    const found = /^(?:log|i had|i ate|had|ate) (.+)$/.exec(m);
    return found !== null && foodEntry(found[1]);
  },
];

/** A second sentence or clause, or a reason, anywhere in the message. */
const SECOND_CLAUSE = /[,;:!?]|\.(?!\d)|\b(because|after|since|so|when|while|but|though|although|unless|if|cause|cuz|coz|then i)\b/;

/** True when the whole message is exactly one coach command form with allowed arguments. */
export function isCoachCommand(normalized: string): boolean {
  const message = normalized.trim().replace(/[.?!]$/, "").trim()
    // A time offset in front of a command: "in 30 min, log 2 cups of water".
    .replace(/^in \d+ ?(?:min|mins|minutes|hours?|h),? /, "")
    // A comma inside a list of foods is not a clause: "two slices of toast, bacon and eggs".
    .replace(/([a-z]+), (?=([a-z]+))/g, (hit, before: string, after: string) => (isFood(before) && isFood(after) ? `${before} and ` : hit));
  if (message.length === 0 || message.length > 120 || SECOND_CLAUSE.test(message)) return false;
  return FORMS.some((form) => form(message));
}
