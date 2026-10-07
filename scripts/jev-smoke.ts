import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

loadEnvFile(".env.local");

const SERVER_CHILD_ARG = "--jev-react-server-child";

const CASES = [
  "I woke up late, can you move all my meals by 30 minutes?",
  "add watermelon to my avoid list",
  "make me 5 suggestions from my eats list",
  "suggest a snack that fits my remaining macros",
  "what do I have left to eat today?",
] as const;

async function main(): Promise<void> {
  const { classifyIntent } = await import("@/lib/coach/intent");
  const now = new Date().toISOString();
  const rows = await Promise.all(CASES.map(async (message) => {
    const result = await classifyIntent(message, {
      now,
      ...(message.includes("watermelon") ? { foodsMentioned: ["watermelon"] } : {}),
    });
    return {
      message,
      intent: result?.intent ?? "unavailable",
      confidence: result?.confidence ?? null,
      args: result ? JSON.stringify(result.args) : "",
    };
  }));

  console.table(rows);
  const first = rows[0];
  const third = rows[2];
  const firstArgs = first.intent === "shift_schedule" ? JSON.parse(first.args) as { minutes?: number } : {};
  const thirdArgs = third.intent === "suggest_options" ? JSON.parse(third.args) as { count?: number } : {};
  process.exitCode = first.intent === "shift_schedule" && firstArgs.minutes === 30
    && third.intent === "suggest_options" && thirdArgs.count === 5 ? 0 : 1;
}

if (!process.argv.includes(SERVER_CHILD_ARG)) {
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    "--conditions=react-server",
    fileURLToPath(import.meta.url),
    SERVER_CHILD_ARG,
  ], { stdio: "inherit", env: process.env });
  if (child.error) console.error(child.error);
  process.exitCode = child.status ?? 1;
} else {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
