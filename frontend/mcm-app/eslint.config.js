// ESLint flat config (feature 081 US5b). ESLint 10 removed `.eslintrc.*` and `--ext`. This file replaces
// `.eslintrc.json` (`"extends": "expo"`, `"ignorePatterns": ["/dist/*"]`) one-for-one: the same Expo preset,
// through its flat entry point (eslint-config-expo/flat, same package and version as the legacy `expo`).
const { fixupConfigRules } = require('@eslint/compat');
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  // `/dist/*` from the old ignorePatterns. Flat-config ignores resolve against this file's directory.
  globalIgnores(['dist/*']),
  // SCOPE IS UNCHANGED: the lint command used `--ext .ts,.tsx`. Flat config has no way to NARROW the
  // extensions it lints (ESLint 9.21's `--ext` only adds), and it lints *.js/*.mjs/*.cjs by default. So
  // the JS extensions are ignored here, keeping the linted set to the TypeScript files `--ext` selected.
  // Widening lint to JS is a separate decision, not a side effect of the format migration.
  globalIgnores(['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs']),
  // fixupConfigRules: eslint-config-expo 57.0.2 (also 58.0.4, the newest) bundles eslint-plugin-react 7.37.5 and
  // eslint-plugin-import 2.32.0, whose newest releases peer eslint <=9 and still call context methods ESLint 10
  // REMOVED. MEASURED: without this, every file fails at load with `react/display-name:
  // contextOrFilename.getFilename is not a function`. @eslint/compat (the ESLint team's bridge) restores those
  // methods on the rule context; it changes no rule and no severity. DROP IT when both plugins (as shipped by
  // eslint-config-expo) declare eslint 10 in their peers — then `expoConfig` goes back in unwrapped.
  ...fixupConfigRules(expoConfig),
  // PARITY WITH THE ESLINT 8 RESULT — four settings, each kept at what `main` resolved, because each one would
  // otherwise report on today's code. eslint-config-expo's FLAT preset is not its legacy preset re-expressed:
  // it takes eslint-plugin-react's `flat.recommended` (a dozen react rules warn -> error, plus jsx-key,
  // no-unescaped-entities, …) and eslint-plugin-import's `flatConfigs.warnings`, and ESLint 9+ reports unused
  // disable directives by default. Every OTHER difference is adopted as-is; it reports nothing today (measured
  // with `--print-config` and `-f json` against `main`, research.md R6). These four are not new exemptions —
  // `main` never ran them. Turning them on means fixing what they report (33 findings in mcm-app, 0 in
  // design-system), which is its own change, not a side effect of the format migration.
  {
    linterOptions: {
      // ESLint 8's default. ESLint 9+ defaults to 'warn': 9 stale directives in mcm-app.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Absent from the legacy preset. Flat preset: error. 4 findings (a literal ' in JSX text).
      'react/no-unescaped-entities': 'off',
      // Absent from the legacy preset. Flat preset: warn. 10 findings (5 modules imported twice).
      'import/no-duplicates': 'off',
      // Absent from the legacy preset. Flat preset: warn. 14 findings, every one `axios.create` /
      // `axios.isAxiosError` on axios's default export (its documented API; the tests mock that export).
      'import/no-named-as-default-member': 'off',
    },
  },
  // NON-APP CODE (spec 097, item #962). `lint` runs `eslint .` since 097, so tests, scripts and the
  // root config files are linted with the app. Each rule changed here is changed for a reason that
  // holds for these paths and NOT for `src/`; nothing is turned off because it was inconvenient.
  {
    files: ['tests/**', 'scripts/**', '*.config.ts'],
    rules: {
      // OFF: the rule exists because Metro inlines only STATIC `process.env.EXPO_PUBLIC_*` reads into
      // the app bundle, so a dynamic read there is `undefined` at runtime. This code never enters the
      // bundle: it runs under Node (jest, Playwright, tsx scripts), where `process.env[name]` is
      // simply correct. 10 findings, every one a test/config helper reading its own env by name.
      'expo/no-dynamic-env-var': 'off',
      // ERROR, up from the preset's warn: unused code had piled up here unseen until spec 096 removed
      // 15 symbols, four of them a skip-escalation guard imported and never called. `_`-prefixed
      // names are the conventional "deliberately unused" marker (mock factory and fixture params).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/e2e/**'],
    rules: {
      // OFF: Playwright, not React. A fixture's second parameter is conventionally named `use`, which
      // the rule takes for React 19's `use()` hook, and nothing under tests/e2e renders a component, so
      // the rule has no true positive to find here. Confirmed on worker-session.ts (`storageState:
      // ({ workerStorageState }, use) => use(...)`). Component tests live in tests/app and keep it.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    files: ['tests/load/**'],
    settings: {
      // k6 scripts import k6's built-in modules, which the k6 runtime supplies and Node cannot
      // resolve. Declared as core modules rather than turning `import/no-unresolved` off, so a
      // genuinely misspelled relative import in a load script is still an error.
      'import/core-modules': ['k6', 'k6/http', 'k6/metrics'],
    },
  },
]);
