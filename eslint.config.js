import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import regexp from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

// Literals defined by an outside format, grouped by the one module that names
// them. Every other file, scripts and tests included, must use that name.
const ownedLiterals = {
  "src/features/workspace/snapshot.ts": [
    {
      selector: "Literal[value=/^(100644|100755|120000|160000|040000)$/]",
      message: "Use GIT_MODE from features/workspace/snapshot.ts.",
    },
  ],
  "src/shared/constants.ts": [
    {
      selector: "Literal[raw=/^0o(111|077|700|755|644)$/]",
      message: "Use POSIX_MODE from shared/constants.ts.",
    },
    {
      selector: "Literal[raw=/^(400|401|403|404|409|413|500)$/]",
      message: "Use HTTP_STATUS from shared/constants.ts.",
    },
  ],
};

// A later config block replaces a rule's options rather than merging them, so
// each owner gets the full list minus its own literals.
function restrictLiterals(owner) {
  const restrictions = Object.entries(ownedLiterals)
    .filter(([module]) => module !== owner)
    .flatMap(([, literals]) => literals);

  return { "no-restricted-syntax": ["error", ...restrictions] };
}

/** Forbids imports that point up the layer order from the files `files` matches. */
function layer(files, message, group) {
  return {
    files: [files],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
    },
  };
}

export default defineConfig([
  { ignores: ["dist/**", "node_modules/**", ".barndog/**", "coverage/**"] },
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
      // After `prettier`, which turns `curly` off; "all" is the option that doesn't
      // conflict with Prettier.
      curly: ["error", "all"],
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
        { blankLine: "always", prev: "*", next: "return" },
        {
          blankLine: "always",
          prev: [
            "block-like",
            "multiline-expression",
            "multiline-const",
            "multiline-let",
          ],
          next: "*",
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
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
        },
      ],
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-nested-ternary": "error",
      "max-params": ["error", 4],
      "one-var": ["error", "never"],
      // Advisory on purpose: it points at functions worth splitting.
      complexity: ["warn", 15],
    },
  },
  { files: ["**/*.{js,mjs,ts}"], rules: restrictLiterals() },
  ...Object.keys(ownedLiterals).map((owner) => ({
    files: [owner],
    rules: restrictLiterals(owner),
  })),
  {
    // No module may reach itself through its imports; a cycle means two
    // modules should share a lower one instead.
    files: ["src/**/*.ts"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/parsers": { "@typescript-eslint/parser": [".ts"] },
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: { "import-x/no-cycle": "error" },
  },
  // Imports point down: commands → ui → features → config → harnesses → shared.
  layer("src/config/*.ts", "config/ depends on no feature, UI or command.", [
    "../features/*",
    "../ui/*",
    "../commands/*",
    "../program.js",
  ]),
  layer("src/harnesses/*.ts", "harnesses/ depends only on shared/.", [
    "../config/*",
    "../features/*",
    "../ui/*",
    "../commands/*",
  ]),
  layer("src/features/**/*.ts", "Features don't import UI or commands.", [
    "../../ui/*",
    "../../commands/*",
    "../../program.js",
  ]),
  layer("src/ui/*.ts", "ui/ doesn't import commands.", [
    "../commands/*",
    "../program.js",
  ]),
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
