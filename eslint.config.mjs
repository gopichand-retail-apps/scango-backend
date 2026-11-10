import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "data/**", "coverage/**"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      complexity: ["error", 15],
      "max-depth": ["error", 3],
      "max-len": [
        "error",
        {
          code: 120,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
        },
      ],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "no-console": "error",
    },
  },
];
