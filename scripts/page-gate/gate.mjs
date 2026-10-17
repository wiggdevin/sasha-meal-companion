// The Build job's page gate (W079), run against `next start` after the build:
//   1. CSP: every page in scripts/perf-budget.json loads with no Content-Security-Policy violation,
//      report-only ones included (the page policy is report-only until CSP_ENFORCE in
//      lib/security-headers.ts, so a violation here is exactly what enforcing would break).
//   2. Lighthouse, mobile (its default form factor and throttling): the median of `runs` runs per
//      page meets the category scores in the budget file.
//
// Lighthouse is not an app dependency: it has its own lockfile in this folder, installed with
// `npm ci --prefix scripts/page-gate`. CHROME_PATH names the browser. Usage:
//   CHROME_PATH=<chrome> node scripts/page-gate/gate.mjs http://localhost:3000
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const budget = JSON.parse(readFileSync(path.join(repo, "scripts", "perf-budget.json"), "utf8")).pages;
const base = process.argv[2] ?? "http://localhost:3000";
const chromePath = process.env.CHROME_PATH;
if (!chromePath) {
  console.error("page gate: set CHROME_PATH");
  process.exit(2);
}

const req = createRequire(path.join(here, "package.json"));
const load = async (name) => import(pathToFileURL(req.resolve(name)).href);
const { default: puppeteer } = await load("puppeteer-core");
const { default: lighthouse } = await load("lighthouse");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  args: ["--headless=new", "--no-sandbox", "--remote-debugging-port=9333"],
});
const failures = [];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

try {
  for (const pagePath of budget.paths) {
    const url = new URL(pagePath, base).href;

    // 1. CSP violations, from the page's own event and the console line Chrome writes for each.
    const page = await browser.newPage();
    const seen = [];
    page.on("console", (msg) => {
      if (/Content Security Policy/i.test(msg.text())) seen.push(msg.text());
    });
    await page.evaluateOnNewDocument(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window.__cspViolations ??= []).push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
      });
    });
    const res = await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
    seen.push(...(await page.evaluate(() => window.__cspViolations ?? [])));
    const header = res?.headers()["content-security-policy-report-only"] ?? res?.headers()["content-security-policy"] ?? "";
    if (!/script-src [^;]*'nonce-/.test(header)) failures.push(`${pagePath}: no nonce script-src policy on the response`);
    for (const v of new Set(seen)) failures.push(`${pagePath}: CSP violation: ${v}`);
    console.log(`${pagePath}: ${new Set(seen).size} CSP violations`);
    await page.close();

    // 2. Lighthouse mobile scores.
    const scores = {};
    for (let i = 0; i < budget.runs; i++) {
      const result = await lighthouse(url, {
        port: 9333,
        output: "json",
        logLevel: "error",
        onlyCategories: Object.keys(budget.minScores),
      });
      for (const [key, cat] of Object.entries(result.lhr.categories)) (scores[key] ??= []).push(cat.score ?? 0);
    }
    for (const [key, min] of Object.entries(budget.minScores)) {
      const score = median(scores[key] ?? [0]);
      console.log(`${pagePath}: ${key} ${score} (runs ${scores[key]?.join(", ")}), minimum ${min}`);
      if (score < min) failures.push(`${pagePath}: ${key} ${score}, minimum ${min}`);
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(`page gate: ${f}`);
  process.exit(1);
}
