import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(__dirname, "globals.css"), "utf-8");

// Other lanes reference these legacy token names directly (see AGENTS.md /
// task brief) — every one of them must keep existing, even as values change.
const legacyColorNames = [
  "paper",
  "charcoal",
  "fog",
  "graphite",
  "hairline",
  "signal",
  "plum",
  "sky",
  "green",
  "muted",
  "tangerine",
  "amber",
  "alert",
];

describe("globals.css legacy token names", () => {
  it.each(legacyColorNames)("keeps --color-%s", (name) => {
    expect(css).toMatch(new RegExp(`--color-${name}:`));
  });

  it.each(["--radius-card:", "--radius-pill:", "--text-body:", "--text-display:"])(
    "keeps %s",
    (token) => {
      expect(css).toContain(token);
    },
  );
});

describe("globals.css NeuForm utility classes", () => {
  it.each([
    ".shell",
    ".surface",
    ".pill",
    ".pill-in",
    ".well",
    ".olive-panel",
    ".meal-card",
    ".meal-card-in",
    ".tab-glass",
    ".ts",
    ".btn-ink",
  ])(
    "defines %s",
    (selector) => {
      expect(css).toContain(selector);
    },
  );
});
