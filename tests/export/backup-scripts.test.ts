import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps backup publication, credentials, retention and restore guards safe", () => {
  const script = path.resolve(__dirname, "backup_scripts_test.py");
  const result = execFileSync("python3", ["-B", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(result).toBe("");
}, 30_000);

it("verifies media backup checksums, private files, traversal safety and failure preservation", () => {
  const script = path.resolve(__dirname, "../../scripts/test_backup_storage.py");
  const result = execFileSync("python3", ["-B", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(result).toBe("");
}, 30_000);
