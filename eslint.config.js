export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        chrome: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        location: "readonly",
        fetch: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URLSearchParams: "readonly",
        MutationObserver: "readonly",
        InputEvent: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        Intl: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "no-undef": "error",
      "no-constant-condition": ["error", { "checkLoops": false }]
    }
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        global: "readonly"
      }
    }
  },
  {
    files: ["apps-script/**/*.gs", "apps-script/**/*.js"],
    languageOptions: {
      globals: {
        SpreadsheetApp: "readonly",
        ContentService: "readonly",
        Logger: "readonly"
      }
    }
  },
  {
    ignores: ["node_modules/", "dist/", "icons/source.html"]
  }
];
