import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import regexp from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["dist/**", "node_modules/**", ".barndog/**"] },
  {
    files: ["**/*.{js,ts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      regexp.configs.recommended,
      prettier,
    ],
    languageOptions: { globals: globals.node },
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        {
          blankLine: "always",
          prev: ["function", "class", "type", "interface", "export"],
          next: "*",
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["function", "class", "type", "interface", "export"],
        },
        { blankLine: "any", prev: "import", next: "import" },
      ],
      "@stylistic/lines-between-class-members": [
        "error",
        {
          enforce: [
            { blankLine: "always", prev: "*", next: "method" },
            { blankLine: "always", prev: "method", next: "*" },
          ],
        },
      ],
    },
  },
  {
    // Type-aware rules read the compiler's types. Tests keep the syntax-only set
    // above: fakes and fixtures cast and assert on purpose.
    files: ["src/**/*.ts"],
    ignores: ["src/tests/**"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // Shared helpers stay free of BarnDog code, so any module can import them.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*", "!./*"],
              message: "src/shared/ imports nothing from the rest of src/.",
            },
          ],
        },
      ],
    },
  },
]);
