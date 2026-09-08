import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated OpenNext + wrangler output: tens of megabytes of bundled
    // code that OOMs the linter and must never be hand-edited.
    ".open-next/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
