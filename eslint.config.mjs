import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Match the repo's existing "_" convention for intentionally-unused
      // bindings (test doubles, ignored callback args) so --max-warnings 0
      // (package.json) doesn't fail on names that are already marked unused.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Colours come from the design tokens (DESIGN.md → app/design-tokens.css, role tokens in
  // app/globals.css), never from a literal in a component: a theme change then edits one file.
  // Neutral black / white alpha (rgba(0,0,0,…), rgba(255,255,255,…)) stays allowed for now.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/]",
          message: "Hard-coded hex colour: use a design token, e.g. var(--color-text-muted).",
        },
        {
          selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/]",
          message: "Hard-coded hex colour: use a design token, e.g. var(--color-text-muted).",
        },
        {
          selector: "Literal[value=/rgba?\\((?!0, ?0, ?0\\b|255, ?255, ?255\\b)\\d/]",
          message: "Tinted rgb() colour: use a design token, e.g. rgb(var(--ink-rgb) / 0.08).",
        },
        {
          selector: "TemplateElement[value.raw=/rgba?\\((?!0, ?0, ?0\\b|255, ?255, ?255\\b)\\d/]",
          message: "Tinted rgb() colour: use a design token, e.g. rgb(var(--ink-rgb) / 0.08).",
        },
      ],
    },
  },
  // The design-system primitives (components/ui) read tokens through classes only: no inline
  // font size, weight, padding or radius, so a theme edits globals.css and nothing else. The
  // migration extends this scope one screen at a time (docs/plans, 2026-09-22).
  {
    files: ["components/ui/**/*.{ts,tsx}", "app/design/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error",
        {
          selector: "Property[key.name=/^(fontSize|fontWeight|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|borderRadius|lineHeight|letterSpacing)$/]",
          message: "Inline type, spacing or radius in a primitive: use a token class from globals.css.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Workflow scripts run inside the Claude Code Workflow runtime, not Node.
    "docs/audit/**/*.js",
  ]),
]);

export default eslintConfig;
