import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const WALK_TITLES = [
  "onboarding gate", "onboarding writes", "first Today", "log banana", "eaten reload",
  "week and strip", "body and settings", "coach context", "jobs", "cross-account isolation",
];
export const WALK_HYPOTHESES = [
  "components/AuthGate.tsx:98-121 renders children before its onboarding effect redirects.",
  "lib/profile/onboarding-client.ts:147-165 owns the four onboarding writes.",
  "design §2.1-2.3: a zero-food account resolves every scheduled slot empty and Today draws one"
    + " card per slot (lib/resolve.ts, components/SlotCard.tsx:153-173).",
  "design §2.2: an empty slot's own 'Log what you ate' opens LogFoodSheet with that slot"
    + " preselected (components/SlotCard.tsx:167-168).",
  "design §3.1-3.6/C3: a tick is a plan_days.eaten_slots entry the filled slot's tick writes"
    + " (components/SlotCard.tsx:192-207 → lib/plan-day-client.ts:184) and the next load reads back.",
  "app/week/page.tsx:97-99 and :134-135 resolve the local store and gate stat copy.",
  "app/layout.tsx:13-20 still owns person-specific metadata; app/settings/page.tsx mounts sections.",
  "lib/coach/prompt.ts:59-105 and lib/server/day-context.ts:152-176 build the coach context.",
  "lib/server/jobs.ts:31-35 selects job users from user_settings.",
  "lib/server/day-context.ts:152-176 contains the known unscoped legacy reads.",
];
export const WALK_USER_TABLES = [
  "ai_calls", "api_tokens", "change_log", "change_seq", "client_timings",
  "coach_intent_events", "coach_messages", "coach_threads", "constraint_profiles",
  "daily_health", "daily_totals", "duplicate_groups", "expenditure_estimates",
  "favorites_foods", "favorites_meals", "favorites_recipes", "food_facets",
  "food_membership_revisions", "gut_log", "health_samples", "health_source_status",
  "health_sources", "ingest_events", "job_runs", "log_entries", "media_objects", "oauth_states",
  "plan_days", "recipes", "target_profiles", "target_proposals", "user_food_prefs",
  "user_foods", "user_settings", "water_log", "weigh_ins",
];

export function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== "--baseline");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(" ")}`);
  return { baseline: argv.includes("--baseline") };
}

export function assertLocalSupabase(raw) {
  if (!raw) throw new Error("SUPABASE_TEST_URL is missing");
  let url;
  try { url = new URL(raw); } catch { throw new Error("SUPABASE_TEST_URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing non-local Supabase host: ${url.hostname || "unknown"}`);
  }
}

export function redact(value, exact = []) {
  let text = String(value ?? "");
  for (const secret of exact.filter(Boolean)) text = text.split(secret).join("<redacted>");
  return text
    .replace(/([?#&](?:access_token|refresh_token|token|token_hash|code)=)[^&#\s'\"`]+/gi,
      "$1<redacted>")
    .replace(/eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, "<redacted>")
    .replace(/\bsb_[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/postgres(?:ql)?:\/\/[^\s'\"`]+/gi, "<redacted>");
}

export function verdictFor(results, expected = 10) {
  return results.length === expected && results.every((result) => result.status === "PASS")
    ? "PASS" : "FAIL";
}

export async function poll(fn, { timeout = 10_000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw lastError ?? new Error(`Timed out after ${timeout} ms`);
}

/**
 * The local mailpit OTP for a fixture address. A local sign-in mail carries a link but no numeric
 * code, which is what `LOCAL_NO_OTP` tells the caller: the walkthrough then falls back to an
 * admin-generated magic link rather than pretending the real path worked.
 */
export const LOCAL_NO_OTP = "Local sign-in email contains a link but no numeric OTP";

/** A sign-in message's own links and addresses: neither ever carries the code. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()]+/gi;
const EMAIL_IN_TEXT = /[^\s"'<>()@,;]+@[^\s"'<>()@,;]+\.[A-Za-z]{2,}/g;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The code in one sign-in message's text, or null. Run 4 read the fixture's own address
 * (`newuser-w1-…-981623@example.test` carries six digits): a whole-message scan took that suffix as
 * the OTP, "Use the code" filled a code that was never sent, and the recorded reason became a
 * navigation timeout instead of LOCAL_NO_OTP. The address and every URL are removed first — neither
 * is ever the code.
 */
export function otpInMessage(body, email) {
  const address = String(email ?? "").trim();
  let text = String(body ?? "");
  if (address) {
    text = text.split(address).join(" ").replace(new RegExp(escapeForRegExp(address), "gi"), " ");
  }
  return text
    .replace(URL_IN_TEXT, " ")
    .replace(EMAIL_IN_TEXT, " ")
    .replace(/<[^>]*>/g, " ")
    .match(/\b\d{6,8}\b/g)?.at(-1) ?? null;
}

export async function otpFor(email) {
  const localpart = email.split("@")[0];
  const urls = [
    `http://127.0.0.1:54324/api/v1/mailbox/${encodeURIComponent(localpart)}`,
    `http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
  ];
  return poll(async () => {
    for (const url of urls) {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const messages = data.messages ?? [];
      if (messages.length === 0) continue;
      // Only the bodies are read; a listing's own metadata (ids, addresses, links) is not message text.
      let bodies = "";
      for (const message of messages) {
        bodies += `\n${message.Subject ?? ""}\n${message.Snippet ?? ""}`;
        const detail = await fetch(`http://127.0.0.1:54324/api/v1/message/${message.ID}`);
        if (!detail.ok) continue;
        const full = await detail.json();
        bodies += `\n${full.Subject ?? ""}\n${full.Text ?? ""}\n${full.HTML ?? ""}`;
      }
      const code = otpInMessage(bodies, email);
      if (code) return code;
      throw new Error(LOCAL_NO_OTP);
    }
    return null;
  }, { timeout: 10_000, interval: 250 });
}

export async function waitForReact(page, buttonText) {
  await page.waitForFunction((text) => {
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent?.includes(text));
    return !!button && Reflect.ownKeys(button).some((key) => String(key).startsWith("__reactProps"));
  }, buttonText);
}

async function packageIn(versionDir) {
  for (const hash of await readdir(versionDir)) {
    const candidate = join(versionDir, hash, "node_modules/playwright/index.mjs");
    try { await import(candidate); return candidate; } catch { /* try next store link */ }
  }
  return null;
}

export async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(process.env.PLAYWRIGHT_MODULE);
  try { return await import("playwright"); } catch { /* use the pnpm store */ }
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is missing; cannot locate Playwright");
  const root = join(home, "Library/pnpm/store/v11/links/@/playwright");
  let versions;
  try { versions = (await readdir(root)).sort().reverse(); }
  catch { throw new Error("Playwright is not installed; run `pnpm dlx playwright --version`"); }
  for (const version of versions) {
    const entry = await packageIn(join(root, version));
    if (entry) return import(entry);
  }
  throw new Error("Playwright package was not found in the pnpm store");
}

/** The seven slot labels (lib/meals.ts:115-123) mapped to their `plan_days.eaten_slots` key. */
export const SLOT_ID_BY_LABEL = {
  "Coffee": "coffee",
  "Pre-training carbs": "pouches-pre",
  "Post-training refuel": "post-refuel",
  "Meal 1": "meal-1",
  "Meal 2": "meal-2",
  "Meal 3": "meal-3",
  "Hot chocolate": "hot-chocolate",
};

/**
 * Today's tick, exactly as SlotCard writes it: `aria-label` "Mark <slot label> eaten"
 * (components/SlotCard.tsx:197). The same line writes "Mark <slot label> not eaten" on a slot that
 * is already ticked, and that label also ends in " eaten" — hence the `:not(...)`, so this matches
 * only the button that marks a slot eaten. It is rendered only on a slot that has a meal, so the
 * selector doubles as the check that a slot is planned — an empty day matches nothing.
 */
export const TICK = 'button[aria-label^="Mark "][aria-label$=" eaten"]:not([aria-label*=" not eaten"])';

/** "Mark Meal 1 eaten" → "meal-1"; null when the label is not one this app writes. */
export function slotIdFromTickLabel(label) {
  const name = String(label ?? "").replace(/^Mark\s+/, "").replace(/\s+(?:not\s+)?eaten$/, "");
  return SLOT_ID_BY_LABEL[name] ?? null;
}

/** The calorie ring's own numbers — `aria-label` "Calories: <consumed> of <target>" — parsed. */
export async function calorieOn(page) {
  const label = await page.locator('[role="img"][aria-label^="Calories:"]').first()
    .getAttribute("aria-label");
  const numbers = label?.match(/[\d,]+/g)?.map((n) => Number(n.replaceAll(",", ""))) ?? [];
  return { consumed: numbers[0] ?? null, target: numbers[1] ?? null, label };
}

/** The slot order per day type, copied from lib/plan.ts:43-47 (labels: lib/meals.ts:115-123). */
export const SLOT_ORDER = {
  "training-10": ["coffee", "pouches-pre", "meal-1", "meal-2", "meal-3"],
  "training-7-fasted": ["coffee", "post-refuel", "meal-1", "meal-2", "meal-3"],
  rest: ["coffee", "meal-1", "meal-2", "meal-3", "hot-chocolate"],
};

/** lib/plan.ts:27-37 dayTypeFor, over the fixture's own training weekdays and this date. */
export function fixtureDayTypeFor(dateIso, trainingWeekdays) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const dow = new Date(year, month - 1, day).getDay();
  if (!trainingWeekdays?.length || !trainingWeekdays.includes(dow)) return "rest";
  return dow === 3 ? "training-7-fasted" : "training-10";
}

/**
 * The slot cards the fixture's day draws — with no foods every one reads "Nothing planned yet.":
 * resolveDay rotates nothing until the account holds a food (lib/resolve.ts:175-178), so each
 * scheduled slot resolves with `meal === null` (components/SlotCard.tsx:153-173).
 */
export function scheduledSlotCount(dayType) {
  return SLOT_ORDER[dayType]?.length ?? 0;
}

/**
 * The h2 titles the Settings page mounts, in order (components/settings/Section.tsx draws them):
 * app/settings/page.tsx, then the Profile, Health, Targets, Water, Schedule and Data & account
 * sections. "Food preferences" left Settings on 2026-10-04 (U17).
 */
export const SETTINGS_SECTION_TITLES = [
  "Profile", "Body profile & units", "Health connections", "Goals & targets", "Water",
  "Schedule & reminders", "Data & account",
];

const WEEKDAY_COLUMNS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Today's cell on /week: an anchor whose `aria-label` reads "<Mon 20 Sep>, <status>"
 * (components/week/WeekGrid.tsx:31-35) with the words statusFor (:7-14) gives that day.
 */
export async function weekCell(page, dateIso) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const dow = new Date(year, month - 1, day).getDay();
  const prefix = `${WEEKDAY_COLUMNS[(dow + 6) % 7]} ${day} ${MONTH_NAMES[month - 1]}, `;
  const cell = page.locator(`[role="list"][aria-label="This week"] a[aria-label^="${prefix}"]`).first();
  const label = await cell.getAttribute("aria-label", { timeout: 15_000 }).catch(() => null);
  return { label, status: label?.startsWith(prefix) ? label.slice(prefix.length) : "" };
}

const APPLY_CARD = /^Put it in /;
const APPLYING_COPY = /Applying/;
const APPLIED_ACTION_KEY = "smc:coach-action:";
const APPLIED_ACTION_INDEX = "smc:coach-action:index";

async function conversationCopy(page, limit = 400) {
  const text = await page.locator('[aria-label="Conversation"]').innerText().catch(() => "");
  const seen = text || await page.locator("body").innerText().catch(() => "");
  return seen.replaceAll("\n", " ").slice(0, limit);
}

async function alertCopy(page) {
  const alerts = page.locator('[role="alert"]');
  const seen = await alerts.count();
  return seen === 0 ? "" : (await alerts.first().innerText()).trim().replaceAll("\n", " ").slice(0, 160);
}

/** The coach actions this device recorded as applied (lib/coach/apply-client.ts:30-32 and :65-77). */
async function appliedActionCount(page) {
  return page.evaluate(([key, indexKey]) => {
    try {
      const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]");
      if (!Array.isArray(ids)) return 0;
      return ids.filter((id) => {
        try { return JSON.parse(localStorage.getItem(`${key}${id}`) ?? "null")?.status === "applied"; }
        catch { return false; }
      }).length;
    } catch { return 0; }
  }, [APPLIED_ACTION_KEY, APPLIED_ACTION_INDEX]);
}

/**
 * The turn's own plan writes, finished. A composed card holds a `set_slot_meal` the user has to tap
 * — "Put it in <slot>" (components/CoachComposedCard.tsx:178-186) — and that tap mints the action
 * CoachShell then applies (components/coach/CoachShell.tsx:151-166); skip it and the slot stays
 * empty, so Today draws no tick. A turn can also carry its own pending action, which the same effect
 * applies without a tap; either way the page is not left mid-write.
 */
async function settleCoachWrites(page) {
  const cards = page.getByRole("button", { name: APPLY_CARD });
  const made = await cards.count();
  const before = await appliedActionCount(page);
  let tapped = "";
  if (made > 0) {
    const mealOne = page.getByRole("button", { name: /^Put it in breakfast/ }).first();
    const target = (await mealOne.count()) > 0 ? mealOne : cards.first();
    tapped = (await target.innerText()).trim().replaceAll("\n", " ");
    await target.click();
  }
  await poll(async () => {
    if ((await page.getByText(APPLYING_COPY).count()) > 0) return false;
    return tapped ? (await appliedActionCount(page)) > before : true;
  }, { timeout: 20_000, interval: 250 }).catch(async () => {
    const failure = await alertCopy(page);
    throw new Error(`${tapped || "the coach's own action"} did not apply${failure ? `: ${failure}` : ""}`);
  });
  if (tapped) return `applied ${tapped}`;
  return before > 0 ? "an earlier coach action was already applied" : "no composed card to apply";
}

/**
 * Step 5's real path to a tick. An empty slot has no tick at all — SlotCard returns the empty card
 * (components/SlotCard.tsx:153-173) before the tick it draws on a planned one (:192-207) — so the
 * only way a brand-new account can tick anything is to give a slot a meal first. The action the
 * empty card offers for that is "Plan with the coach" (components/SlotCard.tsx:165-166), which
 * opens the coach carrying this date and slot. This drives that action, sends one turn, applies the
 * meal the turn composed, and waits for every write to settle; the caller then looks for a tick.
 */
export async function planSlotWithCoach(page, request) {
  await page.getByRole("button", { name: "Plan with the coach" }).first().click();
  await page.waitForURL((url) => url.pathname === "/coach", { timeout: 10_000 });
  const input = page.getByLabel("Message the coach");
  const composer = await input.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  if (!composer) {
    throw new Error(`the coach has no composer: ${await conversationCopy(page, 160)}`);
  }
  // A draft-carrying arrival may already have filled the box; an empty one gets the request.
  if (!(await input.inputValue()).trim()) await input.fill(request);
  await page.getByRole("button", { name: "Send" }).click();
  await poll(async () => (await page.locator('[aria-label="Conversation"] p').count()) >= 2,
    { timeout: 60_000, interval: 250 })
    .catch(async () => { throw new Error(`the coach turn never answered: ${await conversationCopy(page)}`); });
  const reply = (await page.locator('[aria-label="Conversation"] p').last().innerText()).slice(0, 400);
  return `${reply} [${await settleCoachWrites(page)}]`;
}

/**
 * Tick the first planned slot on Today, wait for the row the coach context reads to carry the tick
 * (the handler is fire-and-forget: app/page.tsx toggleEaten → saveEatenSlot through the outbox, so a
 * reload straight after the click re-read a row with no tick and painted "Mark <slot> eaten"
 * again), then reload and read the label back.
 */
export async function tickFirstPlannedSlot(page, { admin, userId, date, timeout = 20_000 }) {
  const offered = await poll(async () => page.locator(TICK).count(), { timeout: 30_000, interval: 250 })
    .catch(() => 0);
  if (!offered) {
    return { missing: true, label: "", slotId: null, persisted: false, onServer: false, keys: [] };
  }
  const mark = page.locator(TICK).first();
  const label = (await mark.getAttribute("aria-label")) ?? "";
  const slotId = slotIdFromTickLabel(label);
  await mark.click();
  const server = await poll(async () => {
    const response = await admin.from("plan_days").select("eaten_slots")
      .eq("user_id", userId).eq("local_date", date).maybeSingle();
    if (response.error) throw new Error(`plan day: ${response.error.message}`);
    const row = response.data?.eaten_slots?.[slotId ?? ""];
    return row?.eaten_at
      ? { at: row.eaten_at, keys: Object.keys(response.data.eaten_slots ?? {}) } : null;
  }, { timeout, interval: 250 })
    .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  await page.reload({ waitUntil: "domcontentloaded" });
  const persisted = await poll(async () =>
    page.locator(`button[aria-label="${label.replace(" eaten", " not eaten")}"]`).count(),
  { timeout: 8_000 }).then(Boolean).catch(() => false);
  return { missing: false, label, slotId, persisted, onServer: slotId !== null && Boolean(server.at),
    keys: server.keys ?? [], at: server.at, error: server.error };
}

export function markdownReceipt({ results, meta }) {
  const lines = [
    "# W1 baseline — brand-new account walkthrough",
    "",
    `Date: ${meta.date}`,
    `Target: \`${meta.target}\` (local Docker Supabase only)`,
    `Auth path: ${meta.authPath}`,
    `Fixture emails: ${meta.fixtureEmails.join(", ")}`,
    `Cleanup: ${meta.cleanup}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## Step ${result.step} — ${result.title}`, "", `Command: \`${result.command}\``, "",
      `Observation: ${result.observation}`, "", `Result: **${result.status}**`, "",
      `Hypothesis: ${result.hypothesis}`, "", `Screenshot: \`${result.screenshot}\``, "");
  }
  lines.push("## Summary", "", "| Step | Result | Hypothesis |", "|---:|:---:|---|");
  for (const result of results) {
    lines.push(`| ${result.step} | ${result.status} | ${result.hypothesis.replaceAll("|", "\\|")} |`);
  }
  lines.push("", `**VERDICT: ${verdictFor(results)}**`, "");
  return lines.join("\n");
}
