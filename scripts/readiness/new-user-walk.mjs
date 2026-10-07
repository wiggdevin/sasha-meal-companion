#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import {
  assertLocalSupabase, calorieOn, fixtureDayTypeFor, loadPlaywright, markdownReceipt, parseArgs,
  planSlotWithCoach, poll, redact, scheduledSlotCount, SETTINGS_SECTION_TITLES,
  tickFirstPlannedSlot, verdictFor, waitForReact, weekCell, otpFor, LOCAL_NO_OTP,
  WALK_HYPOTHESES as HYPOTHESES, WALK_TITLES as TITLES,
  WALK_USER_TABLES as USER_TABLES,
} from "./new-user-walk.lib.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const STATE = `${process.env.HOME}/.claude/goal-state/sasha-new-user/lanes/W1`;
const SHOTS = `${process.env.HOME}/Inbox/screenshots/sasha-new-user-2026-09-20/baseline`;
const RECEIPT = `${STATE}/baseline.md`;
const ORIGIN = "http://localhost:3000";
/** Step 5's planner turn: an explicit slot and a plain dish, so the coach has something to apply. */
const COACH_PLAN_REQUEST = "Plan Meal 1 for today with something simple, and put it on my plan.";
const TRAINING_WEEKDAYS = [2]; // Tue, the one weekday onboarding selects (OnboardingSteps.tsx:72-96).

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js"); const args = parseArgs(process.argv.slice(2));
assertLocalSupabase(process.env.SUPABASE_TEST_URL);
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
if (!serviceKey || !anonKey) throw new Error("Local Supabase test keys are missing");
const admin = createClient(process.env.SUPABASE_TEST_URL, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const cronSecret = randomBytes(32).toString("base64url");
const healthTokenKey = randomBytes(32).toString("base64url");
const secrets = [serviceKey, anonKey, cronSecret, healthTokenKey];
const results = [];
const users = [];
let server = null;
let browser = null;
let page = null;
let authPath = "OTP code"; let authFallbackReason = "";
const authAccepted = (path) => path === "OTP code" || authFallbackReason === LOCAL_NO_OTP;
let serverTail = "";
const browserIssues = [];
let cleanupStatus = "not run";

function safeError(error) {
  return redact(error instanceof Error ? error.message : error, secrets).replaceAll("\n", " ");
}
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric",
    month: "2-digit", day: "2-digit" }).format(new Date());
}
function shot(step, slug = TITLES[step - 1].replaceAll(" ", "-")) {
  return `${SHOTS}/${String(step).padStart(2, "0")}-${slug}.png`;
}
async function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 3000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}
async function startServer() {
  if (await isPortOpen()) throw new Error("Port 3000 is already in use; no fixture was created");
  const env = { ...process.env, SUPABASE_URL: process.env.SUPABASE_TEST_URL,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_TEST_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    COACH_ENABLED: "1", HEALTH_INGEST_ENABLED: "1", ESTIMATOR_ENABLED: "1",
    NEXT_PUBLIC_ESTIMATOR_UI: "1", NEXT_PUBLIC_CATALOG_SEARCH: "1",
    FEATURE_SCAN: "1", NEXT_PUBLIC_FEATURE_SCAN: "1", HEALTH_TOKEN_KEY: healthTokenKey,
    CRON_SECRET: cronSecret };
  server = spawn("pnpm", ["exec", "next", "dev", "-p", "3000"],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => {
    serverTail = (serverTail + redact(chunk, secrets)).slice(-4000);
  });
  await poll(async () => { try { return (await fetch(`${ORIGIN}/sign-in`)).status < 500; }
    catch { return false; } }, { timeout: 45_000, interval: 250 }).catch((error) => {
      throw new Error(`Dev server did not become ready: ${safeError(error)} ${serverTail.slice(-800)}`);
    });
}
async function stopServer() {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already stopped */ } }
  await poll(async () => !(await isPortOpen()), { timeout: 10_000, interval: 150 });
}
function must(label, response) {
  if (response.error) throw new Error(`${label}: ${response.error.message}`);
  return response.data;
}
async function makeUser(lane) {
  const email = `newuser-${lane}-${Date.now()}-${randomBytes(3).toString("hex")}@example.test`;
  const data = must("create user", await admin.auth.admin.createUser({ email, email_confirm: true }));
  users.push({ id: data.user.id, email });
  return users.at(-1);
}
async function countsFor(userId, tables = USER_TABLES) {
  const counts = {};
  for (const table of tables) {
    const response = await admin.from(table).select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    if (response.error) throw new Error(`count ${table}: ${response.error.message}`);
    counts[table] = response.count ?? 0;
  }
  return counts;
}
async function cleanup() {
  for (const user of users.reverse()) {
    for (const table of USER_TABLES) await admin.from(table).delete().eq("user_id", user.id);
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw new Error(`delete fixture user: ${deleted.error.message}`);
    const remaining = await countsFor(user.id);
    if (Object.values(remaining).some(Boolean)) throw new Error("Fixture rows remain after cleanup");
  }
  cleanupStatus = `${users.length} fixture accounts deleted; direct user-row counts are zero`;
}
async function signIn(targetPage, user) {
  try {
    await targetPage.goto(`${ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
    await waitForReact(targetPage, "Send me a sign-in link");
    await targetPage.getByLabel("Email").fill(user.email);
    await targetPage.getByRole("button", { name: "Send me a sign-in link" }).click();
    await targetPage.waitForFunction(() => /Check your email|did not send/.test(document.body.innerText),
      undefined, { timeout: 8_000 });
    if (/did not send/.test(await targetPage.locator("body").innerText())) {
      throw new Error("The real sign-in page could not send its email");
    }
    const otp = await otpFor(user.email);
    await targetPage.getByRole("button", { name: "Use the code instead" }).click();
    await targetPage.getByLabel("Code from the email").fill(otp);
    await targetPage.getByRole("button", { name: "Use the code" }).click();
    await targetPage.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 12_000 });
    return "OTP code";
  } catch (error) {
    authFallbackReason ||= safeError(error);
    const generated = must("generate magic link", await admin.auth.admin.generateLink({
      type: "magiclink", email: user.email, options: { redirectTo: `${ORIGIN}/auth/callback` },
    }));
    await targetPage.goto(generated.properties.action_link, { waitUntil: "domcontentloaded" });
    const landed = new URL(await targetPage.url());
    const fragment = new URLSearchParams(landed.hash.slice(1));
    const accessToken = fragment.get("access_token");
    const refreshToken = fragment.get("refresh_token");
    if (!accessToken || !refreshToken) throw new Error("Generated magic link returned no session");
    const userResponse = await fetch(`${process.env.SUPABASE_TEST_URL}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) throw new Error("Generated magic-link session could not read its user");
    const session = { access_token: accessToken, refresh_token: refreshToken,
      expires_in: Number(fragment.get("expires_in") ?? 3600),
      expires_at: Number(fragment.get("expires_at") ?? 0), token_type: "bearer",
      user: await userResponse.json() };
    const cookie = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    const storageKey = `sb-${new URL(process.env.SUPABASE_TEST_URL).hostname.split(".")[0]}-auth-token`;
    await targetPage.context().addCookies([{ name: storageKey, value: cookie, url: ORIGIN,
      sameSite: "Lax", secure: false }]);
    await targetPage.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await targetPage.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 12_000 });
    return "magic-link fallback";
  }
}
async function completeOnboarding(targetPage, skip = false) {
  await targetPage.goto(`${ORIGIN}/onboarding`, { waitUntil: "domcontentloaded" });
  await targetPage.getByRole("heading", { name: "Body" }).waitFor();
  if (skip) { await targetPage.getByRole("button", { name: "Skip for now" }).click(); return; }
  await targetPage.getByRole("textbox", { name: "Feet", exact: true }).fill("5");
  await targetPage.getByRole("textbox", { name: "Inches", exact: true }).fill("6");
  await targetPage.getByRole("textbox", { name: "Birth year", exact: true }).fill("1990");
  await targetPage.getByLabel("Sex used in formula").selectOption("female");
  await targetPage.getByRole("textbox", { name: "Weight in pounds", exact: true }).fill("150");
  await targetPage.getByRole("textbox", { name: "Weight in pounds", exact: true }).press("Tab");
  await targetPage.getByRole("button", { name: "Next", exact: true }).click();
  await targetPage.getByRole("heading", { name: "Activity" }).waitFor();
  await targetPage.getByRole("button", { name: /^Light\b/ }).click();
  await targetPage.getByRole("button", { name: "Tue", exact: true }).click();
  await targetPage.getByRole("button", { name: "Next", exact: true }).click();
  await targetPage.getByRole("heading", { name: "Goal" }).waitFor();
  await targetPage.getByRole("button", { name: /^Maintain\b/ }).click();
  await targetPage.getByRole("button", { name: "Next", exact: true }).click();
  await targetPage.getByRole("heading", { name: "Dietary preferences" }).waitFor();
  await targetPage.getByRole("button", { name: "No peanuts", exact: true }).click();
  await targetPage.getByRole("button", { name: "Next", exact: true }).click();
  await targetPage.getByRole("heading", { name: "Your plan" }).waitFor();
  await targetPage.getByRole("button", { name: "Use this plan" }).click();
  await targetPage.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
}
async function addResult(step, observation, pass, command, targetPage = page) {
  const screenshot = shot(step);
  if (targetPage) await targetPage.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  const status = pass ? "PASS" : "FAIL";
  results.push({ step, title: TITLES[step - 1], command, observation: redact(observation, secrets),
    status, hypothesis: HYPOTHESES[step - 1], screenshot });
  console.log(`STEP ${step} ${status}`);
  if (!pass && !args.baseline) throw new Error(`Step ${step} failed`);
}
async function step(step, command, fn) {
  let value;
  try { value = await fn(); }
  catch (error) { await addResult(step, safeError(error), false, command); return; }
  await addResult(step, value.observation, value.pass, command, value.screenshotDone ? false : page);
}
function personal(text) { return [...new Set((text.match(/\b(?:Sasha|Devin|she|her)\b/gi) ?? []))]; }
async function bodyText(targetPage = page) { return targetPage.locator("body").innerText(); }
async function main() {
  await mkdir(STATE, { recursive: true }); await mkdir(SHOTS, { recursive: true }); await startServer();
  const first = await makeUser("w1");
  const initial = await countsFor(first.id);
  if (Object.values(initial).some(Boolean)) throw new Error("Fresh fixture has user rows before login");
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: "America/Denver", reducedMotion: "reduce" });
  page = await context.newPage();
  page.on("pageerror", (error) => browserIssues.push(`pageerror:${safeError(error)}`));
  page.on("console", (message) => { if (message.type() === "error") browserIssues.push(`console:${safeError(message.text())}`); });
  page.on("requestfailed", (request) => browserIssues.push(`request:${request.url().replace(/[?#].*$/, "")}`));
  authPath = await signIn(page, first);
  await step(1, "sign in via /sign-in; capture / at commit and after 3 s", async () => {
    const started = Date.now();
    await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
    await page.screenshot({ path: shot(1) });
    const earlyMs = Date.now() - started;
    const earlyToday = await page.getByRole("link", { name: "Today", exact: true }).count() > 0;
    await page.waitForTimeout(2800);
    const lateToday = await page.getByRole("heading", { name: "Today", exact: true }).count() > 0;
    await page.screenshot({ path: shot(1, "onboarding-gate-late") });
    const onboarding = await page.goto(`${ORIGIN}/onboarding`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Body", exact: true }).waitFor({ timeout: 8_000 }).catch(() => {}); // gate resolves
    const pass = authAccepted(authPath) && earlyMs <= 300 && !earlyToday && onboarding?.ok() === true
      && /Body/.test(await bodyText());
    return { pass, observation: `early=${earlyMs}ms Today chrome=${earlyToday}; after 2.8s `
      + `Today heading=${lateToday} onboarding=${/Body/.test(await bodyText())}; auth=${authPath}`
      + (authFallbackReason ? `; OTP failure=${authFallbackReason}` : "") + `; url=${new URL(page.url()).pathname}`
      + `; issues=${browserIssues.slice(-3).join(" | ") || "none"}`,
      screenshotDone: true };
  });
  await step(2, "complete five onboarding steps; count four canonical tables", async () => {
    await completeOnboarding(page);
    const counts = await countsFor(first.id, ["user_settings", "target_profiles", "health_samples", "constraint_profiles"]);
    return { pass: Object.values(counts).every((count) => count > 0),
      observation: `row counts ${JSON.stringify(counts)}` };
  });
  let firstTarget = null; let markedLabel = ""; let bananaLogged = false;
  await step(3, "open /; compare displayed kcal with target_profiles; count the empty slots", async () => {
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Today's progress").waitFor();
    const gauge = await calorieOn(page);
    const query = await admin.from("target_profiles").select("*").eq("user_id", first.id).order("rev", { ascending: false }).limit(1).maybeSingle();
    firstTarget = must("target profile", query);
    const targets = [firstTarget?.kcal_train, firstTarget?.kcal_rest,
      firstTarget?.training_macros?.kcal, firstTarget?.rest_macros?.kcal].filter(Number.isFinite);
    const localFoods = await page.evaluate(() => Object.keys(JSON.parse(
      localStorage.getItem("meal-companion:store:v1") ?? "{\"foods\":{}}"
    ).foods ?? {}).length);
    // Design §2.2: every scheduled slot resolves empty for a zero-food account, and an empty slot
    // draws "Nothing planned yet." with no tick (components/SlotCard.tsx:153-173) — so this copy,
    // not a tick count, is what proves the slots resolved.
    const slots = await page.getByText("Nothing planned yet.", { exact: true }).count();
    const water = await page.locator('button[aria-label^="Water:"]').count();
    const dayStrip = await page.getByRole("group", { name: "Days" }).count();
    // Zero foods rotate nothing (lib/resolve.ts:175-178): one empty card per scheduled slot, exactly.
    const expected = scheduledSlotCount(fixtureDayTypeFor(today(), TRAINING_WEEKDAYS));
    return { pass: targets.includes(gauge.target) && localFoods === 0 && slots === expected && water > 0 && dayStrip > 0,
      observation: `kcal=${gauge.target}; profileMatch=${targets.includes(gauge.target)}; `
        + `local foods=${localFoods}; empty slots=${slots}/${expected}; water=${water}; day strip=${dayStrip}` };
  });
  await step(4, "open the first slot's log sheet; search banana; log one portion", async () => {
    const before = await calorieOn(page);
    // Design §2.2: Today has no page-level "Log a food" opener; the way in is the empty slot's own
    // "Log what you ate", which opens LogFoodSheet with that slot preselected
    // (components/SlotCard.tsx:167-168 → app/page.tsx's onLogWhatYouAte).
    const opener = page.getByRole("button", { name: "Log what you ate" }).first();
    if (await opener.count() === 0) throw new Error("No 'Log what you ate' opener on Today");
    await opener.click(); await page.getByLabel("Search foods").fill("banana");
    const result = page.locator("button").filter({ hasText: /banana/i }).first();
    await result.waitFor({ timeout: 8_000 }); await result.click();
    const log = page.getByRole("button", { name: /^Log it|^Add ·/ }).first();
    await log.waitFor({ timeout: 8_000 }); const label = await log.innerText(); await log.click();
    await poll(async () => /banana/i.test(await bodyText()), { timeout: 12_000 });
    // Read the gauge only once it has moved: the log lands optimistically, the ring repaints later.
    const after = await poll(async () => {
      const gauge = await calorieOn(page);
      return gauge.consumed > before.consumed ? gauge : null;
    }, { timeout: 12_000, interval: 250 });
    bananaLogged = after.consumed > before.consumed && /banana/i.test(await bodyText());
    return { pass: bananaLogged,
      observation: `banana card visible; ${label}; calories ${before.consumed}→${after.consumed}` };
  });
  await step(5, "plan a slot with the coach; tick it; reload; query plan_days.eaten_slots", async () => {
    // An empty slot carries no tick (components/SlotCard.tsx:153-173 returns before :192-207), so the
    // tick must be driven on a slot the empty card's "Plan with the coach" action (:165-166) just
    // gave a meal; planSlotWithCoach also taps the composed card's "Put it in <slot>", which applies it.
    const reply = await planSlotWithCoach(page, COACH_PLAN_REQUEST);
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
    // The tick must also be in the row the coach context is built from, plan_days.eaten_slots — so
    // the row is polled for this slot's own eaten_at before the reload reads the label back.
    const tick = await tickFirstPlannedSlot(page, { admin, userId: first.id, date: today() });
    if (tick.missing) throw new Error(`no planned slot to tick after the coach turn; reply=${reply}`);
    markedLabel = tick.label;
    return { pass: tick.persisted && tick.onServer,
      observation: `ticked "${tick.label}" → ${tick.slotId ?? "unmapped label"}; `
        + `reload persisted=${tick.persisted}; plan_days.eaten_slots=${tick.keys.join(",") || "none"}`
        + ` (${tick.at ?? tick.error ?? "no eaten_at"}); coach reply=${reply.slice(0, 160)}` };
  });
  await step(6, "open /week and read current-day status plus stat cards", async () => {
    // One tick per planned slot (components/SlotCard.tsx:197); statusFor (WeekGrid.tsx:7-14) scores these.
    const planned = await page.locator('button[aria-label^="Mark "]').count();
    const eaten = await page.locator('button[aria-label$=" not eaten"]').count();
    await page.goto(`${ORIGIN}/week`, { waitUntil: "domcontentloaded" });
    const cell = await weekCell(page, today());
    const text = await bodyText();
    // components/week/WeekGrid.tsx:7-14: every planned slot ticked reads "all done", fewer reads
    // "partially done" — the words a day with one logged extra and the coach's slot ticked must show.
    const expected = eaten === planned ? "all done" : "partially done";
    return { pass: bananaLogged && planned > 0 && eaten > 0 && cell.status === expected,
      observation: `banana logged=${bananaLogged}; today planned=${planned} eaten=${eaten}; `
        + `day status=${cell.status || "missing"} (expected ${expected}); `
        + `protein copy=${/hit-rate[^\n]*/i.exec(text)?.[0] ?? "missing"}; `
        + `calorie copy=${/average[^\n]*/i.exec(text)?.[0] ?? "missing"}` };
  });
  await step(7, "open /body and /settings; scan visible text and document titles", async () => {
    const seen = [];
    await page.goto(`${ORIGIN}/body`, { waitUntil: "domcontentloaded" });
    await poll(async () => (await bodyText()).trim().length > 0);
    seen.push(`${await page.title()}\n${await bodyText()}`);
    await page.goto(`${ORIGIN}/settings`, { waitUntil: "domcontentloaded" });
    // The route gate draws nothing until the session resolves (components/AuthGate.tsx), so the page's
    // first section heading — not a non-empty body — is awaited before its text is read.
    await page.getByRole("heading", { level: 2, name: SETTINGS_SECTION_TITLES[0], exact: true })
      .waitFor({ timeout: 15_000 });
    seen.push(`${await page.title()}\n${await bodyText()}`);
    const hits = personal(seen.join("\n")); const settings = seen[1];
    const missing = SETTINGS_SECTION_TITLES.filter((name) => !settings.includes(name));
    return { pass: hits.length === 0 && missing.length === 0,
      observation: `body empty=${/Nothing here yet/.test(seen[0])}; settings missing=${missing.join(",") || "none"}; `
        + `personal=${hits.join(",") || "none"}` };
  });
  await step(8, "send one coach turn: What have I eaten so far today?", async () => {
    await page.goto(`${ORIGIN}/coach`, { waitUntil: "domcontentloaded" });
    const input = page.getByLabel("Message the coach"); await input.waitFor();
    const thread = page.locator('[aria-label="Conversation"]'); const question = "What have I eaten so far today?"; await input.fill(question); await page.getByRole("button", { name: "Send" }).click();
    const replyText = async () => (await thread.innerText()).split(question).at(-1) ?? ""; // text after THIS question; reply may be chips, not <p>
    await poll(async () => /\S/.test(await replyText()) && !/…|Thinking/.test(await replyText()), { timeout: 90_000, interval: 250 });
    const reply = (await replyText()).trim();
    const assumptions = /colitis|gluten|dairy|apple|\b(?:Sasha|she|her)\b/i.test(reply);
    const contextSeen = /banana/i.test(reply) && /logged|ate|eaten|already/i.test(reply);
    return { pass: !assumptions && contextSeen,
      observation: `reply=${reply.slice(0, 500)}; neutral=${!assumptions}; banana+eaten context=${contextSeen}` };
  });
  await step(9, "GET estimate and weekly-proposal jobs with local CRON_SECRET", async () => {
    const outputs = {};
    for (const name of ["estimate", "weekly-proposal"]) {
      const response = await fetch(`${ORIGIN}/api/jobs/${name}`, { headers: { Authorization: `Bearer ${cronSecret}` } });
      const json = await response.json().catch(() => ({}));
      outputs[name] = { status: response.status, ran: json.ran ?? null, skipped: json.skipped ?? null,
        errors: json.errors ?? null };
    }
    const jobs = await countsFor(first.id, ["job_runs"]);
    return { pass: Object.values(outputs).every((o) => o.status === 200 && o.errors === 0) && jobs.job_runs > 0,
      observation: `counts only ${JSON.stringify(outputs)}; fixture job rows=${jobs.job_runs}` };
  });
  await step(10, "create second account; real sign-in; inspect Today, week and coach", async () => {
    const second = await makeUser("w1b");
    const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 },
      timezoneId: "America/Denver", reducedMotion: "reduce" });
    const secondPage = await secondContext.newPage(); const secondAuth = await signIn(secondPage, second);
    await completeOnboarding(secondPage, true);
    const texts = [];
    for (const path of ["/", "/week", "/coach"]) {
      await secondPage.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
      texts.push(await bodyText(secondPage));
    }
    const localFoods = await secondPage.evaluate(() => Object.keys(JSON.parse(
      localStorage.getItem("meal-companion:store:v1") ?? "{\"foods\":{}}"
    ).foods ?? {}).length);
    const leak = /banana/i.test(texts.join("\n")) || (markedLabel && texts.join("\n").includes(markedLabel));
    const messages = await secondPage.locator('[aria-label="Conversation"] p').count();
    await secondPage.screenshot({ path: shot(10), fullPage: true }); await secondContext.close();
    return { pass: authAccepted(secondAuth) && !leak && localFoods === 0 && messages === 0,
      observation: `auth=${secondAuth}; first-account leak=${leak}; local foods=${localFoods}; coach messages=${messages}`,
      screenshotDone: true };
  });
}

let fatal = null; try { await main(); } catch (error) { fatal = error; }
finally {
  await browser?.close().catch(() => {});
  await cleanup().catch((error) => { fatal ??= error; });
  await stopServer().catch((error) => { fatal ??= error; });
  const meta = { date: "2026-09-20", target: ORIGIN, authPath, cleanup: cleanupStatus,
    fixtureEmails: users.map((user) => user.email) };
  await writeFile(RECEIPT, markdownReceipt({ results, meta }));
}
const verdict = fatal ? "FAIL" : verdictFor(results);
console.log(`VERDICT ${verdict}`);
console.log(`RECEIPT ${RECEIPT}`);
if (fatal) console.error(`ERROR ${safeError(fatal)}`);
process.exitCode = verdict === "PASS" ? 0 : 1;
